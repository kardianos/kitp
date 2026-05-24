// Package tag implements tag.apply / tag.remove. Tags are CARDs of
// type 'tag' with two built-in attributes: 'path' (slash-delimited) and
// 'root_exclusive_at' (the prefix at which the tag is mutually exclusive
// with sibling tags). Applying/removing a tag mutates the target card's
// 'tags' attribute (a jsonb array of tag card ids).
//
// Both handlers are unified PL/pgSQL functions per Phase 2 of
// docs/UNIFIED_HANDLER_PLAN.md — bodies live in
// db/schema/functions/tag_apply_batch.sql and tag_remove_batch.sql.
// All validation (target / tag existence, edge, project scope) and the
// mutually-exclusive sibling-tag removal happen inside the same
// transaction as the activity_value upsert.
package tag

import (
	"context"
	"reflect"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

// ApplyInput is one (target, tag) pair to apply.
type ApplyInput struct {
	TargetCardID int64 `json:"target_card_id,string" mcp:"required,desc=id of the card receiving the tag"`
	TagCardID    int64 `json:"tag_card_id,string" mcp:"required,desc=id of the tag card to apply"`
}

// ApplyOutput acknowledges success.
type ApplyOutput struct {
	OK            bool    `json:"ok" mcp:"desc=true on success"`
	ActivityID    int64   `json:"activity_id,string" mcp:"desc=id of the activity row recording the apply"`
	RemovedTagIDs reg.IDs `json:"removed_tag_ids,omitempty" mcp:"desc=ids of sibling tags removed by mutual exclusion"`
}

// RemoveInput is one (target, tag) pair to remove.
type RemoveInput struct {
	TargetCardID int64 `json:"target_card_id,string" mcp:"required,desc=id of the card to remove the tag from"`
	TagCardID    int64 `json:"tag_card_id,string" mcp:"required,desc=id of the tag card to remove"`
}

// RemoveOutput acknowledges success.
type RemoveOutput struct {
	OK         bool  `json:"ok" mcp:"desc=true on success"`
	ActivityID int64 `json:"activity_id,string" mcp:"desc=id of the activity row recording the removal"`
}

// Register installs tag.apply and tag.remove. The `_ *store.Pool` arg
// is preserved for call-site symmetry with the other domain Register
// functions; the unified path observes writes via the dispatcher.
func Register(_ *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "tag",
		Action:       "apply",
		Doc:          "Apply a tag card to a target card; mutually-exclusive sibling tags at the same root are removed atomically.",
		InputType:    reflect.TypeFor[ApplyInput](),
		OutputType:   reflect.TypeFor[ApplyOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "card.update",
		CardTypeID:   cardTypeFromApplyInput,
		// Unified handler — body lives in
		// db/schema/functions/tag_apply_batch.sql. The function enforces
		// the mutual-exclusion rule in the same tx as the upsert.
		SQLFunc: "tag_apply_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "tag",
		Action:       "remove",
		Doc:          "Remove a tag card from a target card.",
		InputType:    reflect.TypeFor[RemoveInput](),
		OutputType:   reflect.TypeFor[RemoveOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "card.update",
		CardTypeID:   cardTypeFromRemoveInput,
		// Unified handler — body lives in
		// db/schema/functions/tag_remove_batch.sql.
		SQLFunc: "tag_remove_batch",
	})
}

// cardTypeFromApplyInput resolves the target card's card_type so the
// dispatcher can match it against the actor's scoped grants. Both
// tag.apply and tag.remove gate on `card.update` against the target
// card (NOT the tag card) — the actor needs write access to whatever
// they're tagging, not to the tag definition itself.
func cardTypeFromApplyInput(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	return schema.CardTypeIDByCardID(ctx, pool, raw.(ApplyInput).TargetCardID)
}

func cardTypeFromRemoveInput(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	return schema.CardTypeIDByCardID(ctx, pool, raw.(RemoveInput).TargetCardID)
}
