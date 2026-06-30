// Package card — `card.search` is the lightweight typeahead read used by
// the value-picker UI (Combobox dropdown for ref:* attributes). Returns
// only `(id, title)` for each match — no LATERAL attribute join — so it
// stays cheap as the picker fires per keystroke.
//
// Filter shape:
//   - card_type_name (required) — caller knows the target type from the
//     attribute_def's value_type (`ref:<card_type>`).
//   - query — case-insensitive substring on title (accelerated by the
//     `attribute_value_trgm` GIN index for >=3-char inputs). If the
//     query parses as a positive integer, an OR-arm matches `card.id`
//     exactly — typing "42" surfaces task #42 alongside any title that
//     happens to contain "42". Empty means "no substring filter".
//   - ids — explicit id list. Used by callers that need to resolve a
//     label for an already-set value (e.g. the trigger button label
//     before the user opens the dropdown).
//
// Results are ordered by `created_at DESC` so the empty-query case
// (the just-opened picker) shows recently-created cards first — that's
// usually what's relevant for related-task pickers. Typed queries keep
// the same ordering for consistency.
//
// All filters AND together; soft-deleted rows are excluded.
package card

import (
	"reflect"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// SearchInput is the wire shape.
type SearchInput struct {
	CardTypeName string  `json:"card_type_name" mcp:"required,desc=card_type to search within"`
	Query        string  `json:"query,omitempty" mcp:"desc=case-insensitive substring match on title"`
	IDs          reg.IDs `json:"ids,omitempty" mcp:"desc=optional explicit id filter; combined with query via AND"`
	Limit        *int    `json:"limit,omitempty" mcp:"desc=optional row limit (default 50, capped at 200)"`
	// ParentCardID restricts results to cards whose parent_card_id
	// equals this value. Used by ref:* picker dropdowns to keep the
	// typeahead in the same project as the editing task — matches the
	// per-project reference scoping enforced on the write side.
	ParentCardID *int64 `json:"parent_card_id,string,omitempty" mcp:"desc=optional parent card id filter; used by per-project picker scoping"`
	// ExcludeTerminal drops cards whose `status` value-card is in the
	// terminal phase (i.e. keeps only triage/active "open" work). Used by
	// the subtask parent/child picker so done tasks don't crowd the
	// recency-capped list. A card with no `status` attribute (most non-task
	// types) is unaffected.
	ExcludeTerminal bool `json:"exclude_terminal,omitempty" mcp:"desc=if true, drop cards whose status value-card is terminal (keep only open triage/active work)"`
}

// SearchHit is one result row.
type SearchHit struct {
	ID    int64  `json:"id,string" mcp:"desc=card id"`
	Title string `json:"title" mcp:"desc=current title attribute value"`
}

// SearchOutput wraps the hits.
type SearchOutput struct {
	Rows []SearchHit `json:"rows" mcp:"desc=matching cards, ordered by created_at DESC"`
}

// RegisterSearch installs the card.search handler. Called by Register in
// card.go alongside the other endpoints.
//
// The body lives in db/schema/functions/card_search_batch.sql; the
// numericIDFromQuery / nullableString / nullableInt64Array helpers
// from the legacy Go-side body are now inlined as PL/pgSQL gates.
func RegisterSearch(p *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "card",
		Action:       "search",
		Doc:          "Lightweight typeahead read for ref:* picker dropdowns. Returns (id, title) of cards in card_type_name that match query (substring) and/or ids.",
		InputType:    reflect.TypeFor[SearchInput](),
		OutputType:   reflect.TypeFor[SearchOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		// Unified handler — body lives in
		// db/schema/functions/card_search_batch.sql.
		SQLFunc: "card_search_batch",
	})
}
