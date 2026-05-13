// Package agent exposes the agent lifecycle handlers — agent.create and
// agent.delete. Agents are first-class user_account rows with
// parent_user_id pointing at their parent and is_agent=true. They are
// NOT assignable through the normal assignee picker; instead a parent
// routes one of their own tasks to one of their own agents via
// user_card_agent (separate per-(parent-user, card) slot).
//
// Authz model:
//   - agent.create: actor must NOT be an agent. The new agent's
//     parent_user_id is set to the actor's id — every user can create
//     agents under themselves. (The wider escalation guard sits in
//     user_role.set: admin is never grantable to agents.)
//   - agent.delete: actor must NOT be an agent. Actor must be the
//     target's parent_user_id OR a global admin. user_account ON DELETE
//     CASCADE wipes session, user_token, user_card_agent, and
//     user_card_sort rows automatically.
//
// Role-grant and token mint flows are NOT here. user_role.set already
// implements the parent-grants-subset-of-own-roles rule; user_token.*
// lives in its own package (#45).
package agent

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

// CreateInput is one row of agent.create.
type CreateInput struct {
	DisplayName string `json:"display_name" mcp:"required,desc=display name shown in the UI and on activity rows"`
}

// CreateOutput identifies the freshly-minted agent. Agents have no
// person card and never appear in the assignee picker; the parent
// routes tasks to them via user_card_agent.set.
type CreateOutput struct {
	UserID int64 `json:"user_id,string" mcp:"desc=user_account id for the new agent"`
}

// DeleteInput is one row of agent.delete.
type DeleteInput struct {
	UserID int64 `json:"user_id,string" mcp:"required,desc=user_account id of the agent to remove"`
}

// DeleteOutput acknowledges; reports whether a row actually went away.
type DeleteOutput struct {
	OK      bool `json:"ok" mcp:"desc=true when the agent was deleted"`
	Deleted int  `json:"deleted" mcp:"desc=number of user_account rows removed (0 or 1)"`
}

// Register wires both handlers.
func Register(p *store.Pool) {
	authzPool = p
	reg.Register(reg.Handler{
		Endpoint:     "agent",
		Action:       "create",
		Doc:          "Create an agent owned by the calling user. Inserts a user_account row (is_agent=true, parent_user_id=actor). Agents are NOT assignable through the assignee picker; the parent routes tasks to them via user_card_agent.set. Rejects when the actor is itself an agent.",
		InputType:    reflect.TypeFor[CreateInput](),
		OutputType:   reflect.TypeFor[CreateOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Authz:        authzCreate,
		Run:          runCreate(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "agent",
		Action:       "delete",
		Doc:          "Delete an agent owned by the calling user (or by any admin). Cascades sessions, tokens, and user_card_agent rows. Rejects when the actor is itself an agent.",
		InputType:    reflect.TypeFor[DeleteInput](),
		OutputType:   reflect.TypeFor[DeleteOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Authz:        authzDelete,
		Run:          runDelete(p),
	})
}

// authzPool holds the pool the Authz hook closes over. Set by Register.
var authzPool any

// authzCreate: actor must not be an agent. No admin requirement —
// any signed-in user can spawn agents under themselves.
func authzCreate(ctx context.Context, _ any) error {
	pool, _ := authzPool.(*store.Pool)
	if pool == nil {
		return nil // tests
	}
	return rejectAgentActor(ctx, pool, auth.ActorOrSystem(ctx))
}

// authzDelete: actor must not be an agent AND must be either the
// target's parent_user_id or a global admin.
func authzDelete(ctx context.Context, in any) error {
	row, ok := in.(DeleteInput)
	if !ok {
		return nil
	}
	pool, _ := authzPool.(*store.Pool)
	if pool == nil {
		return nil
	}
	actor := auth.ActorOrSystem(ctx)
	if err := rejectAgentActor(ctx, pool, actor); err != nil {
		return err
	}
	var isAgent bool
	var parentID *int64
	err := pool.P.QueryRow(ctx,
		`SELECT is_agent, parent_user_id FROM user_account WHERE id = $1`,
		row.UserID,
	).Scan(&isAgent, &parentID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return &reg.HandlerError{Code: "not_found",
				Message: fmt.Sprintf("agent.delete: user %d not found", row.UserID)}
		}
		return fmt.Errorf("agent.delete: lookup target: %w", err)
	}
	if !isAgent {
		return &reg.HandlerError{Code: "validation",
			Message: fmt.Sprintf("agent.delete: user %d is not an agent", row.UserID)}
	}
	if parentID != nil && *parentID == actor {
		return nil
	}
	// Fall back to global admin check.
	var n int
	row2 := pool.P.QueryRow(ctx, `
		SELECT count(*) FROM user_role ur JOIN role r ON r.id = ur.role_id
		WHERE ur.user_id = $1 AND r.name IN ('admin','system') AND ur.scope_card_id IS NULL
	`, actor)
	if err := row2.Scan(&n); err != nil {
		return fmt.Errorf("agent.delete: admin check: %w", err)
	}
	if n == 0 {
		return &reg.HandlerError{Code: "forbidden",
			Message: fmt.Sprintf("agent.delete: actor %d is not the parent of agent %d nor a global admin", actor, row.UserID)}
	}
	return nil
}

// rejectAgentActor returns a non-nil error when the actor itself is an
// agent. Agents cannot manage the agent lifecycle (mirrors the gate in
// userrole package).
func rejectAgentActor(ctx context.Context, pool *store.Pool, actor int64) error {
	var actorIsAgent bool
	err := pool.P.QueryRow(ctx,
		`SELECT is_agent FROM user_account WHERE id = $1`,
		actor,
	).Scan(&actorIsAgent)
	if err != nil {
		return fmt.Errorf("agent.authz: load actor: %w", err)
	}
	if actorIsAgent {
		return &reg.HandlerError{Code: "forbidden",
			Message: fmt.Sprintf("agent: agent actor %d cannot manage the agent lifecycle", actor)}
	}
	return nil
}

// runCreate inserts one user_account row per input. Agents have no
// person card — they are routed-to via user_card_agent, not via the
// assignee attribute — so this is a single INSERT … RETURNING with
// ord preserved through the input json.
func runCreate(_ *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		actorID := auth.ActorOrSystem(ctx)
		type jsonRow struct {
			Ord         int    `json:"ord"`
			DisplayName string `json:"display_name"`
		}
		payload := make([]jsonRow, len(ins))
		for i, raw := range ins {
			in := raw.(CreateInput)
			payload[i] = jsonRow{Ord: i, DisplayName: in.DisplayName}
		}
		buf, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		const q = `
			WITH input AS (
				SELECT ord, display_name FROM jsonb_to_recordset($1::jsonb)
				AS x(ord int, display_name text)
			),
			ins_user AS (
				INSERT INTO user_account (display_name, parent_user_id, is_agent)
				SELECT display_name, $2, TRUE FROM input ORDER BY ord
				RETURNING id, display_name
			),
			user_numbered AS (
				SELECT id, row_number() OVER (ORDER BY id) AS rn FROM ins_user
			),
			input_numbered AS (
				SELECT ord, row_number() OVER (ORDER BY ord) AS rn FROM input
			)
			SELECT i.ord, u.id
			FROM input_numbered i JOIN user_numbered u ON u.rn = i.rn
			ORDER BY i.ord
		`
		rows, err := tx.Query(ctx, q, buf, actorID)
		if err != nil {
			return nil, fmt.Errorf("agent.create: %w", err)
		}
		defer rows.Close()
		outs := make([]any, len(ins))
		for rows.Next() {
			var ord int
			var userID int64
			if err := rows.Scan(&ord, &userID); err != nil {
				return nil, err
			}
			if ord < 0 || ord >= len(ins) {
				return nil, fmt.Errorf("agent.create: ord %d out of range", ord)
			}
			outs[ord] = CreateOutput{UserID: userID}
		}
		return outs, rows.Err()
	}
}

// runDelete removes agent user_account rows. Cascade wipes session,
// user_token, user_card_agent, and user_card_sort. We null out
// attribute_value.last_activity_id and clear activity rows whose
// actor_id points at any deleted agent — those FKs are NO ACTION and
// would otherwise block the user_account delete.
//
// Order:
//   1. Null attribute_value.last_activity_id for activity rows we are
//      about to remove (rows where the agent was the actor).
//   2. Delete activity rows where actor_id = any-agent.
//   3. Delete user_account (gated on is_agent=TRUE).
func runDelete(_ *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		ids := make([]int64, len(ins))
		for i, raw := range ins {
			ids[i] = raw.(DeleteInput).UserID
		}

		// 1. Null any attribute_value.last_activity_id pointing at
		//    activity rows we are about to delete. The column is
		//    nullable so this is safe — losing the last-actor pointer
		//    is a small price for being able to remove the agent.
		if _, err := tx.Exec(ctx, `
			UPDATE attribute_value SET last_activity_id = NULL
			WHERE last_activity_id IN (
				SELECT id FROM activity WHERE actor_id = ANY($1)
			)
		`, ids); err != nil {
			return nil, fmt.Errorf("agent.delete: null last_activity_id: %w", err)
		}

		// 2. Wipe activity rows where the agent was the actor.
		if _, err := tx.Exec(ctx, `
			DELETE FROM activity WHERE actor_id = ANY($1)
		`, ids); err != nil {
			return nil, fmt.Errorf("agent.delete: clear activity: %w", err)
		}

		// 3. Delete user_account rows. Cascade clears session,
		//    user_token, user_card_agent (both sides), and
		//    user_card_sort. Gate on is_agent=TRUE so a stray id is
		//    reported as 0.
		delRows, err := tx.Query(ctx, `
			DELETE FROM user_account
			WHERE id = ANY($1) AND is_agent = TRUE
			RETURNING id
		`, ids)
		if err != nil {
			return nil, fmt.Errorf("agent.delete: delete user_account: %w", err)
		}
		deleted := map[int64]bool{}
		for delRows.Next() {
			var id int64
			if err := delRows.Scan(&id); err != nil {
				delRows.Close()
				return nil, err
			}
			deleted[id] = true
		}
		delRows.Close()
		if err := delRows.Err(); err != nil {
			return nil, err
		}

		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(DeleteInput)
			n := 0
			if deleted[in.UserID] {
				n = 1
			}
			outs[i] = DeleteOutput{OK: n > 0, Deleted: n}
		}
		return outs, nil
	}
}
