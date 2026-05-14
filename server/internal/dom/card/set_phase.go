// File card/set_phase.go: card.set_phase — write the structural `phase`
// column on a value-card (triage / active / terminal). Mirrors card.move's
// shape because phase, like parent_card_id, lives on the card row itself
// rather than in attribute_value — attribute.update can't reach it.
//
// One CTE per Run: UPDATE card.phase + INSERT activity (kind='card_set_phase',
// value_old/value_new carry the phase strings as JSON). The activity stream
// stays the canonical event log even for structural-column writes.
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

// SetPhaseInput targets one card for a phase change.
type SetPhaseInput struct {
	CardID int64  `json:"card_id,string" mcp:"required,desc=id of the card whose phase column is being updated"`
	Phase  string `json:"phase" mcp:"required,desc=new phase value; must be triage, active, or terminal"`
}

// SetPhaseOutput acknowledges success.
type SetPhaseOutput struct {
	OK         bool  `json:"ok" mcp:"desc=true on success"`
	ActivityID int64 `json:"activity_id,string" mcp:"desc=id of the activity row recording the phase change"`
}

// RegisterSetPhase installs the handler; called from card.Register.
func RegisterSetPhase(p *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "card",
		Action:       "set_phase",
		Doc:          "Set the structural phase column on a value-card (triage|active|terminal); emits an activity row recording the change.",
		InputType:    reflect.TypeFor[SetPhaseInput](),
		OutputType:   reflect.TypeFor[SetPhaseOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "card.update",
		CardTypeID:   cardTypeFromSetPhaseInput,
		Validate:     validateSetPhase,
		Run:          runSetPhase(p),
	})
}

func cardTypeFromSetPhaseInput(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	return schema.CardTypeIDByCardID(ctx, pool, raw.(SetPhaseInput).CardID)
}

// IsValidPhase reports whether p is one of the three accepted phase values.
// Exported for the card.insert validator + future callers that need to
// pre-validate without round-tripping through the DB CHECK constraint.
func IsValidPhase(p string) bool {
	return p == "triage" || p == "active" || p == "terminal"
}

func validateSetPhase(ctx context.Context, pool reg.ValidationPool, raw any) error {
	in := raw.(SetPhaseInput)
	if in.CardID == 0 {
		return &reg.HandlerError{Code: "validation",
			Message: "card.set_phase: card_id is required"}
	}
	if !IsValidPhase(in.Phase) {
		return &reg.HandlerError{Code: "validation",
			Message: fmt.Sprintf("card.set_phase: phase %q: must be triage|active|terminal", in.Phase)}
	}
	// Confirm the card exists so we return a clean error instead of
	// silently no-opping a missing-row UPDATE.
	var exists bool
	row := pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM card WHERE id = $1 AND deleted_at IS NULL)`,
		in.CardID)
	if err := row.Scan(&exists); err != nil {
		return fmt.Errorf("card.set_phase: validate lookup: %w", err)
	}
	if !exists {
		return &reg.HandlerError{Code: "card_not_found",
			Message: fmt.Sprintf("card.set_phase: card %d not found", in.CardID)}
	}
	return nil
}

// runSetPhase is an arrayPath writer: one CTE updates N cards + emits N
// activity rows. // arrayPath
func runSetPhase(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		actorID := auth.ActorOrSystem(ctx)

		type jsonRow struct {
			Ord    int    `json:"ord"`
			CardID int64  `json:"card_id,string"`
			Phase  string `json:"phase"`
		}
		payload := make([]jsonRow, len(ins))
		for i, raw := range ins {
			in := raw.(SetPhaseInput)
			payload[i] = jsonRow{Ord: i, CardID: in.CardID, Phase: in.Phase}
		}
		buf, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}

		// One CTE: read prev phase, UPDATE card.phase, INSERT activity
		// with kind='card_set_phase' carrying old/new phase strings. The
		// SELECT-from-card-into-prev hop is needed because UPDATE's
		// RETURNING gives us the NEW row only; value_old comes from the
		// pre-update snapshot.
		const q = `
			WITH input AS (
				SELECT ord, card_id, phase
				FROM jsonb_to_recordset($1::jsonb)
				AS x(ord int, card_id bigint, phase text)
			),
			prev AS (
				SELECT i.ord, i.card_id, i.phase AS phase_new, c.phase AS phase_old
				FROM input i
				JOIN card c ON c.id = i.card_id
			),
			upd AS (
				UPDATE card SET phase = prev.phase_new
				FROM prev
				WHERE card.id = prev.card_id
				RETURNING card.id, prev.ord, prev.phase_old, prev.phase_new
			),
			ins_act AS (
				INSERT INTO activity (card_id, kind, value_old, value_new, actor_id)
				SELECT id, 'card_set_phase', to_jsonb(phase_old), to_jsonb(phase_new), $2
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
			return nil, fmt.Errorf("card.set_phase: %w", err)
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
			outs[ord] = SetPhaseOutput{OK: true, ActivityID: actID}
			seen++
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		if seen != len(ins) {
			return nil, fmt.Errorf("card.set_phase: returned %d rows for %d inputs", seen, len(ins))
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}
