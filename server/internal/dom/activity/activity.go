// Package activity provides activity.select — paged, chronological
// activity for a card, with comments inlined via a join to comment_body.
package activity

import (
	"context"
	"encoding/json"
	"reflect"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// SelectInput selects activity with optional cursor paging.
//
// CardID is optional: when zero/null the handler returns activity across
// every card the actor can see (cross-card mode). When non-zero, only
// rows for that card are returned. BeforeActivityID is exclusive: the
// page contains rows with id < cursor.
type SelectInput struct {
	CardID           int64  `json:"card_id,omitempty" mcp:"desc=card whose activity is being read; omit for cross-card mode"`
	Limit            *int   `json:"limit,omitempty" mcp:"desc=optional row cap; defaults to 200"`
	BeforeActivityID *int64 `json:"before_activity_id,omitempty" mcp:"desc=cursor; only return activity rows with id < this"`
}

// Row is one denormalized activity row. CardID is set so cross-card
// callers can route per-row links back to a card.
type Row struct {
	ID            int64           `json:"id" mcp:"desc=activity row id"`
	CardID        int64           `json:"card_id" mcp:"desc=card the activity belongs to"`
	Kind          string          `json:"kind" mcp:"desc=activity kind (card_create, attr_update, comment, ...)"`
	AttributeName *string         `json:"attribute_name,omitempty" mcp:"desc=attribute name when kind is attr_update"`
	ValueOld      json.RawMessage `json:"value_old,omitempty" mcp:"desc=previous JSON value of the attribute, if any"`
	ValueNew      json.RawMessage `json:"value_new,omitempty" mcp:"desc=new JSON value of the attribute, if any"`
	CommentBody   *string         `json:"comment_body,omitempty" mcp:"desc=resolved comment body when kind is comment"`
	ActorID       int64           `json:"actor_id" mcp:"desc=user id that made the change"`
	CreatedAt     time.Time       `json:"created_at" mcp:"desc=activity timestamp"`
}

// SelectOutput is the per-input reply.
type SelectOutput struct {
	Rows []Row `json:"rows" mcp:"desc=matching activity rows in chronological order"`
}

// Register installs the handler.
func Register(p *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "activity",
		Action:       "select",
		Doc:          "Read paged activity for one card in chronological order; comments include their body inline.",
		InputType:    reflect.TypeFor[SelectInput](),
		OutputType:   reflect.TypeFor[SelectOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Run:          runSelect(p),
	})
}

func runSelect(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(SelectInput)
			limit := 200
			if in.Limit != nil && *in.Limit > 0 && *in.Limit < 1000 {
				limit = *in.Limit
			}
			// One static query handles both modes. CardID == 0 → cross-card
			// (the IS-NULL gate collapses) and we sort newest-first; for a
			// per-card read we keep chronological-ascending. Direction is
			// switched by a sort_asc bool parameter that drives two CASEs in
			// ORDER BY — the column literal is fixed in SQL, no string
			// interpolation.
			var cardIDArg any = in.CardID
			sortAsc := true
			if in.CardID == 0 {
				cardIDArg = nil
				sortAsc = false
			}
			rows, err := tx.Query(ctx, `
				SELECT a.id, a.card_id, a.kind, ad.name, a.value_old, a.value_new,
				       cb.body,
				       a.actor_id, a.created_at
				FROM activity a
				LEFT JOIN attribute_def ad ON ad.id = a.attribute_def_id
				LEFT JOIN comment_body cb ON cb.id = (a.value_new->>'comment_body_id')::bigint
				WHERE ($1::bigint IS NULL OR a.card_id = $1)
				  AND ($2::bigint IS NULL OR a.id < $2)
				ORDER BY
				  CASE WHEN $4 THEN a.id END ASC,
				  CASE WHEN NOT $4 THEN a.id END DESC
				LIMIT $3
			`, cardIDArg, in.BeforeActivityID, limit, sortAsc)
			if err != nil {
				return nil, err
			}
			if p != nil {
				p.NoteRead()
			}
			var out []Row
			for rows.Next() {
				var r Row
				var attrName *string
				var oldRaw, newRaw []byte
				var body *string
				if err := rows.Scan(&r.ID, &r.CardID, &r.Kind, &attrName, &oldRaw, &newRaw, &body, &r.ActorID, &r.CreatedAt); err != nil {
					rows.Close()
					return nil, err
				}
				r.AttributeName = attrName
				if oldRaw != nil {
					r.ValueOld = json.RawMessage(oldRaw)
				}
				if newRaw != nil {
					r.ValueNew = json.RawMessage(newRaw)
				}
				r.CommentBody = body
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
