// Package inbox holds inbox.select — the per-user "open work assigned to
// me" read. The server applies the standard inbox predicate
// (`assignee = :user_id AND status != 'done'`) and a LEFT JOIN against
// user_card_sort so personal ordering wins when set, falling back to
// `created_at DESC` for cards the user has never reordered.
//
// This is intentionally a separate handler from card.select_with_attributes:
// the LATERAL personal-sort join is fundamental to the read shape, and
// pushing it into the generic LATERAL handler would force every grid/kanban
// query to LEFT JOIN user_card_sort even when it has nothing to do with
// the inbox. Keeping the handlers separate also keeps each one under the
// per-file size budget.
package inbox

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// SelectInput optionally accepts a UserID override (admin/feature-flag
// scoped). In the v1 dev mode we refuse a non-self UserID until OIDC +
// roles land in P9/P11 — so callers should leave it empty and let the
// handler default to the authenticated actor.
//
// Tree carries an optional v2 predicate-tree (the same shape used by
// card.select_with_attributes) so the client's FilterBar can layer extra
// "show me only X" constraints on top of the inbox's built-in
// `assignee = me AND status != done` predicate. The compiled SQL is
// AND-joined into the WHERE clause; the soft-delete / type / inbox
// constraints always hold.
type SelectInput struct {
	UserID *int64               `json:"user_id,omitempty" mcp:"desc=optional user override (defaults to caller)"`
	Tree   *card.CardWhereGroup `json:"tree,omitempty" mcp:"desc=optional v2 predicate-tree to layer on top of the inbox predicate"`
	Limit  *int32               `json:"limit,omitempty" mcp:"desc=row cap"`
	Offset *int32               `json:"offset,omitempty" mcp:"desc=offset"`
}

// Row mirrors the per-card shape of card.select_with_attributes so the
// inbox screen can reuse the existing CardWithAttrs renderer, with one
// extra field — the user's PersonalSort, which the screen needs to drive
// the drag-drop reorder.
type Row struct {
	ID           int64                      `json:"id" mcp:"desc=card id"`
	CardTypeID   int32                      `json:"card_type_id" mcp:"desc=card_type id"`
	ParentCardID *int64                     `json:"parent_card_id,omitempty" mcp:"desc=parent card id, if any"`
	Attributes   map[string]json.RawMessage `json:"attributes" mcp:"desc=current attribute values keyed by attribute_def name"`
	PersonalSort *float64                   `json:"personal_sort_order,omitempty" mcp:"desc=this user's personal sort_order, if any"`
}

// SelectOutput wraps the rows in a stable envelope. One Run -> one query
// per input slot, but in practice every batch sends a single inbox.select.
type SelectOutput struct {
	Rows []Row `json:"rows" mcp:"desc=inbox tasks ordered by personal_sort_order ASC NULLS LAST, then created_at DESC"`
}

// Register installs the handler.
func Register(p *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:   "inbox",
		Action:     "select",
		Doc:        "List the calling user's open inbox tasks, ordered by their personal sort_order with a created_at fallback.",
		InputType:  reflect.TypeFor[SelectInput](),
		OutputType: reflect.TypeFor[SelectOutput](),
		Authz:      authzSelect,
		Run:        runSelect(p),
	})
}

// authzSelect refuses cross-user reads until role-grants are wired in.
// A nil UserID (the common case) reads as "show me my own inbox" and is
// always allowed. Until OIDC lands in Phase 20, the System User
// (auth.SystemUserID = 1) is treated as "everyone" — it may impersonate
// any user_id so the dev-mode UI can render any team member's inbox
// from a single hardcoded actor. Any non-system caller may only view
// their own inbox.
func authzSelect(ctx context.Context, raw any) error {
	in := raw.(SelectInput)
	if in.UserID == nil {
		return nil
	}
	actor := auth.ActorOrSystem(ctx)
	if *in.UserID == actor {
		return nil
	}
	if actor == auth.SystemUserID {
		return nil // dev-mode impersonation; safe until real auth lands
	}
	return fmt.Errorf("inbox.select: user_id override (=%d) is not allowed for actor %d in dev mode",
		*in.UserID, actor)
}

func runSelect(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(SelectInput)
			userID := auth.ActorOrSystem(ctx)
			if in.UserID != nil {
				userID = *in.UserID
			}

			// One LATERAL-joined query: filter to task / status != done /
			// assignee = :user_id, fold every attribute into a jsonb object
			// like card.select_with_attributes does, LEFT JOIN
			// user_card_sort to expose the personal sort, and ORDER BY
			// personal_sort_order ASC NULLS LAST, created_at DESC. Predicate
			// values flow through pgx parameters; no string concatenation.
			//
			// $1 is reserved for the user_id; subsequent placeholders are
			// allocated by addArg below — the optional v2 predicate tree
			// (in.Tree) gets compiled with addArg so its values share the
			// same parameter counter, and its boolean expression slots into
			// the outer WHERE alongside the inbox's built-in predicate.
			args := []any{userID}
			addArg := func(v any) string {
				args = append(args, v)
				return fmt.Sprintf("$%d", len(args))
			}
			treeSQL := ""
			if in.Tree != nil {
				s, err := card.CompileTree(*in.Tree, addArg)
				if err != nil {
					return nil, fmt.Errorf("inbox.select: tree: %w", err)
				}
				treeSQL = " AND (" + s + ")"
			}
			q := fmt.Sprintf(`
				SELECT
					c.id,
					c.card_type_id,
					c.parent_card_id,
					COALESCE(attrs.values, '{}'::jsonb) AS attrs,
					ucs.sort_order AS personal_sort_order
				FROM card c
				JOIN card_type ct ON ct.id = c.card_type_id
				LEFT JOIN LATERAL (
					SELECT jsonb_object_agg(ad.name, av.value) AS values
					FROM attribute_value av
					JOIN attribute_def ad ON ad.id = av.attribute_def_id
					WHERE av.card_id = c.id
				) attrs ON TRUE
				LEFT JOIN user_card_sort ucs
					ON ucs.user_id = $1::bigint AND ucs.card_id = c.id
				WHERE c.deleted_at IS NULL
				  AND ct.name = 'task'
				  AND EXISTS (
					  SELECT 1 FROM attribute_value av
					  JOIN attribute_def ad ON ad.id = av.attribute_def_id
					  WHERE av.card_id = c.id AND ad.name = 'assignee'
					    AND av.value = to_jsonb($1::bigint)
				  )
				  AND NOT EXISTS (
					  SELECT 1 FROM attribute_value av
					  JOIN attribute_def ad ON ad.id = av.attribute_def_id
					  WHERE av.card_id = c.id AND ad.name = 'status'
					    AND av.value = '"done"'::jsonb
				  )%s
				ORDER BY ucs.sort_order ASC NULLS LAST, c.created_at DESC, c.id ASC
			`, treeSQL)
			if in.Limit != nil {
				q += fmt.Sprintf(" LIMIT $%d", len(args)+1)
				args = append(args, *in.Limit)
			}
			if in.Offset != nil {
				q += fmt.Sprintf(" OFFSET $%d", len(args)+1)
				args = append(args, *in.Offset)
			}

			rows, err := tx.Query(ctx, q, args...)
			if err != nil {
				return nil, fmt.Errorf("inbox.select: %w", err)
			}
			if p != nil {
				p.NoteRead()
			}
			var out []Row
			for rows.Next() {
				var r Row
				var attrsRaw []byte
				if err := rows.Scan(&r.ID, &r.CardTypeID, &r.ParentCardID, &attrsRaw, &r.PersonalSort); err != nil {
					rows.Close()
					return nil, err
				}
				if len(attrsRaw) > 0 {
					r.Attributes = map[string]json.RawMessage{}
					if err := json.Unmarshal(attrsRaw, &r.Attributes); err != nil {
						rows.Close()
						return nil, err
					}
				} else {
					r.Attributes = map[string]json.RawMessage{}
				}
				out = append(out, r)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return nil, err
			}
			outs[i] = SelectOutput{Rows: out}
		}
		return outs, nil
	}
}
