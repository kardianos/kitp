// File card/move_delete.go: card.delete (soft), card.undelete, card.move.
// All three are array-in writers funneling through one CTE per Run that
// emits one activity row per input + one card update per input.
package card

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

// DeleteInput is one card to soft-delete.
type DeleteInput struct {
	CardID int64 `json:"card_id" mcp:"required,desc=id of the card to soft-delete"`
}

// DeleteOutput acknowledges success.
type DeleteOutput struct {
	OK         bool  `json:"ok" mcp:"desc=true on success"`
	ActivityID int64 `json:"activity_id" mcp:"desc=id of the activity row recording the delete"`
}

// UndeleteInput is one card to undelete.
type UndeleteInput struct {
	CardID int64 `json:"card_id" mcp:"required,desc=id of the card to undelete"`
}

// UndeleteOutput acknowledges success.
type UndeleteOutput struct {
	OK         bool  `json:"ok" mcp:"desc=true on success"`
	ActivityID int64 `json:"activity_id" mcp:"desc=id of the activity row recording the undelete"`
}

// MoveInput moves card_id under new_parent_card_id.
type MoveInput struct {
	CardID            int64 `json:"card_id" mcp:"required,desc=id of the card to move"`
	NewParentCardID   int64 `json:"new_parent_card_id" mcp:"required,desc=id of the new parent card"`
}

// MoveOutput acknowledges success.
type MoveOutput struct {
	OK         bool  `json:"ok" mcp:"desc=true on success"`
	ActivityID int64 `json:"activity_id" mcp:"desc=id of the activity row recording the move"`
}

// RegisterMoveDelete is called from card.Register to install the three
// secondary handlers; placed in a separate file to keep card.go readable.
func RegisterMoveDelete(p *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "card",
		Action:       "delete",
		Doc:          "Soft-delete a card; the row is hidden from default selects but kept for activity history.",
		InputType:    reflect.TypeFor[DeleteInput](),
		OutputType:   reflect.TypeFor[DeleteOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "card.delete",
		CardTypeID:   cardTypeFromDeleteInput,
		Run:          runDelete(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "card",
		Action:       "undelete",
		Doc:          "Undo a previous soft-delete by clearing deleted_at on the card.",
		InputType:    reflect.TypeFor[UndeleteInput](),
		OutputType:   reflect.TypeFor[UndeleteOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "card.delete",
		CardTypeID:   cardTypeFromUndeleteInput,
		Run:          runUndelete(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "card",
		Action:       "move",
		Doc:          "Re-parent a card under a different parent of a compatible card_type.",
		InputType:    reflect.TypeFor[MoveInput](),
		OutputType:   reflect.TypeFor[MoveOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "card.update",
		CardTypeID:   cardTypeFromMoveInput,
		Run:          runMove(p),
	})
}

func cardTypeFromDeleteInput(ctx context.Context, pool reg.ValidationPool, raw any) (int32, error) {
	return schema.CardTypeIDByCardID(ctx, pool, raw.(DeleteInput).CardID)
}

func cardTypeFromUndeleteInput(ctx context.Context, pool reg.ValidationPool, raw any) (int32, error) {
	return schema.CardTypeIDByCardID(ctx, pool, raw.(UndeleteInput).CardID)
}

func cardTypeFromMoveInput(ctx context.Context, pool reg.ValidationPool, raw any) (int32, error) {
	return schema.CardTypeIDByCardID(ctx, pool, raw.(MoveInput).CardID)
}

// runDelete is an arrayPath writer. // arrayPath
func runDelete(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		actorID := auth.ActorOrSystem(ctx)
		ids := make([]int64, len(ins))
		for i, raw := range ins {
			in := raw.(DeleteInput)
			if in.CardID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "card.delete: card_id is required"}
			}
			ids[i] = in.CardID
		}
		// One CTE: UPDATE deleted_at + INSERT activity 'card_delete'.
		const q = `
			WITH input AS (
				SELECT row_number() OVER () AS ord, unnest($1::bigint[]) AS card_id
			),
			upd AS (
				UPDATE card SET deleted_at = now()
				FROM input
				WHERE card.id = input.card_id AND card.deleted_at IS NULL
				RETURNING card.id, input.ord
			),
			ins_act AS (
				INSERT INTO activity (card_id, kind, actor_id)
				SELECT id, 'card_delete', $2 FROM upd ORDER BY ord
				RETURNING id, card_id
			),
			act_numbered AS (
				SELECT id, card_id, row_number() OVER (ORDER BY id) AS rn FROM ins_act
			),
			upd_numbered AS (
				SELECT ord, row_number() OVER (ORDER BY ord) AS rn FROM upd
			),
			zipped AS (
				SELECT u.ord, a.id AS activity_id
				FROM act_numbered a
				JOIN upd_numbered u ON u.rn = a.rn
			)
			SELECT ord, activity_id FROM zipped ORDER BY ord
		`
		rows, err := tx.Query(ctx, q, ids, actorID)
		if err != nil {
			return nil, fmt.Errorf("card.delete: %w", err)
		}
		outs := make([]any, len(ins))
		seen := 0
		for rows.Next() {
			var ord int
			var actID int64
			if err := rows.Scan(&ord, &actID); err != nil {
				rows.Close()
				return nil, err
			}
			outs[ord-1] = DeleteOutput{OK: true, ActivityID: actID}
			seen++
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		if seen != len(ins) {
			return nil, &reg.HandlerError{InputIndex: 0, Code: "card_not_found",
				Message: "card.delete: one or more cards were missing or already deleted"}
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}

// runUndelete is an arrayPath writer. // arrayPath
func runUndelete(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		actorID := auth.ActorOrSystem(ctx)
		ids := make([]int64, len(ins))
		for i, raw := range ins {
			in := raw.(UndeleteInput)
			if in.CardID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "card.undelete: card_id is required"}
			}
			ids[i] = in.CardID
		}
		const q = `
			WITH input AS (
				SELECT row_number() OVER () AS ord, unnest($1::bigint[]) AS card_id
			),
			upd AS (
				UPDATE card SET deleted_at = NULL
				FROM input
				WHERE card.id = input.card_id AND card.deleted_at IS NOT NULL
				RETURNING card.id, input.ord
			),
			ins_act AS (
				INSERT INTO activity (card_id, kind, actor_id)
				SELECT id, 'card_undelete', $2 FROM upd ORDER BY ord
				RETURNING id
			),
			act_numbered AS (
				SELECT id, row_number() OVER (ORDER BY id) AS rn FROM ins_act
			),
			upd_numbered AS (
				SELECT ord, row_number() OVER (ORDER BY ord) AS rn FROM upd
			),
			zipped AS (
				SELECT u.ord, a.id AS activity_id
				FROM act_numbered a
				JOIN upd_numbered u ON u.rn = a.rn
			)
			SELECT ord, activity_id FROM zipped ORDER BY ord
		`
		rows, err := tx.Query(ctx, q, ids, actorID)
		if err != nil {
			return nil, fmt.Errorf("card.undelete: %w", err)
		}
		outs := make([]any, len(ins))
		seen := 0
		for rows.Next() {
			var ord int
			var actID int64
			if err := rows.Scan(&ord, &actID); err != nil {
				rows.Close()
				return nil, err
			}
			outs[ord-1] = UndeleteOutput{OK: true, ActivityID: actID}
			seen++
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		if seen != len(ins) {
			return nil, &reg.HandlerError{InputIndex: 0, Code: "card_not_found",
				Message: "card.undelete: one or more cards were missing or already live"}
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}

// runMove is an arrayPath writer. // arrayPath
//
// Validation: the new parent's card_type must be the moved card's
// parent_card_type_id (or self if allow_self_parent). We pre-validate in
// Go with a Snapshot, then issue ONE statement that updates parent_card_id
// and emits activity 'card_move' with old/new parent ids in the value.
func runMove(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		actorID := auth.ActorOrSystem(ctx)
		snap, err := schema.Load(ctx, tx)
		if err != nil {
			return nil, err
		}

		// Resolve current card_type and parent for the moved + new-parent cards.
		ids := map[int64]struct{}{}
		for _, raw := range ins {
			in := raw.(MoveInput)
			if in.CardID == 0 || in.NewParentCardID == 0 {
				return nil, &reg.HandlerError{Code: "validation",
					Message: "card.move: card_id and new_parent_card_id are required"}
			}
			ids[in.CardID] = struct{}{}
			ids[in.NewParentCardID] = struct{}{}
		}
		idList := make([]int64, 0, len(ids))
		for id := range ids {
			idList = append(idList, id)
		}
		type row struct {
			TypeID   int32
			ParentID *int64
		}
		info := map[int64]row{}
		{
			rows, err := tx.Query(ctx, `SELECT id, card_type_id, parent_card_id FROM card WHERE id = ANY($1::bigint[])`, idList)
			if err != nil {
				return nil, fmt.Errorf("card.move: lookup: %w", err)
			}
			for rows.Next() {
				var id int64
				var ctid int32
				var parent *int64
				if err := rows.Scan(&id, &ctid, &parent); err != nil {
					rows.Close()
					return nil, err
				}
				info[id] = row{TypeID: ctid, ParentID: parent}
			}
			rows.Close()
		}

		// Build the per-input payload.
		type jsonRow struct {
			Ord       int    `json:"ord"`
			CardID    int64  `json:"card_id"`
			NewParent int64  `json:"new_parent"`
			OldParent string `json:"old_parent"` // jsonb-encoded
		}
		payload := make([]jsonRow, len(ins))
		for i, raw := range ins {
			in := raw.(MoveInput)
			child, ok := info[in.CardID]
			if !ok {
				return nil, &reg.HandlerError{InputIndex: i, Code: "card_not_found",
					Message: fmt.Sprintf("card.move: card %d not found", in.CardID)}
			}
			parent, ok := info[in.NewParentCardID]
			if !ok {
				return nil, &reg.HandlerError{InputIndex: i, Code: "parent_not_found",
					Message: fmt.Sprintf("card.move: new_parent_card_id %d not found", in.NewParentCardID)}
			}
			ct, ok := snap.CardTypeByID[child.TypeID]
			if !ok {
				return nil, fmt.Errorf("card.move: card_type id=%d missing", child.TypeID)
			}
			if !snap.ParentAllowed(ct, parent.TypeID) {
				parentName := snap.CardTypeByID[parent.TypeID].Name
				return nil, &reg.HandlerError{InputIndex: i, Code: "edge_violation",
					Message: fmt.Sprintf("card.move: card_type %q is not allowed under parent type %q",
						ct.Name, parentName)}
			}
			oldB, _ := json.Marshal(child.ParentID)
			payload[i] = jsonRow{
				Ord:       i,
				CardID:    in.CardID,
				NewParent: in.NewParentCardID,
				OldParent: string(oldB),
			}
		}
		buf, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}

		const q = `
			WITH input AS (
				SELECT ord, card_id, new_parent, old_parent::jsonb AS old_parent
				FROM jsonb_to_recordset($1::jsonb)
				AS x(ord int, card_id bigint, new_parent bigint, old_parent text)
			),
			upd AS (
				UPDATE card SET parent_card_id = input.new_parent
				FROM input
				WHERE card.id = input.card_id
				RETURNING card.id, input.ord, input.new_parent, input.old_parent
			),
			ins_act AS (
				INSERT INTO activity (card_id, kind, value_old, value_new, actor_id)
				SELECT id, 'card_move', old_parent, to_jsonb(new_parent), $2
				FROM upd
				ORDER BY ord
				RETURNING id
			),
			act_numbered AS (
				SELECT id, row_number() OVER (ORDER BY id) AS rn FROM ins_act
			),
			upd_numbered AS (
				SELECT ord, row_number() OVER (ORDER BY ord) AS rn FROM upd
			),
			zipped AS (
				SELECT u.ord, a.id AS activity_id
				FROM act_numbered a
				JOIN upd_numbered u ON u.rn = a.rn
			)
			SELECT ord, activity_id FROM zipped ORDER BY ord
		`
		rows, err := tx.Query(ctx, q, buf, actorID)
		if err != nil {
			return nil, fmt.Errorf("card.move: %w", err)
		}
		outs := make([]any, len(ins))
		seen := 0
		for rows.Next() {
			var ord int
			var actID int64
			if err := rows.Scan(&ord, &actID); err != nil {
				rows.Close()
				return nil, err
			}
			outs[ord] = MoveOutput{OK: true, ActivityID: actID}
			seen++
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		if seen != len(ins) {
			return nil, fmt.Errorf("card.move: returned %d rows for %d inputs", seen, len(ins))
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}
