// Package card — `card.search` is the lightweight typeahead read used by
// the value-picker UI (Combobox dropdown for ref:* attributes). Returns
// only `(id, title)` for each match — no LATERAL attribute join — so it
// stays cheap as the picker fires per keystroke.
//
// Filter shape:
//   - card_type_name (required) — caller knows the target type from the
//     attribute_def's value_type (`ref:<card_type>`).
//   - query — case-insensitive substring on title. Empty means "no
//     substring filter"; combined with limit this returns "top N".
//   - ids — explicit id list. Used by callers that need to resolve a
//     label for an already-set value (e.g. the trigger button label
//     before the user opens the dropdown).
//
// All filters AND together; soft-deleted rows are excluded.
package card

import (
	"context"
	"fmt"
	"reflect"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// SearchInput is the wire shape.
type SearchInput struct {
	CardTypeName string  `json:"card_type_name" mcp:"required,desc=card_type to search within"`
	Query        string  `json:"query,omitempty" mcp:"desc=case-insensitive substring match on title"`
	IDs          []int64 `json:"ids,omitempty" mcp:"desc=optional explicit id filter; combined with query via AND"`
	Limit        *int    `json:"limit,omitempty" mcp:"desc=optional row limit (default 50, capped at 200)"`
}

// SearchHit is one result row.
type SearchHit struct {
	ID    int64  `json:"id" mcp:"desc=card id"`
	Title string `json:"title" mcp:"desc=current title attribute value"`
}

// SearchOutput wraps the hits.
type SearchOutput struct {
	Rows []SearchHit `json:"rows" mcp:"desc=matching cards, ordered by title ASC"`
}

// RegisterSearch installs the card.search handler. Called by Register in
// card.go alongside the other endpoints.
func RegisterSearch(p *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "card",
		Action:       "search",
		Doc:          "Lightweight typeahead read for ref:* picker dropdowns. Returns (id, title) of cards in card_type_name that match query (substring) and/or ids.",
		InputType:    reflect.TypeFor[SearchInput](),
		OutputType:   reflect.TypeFor[SearchOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Run:          runSearch(p),
	})
}

func runSearch(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(SearchInput)
			if in.CardTypeName == "" {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "card.search: card_type_name is required"}
			}
			limit := 50
			if in.Limit != nil && *in.Limit > 0 {
				limit = min(*in.Limit, 200)
			}
			// Single parameterised query. Each filter is gated by an "is
			// the parameter set?" check so the same SQL handles every
			// combination of (query, ids) without branching in Go.
			rows, err := tx.Query(ctx, `
				SELECT c.id, COALESCE(av.value #>> '{}', '') AS title
				FROM card c
				JOIN card_type ct ON ct.id = c.card_type_id
				LEFT JOIN LATERAL (
					SELECT av.value
					FROM attribute_value av
					JOIN attribute_def ad ON ad.id = av.attribute_def_id
					WHERE av.card_id = c.id AND ad.name = 'title'
					LIMIT 1
				) av ON TRUE
				WHERE c.deleted_at IS NULL
				  AND ct.name = $1
				  AND ($2::text IS NULL OR av.value #>> '{}' ILIKE '%' || $2 || '%')
				  AND ($3::bigint[] IS NULL OR c.id = ANY($3))
				ORDER BY av.value #>> '{}' ASC NULLS LAST, c.id ASC
				LIMIT $4
			`,
				in.CardTypeName,
				nullableString(in.Query),
				nullableInt64Array(in.IDs),
				limit,
			)
			if err != nil {
				return nil, fmt.Errorf("card.search: %w", err)
			}
			var out []SearchHit
			for rows.Next() {
				var h SearchHit
				if err := rows.Scan(&h.ID, &h.Title); err != nil {
					rows.Close()
					return nil, err
				}
				out = append(out, h)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return nil, err
			}
			if p != nil {
				p.NoteRead()
			}
			outs[i] = SearchOutput{Rows: out}
		}
		return outs, nil
	}
}

// nullableString collapses an empty string to a SQL NULL so the
// `($N::text IS NULL OR …)` gate skips the substring match cleanly.
func nullableString(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// nullableInt64Array collapses an empty / nil slice to a SQL NULL so the
// `($N::bigint[] IS NULL OR …)` gate skips the id filter.
func nullableInt64Array(ids []int64) any {
	if len(ids) == 0 {
		return nil
	}
	return ids
}
