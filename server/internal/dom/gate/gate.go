// Package gate hosts gate-related endpoints:
//
//   - gate.spawn — process step run after classify. Walks the workflow's
//     gate_template children and inserts a runtime gate sub-card under
//     the parent for each one. Idempotent on (parent, gate_template_ref).
//
// Phase 4 (shared gates) extends the effective-gate resolver consulted
// by the transition guard; this package owns spawn + the lookup helper
// the guard reads.
package gate

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

// ListEffectiveInput selects every effective gate for a parent card,
// including inherited gates from propagating attributes.
type ListEffectiveInput struct {
	CardID int64 `json:"card_id" mcp:"required,desc=parent card to list effective gates for"`
}

// EffectiveGateRow is one effective gate.
type EffectiveGateRow struct {
	ID               int64    `json:"id"`
	Title            string   `json:"title"`
	Status           string   `json:"status"`
	RequiredInStates []string `json:"required_in_states"`
	Source           string   `json:"source"`
	SourceCardID     int64    `json:"source_card_id"`
}

// ListEffectiveOutput is per-input snapshot.
type ListEffectiveOutput struct {
	Rows []EffectiveGateRow `json:"rows"`
}

// SpawnInput tells the dispatcher which parent to spawn gates under.
// The classify process passes the parent's card_id; standalone callers
// supply both card_id and workflow_def_id (for re-bind).
type SpawnInput struct {
	CardID        int64  `json:"card_id" mcp:"required,desc=parent card under which to spawn gates"`
	WorkflowDefID *int64 `json:"workflow_def_id,omitempty" mcp:"desc=workflow_def to spawn from; defaults to the card's workflow_def_ref"`
}

// SpawnOutput surfaces the spawn count.
type SpawnOutput struct {
	Spawned int `json:"spawned" mcp:"desc=number of new gate cards inserted; existing rows are not duplicated"`
}

// Register installs the gate handlers.
func Register(p *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "gate",
		Action:       "spawn",
		Doc:          "Walk the workflow's gate_templates and insert one runtime gate sub-card per template under the given parent. Idempotent.",
		InputType:    reflect.TypeFor[SpawnInput](),
		OutputType:   reflect.TypeFor[SpawnOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "gate.spawn",
		CardTypeID:   cardTypeFromInput,
		Run:          runSpawn(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "gate",
		Action:       "list_effective",
		Doc:          "List effective gates on a parent: private sub-cards plus gates inherited via propagating card_ref attributes.",
		InputType:    reflect.TypeFor[ListEffectiveInput](),
		OutputType:   reflect.TypeFor[ListEffectiveOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Run:          runListEffective(p),
	})
}

func runListEffective(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(ListEffectiveInput)
			gates, err := EffectiveGatesFor(ctx, tx, in.CardID)
			if err != nil {
				return nil, err
			}
			rows := make([]EffectiveGateRow, len(gates))
			for j, g := range gates {
				rows[j] = EffectiveGateRow{
					ID:               g.ID,
					Title:            g.Title,
					Status:           g.Status,
					RequiredInStates: g.RequiredInStates,
					Source:           g.Source,
					SourceCardID:     g.SourceCardID,
				}
			}
			outs[i] = ListEffectiveOutput{Rows: rows}
		}
		if p != nil {
			p.NoteRead()
		}
		return outs, nil
	}
}

func cardTypeFromInput(ctx context.Context, pool reg.ValidationPool, raw any) (int32, error) {
	return schema.CardTypeIDByCardID(ctx, pool, raw.(SpawnInput).CardID)
}

// runSpawn is the per-card spawn pass. Idempotent on
// (parent_card_id, gate_template_ref): re-running does not duplicate.
// arrayPath
func runSpawn(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		actorID := auth.ActorOrSystem(ctx)
		snap, err := schema.Load(ctx, tx)
		if err != nil {
			return nil, err
		}
		gateCT, ok := snap.CardTypeByName["gate"]
		if !ok {
			return nil, fmt.Errorf("gate.spawn: gate card_type missing (migration 0025 not applied?)")
		}
		gateTemplateCT, ok := snap.CardTypeByName["gate_template"]
		if !ok {
			return nil, fmt.Errorf("gate.spawn: gate_template card_type missing")
		}
		titleAttr := snap.AttrByName["title"]
		gateKindAttr := snap.AttrByName["gate_kind"]
		requiredAttr := snap.AttrByName["required_in_states"]
		statusAttr := snap.AttrByName["gate_status"]
		gateTemplateRefAttr := snap.AttrByName["gate_template_ref"]
		assigneeAttr := snap.AttrByName["assignee"]
		defaultAssigneeAttr := snap.AttrByName["default_assignee"]
		workflowRefAttr := snap.AttrByName["workflow_def_ref"]

		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(SpawnInput)
			if in.CardID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "gate.spawn: card_id is required"}
			}
			workflowID := in.WorkflowDefID
			if workflowID == nil {
				// Default to the card's workflow_def_ref.
				var refRaw []byte
				err := tx.QueryRow(ctx, `
					SELECT value FROM attribute_value
					WHERE card_id = $1 AND attribute_def_id = $2
				`, in.CardID, workflowRefAttr.ID).Scan(&refRaw)
				if err == pgx.ErrNoRows {
					outs[i] = SpawnOutput{Spawned: 0}
					continue
				}
				if err != nil {
					return nil, fmt.Errorf("gate.spawn: workflow_def_ref read: %w", err)
				}
				var ref int64
				if err := json.Unmarshal(refRaw, &ref); err != nil {
					return nil, fmt.Errorf("gate.spawn: workflow_def_ref is not int64: %w", err)
				}
				workflowID = &ref
			}

			// Load every gate_template under the workflow_def along with
			// its attribute values.
			rows, err := tx.Query(ctx, `
				SELECT c.id,
				       (SELECT value FROM attribute_value WHERE card_id = c.id AND attribute_def_id = $2) AS title_v,
				       (SELECT value FROM attribute_value WHERE card_id = c.id AND attribute_def_id = $3) AS kind_v,
				       (SELECT value FROM attribute_value WHERE card_id = c.id AND attribute_def_id = $4) AS req_v,
				       (SELECT value FROM attribute_value WHERE card_id = c.id AND attribute_def_id = $5) AS dassign_v
				FROM card c
				WHERE c.parent_card_id = $1
				  AND c.card_type_id = $6
				  AND c.deleted_at IS NULL
			`, *workflowID, titleAttr.ID, gateKindAttr.ID, requiredAttr.ID, defaultAssigneeAttr.ID, gateTemplateCT.ID)
			if err != nil {
				return nil, fmt.Errorf("gate.spawn: load templates: %w", err)
			}
			type template struct {
				ID                 int64
				Title              json.RawMessage
				Kind               json.RawMessage
				RequiredInStates   json.RawMessage
				DefaultAssignee    json.RawMessage
			}
			var templates []template
			for rows.Next() {
				var t template
				if err := rows.Scan(&t.ID, &t.Title, &t.Kind, &t.RequiredInStates, &t.DefaultAssignee); err != nil {
					rows.Close()
					return nil, err
				}
				templates = append(templates, t)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return nil, err
			}

			// Look up which (parent, template) pairs already have a runtime
			// gate so we can skip them.
			existing := map[int64]bool{}
			r2, err := tx.Query(ctx, `
				SELECT (av.value)::text::bigint
				FROM card g
				JOIN attribute_value av ON av.card_id = g.id AND av.attribute_def_id = $1
				WHERE g.parent_card_id = $2
				  AND g.card_type_id = $3
				  AND g.deleted_at IS NULL
			`, gateTemplateRefAttr.ID, in.CardID, gateCT.ID)
			if err != nil {
				return nil, fmt.Errorf("gate.spawn: existing scan: %w", err)
			}
			for r2.Next() {
				var refID int64
				if err := r2.Scan(&refID); err != nil {
					r2.Close()
					return nil, err
				}
				existing[refID] = true
			}
			r2.Close()

			spawned := 0
			for _, t := range templates {
				if existing[t.ID] {
					continue
				}
				// Insert the runtime gate card.
				var newID int64
				if err := tx.QueryRow(ctx, `
					INSERT INTO card (card_type_id, parent_card_id)
					VALUES ($1, $2)
					RETURNING id
				`, gateCT.ID, in.CardID).Scan(&newID); err != nil {
					return nil, fmt.Errorf("gate.spawn: card insert: %w", err)
				}

				// Build the per-attribute writes.
				type writeRow struct {
					CardID int64           `json:"card_id"`
					DefID  int32           `json:"def_id"`
					Value  json.RawMessage `json:"value"`
				}
				writes := []writeRow{}
				if len(t.Title) > 0 {
					writes = append(writes, writeRow{CardID: newID, DefID: titleAttr.ID, Value: t.Title})
				}
				if len(t.Kind) > 0 {
					writes = append(writes, writeRow{CardID: newID, DefID: gateKindAttr.ID, Value: t.Kind})
				}
				if len(t.RequiredInStates) > 0 {
					writes = append(writes, writeRow{CardID: newID, DefID: requiredAttr.ID, Value: t.RequiredInStates})
				}
				if len(t.DefaultAssignee) > 0 {
					writes = append(writes, writeRow{CardID: newID, DefID: assigneeAttr.ID, Value: t.DefaultAssignee})
				}
				ref, _ := json.Marshal(t.ID)
				writes = append(writes, writeRow{CardID: newID, DefID: gateTemplateRefAttr.ID, Value: ref})
				pendingV, _ := json.Marshal("pending")
				writes = append(writes, writeRow{CardID: newID, DefID: statusAttr.ID, Value: pendingV})

				buf, _ := json.Marshal(writes)
				const sqlText = `
					WITH input AS (
						SELECT row_number() OVER () AS ord, *
						FROM jsonb_to_recordset($1::jsonb)
						AS x(card_id bigint, def_id int, value jsonb)
					),
					ins_act AS (
						INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
						SELECT card_id, 'attr_update', def_id, NULL, value, $2
						FROM input ORDER BY ord
						RETURNING id, card_id, attribute_def_id, value_new
					),
					upsert AS (
						INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
						SELECT card_id, attribute_def_id, value_new, id FROM ins_act
						RETURNING card_id
					)
					SELECT count(*) FROM upsert
				`
				var n int64
				if err := tx.QueryRow(ctx, sqlText, buf, actorID).Scan(&n); err != nil {
					return nil, fmt.Errorf("gate.spawn: writes: %w", err)
				}
				// card_create activity for the gate.
				if _, err := tx.Exec(ctx, `
					INSERT INTO activity (card_id, kind, actor_id) VALUES ($1, 'card_create', $2)
				`, newID, actorID); err != nil {
					return nil, fmt.Errorf("gate.spawn: card_create activity: %w", err)
				}
				spawned++
			}
			outs[i] = SpawnOutput{Spawned: spawned}
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}

// EffectiveGates returns gate sub-cards under parentCardID and their
// status + required_in_states. Phase 4 extends this to include
// inherited gates from card_refs marked propagates_gates.
type EffectiveGate struct {
	ID                 int64
	Title              string
	Status             string
	RequiredInStates   []string
	Source             string // "private" or "inherited"
	SourceCardID       int64
}

// EffectiveGatesFor returns every gate effective on the parent: the
// union of direct gate sub-cards (private) and gates inherited from
// cards referenced via attributes flagged propagates_gates (one-hop
// only, see WORKFLOW_SHARED_GATES_PLAN.md).
func EffectiveGatesFor(ctx context.Context, tx pgx.Tx, parentCardID int64) ([]EffectiveGate, error) {
	const q = `
		WITH owners AS (
			SELECT $1::bigint AS owner_id, 'private'::text AS source
			UNION
			SELECT (av.value::text)::bigint AS owner_id, 'inherited'::text AS source
			FROM attribute_value av
			JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE av.card_id = $1
			  AND ad.propagates_gates = true
			  AND ad.value_type = 'card_ref'
			  AND jsonb_typeof(av.value) = 'number'
		)
		SELECT g.id,
		       COALESCE((SELECT value FROM attribute_value av JOIN attribute_def ad ON ad.id=av.attribute_def_id WHERE av.card_id=g.id AND ad.name='title'), to_jsonb('')),
		       COALESCE((SELECT value FROM attribute_value av JOIN attribute_def ad ON ad.id=av.attribute_def_id WHERE av.card_id=g.id AND ad.name='gate_status'), to_jsonb('pending')),
		       COALESCE((SELECT value FROM attribute_value av JOIN attribute_def ad ON ad.id=av.attribute_def_id WHERE av.card_id=g.id AND ad.name='required_in_states'), to_jsonb('')),
		       o.source,
		       g.parent_card_id
		FROM owners o
		JOIN card g ON g.parent_card_id = o.owner_id
		JOIN card_type ct ON ct.id = g.card_type_id
		WHERE ct.name = 'gate'
		  AND g.deleted_at IS NULL
	`
	rows, err := tx.Query(ctx, q, parentCardID)
	if err != nil {
		return nil, fmt.Errorf("gate.EffectiveGatesFor: %w", err)
	}
	defer rows.Close()
	var out []EffectiveGate
	for rows.Next() {
		var (
			id        int64
			titleRaw  []byte
			statusRaw []byte
			reqRaw    []byte
			source    string
			parentID  int64
		)
		if err := rows.Scan(&id, &titleRaw, &statusRaw, &reqRaw, &source, &parentID); err != nil {
			return nil, err
		}
		var title, status string
		_ = json.Unmarshal(titleRaw, &title)
		_ = json.Unmarshal(statusRaw, &status)
		var reqStr string
		_ = json.Unmarshal(reqRaw, &reqStr)
		var req []string
		if reqStr != "" {
			_ = json.Unmarshal([]byte(reqStr), &req)
		}
		out = append(out, EffectiveGate{
			ID:               id,
			Title:            title,
			Status:           status,
			RequiredInStates: req,
			Source:           source,
			SourceCardID:     parentID,
		})
	}
	return out, rows.Err()
}
