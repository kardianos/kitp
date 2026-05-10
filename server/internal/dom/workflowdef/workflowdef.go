// Package workflowdef hosts workflow-related read endpoints and the
// classify handler that binds a card to a workflow_def in one tx.
//
// Registration of the workflow_def card_type itself happens via the
// regular card endpoints — workflow_def is just a card_type whose
// edges (title, states, initial_state) are seeded by migration 0021.
//
// This package contributes:
//   - card.classify — atomic write: set workflow_def_ref + status to the
//     workflow's initial_state + emit a `classified` activity row.
//   - card.blockers — read-only diagnostic: for each outgoing transition
//     from the card's current state, report whether each guard would
//     pass. Drives the "What's blocking me" UI.
package workflowdef

import (
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

// BlockersInput selects a card whose outgoing-transition diagnostics
// should be returned.
type BlockersInput struct {
	CardID int64 `json:"card_id" mcp:"required,desc=card to evaluate blockers for"`
}

// TransitionBlockers reports the diagnostic for one outgoing transition.
type TransitionBlockers struct {
	ToState        string   `json:"to_state"`
	OK             bool     `json:"ok"`
	GatesBlocking  []string `json:"gates_blocking,omitempty"`
	AggregateMsg   string   `json:"aggregate_msg,omitempty"`
	AggregateOK    bool     `json:"aggregate_ok"`
}

// BlockersOutput is the per-call snapshot.
type BlockersOutput struct {
	WorkflowBound bool                 `json:"workflow_bound"`
	CurrentState  string               `json:"current_state"`
	Transitions   []TransitionBlockers `json:"transitions"`
}

// ClassifyInput binds a card to a workflow. The dispatcher writes
// workflow_def_ref + status (to the workflow's initial_state) and emits
// one `classified` activity row, all inside the batch transaction.
//
// initial_state is read from the workflow_def card's `initial_state`
// attribute_value. Phase 3 extends this handler with a gate.spawn step;
// the spawn lives behind workflow_def_ref so when no gate templates
// exist nothing happens.
type ClassifyInput struct {
	CardID         int64 `json:"card_id" mcp:"required,desc=card to classify"`
	WorkflowDefID  int64 `json:"workflow_def_id" mcp:"required,desc=workflow_def card id to bind to"`
}

// ClassifyOutput acks the classification.
type ClassifyOutput struct {
	OK           bool   `json:"ok" mcp:"desc=true on success"`
	InitialState string `json:"initial_state" mcp:"desc=state the card was set to (the workflow's initial_state)"`
}

// Register installs the classify handler.
func Register(p *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "card",
		Action:       "classify",
		Doc:          "Bind a card to a workflow_def: writes workflow_def_ref + status to initial_state, emits a classified activity.",
		InputType:    reflect.TypeFor[ClassifyInput](),
		OutputType:   reflect.TypeFor[ClassifyOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "card.classify",
		CardTypeID:   cardTypeFromInput,
		Run:          runClassify(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "card",
		Action:       "blockers",
		Doc:          "Read-only diagnostic: for each outgoing transition from a card's current state, report which guards would block it.",
		InputType:    reflect.TypeFor[BlockersInput](),
		OutputType:   reflect.TypeFor[BlockersOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Run:          runBlockers(p),
	})
}

func runBlockers(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(BlockersInput)
			out := BlockersOutput{Transitions: []TransitionBlockers{}}

			// Read workflow_def_ref + status off the card.
			var wfRefRaw, statusRaw []byte
			err := tx.QueryRow(ctx, `
				SELECT
				    (SELECT av.value FROM attribute_value av
				       JOIN attribute_def ad ON ad.id = av.attribute_def_id
				       WHERE av.card_id = $1 AND ad.name = 'workflow_def_ref'),
				    (SELECT av.value FROM attribute_value av
				       JOIN attribute_def ad ON ad.id = av.attribute_def_id
				       WHERE av.card_id = $1 AND ad.name = 'status')
			`, in.CardID).Scan(&wfRefRaw, &statusRaw)
			if err != nil {
				return nil, fmt.Errorf("card.blockers: lookup: %w", err)
			}
			if len(wfRefRaw) == 0 || string(wfRefRaw) == "null" {
				outs[i] = out
				continue
			}
			out.WorkflowBound = true
			var wfID int64
			if err := json.Unmarshal(wfRefRaw, &wfID); err != nil {
				outs[i] = out
				continue
			}
			var current string
			_ = json.Unmarshal(statusRaw, &current)
			out.CurrentState = current

			// Effective gates for the card.
			gates, err := gate.EffectiveGatesFor(ctx, tx, in.CardID)
			if err != nil {
				return nil, err
			}
			// Outgoing transitions from current state.
			rows, err := tx.Query(ctx, `
				SELECT to_state, aggregate_guard
				FROM workflow_transition
				WHERE workflow_def_id = $1 AND from_state = $2
				ORDER BY to_state
			`, wfID, current)
			if err != nil {
				return nil, fmt.Errorf("card.blockers: transitions: %w", err)
			}
			type pending struct {
				to    string
				guard json.RawMessage
			}
			var trans []pending
			for rows.Next() {
				var p pending
				var raw json.RawMessage
				if err := rows.Scan(&p.to, &raw); err != nil {
					rows.Close()
					return nil, err
				}
				p.guard = raw
				trans = append(trans, p)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return nil, err
			}

			for _, t := range trans {
				blockers := []string{}
				for _, g := range gates {
					required := false
					for _, s := range g.RequiredInStates {
						if s == t.to {
							required = true
							break
						}
					}
					if required && g.Status != "approved" && g.Status != "n_a" {
						blockers = append(blockers, fmt.Sprintf("%s (%s)", g.Title, g.Status))
					}
				}
				aggOK := true
				aggMsg := ""
				if len(t.guard) > 0 && string(t.guard) != "null" {
					ok, msg, err := workflowtransition.EvaluateGuard(ctx, tx, in.CardID, t.guard)
					if err != nil {
						aggOK = false
						aggMsg = err.Error()
					} else {
						aggOK = ok
						aggMsg = msg
					}
				}
				out.Transitions = append(out.Transitions, TransitionBlockers{
					ToState:       t.to,
					OK:            len(blockers) == 0 && aggOK,
					GatesBlocking: blockers,
					AggregateMsg:  aggMsg,
					AggregateOK:   aggOK,
				})
			}
			outs[i] = out
		}
		if p != nil {
			p.NoteRead()
		}
		return outs, nil
	}
}

func cardTypeFromInput(ctx context.Context, pool reg.ValidationPool, raw any) (int32, error) {
	return schema.CardTypeIDByCardID(ctx, pool, raw.(ClassifyInput).CardID)
}

// runClassify is an arrayPath writer. // arrayPath
func runClassify(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		actorID := auth.ActorOrSystem(ctx)
		snap, err := schema.Load(ctx, tx)
		if err != nil {
			return nil, err
		}
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(ClassifyInput)
			if in.CardID == 0 || in.WorkflowDefID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "card.classify: card_id and workflow_def_id are required"}
			}

			// Fetch the workflow_def card and its initial_state.
			var (
				ctName       string
				wfCardTypeID int32
			)
			err := tx.QueryRow(ctx, `
				SELECT ct.name, c.card_type_id
				FROM card c
				JOIN card_type ct ON ct.id = c.card_type_id
				WHERE c.id = $1
			`, in.WorkflowDefID).Scan(&ctName, &wfCardTypeID)
			if err == pgx.ErrNoRows {
				return nil, &reg.HandlerError{InputIndex: i, Code: "not_found",
					Message: fmt.Sprintf("card.classify: workflow_def %d not found", in.WorkflowDefID)}
			}
			if err != nil {
				return nil, fmt.Errorf("card.classify: workflow_def lookup: %w", err)
			}
			if ctName != "workflow_def" {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "card.classify: workflow_def_id does not point at a workflow_def card"}
			}

			initStateAttr, ok := snap.AttrByName["initial_state"]
			if !ok {
				return nil, fmt.Errorf("card.classify: initial_state attribute_def missing (migration 0021 not applied?)")
			}
			var initialStateRaw json.RawMessage
			if err := tx.QueryRow(ctx, `
				SELECT value FROM attribute_value
				WHERE card_id = $1 AND attribute_def_id = $2
			`, in.WorkflowDefID, initStateAttr.ID).Scan(&initialStateRaw); err != nil {
				if err == pgx.ErrNoRows {
					return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
						Message: "card.classify: workflow_def has no initial_state set"}
				}
				return nil, fmt.Errorf("card.classify: initial_state read: %w", err)
			}
			var initialState string
			if err := json.Unmarshal(initialStateRaw, &initialState); err != nil {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: fmt.Sprintf("card.classify: workflow_def initial_state is not a string: %v", err)}
			}
			if initialState == "" {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "card.classify: workflow_def initial_state is empty"}
			}

			// Resolve the target card's card_type and the workflow_def_ref +
			// status attribute_def_ids.
			var targetCardTypeID int32
			if err := tx.QueryRow(ctx, `SELECT card_type_id FROM card WHERE id = $1`, in.CardID).Scan(&targetCardTypeID); err != nil {
				if err == pgx.ErrNoRows {
					return nil, &reg.HandlerError{InputIndex: i, Code: "not_found",
						Message: fmt.Sprintf("card.classify: card %d not found", in.CardID)}
				}
				return nil, fmt.Errorf("card.classify: card lookup: %w", err)
			}

			workflowRefAttr, ok := snap.AttrByName["workflow_def_ref"]
			if !ok {
				return nil, fmt.Errorf("card.classify: workflow_def_ref attribute_def missing")
			}
			statusAttr, hasStatus := snap.AttrByName["status"]

			// Two attribute_value upserts + activity rows in one CTE.
			type writeRow struct {
				CardID int64           `json:"card_id"`
				DefID  int32           `json:"def_id"`
				Value  json.RawMessage `json:"value"`
			}
			var writes []writeRow
			workflowRefValue, _ := json.Marshal(in.WorkflowDefID)
			writes = append(writes, writeRow{
				CardID: in.CardID,
				DefID:  workflowRefAttr.ID,
				Value:  workflowRefValue,
			})
			if hasStatus {
				v, _ := json.Marshal(initialState)
				writes = append(writes, writeRow{
					CardID: in.CardID,
					DefID:  statusAttr.ID,
					Value:  v,
				})
			}
			buf, _ := json.Marshal(writes)
			const sqlText = `
				WITH input AS (
					SELECT row_number() OVER () AS ord, *
					FROM jsonb_to_recordset($1::jsonb)
					AS x(card_id bigint, def_id int, value jsonb)
				),
				prev AS (
					SELECT i.ord, i.card_id, i.def_id, i.value AS new_v, av.value AS old_v
					FROM input i
					LEFT JOIN attribute_value av
					  ON av.card_id = i.card_id AND av.attribute_def_id = i.def_id
				),
				ins_act AS (
					INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
					SELECT card_id, 'attr_update', def_id, old_v, new_v, $2
					FROM prev ORDER BY ord
					RETURNING id, card_id, attribute_def_id, value_new
				),
				upsert AS (
					INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
					SELECT card_id, attribute_def_id, value_new, id FROM ins_act
					ON CONFLICT (card_id, attribute_def_id) DO UPDATE
						SET value = EXCLUDED.value,
						    last_activity_id = EXCLUDED.last_activity_id
					RETURNING card_id, attribute_def_id
				)
				SELECT count(*) FROM upsert
			`
			var n int64
			if err := tx.QueryRow(ctx, sqlText, buf, actorID).Scan(&n); err != nil {
				return nil, fmt.Errorf("card.classify: writes: %w", err)
			}

			// Emit a single `classified` activity row carrying workflow_def_ref
			// for the audit trail (separate from the per-attribute attr_update
			// rows above).
			if _, err := tx.Exec(ctx, `
				INSERT INTO activity (card_id, kind, attribute_def_id, value_new, actor_id)
				VALUES ($1, 'classified', $2, $3, $4)
			`, in.CardID, workflowRefAttr.ID, workflowRefValue, actorID); err != nil {
				return nil, fmt.Errorf("card.classify: classified activity: %w", err)
			}

			// Materialise the workflow's gate sub-cards on the classified card
			// in the same tx. SpawnFor is idempotent so a reclassify call
			// won't duplicate gates already present.
			wfID := in.WorkflowDefID
			if _, err := gate.SpawnFor(ctx, tx, in.CardID, &wfID); err != nil {
				return nil, fmt.Errorf("card.classify: spawn gates: %w", err)
			}

			// Suppress unused-variable warnings.
			_ = targetCardTypeID
			_ = wfCardTypeID

			outs[i] = ClassifyOutput{OK: true, InitialState: initialState}
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}
