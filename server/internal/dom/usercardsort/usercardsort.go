// Package usercardsort holds user_card_sort.set — the canonical writer for
// the per-user inbox ordering. Each user keeps their own sort_order on
// every card they touch; this is intentionally distinct from the global
// `attributes.sort_order` the kanban uses (see migration 0008), which is
// shared across users.
//
// Authz: a user may only write their own row. The user_id used is
// `auth.ActorOrSystem(ctx)` — the caller never supplies it. (When OIDC
// lands in Phase 20, the actor id flows from the verified subject claim;
// in dev mode it falls back to the System User.)
//
// Coalescing: N user_card_sort.set sub-requests in one batch produce ONE
// SQL statement-group. The unified PL/pgSQL function ingests the JSONB
// array of (card_id, sort_order) tuples and upserts every row in one
// pass — see db/schema/functions/user_card_sort_set_batch.sql.
package usercardsort

import (
	"context"
	"reflect"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

// SetInput is one row of user_card_sort.set. The user_id is implicit: it
// is always the calling actor (auth.ActorOrSystem). Callers pick the
// midpoint between neighbours when computing SortOrder; the server stores
// it verbatim.
type SetInput struct {
	CardID    int64   `json:"card_id,string" mcp:"required,desc=card to reorder"`
	SortOrder float64 `json:"sort_order" mcp:"required,desc=new sort order — caller picks midpoint between neighbours"`
}

// SetOutput is a tiny ack — the per-user ordering is opaque to clients
// beyond the inbox.select read.
type SetOutput struct {
	OK bool `json:"ok" mcp:"desc=true on successful upsert"`
}

// Register installs the handler.
func Register(_ *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "user_card_sort",
		Action:       "set",
		Doc:          "Upsert the calling user's personal sort_order for one card. Used by the inbox drag-drop reorder; per-user ordering is independent of the global sort_order attribute.",
		InputType:    reflect.TypeFor[SetInput](),
		OutputType:   reflect.TypeFor[SetOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "user_card_sort.set",
		CardTypeID:   cardTypeFromInput,
		// Unified handler — body lives in
		// db/schema/functions/user_card_sort_set_batch.sql. See
		// docs/UNIFIED_HANDLER_PLAN.md Phase 2.
		SQLFunc: "user_card_sort_set_batch",
	})
}

// cardTypeFromInput resolves the card_type_id of the targeted card so the
// dispatcher can authorize (card_type, process). Inbox writes always target
// task cards in practice; we look it up rather than hard-coding so a future
// "drag a milestone in your personal view" works without a code change.
func cardTypeFromInput(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	return schema.CardTypeIDByCardID(ctx, pool, raw.(SetInput).CardID)
}
