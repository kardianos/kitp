// Package card holds card.insert and card.select.
//
// Both writers funnel through jsonb_to_recordset (N-SRV-4); the array path
// is tagged with "// arrayPath" comments so the next phase can grep for
// "non-array" writers in CI.
package card

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"reflect"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

// isJSONNull reports whether raw is a JSON null literal (or empty).
// Mirrors attribute.isJSONNull; copied here to keep the card package
// free of a cyclic dep on attribute for one helper.
func isJSONNull(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return true
	}
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

// InsertInput is the wire shape for one row of card.insert. ParentCardID
// is nil for top-level cards (projects).
//
// Title is shorthand for the built-in title attribute. Attributes is an
// optional map of additional attribute writes that fire as part of the
// same insert; together with Title they go through the
// attribute_value+activity pipeline so the activity stream shows
// kind='card_create' plus one kind='attr_update' per initial attribute.
type InsertInput struct {
	CardTypeName string                     `json:"card_type_name" mcp:"required,desc=name of the card_type to create (e.g. project, task)"`
	ParentCardID *int64                     `json:"parent_card_id,string,omitempty" mcp:"desc=parent card id; nil for top-level project cards"`
	Title        string                     `json:"title" mcp:"required,desc=value for the built-in title attribute"`
	Attributes   map[string]json.RawMessage `json:"attributes,omitempty" mcp:"desc=optional map of additional attribute name to JSON value"`
	// Optional initial value for the structural `phase` column. Empty
	// means "let the column default apply" (triage). When set, must be
	// one of triage|active|terminal — `phase` is otherwise unreachable
	// because it doesn't live in attribute_value.
	Phase string `json:"phase,omitempty" mcp:"desc=initial phase for value-cards; one of triage|active|terminal (defaults to triage)"`
}

// InsertOutput carries the new row id.
type InsertOutput struct {
	ID int64 `json:"id,string" mcp:"desc=id of the newly inserted card row"`
}

// SelectInput filters cards by parent and/or type. Both fields are optional;
// no fields means "all top-level cards" (parent IS NULL).
type SelectInput struct {
	ParentCardID *int64  `json:"parent_card_id,string,omitempty" mcp:"desc=if set, return only cards with this parent_card_id"`
	CardTypeName *string `json:"card_type_name,omitempty" mcp:"desc=if set, return only cards of this card_type"`
}

// CardRow is a card record with its title flattened in for convenience.
type CardRow struct {
	ID           int64   `json:"id,string" mcp:"desc=card id"`
	CardTypeID   int64   `json:"card_type_id,string" mcp:"desc=card_type id"`
	CardTypeName string  `json:"card_type_name" mcp:"desc=card_type name"`
	ParentCardID *int64  `json:"parent_card_id,string,omitempty" mcp:"desc=parent card id, if any"`
	Title        *string `json:"title,omitempty" mcp:"desc=convenience copy of the title attribute"`
}

// SelectOutput is one row's worth — every input gets a snapshot.
type SelectOutput struct {
	Rows []CardRow `json:"rows" mcp:"desc=matching card rows"`
}

// jsonInsertRow is the on-the-wire row shape we feed into jsonb_to_recordset.
// We resolve names to ids in Go (to give clean error messages) but the
// actual INSERT still uses the array path.
type jsonInsertRow struct {
	CardTypeID   int64  `json:"card_type_id,string"`
	ParentCardID *int64 `json:"parent_card_id,string,omitempty"`
	// Empty string means "use the column default" (triage). The INSERT
	// CTE substitutes NULLIF('', '') → NULL → DEFAULT so unset rows
	// keep their behaviour.
	Phase string `json:"phase,omitempty"`
}

// Register installs every card.* handler. The pool reference lets the
// writers note one statement-group per Run for the write counter.
func Register(p *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:   "card",
		Action:     "insert",
		Doc:        "Insert a new card with the given card_type, optional parent, and initial title plus attributes.",
		InputType:  reflect.TypeFor[InsertInput](),
		OutputType: reflect.TypeFor[InsertOutput](),
		// Worker can insert tasks; manager/admin can insert any card type.
		// The handler / scope authz enforces card-type-specific limits;
		// this list is the broadest set of roles that may reach the
		// handler at all.
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "card.create",
		CardTypeID:   cardTypeFromName,
		Run:          runInsert(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "card",
		Action:       "select",
		Doc:          "List cards filtered by optional parent and card_type; soft-deleted rows are excluded.",
		InputType:    reflect.TypeFor[SelectInput](),
		OutputType:   reflect.TypeFor[SelectOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Run:          runSelect(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "card",
		Action:       "select_with_attributes",
		Doc:          "Select cards plus their full attribute set in one round-trip; supports filters and ordering for grids and kanbans.",
		InputType:    reflect.TypeFor[SelectWithAttributesInput](),
		OutputType:   reflect.TypeFor[SelectWithAttributesOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Run:          runSelectWithAttributes(p),
	})
	RegisterSearch(p)
	RegisterMoveDelete(p)
	RegisterSetPhase(p)
}

// cardTypeFromName resolves the card_type_id for an InsertInput.
func cardTypeFromName(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	in := raw.(InsertInput)
	if in.CardTypeName == "" {
		return 0, nil
	}
	var id int64
	row := pool.QueryRow(ctx, `SELECT id FROM card_type WHERE name = $1`, in.CardTypeName)
	if err := row.Scan(&id); err != nil {
		return 0, nil
	}
	return id, nil
}

// runInsert is an arrayPath writer. It runs at most two statement groups
// per Run: (1) the card INSERT, (2) a CTE that writes one card_create
// activity per inserted card plus one attr_update activity + one
// attribute_value upsert per initial attribute. // arrayPath
func runInsert(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		actorID := auth.ActorOrSystem(ctx)
		snap, err := schema.Load(ctx, tx)
		if err != nil {
			return nil, err
		}

		// Pre-collect parent ids so we can validate parent-type rules.
		parentLookups := make(map[int64]int64) // parent_id -> card_type_id
		for _, raw := range ins {
			in := raw.(InsertInput)
			if in.ParentCardID != nil {
				parentLookups[*in.ParentCardID] = 0
			}
		}
		if len(parentLookups) > 0 {
			ids := make([]int64, 0, len(parentLookups))
			for id := range parentLookups {
				ids = append(ids, id)
			}
			rows, err := tx.Query(ctx, `SELECT id, card_type_id FROM card WHERE id = ANY($1::bigint[])`, ids)
			if err != nil {
				return nil, fmt.Errorf("card.insert: parent lookup: %w", err)
			}
			for rows.Next() {
				var pid int64
				var ctid int64
				if err := rows.Scan(&pid, &ctid); err != nil {
					rows.Close()
					return nil, err
				}
				parentLookups[pid] = ctid
			}
			rows.Close()
		}

		// Validate every input. Build the insert payload and a parallel
		// flat list of (input_index, attr_name, value) tuples that the
		// follow-up CTE will turn into activity + attribute_value rows.
		payload := make([]jsonInsertRow, len(ins))
		type initAttr struct {
			InputIndex     int
			AttributeDefID int64
			Value          json.RawMessage
		}
		var initialAttrs []initAttr
		for i, raw := range ins {
			in := raw.(InsertInput)
			ct, ok := snap.CardTypeByName[in.CardTypeName]
			if !ok {
				return nil, &reg.HandlerError{InputIndex: i, Code: "unknown_card_type",
					Message: fmt.Sprintf("card.insert: unknown card_type_name %q", in.CardTypeName)}
			}
			if in.Title == "" {
				return nil, &reg.HandlerError{InputIndex: i, Code: "missing_required",
					Message: "card.insert: title is required (built-in edge)"}
			}
			if in.ParentCardID == nil {
				if ct.ParentCardTypeID != nil {
					return nil, &reg.HandlerError{InputIndex: i, Code: "edge_violation",
						Message: fmt.Sprintf("card.insert: card_type %q requires a parent", in.CardTypeName)}
				}
			} else {
				parentTypeID, parentExists := parentLookups[*in.ParentCardID]
				if !parentExists || parentTypeID == 0 {
					return nil, &reg.HandlerError{InputIndex: i, Code: "parent_not_found",
						Message: fmt.Sprintf("card.insert: parent_card_id %d not found", *in.ParentCardID)}
				}
				if !snap.ParentAllowed(ct, parentTypeID) {
					parentName := ""
					if pt, ok := snap.CardTypeByID[parentTypeID]; ok {
						parentName = pt.Name
					}
					return nil, &reg.HandlerError{InputIndex: i, Code: "edge_violation",
						Message: fmt.Sprintf("card.insert: card_type %q is not allowed under parent type %q",
							in.CardTypeName, parentName)}
				}
			}
			if in.Phase != "" && !IsValidPhase(in.Phase) {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: fmt.Sprintf("card.insert: phase %q: must be triage|active|terminal", in.Phase)}
			}
			payload[i] = jsonInsertRow{CardTypeID: ct.ID, ParentCardID: in.ParentCardID, Phase: in.Phase}

			// Validate + collect title and any additional initial attributes.
			titleEdge, _, ok := snap.EdgeFor(ct.ID, "title")
			if !ok {
				return nil, fmt.Errorf("card.insert: card_type %q lacks a title edge", in.CardTypeName)
			}
			titleJSON, err := json.Marshal(in.Title)
			if err != nil {
				return nil, err
			}
			initialAttrs = append(initialAttrs, initAttr{
				InputIndex:     i,
				AttributeDefID: titleEdge.AttributeDefID,
				Value:          titleJSON,
			})
			for name, raw := range in.Attributes {
				if name == "title" {
					// Title is set above; ignore to avoid duplicate rows.
					continue
				}
				_, ad, ok := snap.EdgeFor(ct.ID, name)
				if !ok {
					return nil, &reg.HandlerError{InputIndex: i, Code: "edge_violation",
						Message: fmt.Sprintf("card.insert: attribute %q is not allowed on card_type %q",
							name, in.CardTypeName)}
				}
				val := raw
				if len(val) == 0 {
					val = json.RawMessage(`null`)
				}
				initialAttrs = append(initialAttrs, initAttr{
					InputIndex:     i,
					AttributeDefID: ad.ID,
					Value:          val,
				})
			}

			// Gate 6: enforce required-attribute presence at the
			// card.insert boundary. Every edge with is_required=TRUE
			// for this card_type must have a non-null value in the
			// payload. Title is always written above (the handler
			// rejects an empty Title earlier), so the loop only
			// catches non-title required edges: today that's
			// (task, status). Future card types with required edges
			// pick this up automatically.
			//
			// This keeps card.insert honest about "the caller
			// provides every required attribute": the client-side
			// default-create-status chain resolves it, but if a
			// future MCP / external caller bypasses the chain the
			// task creation fails at the boundary with a clear
			// error rather than landing a half-formed row.
			presentByDef := map[int64]bool{}
			for _, a := range initialAttrs {
				if a.InputIndex != i {
					continue
				}
				if isJSONNull(a.Value) {
					continue
				}
				presentByDef[a.AttributeDefID] = true
			}
			for _, e := range snap.EdgesByCardTypeID[ct.ID] {
				if !e.IsRequired {
					continue
				}
				if presentByDef[e.AttributeDefID] {
					continue
				}
				ad, ok := snap.AttrByID[e.AttributeDefID]
				if !ok {
					continue
				}
				return nil, &reg.HandlerError{InputIndex: i, Code: "edge_violation",
					Message: fmt.Sprintf(
						"card.insert: attribute %q is required on card_type %q",
						ad.Name, in.CardTypeName)}
			}
		}

		// Per-project reference scope: every card_ref / card_ref[] initial
		// attribute value must point at a card under the new card's
		// enclosing project (or at a global card like a person — those
		// are wildcards). The to-be-inserted card has no id yet, so the
		// scope walk starts from parent_card_id. Top-level inserts skip
		// the check because the enclosing-project notion doesn't apply
		// (projects and other root-level types either have global refs
		// like assignee, or no refs at all).
		var scopeChecks []attribute.ProjectScopeCheck
		for _, a := range initialAttrs {
			ad, ok := snap.AttrByID[a.AttributeDefID]
			if !ok {
				continue
			}
			if ad.ValueType != "card_ref" && ad.ValueType != "card_ref[]" {
				continue
			}
			valueIDs, err := attribute.ParseCardRefValue(ad.Name, a.Value)
			if err != nil {
				return nil, &reg.HandlerError{InputIndex: a.InputIndex, Code: "validation",
					Message: fmt.Sprintf("card.insert: %v", err)}
			}
			if len(valueIDs) == 0 {
				continue
			}
			parent := ins[a.InputIndex].(InsertInput).ParentCardID
			if parent == nil {
				// Top-level card — its enclosing "project" is itself
				// (when it IS a project) or null. The scope helper
				// handles global-vs-scoped via wildcard semantics, so
				// we just skip the check entirely here.
				continue
			}
			scopeChecks = append(scopeChecks, attribute.ProjectScopeCheck{
				StartCardID:      *parent,
				AttributeName:    ad.Name,
				ValueCardIDs:     valueIDs,
				InputIndex:       a.InputIndex,
				TargetCardTypeID: ad.TargetCardTypeID,
			})
		}
		if err := attribute.ValidateProjectScope(ctx, tx, scopeChecks); err != nil {
			return nil, err
		}

		buf, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}

		// Statement 1: coalesced INSERT into card. Phase is optional;
		// an empty string in the payload becomes NULL via NULLIF, and
		// COALESCE(NULL, 'triage') keeps the column default behaviour
		// for callers that don't set it.
		const insertSQL = `
			WITH input AS (
				SELECT row_number() OVER () AS ord, *
				FROM jsonb_to_recordset($1::jsonb)
				AS x(card_type_id int, parent_card_id bigint, phase text)
			)
			INSERT INTO card (card_type_id, parent_card_id, phase)
			SELECT card_type_id, parent_card_id, COALESCE(NULLIF(phase, ''), 'triage')
			FROM input ORDER BY ord
			RETURNING id
		`
		rows, err := tx.Query(ctx, insertSQL, buf)
		if err != nil {
			return nil, fmt.Errorf("card.insert: %w", err)
		}
		ids := make([]int64, 0, len(ins))
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return nil, err
			}
			ids = append(ids, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		if len(ids) != len(ins) {
			return nil, fmt.Errorf("card.insert: returned %d ids for %d inputs", len(ids), len(ins))
		}
		if p != nil {
			p.NoteWrite()
		}

		// Statement 2: card_create activity per card + attr_update activity
		// + attribute_value upsert per initial attribute, all in one CTE.
		// jsonInitAttr binds input slot -> card id via the ids slice.
		type jsonInitAttr struct {
			CardID         int64           `json:"card_id,string"`
			AttributeDefID int64           `json:"attribute_def_id,string"`
			Value          json.RawMessage `json:"value"`
		}
		attrPayload := make([]jsonInitAttr, len(initialAttrs))
		for i, a := range initialAttrs {
			// Canonicalise card_ref / card_ref[] values to JSON numbers
			// so the demo seed (numeric) and the UI-initiated insert
			// (string-form) end up with the same jsonb shape — the read
			// path's predicate compiler also canonicalises, so any
			// subsequent filter matches both seeded and UI-written rows.
			value := a.Value
			if ad, ok := snap.AttrByID[a.AttributeDefID]; ok {
				value = snap.CanonicalizeValue(ad.Name, value)
			}
			attrPayload[i] = jsonInitAttr{
				CardID:         ids[a.InputIndex],
				AttributeDefID: a.AttributeDefID,
				Value:          value,
			}
		}
		attrBuf, err := json.Marshal(attrPayload)
		if err != nil {
			return nil, err
		}
		// One statement: insert N card_create activities + M attr_update
		// activities + M attribute_value upserts. RETURNING from the
		// modifying CTE carries the activity id we just allocated, which
		// becomes attribute_value.last_activity_id.
		const createSQL = `
			WITH cards_input AS (
				SELECT unnest($1::bigint[]) AS card_id
			),
			ins_create AS (
				INSERT INTO activity (card_id, kind, actor_id)
				SELECT card_id, 'card_create', $3 FROM cards_input
				RETURNING id
			),
			attrs_input AS (
				SELECT row_number() OVER () AS ord, *
				FROM jsonb_to_recordset($2::jsonb)
				AS x(card_id bigint, attribute_def_id int, value jsonb)
			),
			ins_attr_act AS (
				INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
				SELECT card_id, 'attr_update', attribute_def_id, NULL, value, $3
				FROM attrs_input
				ORDER BY ord
				RETURNING id, card_id, attribute_def_id, value_new
			),
			upsert AS (
				INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
				SELECT card_id, attribute_def_id, value_new, id FROM ins_attr_act
				ON CONFLICT (card_id, attribute_def_id) DO UPDATE
					SET value = EXCLUDED.value,
					    last_activity_id = EXCLUDED.last_activity_id
				RETURNING card_id, attribute_def_id
			)
			SELECT
				(SELECT count(*) FROM ins_create) AS n_create,
				(SELECT count(*) FROM upsert)     AS n_upsert
		`
		var nCreate, nUpsert int64
		err = tx.QueryRow(ctx, createSQL, ids, attrBuf, actorID).Scan(&nCreate, &nUpsert)
		if err != nil {
			return nil, fmt.Errorf("card.insert: activity: %w", err)
		}
		if int(nCreate) != len(ins) || int(nUpsert) != len(initialAttrs) {
			return nil, fmt.Errorf("card.insert: activity counts mismatch (cards=%d/%d attrs=%d/%d)",
				nCreate, len(ins), nUpsert, len(initialAttrs))
		}
		if p != nil {
			p.NoteWrite()
		}

		outs := make([]any, len(ins))
		for i, id := range ids {
			outs[i] = InsertOutput{ID: id}
		}

		// Per-card_type post-insert hooks. Today the only hook is
		// "freshly-created project → seed its built-in screens"; if
		// another card_type ever needs the same treatment, factor the
		// dispatch into a table keyed by card_type name.
		for i, raw := range ins {
			in := raw.(InsertInput)
			if in.CardTypeName != "project" {
				continue
			}
			if err := seedProjectScreens(ctx, tx, ids[i], actorID, snap); err != nil {
				return nil, err
			}
		}

		return outs, nil
	}
}

// SelectInput.ParentCardID semantics:
//   - nil  → do not filter on parent (return rows regardless of parent).
//     Listing top-level projects is done by setting CardTypeName="project";
//     in v1 every project has parent IS NULL, so that's enough.
//   - non-nil → return rows whose parent_card_id equals that value.
func runSelect(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(SelectInput)
			rows, err := tx.Query(ctx, `
				SELECT c.id, c.card_type_id, ct.name, c.parent_card_id
				FROM card c
				JOIN card_type ct ON ct.id = c.card_type_id
				WHERE c.deleted_at IS NULL
				  AND ($1::bigint IS NULL OR c.parent_card_id = $1)
				  AND ($2::text   IS NULL OR ct.name         = $2)
				ORDER BY c.id
			`, in.ParentCardID, in.CardTypeName)
			if err != nil {
				return nil, err
			}
			if p != nil {
				p.NoteRead()
			}
			var out []CardRow
			for rows.Next() {
				var r CardRow
				if err := rows.Scan(&r.ID, &r.CardTypeID, &r.CardTypeName, &r.ParentCardID); err != nil {
					rows.Close()
					return nil, err
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

