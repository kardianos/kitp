// File card/merge.go: card.merge — fold duplicate cards of the same card_type
// into a survivor. Unified handler; body lives in
// db/schema/functions/card_merge_batch.sql (which calls the shared
// card_merge_into primitive). The person-specific merge (user_account_person
// reconciliation) is person.merge in the user/person package, sharing the same
// primitive.
package card

import (
	"context"
	"reflect"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

// MergeInput folds the loser cards into the survivor. Loser ids are carried as
// strings (the wire convention for bigint ids; an array can't use `,string`
// per-element), and the SQL accepts numeric strings or numbers.
type MergeInput struct {
	SurvivorID int64    `json:"survivor_id,string" mcp:"required,desc=id of the card that survives the merge"`
	LoserIDs   []string `json:"loser_ids" mcp:"required,desc=ids of duplicate cards (same card_type as the survivor) to fold into it; every reference is repointed to the survivor and the losers are soft-deleted"`
}

// MergeOutput reports the survivor and how much was moved.
type MergeOutput struct {
	OK          bool  `json:"ok" mcp:"desc=true on success"`
	SurvivorID  int64 `json:"survivor_id,string" mcp:"desc=the surviving card id"`
	MergedCount int   `json:"merged_count" mcp:"desc=number of loser cards folded in"`
	Repointed   int   `json:"repointed" mcp:"desc=number of attribute_value rows repointed to the survivor"`
}

// RegisterMerge installs card.merge. Gated to manager/admin: merging rewrites
// references across the graph + soft-deletes cards, so it's a curation-tier op,
// not a worker one. CardTypeID resolves from the survivor so the (card_type,
// process) grant check is anchored to a real project/type.
func RegisterMerge(p *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "card",
		Action:       "merge",
		Doc:          "Fold one or more duplicate cards of the same card_type into a survivor: repoint every card_ref / card_ref[] reference to the survivor and soft-delete the losers. For deduplicating value cards (milestones / components / tags) and, via person.merge, people.",
		InputType:    reflect.TypeFor[MergeInput](),
		OutputType:   reflect.TypeFor[MergeOutput](),
		AllowedRoles: []string{"manager", "admin"},
		ProcessName:  "card.delete",
		CardTypeID:   cardTypeFromMergeInput,
		// MergeInput has no plain card_id field, so the dispatcher can't reflect
		// the card to scope-check against — point it at the survivor (BE-H3 / A2).
		ScopeCardID: scopeCardFromMergeInput,
		// Unified handler — body lives in db/schema/functions/card_merge_batch.sql.
		SQLFunc: "card_merge_batch",
	})
}

func cardTypeFromMergeInput(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	return schema.CardTypeIDByCardID(ctx, pool, raw.(MergeInput).SurvivorID)
}

func scopeCardFromMergeInput(_ context.Context, _ reg.ValidationPool, raw any) (int64, error) {
	return raw.(MergeInput).SurvivorID, nil
}
