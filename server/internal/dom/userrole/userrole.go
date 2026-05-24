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
	"fmt"
	"os"
	"reflect"

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

// ListInput selects one user's grants by id.
type ListInput struct {
	UserID int64 `json:"user_id,string" mcp:"required,desc=user_account id whose role grants to list"`
}

// ListRow is one (role_name, scope) tuple held by the user.
type ListRow struct {
	RoleName       string `json:"role_name" mcp:"desc=role name"`
	ScopeProjectID *int64 `json:"scope_project_id,string,omitempty" mcp:"desc=optional project id for scoped grant; null = global"`
}

// ListOutput wraps the row set so the Go OutputType matches the unified
// shape every read uses.
type ListOutput struct {
	Rows []ListRow `json:"rows" mcp:"desc=role grants held by the requested user"`
}

// Register installs both handlers.
func Register(p *store.Pool) {
	authzPool = p
	reg.Register(reg.Handler{
		Endpoint:     "user_role",
		Action:       "set",
		Doc:          "Grant a role to a user, optionally scoped to a project. Admin-only EXCEPT when the target is an agent — then the agent's parent_user_id may also grant any non-admin role they hold themselves. Coalesces N inputs into one upsert statement.",
		InputType:    reflect.TypeFor[SetInput](),
		OutputType:   reflect.TypeFor[SetOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Authz:        authzSet,
		// Unified handler — body lives in
		// db/schema/functions/user_role_set_batch.sql per Phase 3 of
		// docs/UNIFIED_HANDLER_PLAN.md.
		SQLFunc: "user_role_set_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "user_role",
		Action:       "revoke",
		Doc:          "Revoke a role from a user (with matching scope). Admin-only EXCEPT when the target is an agent — then the agent's parent_user_id may also revoke.",
		InputType:    reflect.TypeFor[RevokeInput](),
		OutputType:   reflect.TypeFor[RevokeOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Authz:        authzRevoke,
		// Unified handler — body lives in
		// db/schema/functions/user_role_revoke_batch.sql per Phase 3
		// of docs/UNIFIED_HANDLER_PLAN.md.
		SQLFunc: "user_role_revoke_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "user_role",
		Action:       "list",
		Doc:          "List role grants held by one user. Anyone authenticated may query themselves; the parent of an agent may query that agent; admins may query anyone.",
		InputType:    reflect.TypeFor[ListInput](),
		OutputType:   reflect.TypeFor[ListOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Authz:        authzList,
		IsRead:       true,
		SQLFunc:      "user_role_list_batch",
	})
}

// authzList gates user_role.list. Allowed when the target is the actor
// themselves, an agent of the actor, or the actor is admin.
func authzList(ctx context.Context, in any) error {
	row, ok := in.(ListInput)
	if !ok {
		return authzAdmin(ctx)
	}
	pool := authzPool
	if pool == nil {
		return missingPoolDeny("list")
	}
	actor := auth.ActorOrSystem(ctx)
	if row.UserID == actor {
		return nil
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

// authzAdmin returns nil when the actor holds the `admin` or `system`
// role globally. Used as the fallback gate when the agent-parent path
// below doesn't apply.
func authzAdmin(ctx context.Context) error {
	pool := authzPool
	if pool == nil {
		return missingPoolDeny("authz")
	}
	userID := auth.ActorOrSystem(ctx)
	var n int
	row := pool.P.QueryRow(ctx, `
		SELECT count(*)
		FROM user_role ur
		JOIN role r ON r.id = ur.role_id
		WHERE ur.user_id = $1 AND r.name = 'admin' AND ur.scope_card_id IS NULL
	`, userID)
	if err := row.Scan(&n); err != nil {
		return fmt.Errorf("user_role.authz: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("user_role: actor %d is not an admin", userID)
	}
	return nil
}

// authzSet is the gate for user_role.set. Rules:
//
//  1. Actor must not itself be an agent (no self-bootstrapping; agents
//     cannot escalate themselves or their siblings).
//  2. If the target is an agent AND the actor is that agent's
//     parent_user_id, the grant is allowed unconditionally. Grants on
//     agents are "intent to delegate" — the runtime effective set is
//     intersected with the parent's current roles in
//     auth.LoadUserRoles, so an agent only USES a role when the parent
//     also holds it. Granting `admin` to an agent whose parent never
//     becomes admin is harmless (it's filtered out at every gate).
//  3. Otherwise, fall back to `authzAdmin`.
func authzSet(ctx context.Context, in any) error {
	row, ok := in.(SetInput)
	if !ok {
		return authzAdmin(ctx)
	}
	pool := authzPool
	if pool == nil {
		return missingPoolDeny("set")
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

// authzRevoke gates user_role.revoke. Symmetric to authzSet minus the
// "must hold the role" check — revoking is always safe to permit when
// the actor is the agent's parent.
func authzRevoke(ctx context.Context, in any) error {
	row, ok := in.(RevokeInput)
	if !ok {
		return authzAdmin(ctx)
	}
	pool := authzPool
	if pool == nil {
		return missingPoolDeny("revoke")
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

// authzPool holds the pool the Authz hooks close over. Set by Register
// and read by authzAdmin / authzSet / authzRevoke / authzList.
// Package-level state is necessary because Authz is a value-typed
// callback on reg.Handler that can't accept a pool argument directly.
//
// Strongly typed (*store.Pool, not `any`) so the nil-pool branch is the
// single explicit "no pool wired" case rather than a type-assertion
// fall-through that could silently fail open (SEC-7 / A6).
var authzPool *store.Pool

// missingPoolDeny returns the right answer when no pool is wired: a
// deny (fail CLOSED) in production, nil (fail open) in dev/test.
//
// In production every handler is registered with a real pool, so a nil
// authzPool means a wiring bug — denying is the safe response (SEC-7 /
// A6). In dev/test some suites exercise an Authz hook without calling
// Register (no pool bound); those keep the historical fail-open so they
// don't have to stand up a DB just to test unrelated logic. Tests that
// care about the authz outcome inject a real pool via Register /
// SetAuthzPoolForTest instead of relying on this branch.
func missingPoolDeny(hook string) error {
	if os.Getenv("ENV") == "production" {
		return fmt.Errorf("user_role.%s: no DB pool configured; refusing (fail closed)", hook)
	}
	return nil
}

