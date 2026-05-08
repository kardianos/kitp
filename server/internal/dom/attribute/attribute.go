// Package attribute holds attribute.update — the canonical event-sourced
// write path. Every attribute change generates an activity row and an
// upsert into attribute_value, all within one CTE per Run.
package attribute

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"reflect"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/gate"
	"github.com/kitp/kitp/server/internal/dom/workflowtransition"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

// guardStatusTransition consults workflow_transition for cards bound to
// a workflow_def. Returns nil when the card has no workflow binding
// (legacy behaviour) or when the transition is reachable.
func guardStatusTransition(ctx context.Context, tx pgx.Tx, cardID int64, newState string) error {
	// Look up the workflow_def_ref attribute_def id once per call.
	var workflowDefID *int64
	if err := tx.QueryRow(ctx, `
		SELECT (av.value)::text::bigint
		FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1 AND ad.name = 'workflow_def_ref'
	`, cardID).Scan(&workflowDefID); err != nil {
		if err == pgx.ErrNoRows {
			return nil
		}
		return err
	}
	if workflowDefID == nil {
		return nil
	}
	// Read the current status (may be null on a freshly classified card).
	var currentRaw []byte
	if err := tx.QueryRow(ctx, `
		SELECT av.value
		FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1 AND ad.name = 'status'
	`, cardID).Scan(&currentRaw); err != nil {
		if err == pgx.ErrNoRows {
			// No prior status — treat as match against initial_state on
			// the workflow_def.
			var initRaw []byte
			if err := tx.QueryRow(ctx, `
				SELECT av.value
				FROM attribute_value av
				JOIN attribute_def ad ON ad.id = av.attribute_def_id
				WHERE av.card_id = $1 AND ad.name = 'initial_state'
			`, *workflowDefID).Scan(&initRaw); err != nil {
				return nil // can't check; let the write proceed
			}
			var initial string
			_ = json.Unmarshal(initRaw, &initial)
			if initial == newState {
				return nil // setting to initial is always allowed
			}
			currentRaw = initRaw
		} else {
			return err
		}
	}
	var current string
	_ = json.Unmarshal(currentRaw, &current)
	if current == newState {
		return nil // no-op transition is allowed
	}
	ok, _, err := workflowtransition.Reachable(ctx, tx, *workflowDefID, current, newState)
	if err != nil {
		return err
	}
	if !ok {
		return &reg.HandlerError{Code: "transition_unreachable",
			Message: fmt.Sprintf("attribute.update: transition %q → %q not reachable on workflow %d",
				current, newState, *workflowDefID)}
	}
	// Gate guard. For every effective gate whose required_in_states
	// includes the target state, status must be approved or n_a.
	gates, err := gate.EffectiveGatesFor(ctx, tx, cardID)
	if err != nil {
		return err
	}
	for _, g := range gates {
		required := false
		for _, s := range g.RequiredInStates {
			if s == newState {
				required = true
				break
			}
		}
		if !required {
			continue
		}
		if g.Status != "approved" && g.Status != "n_a" {
			return &reg.HandlerError{Code: "gate_pending",
				Message: fmt.Sprintf("attribute.update: gate %q is %s; must be approved before transitioning to %q",
					g.Title, g.Status, newState)}
		}
	}
	return nil
}


// UpdateInput is one row of attribute.update.
type UpdateInput struct {
	CardID        int64           `json:"card_id" mcp:"required,desc=id of the card whose attribute is being updated"`
	AttributeName string          `json:"attribute_name" mcp:"required,desc=name of the attribute_def to write"`
	Value         json.RawMessage `json:"value" mcp:"required,desc=new JSON value; literal null requests removal"`
}

// UpdateOutput is the per-row reply.
type UpdateOutput struct {
	OK         bool            `json:"ok" mcp:"desc=true on success"`
	ActivityID int64           `json:"activity_id" mcp:"desc=id of the activity row recording the change"`
	PrevValue  json.RawMessage `json:"prev_value,omitempty" mcp:"desc=previous JSON value, if any"`
}

// Register installs the handler.
func Register(p *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "attribute",
		Action:       "update",
		Doc:          "Set an attribute value on a card; emits one activity row and one upsert per write.",
		InputType:    reflect.TypeFor[UpdateInput](),
		OutputType:   reflect.TypeFor[UpdateOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		Validate:     validateUpdate,
		ProcessName:  "card.update",
		CardTypeID:   cardTypeFromCardID,
		Run:          runUpdate(p),
	})
}

// cardTypeFromCardID resolves the card_type_id for the targeted card so the
// dispatcher can authorize the (card_type, process) pair.
func cardTypeFromCardID(ctx context.Context, pool reg.ValidationPool, raw any) (int32, error) {
	return schema.CardTypeIDByCardID(ctx, pool, raw.(UpdateInput).CardID)
}

// validateUpdate runs before the transaction opens. F-ATTR-3:
//   - the card must exist;
//   - the (card_type, attribute_def) edge must exist;
//   - removal of a required attribute is rejected (we treat a JSON null
//     payload as removal);
//   - if the attribute_def has value_type='enum', the supplied value
//     must be one of the rows in attribute_def_option (migration 0012).
//     The check uses a single SELECT, builds a Go set, and rejects
//     unknown values with code 'invalid_enum_value'.
func validateUpdate(ctx context.Context, pool reg.ValidationPool, raw any) error {
	in := raw.(UpdateInput)
	if in.CardID == 0 {
		return &reg.HandlerError{Code: "validation",
			Message: "attribute.update: card_id is required"}
	}
	if in.AttributeName == "" {
		return &reg.HandlerError{Code: "validation",
			Message: "attribute.update: attribute_name is required"}
	}

	var cardTypeID int32
	row := pool.QueryRow(ctx, `SELECT card_type_id FROM card WHERE id = $1`, in.CardID)
	if err := row.Scan(&cardTypeID); err != nil {
		if err == pgx.ErrNoRows {
			return &reg.HandlerError{Code: "card_not_found",
				Message: fmt.Sprintf("attribute.update: card %d not found", in.CardID)}
		}
		return fmt.Errorf("attribute.update: validate card lookup: %w", err)
	}

	// Look up the edge directly (cheap, single query). We also pull
	// value_type so we can apply enum validation in the same pass.
	var attrDefID int32
	var isRequired bool
	var valueType string
	row = pool.QueryRow(ctx, `
		SELECT ad.id, e.is_required, ad.value_type
		FROM attribute_def ad
		JOIN edge e ON e.attribute_def_id = ad.id
		WHERE ad.name = $1 AND e.card_type_id = $2
	`, in.AttributeName, cardTypeID)
	if err := row.Scan(&attrDefID, &isRequired, &valueType); err != nil {
		if err == pgx.ErrNoRows {
			return &reg.HandlerError{Code: "edge_violation",
				Message: fmt.Sprintf("attribute.update: attribute %q is not allowed on this card type",
					in.AttributeName)}
		}
		return fmt.Errorf("attribute.update: validate edge lookup: %w", err)
	}

	// Treat literal JSON null as a removal request.
	if isJSONNull(in.Value) {
		if isRequired {
			return &reg.HandlerError{Code: "edge_violation",
				Message: fmt.Sprintf("attribute.update: attribute %q is required and cannot be removed",
					in.AttributeName)}
		}
		// Removal of an enum-typed attribute is not a membership check.
		return nil
	}

	// Enum membership: only meaningful when value_type='enum'. Decode the
	// JSON payload, accept only string values (the only enum shape we
	// support today — see migration 0012 which seeds plain text values),
	// and look the value up in attribute_def_option.
	if valueType == "enum" {
		var decoded any
		if err := json.Unmarshal(in.Value, &decoded); err != nil {
			return &reg.HandlerError{Code: "invalid_enum_value",
				Message: fmt.Sprintf("attribute.update: value for enum attribute %q is not valid JSON: %v",
					in.AttributeName, err)}
		}
		s, ok := decoded.(string)
		if !ok {
			return &reg.HandlerError{Code: "invalid_enum_value",
				Message: fmt.Sprintf("attribute.update: value for enum attribute %q must be a string; got %T",
					in.AttributeName, decoded)}
		}
		allowed := map[string]struct{}{}
		var allowedList []string
		rows, err := pool.Query(ctx, `
			SELECT value FROM attribute_def_option
			WHERE attribute_def_id = $1
			ORDER BY ordering, value
		`, attrDefID)
		if err != nil {
			return fmt.Errorf("attribute.update: validate enum options: %w", err)
		}
		for rows.Next() {
			var v string
			if err := rows.Scan(&v); err != nil {
				rows.Close()
				return fmt.Errorf("attribute.update: validate enum scan: %w", err)
			}
			allowed[v] = struct{}{}
			allowedList = append(allowedList, v)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return fmt.Errorf("attribute.update: validate enum rows: %w", err)
		}
		if _, ok := allowed[s]; !ok {
			return &reg.HandlerError{Code: "invalid_enum_value",
				Message: fmt.Sprintf("attribute.update: value %q is not allowed for enum attribute %q; allowed: %v",
					s, in.AttributeName, allowedList)}
		}
	}
	return nil
}

// jsonRow is the per-row payload fed to jsonb_to_recordset.
type jsonRow struct {
	CardID        int64           `json:"card_id"`
	AttributeName string          `json:"attribute_name"`
	Value         json.RawMessage `json:"value"`
	Ord           int             `json:"ord"`
}

// runUpdate is an arrayPath writer. // arrayPath
func runUpdate(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		actorID := auth.ActorOrSystem(ctx)

		payload := make([]jsonRow, len(ins))
		for i, raw := range ins {
			in := raw.(UpdateInput)
			value := in.Value
			if len(value) == 0 {
				value = json.RawMessage(`null`)
			}
			payload[i] = jsonRow{
				CardID:        in.CardID,
				AttributeName: in.AttributeName,
				Value:         value,
				Ord:           i,
			}
		}

		// Pre-write transition guard. If the attribute being written is
		// `status` and the card has a workflow_def_ref, consult
		// workflow_transition for reachability. We collect every (card,
		// status) update in this batch and validate before opening the
		// write CTE so a rejected transition aborts cleanly.
		for i, raw := range ins {
			in := raw.(UpdateInput)
			if in.AttributeName != "status" {
				continue
			}
			var newState string
			if err := json.Unmarshal(in.Value, &newState); err != nil {
				continue // leave to the existing validator to surface
			}
			if err := guardStatusTransition(ctx, tx, in.CardID, newState); err != nil {
				if hErr, ok := err.(*reg.HandlerError); ok {
					hErr.InputIndex = i
					return nil, hErr
				}
				return nil, fmt.Errorf("attribute.update: status guard: %w", err)
			}
		}

		buf, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}

		// One CTE per Run: read prev values, INSERT N activity rows ordered
		// by ord, UPSERT N attribute_value rows. The id-vs-ord correlation
		// works because Postgres allocates activity ids in INSERT order, and
		// our INSERT is "ORDER BY ord"; row_number() windows align them.
		const q = `
			WITH input AS (
				SELECT i.ord, i.card_id, ad.id AS attribute_def_id, i.value
				FROM jsonb_to_recordset($1::jsonb)
				AS i(ord int, card_id bigint, attribute_name text, value jsonb)
				JOIN attribute_def ad ON ad.name = i.attribute_name
			),
			prev AS (
				SELECT i.ord, i.card_id, i.attribute_def_id,
				       i.value AS value_new,
				       av.value AS value_old
				FROM input i
				LEFT JOIN attribute_value av
					ON av.card_id = i.card_id AND av.attribute_def_id = i.attribute_def_id
			),
			ins_act AS (
				INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
				SELECT card_id, 'attr_update', attribute_def_id, value_old, value_new, $2
				FROM prev
				ORDER BY ord
				RETURNING id, card_id, attribute_def_id
			),
			act_numbered AS (
				SELECT id, card_id, attribute_def_id,
				       row_number() OVER (ORDER BY id) AS rn
				FROM ins_act
			),
			prev_numbered AS (
				SELECT ord, card_id, attribute_def_id, value_new, value_old,
				       row_number() OVER (ORDER BY ord) AS rn
				FROM prev
			),
			zipped AS (
				SELECT p.ord, a.id AS activity_id, p.card_id, p.attribute_def_id,
				       p.value_new, p.value_old
				FROM act_numbered a
				JOIN prev_numbered p ON p.rn = a.rn
			),
			upsert AS (
				INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
				SELECT card_id, attribute_def_id, value_new, activity_id FROM zipped
				ON CONFLICT (card_id, attribute_def_id) DO UPDATE
					SET value = EXCLUDED.value,
					    last_activity_id = EXCLUDED.last_activity_id
				RETURNING card_id, attribute_def_id
			)
			SELECT ord, activity_id, value_old FROM zipped ORDER BY ord
		`
		rows, err := tx.Query(ctx, q, buf, actorID)
		if err != nil {
			return nil, fmt.Errorf("attribute.update: %w", err)
		}
		outs := make([]any, len(ins))
		seen := 0
		for rows.Next() {
			var ord int
			var activityID int64
			var prev []byte
			if err := rows.Scan(&ord, &activityID, &prev); err != nil {
				rows.Close()
				return nil, err
			}
			if ord < 0 || ord >= len(ins) {
				rows.Close()
				return nil, fmt.Errorf("attribute.update: ord %d out of range", ord)
			}
			outs[ord] = UpdateOutput{
				OK:         true,
				ActivityID: activityID,
				PrevValue:  json.RawMessage(prev),
			}
			seen++
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		if seen != len(ins) {
			return nil, fmt.Errorf("attribute.update: returned %d rows for %d inputs", seen, len(ins))
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}

func isJSONNull(b []byte) bool {
	if len(b) == 0 {
		return true
	}
	return bytes.Equal(bytes.TrimSpace(b), []byte("null"))
}
