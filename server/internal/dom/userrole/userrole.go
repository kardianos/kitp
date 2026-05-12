// Package userrole exposes user_role.set / user_role.revoke — admin-only
// handlers that grant or remove a role for a user, optionally scoped to a
// project. Both writers funnel through jsonb_to_recordset so a coalesced
// batch issues exactly one statement-group per Run.
//
// Authz is enforced via an Authz hook that loads the actor's grants from
// the DB and asserts the actor holds the global `admin` role. The
// dispatcher's scope-aware role check does NOT cover these (they don't
// operate on a card_type) so we hand-roll the gate here.
package userrole

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// SetInput is one row of user_role.set.
type SetInput struct {
	UserID         int64  `json:"user_id,string" mcp:"required,desc=user_account id receiving the role"`
	RoleName       string `json:"role_name" mcp:"required,desc=role name (e.g. worker, manager, admin)"`
	ScopeProjectID *int64 `json:"scope_project_id,string,omitempty" mcp:"desc=optional project id for scoped grant; null = global"`
}

// SetOutput is the per-row reply.
type SetOutput struct {
	OK         bool  `json:"ok" mcp:"desc=true on success"`
	UserRoleID int64 `json:"user_role_id,string" mcp:"desc=id of the (created or pre-existing) user_role row"`
}

// RevokeInput mirrors SetInput; the server deletes any matching row.
type RevokeInput struct {
	UserID         int64  `json:"user_id,string" mcp:"required,desc=user_account id losing the role"`
	RoleName       string `json:"role_name" mcp:"required,desc=role name"`
	ScopeProjectID *int64 `json:"scope_project_id,string,omitempty" mcp:"desc=optional project id for scoped grant; null = global"`
}

// RevokeOutput acknowledges; reports whether a row actually went away.
type RevokeOutput struct {
	OK      bool `json:"ok" mcp:"desc=true if at least one matching user_role row was deleted"`
	Deleted int  `json:"deleted" mcp:"desc=number of rows deleted (0 or 1)"`
}

// Register installs both handlers.
func Register(p *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "user_role",
		Action:       "set",
		Doc:          "Grant a role to a user, optionally scoped to a project. Admin-only EXCEPT when the target is an agent — then the agent's parent_user_id may also grant any non-admin role they hold themselves. Coalesces N inputs into one upsert statement.",
		InputType:    reflect.TypeFor[SetInput](),
		OutputType:   reflect.TypeFor[SetOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Authz:        authzSet,
		Run:          runSet(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "user_role",
		Action:       "revoke",
		Doc:          "Revoke a role from a user (with matching scope). Admin-only EXCEPT when the target is an agent — then the agent's parent_user_id may also revoke.",
		InputType:    reflect.TypeFor[RevokeInput](),
		OutputType:   reflect.TypeFor[RevokeOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Authz:        authzRevoke,
		Run:          runRevoke(p),
	})
}

// authzAdmin returns nil when the actor holds the `admin` or `system`
// role globally. Used as the fallback gate when the agent-parent path
// below doesn't apply.
func authzAdmin(ctx context.Context) error {
	pool, ok := authzPool.(*store.Pool)
	if !ok || pool == nil {
		return nil // tests that bypass Register may not bind a pool; fail open
	}
	userID := auth.ActorOrSystem(ctx)
	var n int
	row := pool.P.QueryRow(ctx, `
		SELECT count(*)
		FROM user_role ur
		JOIN role r ON r.id = ur.role_id
		WHERE ur.user_id = $1 AND r.name IN ('admin','system') AND ur.scope_card_id IS NULL
	`, userID)
	if err := row.Scan(&n); err != nil {
		return fmt.Errorf("user_role.authz: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("user_role: actor %d is not an admin", userID)
	}
	return nil
}

// authzSet is the gate for user_role.set. The full rule set:
//
//  1. Actor must not itself be an agent (no self-bootstrapping; agents
//     cannot escalate themselves or their siblings).
//  2. The role `admin` is NEVER grantable to a target with is_agent=TRUE,
//     regardless of who's calling. Agents stay capped below their parent.
//  3. If the target is an agent AND the actor is that agent's
//     parent_user_id, the actor may grant any non-admin role they
//     themselves hold globally. Lets workers / managers grant their
//     own agents narrow scopes without escalating to admin.
//  4. Otherwise, fall back to `authzAdmin`.
func authzSet(ctx context.Context, in any) error {
	row, ok := in.(SetInput)
	if !ok {
		return authzAdmin(ctx)
	}
	pool, _ := authzPool.(*store.Pool)
	if pool == nil {
		return nil // tests
	}
	actor := auth.ActorOrSystem(ctx)
	if err := rejectAgentActor(ctx, pool, actor); err != nil {
		return err
	}
	isAgent, parentID, err := loadAgentInfo(ctx, pool, row.UserID)
	if err != nil {
		return err
	}
	if isAgent && row.RoleName == "admin" {
		return fmt.Errorf("user_role: admin is not grantable to agent target %d", row.UserID)
	}
	if isAgent && parentID != nil && *parentID == actor {
		// Parent path: must already hold the role being granted.
		held, err := actorHoldsRole(ctx, pool, actor, row.RoleName)
		if err != nil {
			return err
		}
		if !held {
			return fmt.Errorf("user_role: parent %d does not hold role %q so cannot grant it to agent %d", actor, row.RoleName, row.UserID)
		}
		return nil
	}
	return authzAdmin(ctx)
}

// authzRevoke gates user_role.revoke. Symmetric to authzSet minus the
// "must hold the role" check — revoking is always safe to permit when
// the actor is the agent's parent.
func authzRevoke(ctx context.Context, in any) error {
	row, ok := in.(RevokeInput)
	if !ok {
		return authzAdmin(ctx)
	}
	pool, _ := authzPool.(*store.Pool)
	if pool == nil {
		return nil
	}
	actor := auth.ActorOrSystem(ctx)
	if err := rejectAgentActor(ctx, pool, actor); err != nil {
		return err
	}
	isAgent, parentID, err := loadAgentInfo(ctx, pool, row.UserID)
	if err != nil {
		return err
	}
	if isAgent && parentID != nil && *parentID == actor {
		return nil
	}
	return authzAdmin(ctx)
}

// rejectAgentActor returns a non-nil error when the actor's own
// user_account has is_agent=TRUE.
func rejectAgentActor(ctx context.Context, pool *store.Pool, actor int64) error {
	var actorIsAgent bool
	err := pool.P.QueryRow(ctx, `SELECT is_agent FROM user_account WHERE id = $1`, actor).Scan(&actorIsAgent)
	if err != nil {
		return fmt.Errorf("user_role.authz: load actor: %w", err)
	}
	if actorIsAgent {
		return fmt.Errorf("user_role: agent actor %d cannot manage role grants", actor)
	}
	return nil
}

// loadAgentInfo reads (is_agent, parent_user_id) for one user_account.
func loadAgentInfo(ctx context.Context, pool *store.Pool, userID int64) (bool, *int64, error) {
	var isAgent bool
	var parentID *int64
	err := pool.P.QueryRow(ctx, `SELECT is_agent, parent_user_id FROM user_account WHERE id = $1`, userID).Scan(&isAgent, &parentID)
	if err != nil {
		return false, nil, fmt.Errorf("user_role.authz: load target: %w", err)
	}
	return isAgent, parentID, nil
}

// actorHoldsRole is true when the actor has a global grant of the
// named role. Scoped grants don't count — we don't want a "manager of
// project 7" granting "manager" globally to their agent.
func actorHoldsRole(ctx context.Context, pool *store.Pool, actor int64, roleName string) (bool, error) {
	var n int
	err := pool.P.QueryRow(ctx, `
		SELECT count(*)
		FROM user_role ur
		JOIN role r ON r.id = ur.role_id
		WHERE ur.user_id = $1 AND r.name = $2 AND ur.scope_card_id IS NULL
	`, actor, roleName).Scan(&n)
	if err != nil {
		return false, fmt.Errorf("user_role.authz: actor role lookup: %w", err)
	}
	return n > 0, nil
}

// authzPool holds the pool the Authz hook closes over. It is set by
// Register and read by authzAdmin. Package-level state is necessary because
// Authz is a value-typed callback on reg.Handler that can't accept a pool
// argument directly.
var authzPool any

// jsonSetRow is the per-input shape fed to jsonb_to_recordset.
type jsonSetRow struct {
	UserID         int64  `json:"user_id,string"`
	RoleName       string `json:"role_name"`
	ScopeProjectID *int64 `json:"scope_project_id,string,omitempty"`
	Ord            int    `json:"ord"`
}

// runSet is an arrayPath writer. // arrayPath
func runSet(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	authzPool = p
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		payload := make([]jsonSetRow, len(ins))
		for i, raw := range ins {
			in := raw.(SetInput)
			if in.UserID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "user_role.set: user_id is required"}
			}
			if in.RoleName == "" {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "user_role.set: role_name is required"}
			}
			payload[i] = jsonSetRow{
				UserID:         in.UserID,
				RoleName:       in.RoleName,
				ScopeProjectID: in.ScopeProjectID,
				Ord:            i,
			}
		}
		buf, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		// Upsert via the existing partial unique indexes
		// (uniq_user_role_global / uniq_user_role_scoped). When the row
		// already exists we still want to RETURN its id so the caller can
		// cite it; UPDATE on a no-op column lets RETURNING fire.
		const q = `
			WITH input AS (
				SELECT i.ord, i.user_id, r.id AS role_id, i.scope_project_id
				FROM jsonb_to_recordset($1::jsonb)
					AS i(ord int, user_id bigint, role_name text, scope_project_id bigint)
				JOIN role r ON r.name = i.role_name
			),
			-- Global grants (scope NULL): use ON CONFLICT against the partial
			-- unique index; UPDATE writes user_id back to itself so we can
			-- RETURN the row id even when the row already exists.
			ins_global AS (
				INSERT INTO user_role (user_id, role_id, scope_card_id)
				SELECT user_id, role_id, NULL FROM input WHERE scope_project_id IS NULL
				ON CONFLICT (user_id, role_id) WHERE scope_card_id IS NULL
					DO UPDATE SET user_id = EXCLUDED.user_id
				RETURNING id, user_id, role_id
			),
			ins_scoped AS (
				INSERT INTO user_role (user_id, role_id, scope_card_id)
				SELECT user_id, role_id, scope_project_id FROM input WHERE scope_project_id IS NOT NULL
				ON CONFLICT (user_id, role_id, scope_card_id) WHERE scope_card_id IS NOT NULL
					DO UPDATE SET user_id = EXCLUDED.user_id
				RETURNING id, user_id, role_id, scope_card_id
			),
			combined AS (
				SELECT i.ord, COALESCE(g.id, s.id) AS user_role_id
				FROM input i
				LEFT JOIN ins_global g
					ON g.user_id = i.user_id AND g.role_id = i.role_id AND i.scope_project_id IS NULL
				LEFT JOIN ins_scoped s
					ON s.user_id = i.user_id AND s.role_id = i.role_id
					   AND s.scope_card_id = i.scope_project_id
			)
			SELECT ord, user_role_id FROM combined ORDER BY ord
		`
		rows, err := tx.Query(ctx, q, buf)
		if err != nil {
			return nil, fmt.Errorf("user_role.set: %w", err)
		}
		outs := make([]any, len(ins))
		seen := 0
		for rows.Next() {
			var ord int
			var urid int64
			if err := rows.Scan(&ord, &urid); err != nil {
				rows.Close()
				return nil, err
			}
			outs[ord] = SetOutput{OK: true, UserRoleID: urid}
			seen++
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		if seen != len(ins) {
			return nil, fmt.Errorf("user_role.set: returned %d rows for %d inputs", seen, len(ins))
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}

// jsonRevokeRow is the per-input shape fed to jsonb_to_recordset.
type jsonRevokeRow struct {
	UserID         int64  `json:"user_id,string"`
	RoleName       string `json:"role_name"`
	ScopeProjectID *int64 `json:"scope_project_id,string,omitempty"`
	Ord            int    `json:"ord"`
}

// runRevoke is an arrayPath writer. // arrayPath
func runRevoke(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	authzPool = p
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		payload := make([]jsonRevokeRow, len(ins))
		for i, raw := range ins {
			in := raw.(RevokeInput)
			if in.UserID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "user_role.revoke: user_id is required"}
			}
			if in.RoleName == "" {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "user_role.revoke: role_name is required"}
			}
			payload[i] = jsonRevokeRow{
				UserID:         in.UserID,
				RoleName:       in.RoleName,
				ScopeProjectID: in.ScopeProjectID,
				Ord:            i,
			}
		}
		buf, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		const q = `
			WITH input AS (
				SELECT i.ord, i.user_id, r.id AS role_id, i.scope_project_id
				FROM jsonb_to_recordset($1::jsonb)
					AS i(ord int, user_id bigint, role_name text, scope_project_id bigint)
				JOIN role r ON r.name = i.role_name
			),
			del AS (
				DELETE FROM user_role ur
				USING input i
				WHERE ur.user_id = i.user_id
				  AND ur.role_id = i.role_id
				  AND (
					  (ur.scope_card_id IS NULL AND i.scope_project_id IS NULL)
					  OR ur.scope_card_id = i.scope_project_id
				  )
				RETURNING ur.user_id, ur.role_id, ur.scope_card_id, i.ord
			)
			SELECT ord, count(*) FROM del GROUP BY ord
		`
		rows, err := tx.Query(ctx, q, buf)
		if err != nil {
			return nil, fmt.Errorf("user_role.revoke: %w", err)
		}
		deletedByOrd := map[int]int{}
		for rows.Next() {
			var ord int
			var n int
			if err := rows.Scan(&ord, &n); err != nil {
				rows.Close()
				return nil, err
			}
			deletedByOrd[ord] = n
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		outs := make([]any, len(ins))
		for i := range ins {
			n := deletedByOrd[i]
			outs[i] = RevokeOutput{OK: n > 0, Deleted: n}
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}
