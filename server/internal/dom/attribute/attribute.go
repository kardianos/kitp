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
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)


// UpdateInput is one row of attribute.update.
type UpdateInput struct {
	CardID        int64           `json:"card_id,string" mcp:"required,desc=id of the card whose attribute is being updated"`
	AttributeName string          `json:"attribute_name" mcp:"required,desc=name of the attribute_def to write"`
	Value         json.RawMessage `json:"value" mcp:"required,desc=new JSON value; literal null requests removal"`
}

// UpdateOutput is the per-row reply.
type UpdateOutput struct {
	OK         bool            `json:"ok" mcp:"desc=true on success"`
	ActivityID int64           `json:"activity_id,string" mcp:"desc=id of the activity row recording the change"`
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
func cardTypeFromCardID(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
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

	var cardTypeID int64
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
	var attrDefID int64
	var isRequired bool
	var valueType string
	var targetCardTypeID *int64
	row = pool.QueryRow(ctx, `
		SELECT ad.id, e.is_required, ad.value_type, ad.target_card_type_id
		FROM attribute_def ad
		JOIN edge e ON e.attribute_def_id = ad.id
		WHERE ad.name = $1 AND e.card_type_id = $2
	`, in.AttributeName, cardTypeID)
	if err := row.Scan(&attrDefID, &isRequired, &valueType, &targetCardTypeID); err != nil {
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
		// Removal request — no further checks needed.
		return nil
	}

	// Reference scope: every card_ref / card_ref[] write goes through
	// the same per-project check. Value-cards whose enclosing project
	// matches the target are accepted; global cards (e.g. person) are
	// wildcards (accepted against any target). There is no enum
	// special case — pick-from-a-list attributes ARE card_refs.
	if valueType == "card_ref" || valueType == "card_ref[]" {
		valueIDs, err := ParseCardRefValue(in.AttributeName, in.Value)
		if err != nil {
			return &reg.HandlerError{Code: "validation",
				Message: fmt.Sprintf("attribute.update: %v", err)}
		}
		if len(valueIDs) > 0 {
			check := ProjectScopeCheck{
				StartCardID:   in.CardID,
				AttributeName: in.AttributeName,
				ValueCardIDs:  valueIDs,
			}
			if targetCardTypeID != nil {
				check.TargetCardTypeID = *targetCardTypeID
			}
			if err := ValidateProjectScope(ctx, pool, []ProjectScopeCheck{check}); err != nil {
				return err
			}
		}
	}
	return nil
}

// jsonRow is the per-row payload fed to jsonb_to_recordset.
type jsonRow struct {
	CardID        int64           `json:"card_id,string"`
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

		buf, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}

		// One CTE per Run: read prev values, INSERT N activity rows ordered
		// by ord, UPSERT N attribute_value rows. The id-vs-ord correlation
		// works because Postgres allocates activity ids in INSERT order, and
		// our INSERT is "ORDER BY ord"; row_number() windows align them.
		//
		// The CASE in the input CTE canonicalises card_ref / card_ref[]
		// values to JSON numbers so the dispatcher's wire convention
		// (bigint ids as JSON strings) doesn't poison the jsonb store.
		// Reads canonicalise on the query side too, so this is the
		// "close the loop" half: stored values and queried values share
		// the same canonical shape, and equality filters match both
		// seeded (numeric) and UI-written rows.
		const q = `
			WITH input AS (
				SELECT i.ord, i.card_id, ad.id AS attribute_def_id,
				       CASE
				         WHEN ad.value_type = 'card_ref'
				              AND jsonb_typeof(i.value) = 'string'
				              AND (i.value #>> '{}') ~ '^-?\d+$'
				           THEN to_jsonb(((i.value #>> '{}')::bigint))
				         WHEN ad.value_type = 'card_ref[]'
				              AND jsonb_typeof(i.value) = 'array'
				           THEN COALESCE((
				                  SELECT jsonb_agg(
				                           CASE
				                             WHEN jsonb_typeof(e.v) = 'string'
				                                  AND (e.v #>> '{}') ~ '^-?\d+$'
				                               THEN to_jsonb(((e.v #>> '{}')::bigint))
				                             ELSE e.v
				                           END
				                           ORDER BY e.ord)
				                  FROM jsonb_array_elements(i.value)
				                       WITH ORDINALITY AS e(v, ord)),
				                '[]'::jsonb)
				         ELSE i.value
				       END AS value
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
