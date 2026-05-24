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
//
// Phase 3 of docs/UNIFIED_HANDLER_PLAN.md migrated both handlers to the
// unified PL/pgSQL shape — bodies live in
// db/schema/functions/agent_{create,delete}_batch.sql.
package agent

import (
	"context"
	"errors"
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
		SQLFunc:      "agent_create_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "agent",
		Action:       "delete",
		Doc:          "Delete an agent owned by the calling user (or by any admin). Cascades sessions, tokens, and user_card_agent rows. Rejects when the actor is itself an agent.",
		InputType:    reflect.TypeFor[DeleteInput](),
		OutputType:   reflect.TypeFor[DeleteOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Authz:        authzDelete,
		SQLFunc:      "agent_delete_batch",
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
		if errors.Is(err, pgx.ErrNoRows) {
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
		WHERE ur.user_id = $1 AND r.name = 'admin' AND ur.scope_card_id IS NULL
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
