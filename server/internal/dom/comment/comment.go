// Package comment exposes comment.insert. A comment is a special activity
// row of kind='comment' that points at a comment_body row via
// value_new->>'comment_body_id'. Both rows are inserted in one CTE per Run.
package comment

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

// InsertInput is one comment to post.
type InsertInput struct {
	CardID int64  `json:"card_id,string" mcp:"required,desc=id of the card being commented on"`
	Body   string `json:"body" mcp:"required,desc=free-form comment text body"`
}

// InsertOutput surfaces the new ids so a UI can route by them.
type InsertOutput struct {
	OK            bool  `json:"ok" mcp:"desc=true on success"`
	ActivityID    int64 `json:"activity_id,string" mcp:"desc=id of the activity row created for this comment"`
	CommentBodyID int64 `json:"comment_body_id,string" mcp:"desc=id of the comment_body row holding the text"`
}

// Register installs comment.insert.
func Register(p *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "comment",
		Action:       "insert",
		Doc:          "Post a comment on a card; writes one comment_body row and one activity row of kind=comment.",
		InputType:    reflect.TypeFor[InsertInput](),
		OutputType:   reflect.TypeFor[InsertOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		Validate:     validateInsert,
		ProcessName:  "comment.post",
		CardTypeID:   cardTypeFromInput,
		Run:          runInsert(p),
	})
}

func cardTypeFromInput(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	return schema.CardTypeIDByCardID(ctx, pool, raw.(InsertInput).CardID)
}

func validateInsert(ctx context.Context, pool reg.ValidationPool, raw any) error {
	in := raw.(InsertInput)
	if in.CardID == 0 {
		return &reg.HandlerError{Code: "validation",
			Message: "comment.insert: card_id is required"}
	}
	if in.Body == "" {
		return &reg.HandlerError{Code: "validation",
			Message: "comment.insert: body is required"}
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM card WHERE id = $1`, in.CardID).Scan(&n); err != nil {
		return fmt.Errorf("comment.insert: validate: %w", err)
	}
	if n == 0 {
		return &reg.HandlerError{Code: "card_not_found",
			Message: fmt.Sprintf("comment.insert: card %d not found", in.CardID)}
	}
	return nil
}

// jsonRow is the per-row payload fed to jsonb_to_recordset.
type jsonRow struct {
	CardID int64  `json:"card_id,string"`
	Body   string `json:"body"`
}

// runInsert is an arrayPath writer. // arrayPath
func runInsert(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		actorID := auth.ActorOrSystem(ctx)
		payload := make([]jsonRow, len(ins))
		for i, raw := range ins {
			in := raw.(InsertInput)
			payload[i] = jsonRow{CardID: in.CardID, Body: in.Body}
		}
		buf, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		// One CTE: insert N comment_body rows; insert N activity rows
		// referencing them; correlate via row_number (insert order matches
		// id order on bigserial).
		const q = `
			WITH input AS (
				SELECT row_number() OVER () AS ord, *
				FROM jsonb_to_recordset($1::jsonb)
				AS x(card_id bigint, body text)
			),
			ins_body AS (
				INSERT INTO comment_body (body)
				SELECT body FROM input ORDER BY ord
				RETURNING id
			),
			body_numbered AS (
				SELECT id, row_number() OVER (ORDER BY id) AS rn FROM ins_body
			),
			input_numbered AS (
				SELECT ord, card_id, row_number() OVER (ORDER BY ord) AS rn FROM input
			),
			zipped AS (
				SELECT i.ord, i.card_id, b.id AS comment_body_id
				FROM body_numbered b
				JOIN input_numbered i ON i.rn = b.rn
			),
			ins_act AS (
				INSERT INTO activity (card_id, kind, value_new, actor_id)
				SELECT card_id, 'comment',
				       jsonb_build_object('comment_body_id', comment_body_id),
				       $2
				FROM zipped
				ORDER BY ord
				RETURNING id
			),
			act_numbered AS (
				SELECT id, row_number() OVER (ORDER BY id) AS rn FROM ins_act
			),
			zipped2 AS (
				SELECT z.ord, a.id AS activity_id, z.comment_body_id
				FROM act_numbered a
				JOIN (SELECT zipped.*, row_number() OVER (ORDER BY ord) AS rn FROM zipped) z
				  ON z.rn = a.rn
			)
			SELECT ord, activity_id, comment_body_id FROM zipped2 ORDER BY ord
		`
		rows, err := tx.Query(ctx, q, buf, actorID)
		if err != nil {
			return nil, fmt.Errorf("comment.insert: %w", err)
		}
		outs := make([]any, len(ins))
		seen := 0
		for rows.Next() {
			var ord int
			var actID, bodyID int64
			if err := rows.Scan(&ord, &actID, &bodyID); err != nil {
				rows.Close()
				return nil, err
			}
			if ord < 0 || ord-1 >= len(ins) {
				rows.Close()
				return nil, fmt.Errorf("comment.insert: ord %d out of range", ord)
			}
			outs[ord-1] = InsertOutput{OK: true, ActivityID: actID, CommentBodyID: bodyID}
			seen++
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		if seen != len(ins) {
			return nil, fmt.Errorf("comment.insert: returned %d rows for %d inputs", seen, len(ins))
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}

