// Package usercardagent exposes user_card_agent.{set, clear, list} —
// the per-(user, card) routing of a task to one of the user's own
// agents. Same shape as user_card_sort.set (PK (user_id, card_id))
// but the payload is a bigint agent_user_id instead of a float
// sort_order.
//
// Authz: a user may only manage their OWN row. user_id is stamped
// from ctx (auth.ActorOrSystem) — callers never supply it. Set also
// validates that agent_user_id names an agent owned by the actor
// (parent_user_id = actor AND is_agent = true), so the routing graph
// stays strictly within the parent's tree of agents.
//
// Coalescing: N sub-requests in one batch produce one statement-group
// per action. set / clear / list are all unified PL/pgSQL functions
// (db/schema/functions/user_card_agent_{set,unset,list}_batch.sql).
package usercardagent

import (
	"context"
	"reflect"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

// SetInput is one row of user_card_agent.set. user_id is implicit —
// always the calling actor. agent_user_id must be one of the actor's
// own agents (parent_user_id = actor, is_agent = true).
type SetInput struct {
	CardID      int64 `json:"card_id,string" mcp:"required,desc=card to route"`
	AgentUserID int64 `json:"agent_user_id,string" mcp:"required,desc=user_account id of one of the calling user's own agents"`
}

// SetOutput is a tiny ack.
type SetOutput struct {
	OK bool `json:"ok" mcp:"desc=true on successful upsert"`
}

// ClearInput removes the routing for one card. user_id is implicit.
type ClearInput struct {
	CardID int64 `json:"card_id,string" mcp:"required,desc=card whose routing to clear"`
}

// ClearOutput reports whether a routing row was actually removed.
type ClearOutput struct {
	OK      bool `json:"ok" mcp:"desc=true if a routing row was deleted by this call"`
	Deleted int  `json:"deleted" mcp:"desc=number of rows deleted (0 or 1)"`
}

// ListInput selects every card the calling user has routed.
// Currently no filter args — the typical use is "all my routings"
// rendered in the parent's task UI. Optional ParentCardID lets the
// caller scope to one project.
type ListInput struct {
	ParentCardID *int64 `json:"parent_card_id,string,omitempty" mcp:"desc=optional project (or other parent) id; when set, only routings whose target card sits under this parent are returned"`
}

// ListRow is one routing record.
type ListRow struct {
	CardID      int64  `json:"card_id,string" mcp:"desc=routed card id"`
	AgentUserID int64  `json:"agent_user_id,string" mcp:"desc=user_account id of the agent the card is routed to"`
	CreatedAt   string `json:"created_at" mcp:"desc=RFC3339 timestamp when the routing was set"`
}

// ListOutput wraps the row list.
type ListOutput struct {
	Rows []ListRow `json:"rows" mcp:"desc=routings owned by the calling user, in created_at DESC order"`
}

// Register installs all three handlers.
func Register(_ *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "user_card_agent",
		Action:       "set",
		Doc:          "Route a card to one of the calling user's agents. Upsert keyed on (actor, card). The agent_user_id must be an agent owned by the calling user.",
		InputType:    reflect.TypeFor[SetInput](),
		OutputType:   reflect.TypeFor[SetOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "user_card_sort.set", // shares the routing/reorder process bucket
		CardTypeID:   cardTypeFromSet,
		// Unified handler — body lives in
		// db/schema/functions/user_card_agent_set_batch.sql. See
		// docs/UNIFIED_HANDLER_PLAN.md Phase 2.
		SQLFunc: "user_card_agent_set_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "user_card_agent",
		Action:       "clear",
		Doc:          "Remove the calling user's routing for one card. Idempotent.",
		InputType:    reflect.TypeFor[ClearInput](),
		OutputType:   reflect.TypeFor[ClearOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "user_card_sort.set",
		CardTypeID:   cardTypeFromClear,
		// Unified handler — body lives in
		// db/schema/functions/user_card_agent_unset_batch.sql.
		// (SQL function name is `unset` per the Phase 2 task list;
		// the Go-side action stays `clear` for wire compatibility.)
		SQLFunc: "user_card_agent_unset_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "user_card_agent",
		Action:       "list",
		Doc:          "List the calling user's routings, optionally scoped to one parent (e.g. a project).",
		InputType:    reflect.TypeFor[ListInput](),
		OutputType:   reflect.TypeFor[ListOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		// Unified handler — body lives in
		// db/schema/functions/user_card_agent_list_batch.sql per Phase
		// 5 of docs/UNIFIED_HANDLER_PLAN.md. actor_id is wired by the
		// dispatcher from auth.ActorOrSystem(ctx); the function scopes
		// the result rows to that actor (legacy behaviour).
		SQLFunc: "user_card_agent_list_batch",
	})
}

func cardTypeFromSet(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	return schema.CardTypeIDByCardID(ctx, pool, raw.(SetInput).CardID)
}

func cardTypeFromClear(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	return schema.CardTypeIDByCardID(ctx, pool, raw.(ClearInput).CardID)
}


