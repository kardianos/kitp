// Package projectstamp implements Gate 10 of FLOW_AND_SCREEN_KERNEL.md:
// the project.stamp handler that produces a fresh project by graph-copying
// a template project (a project card with is_template=true).
//
// Stamping is a single-transaction copy of the template's structural
// graph — value cards (statuses, milestones, components, tags), screen
// cards and their filter children, flow rows scoped to the template, and
// flow_step rows under those flows. The new project's title comes from
// the handler input; everything else is copied with new ids and the
// internal references between rows (card_ref attribute values, flow
// from/to references, screen flow_ref / default_filter / default_create_status,
// and filter-card predicate JSON) is rewritten through the same in-memory
// id remap so the new project's cards reference each other.
//
// Deliberately NOT copied (FLOW_AND_SCREEN_KERNEL §"Project templates"):
//   - task cards and their attribute_values
//   - comment_body rows and activity rows
//   - user_card_sort, user_card_agent (per-user state)
//   - attribute_value rows on the template project itself (the new
//     project's own attributes are managed via the standard
//     attribute.update path; only the title is stamped on creation)
//
// Authz: manager / admin (V26). Workers cannot stamp new projects.
//
// The project card is inserted directly (skipping the card.insert handler
// and its post-insert screen-seed hook). The template carries its own
// screen cards via the descendant copy; firing the auto-seeded
// inbox/grid/kanban/project_detail set on top would double-up.
package projectstamp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strconv"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

// StampInput names the template to copy and the title for the fresh
// project. The template_project_id must point at an existing project
// card (is_template is not enforced — a normal project can be stamped
// as a starting shape; V24 covers the empty-template degenerate case).
type StampInput struct {
	TemplateProjectID int64  `json:"template_project_id,string" mcp:"required,desc=id of the project card to use as the source template"`
	Name              string `json:"name" mcp:"required,desc=title for the new project card"`
}

// StampOutput surfaces the new project's id plus a Warnings field so
// callers can show V24-style hints (e.g., "template had no screens").
type StampOutput struct {
	NewProjectID int64    `json:"new_project_id,string" mcp:"desc=id of the freshly stamped project"`
	Warnings     []string `json:"warnings,omitempty" mcp:"desc=non-fatal advisories about the template (e.g. empty template)"`
}

// Register installs the project.stamp handler.
func Register(p *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "project",
		Action:       "stamp",
		Doc:          "Create a fresh project by graph-copying a template project's value cards, screens, filters, flows, and flow_steps with ID remapping. Tasks, comments, activity, and per-user state are not copied (FLOW_AND_SCREEN_KERNEL §Project templates / Gate 10).",
		InputType:    reflect.TypeFor[StampInput](),
		OutputType:   reflect.TypeFor[StampOutput](),
		AllowedRoles: []string{"manager", "admin"},
		Run:          runStamp(p),
	})
}

// runStamp is the single-input handler entry. The graph copy is
// atomic — every row goes through the same tx and rolls back together.
func runStamp(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		actorID := auth.ActorOrSystem(ctx)
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(StampInput)
			if in.TemplateProjectID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "project.stamp: template_project_id is required"}
			}
			if in.Name == "" {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "project.stamp: name is required"}
			}
			out, err := stampOne(ctx, tx, actorID, in)
			if err != nil {
				if he, ok := err.(*reg.HandlerError); ok {
					he.InputIndex = i
					return nil, he
				}
				return nil, err
			}
			outs[i] = out
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}

// templateCard captures one row from the template's descendant set —
// every non-task card under the template project, in BFS order so
// parents are processed before children.
type templateCard struct {
	ID           int64
	CardTypeID   int64
	CardTypeName string
	ParentID     *int64
	Phase        string
}

// stampOne does the actual work. The function is sequential and split
// into clearly named phases so the test failure messages point at the
// step that broke.
func stampOne(ctx context.Context, tx pgx.Tx, actorID int64, in StampInput) (StampOutput, error) {
	snap, err := schema.Load(ctx, tx)
	if err != nil {
		return StampOutput{}, fmt.Errorf("project.stamp: schema load: %w", err)
	}

	projectCT, ok := snap.CardTypeByName["project"]
	if !ok {
		return StampOutput{}, fmt.Errorf("project.stamp: card_type 'project' missing")
	}
	taskCT, hasTask := snap.CardTypeByName["task"]

	// 1. Verify template exists and is a project card.
	var templateTypeID int64
	if err := tx.QueryRow(ctx, `
		SELECT card_type_id FROM card WHERE id = $1 AND deleted_at IS NULL
	`, in.TemplateProjectID).Scan(&templateTypeID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return StampOutput{}, &reg.HandlerError{Code: "template_not_found",
				Message: fmt.Sprintf("project.stamp: template project %d not found", in.TemplateProjectID)}
		}
		return StampOutput{}, fmt.Errorf("project.stamp: lookup template: %w", err)
	}
	if templateTypeID != projectCT.ID {
		return StampOutput{}, &reg.HandlerError{Code: "template_not_project",
			Message: fmt.Sprintf("project.stamp: card %d is not a project", in.TemplateProjectID)}
	}

	// 2. Create the new project card. We insert directly (skipping the
	// card.insert handler) so the per-project auto-seeded inbox/grid/
	// kanban/project_detail screens don't appear — the stamp brings its
	// own screens from the template. The activity row + title attribute_value
	// are still emitted so the audit trail and downstream UI behave the same.
	newProjectID, err := insertCardWithTitle(ctx, tx, projectCT.ID, nil, in.Name, actorID, snap)
	if err != nil {
		return StampOutput{}, fmt.Errorf("project.stamp: new project: %w", err)
	}

	// 3. Walk the template's descendants (excluding tasks) and copy them.
	// remap[oldCardID] = newCardID for every copied card. The template's
	// own id maps to the new project id — predicate leaves that point at
	// the template directly (rare; V25 case 3) rewrite to the new project.
	remap := map[int64]int64{in.TemplateProjectID: newProjectID}

	taskExcludeID := int64(0)
	if hasTask {
		taskExcludeID = taskCT.ID
	}

	descendants, err := loadDescendants(ctx, tx, in.TemplateProjectID, taskExcludeID)
	if err != nil {
		return StampOutput{}, fmt.Errorf("project.stamp: load descendants: %w", err)
	}

	// 4. For each descendant copy the card row (deferring attribute_value
	// rows so we have the full remap before rewriting card_ref values).
	for _, src := range descendants {
		var parentID *int64
		if src.ParentID != nil {
			if mapped, ok := remap[*src.ParentID]; ok {
				v := mapped
				parentID = &v
			} else {
				// Should not happen: BFS guarantees parent comes first.
				return StampOutput{}, fmt.Errorf(
					"project.stamp: descendant %d has parent %d that was not copied",
					src.ID, *src.ParentID)
			}
		}
		var newID int64
		if err := tx.QueryRow(ctx, `
			INSERT INTO card (card_type_id, parent_card_id, phase) VALUES ($1, $2, $3) RETURNING id
		`, src.CardTypeID, parentID, src.Phase).Scan(&newID); err != nil {
			return StampOutput{}, fmt.Errorf("project.stamp: copy card %d: %w", src.ID, err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO activity (card_id, kind, actor_id) VALUES ($1, 'card_create', $2)
		`, newID, actorID); err != nil {
			return StampOutput{}, fmt.Errorf("project.stamp: copy card_create activity: %w", err)
		}
		remap[src.ID] = newID
	}

	// 5. Copy flow rows scoped to the template (each project may have
	// multiple flows when multiple attribute_defs are flow-bound).
	flowRemap, err := copyFlows(ctx, tx, in.TemplateProjectID, newProjectID, remap)
	if err != nil {
		return StampOutput{}, fmt.Errorf("project.stamp: flows: %w", err)
	}
	if err := copyFlowSteps(ctx, tx, flowRemap, remap); err != nil {
		return StampOutput{}, fmt.Errorf("project.stamp: flow_steps: %w", err)
	}

	// 6. Copy attribute_value rows for every descendant. Card_ref / card_ref[]
	// values get remapped; filter-card predicate JSON gets predicate-tree
	// remap. flow_ref (number → flow id) is remapped via flowRemap.
	if err := copyAttributeValues(ctx, tx, descendants, remap, flowRemap, actorID, snap); err != nil {
		return StampOutput{}, fmt.Errorf("project.stamp: attribute_values: %w", err)
	}

	out := StampOutput{NewProjectID: newProjectID}
	if len(descendants) == 0 {
		out.Warnings = append(out.Warnings, "template_empty: no value cards, screens, or filter cards were copied (V24)")
	}
	if len(flowRemap) == 0 && len(descendants) > 0 {
		// Descendants but no flow — usable but probably an oversight.
		out.Warnings = append(out.Warnings, "template_no_flows: template carried no flow rows; new project has no transition gating")
	}
	return out, nil
}

// loadDescendants returns every non-deleted descendant of root in BFS
// order (parents before children), excluding cards of card_type taskCTID
// when taskCTID != 0. The recursive CTE handles arbitrary nesting; for
// a template the depth is typically 2 (screens) or 3 (filters under
// screens), so the descend is cheap.
func loadDescendants(ctx context.Context, tx pgx.Tx, root, taskCTID int64) ([]templateCard, error) {
	rows, err := tx.Query(ctx, `
		WITH RECURSIVE walk AS (
			SELECT id, card_type_id, parent_card_id, phase, 1 AS depth
			FROM card
			WHERE parent_card_id = $1 AND deleted_at IS NULL
			UNION ALL
			SELECT c.id, c.card_type_id, c.parent_card_id, c.phase, w.depth + 1
			FROM card c
			JOIN walk w ON w.id = c.parent_card_id
			WHERE c.deleted_at IS NULL
		)
		SELECT w.id, w.card_type_id, ct.name, w.parent_card_id, w.phase, w.depth
		FROM walk w
		JOIN card_type ct ON ct.id = w.card_type_id
		WHERE ($2::bigint = 0 OR w.card_type_id <> $2::bigint)
		ORDER BY w.depth, w.id
	`, root, taskCTID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []templateCard
	for rows.Next() {
		var tc templateCard
		var depth int
		if err := rows.Scan(&tc.ID, &tc.CardTypeID, &tc.CardTypeName, &tc.ParentID, &tc.Phase, &depth); err != nil {
			return nil, err
		}
		out = append(out, tc)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// copyFlows replicates flow rows whose scope is the template into the
// new project. default_create_status_id is remapped via the value-card
// remap (which the caller populated before calling here). Returns
// oldFlowID → newFlowID.
func copyFlows(ctx context.Context, tx pgx.Tx, oldProject, newProject int64, remap map[int64]int64) (map[int64]int64, error) {
	rows, err := tx.Query(ctx, `
		SELECT id, name, doc, attribute_def_id, default_create_status_id
		FROM flow
		WHERE scope_card_id = $1
	`, oldProject)
	if err != nil {
		return nil, err
	}
	type srcFlow struct {
		ID            int64
		Name          string
		Doc           *string
		AttrDefID     int64
		DefaultStatus *int64
	}
	var src []srcFlow
	for rows.Next() {
		var f srcFlow
		if err := rows.Scan(&f.ID, &f.Name, &f.Doc, &f.AttrDefID, &f.DefaultStatus); err != nil {
			rows.Close()
			return nil, err
		}
		src = append(src, f)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := map[int64]int64{}
	for _, f := range src {
		var newDefault *int64
		if f.DefaultStatus != nil {
			if mapped, ok := remap[*f.DefaultStatus]; ok {
				v := mapped
				newDefault = &v
			}
			// If the default points outside the template's value cards
			// (unusual but legal — pass through), the FK would fail. Skip
			// the assignment so the insert succeeds; the admin can fix it
			// post-stamp.
		}
		var newID int64
		err := tx.QueryRow(ctx, `
			INSERT INTO flow (name, doc, attribute_def_id, scope_card_id, default_create_status_id)
			VALUES ($1, $2, $3, $4, $5) RETURNING id
		`, f.Name, f.Doc, f.AttrDefID, newProject, newDefault).Scan(&newID)
		if err != nil {
			return nil, fmt.Errorf("copy flow %d: %w", f.ID, err)
		}
		out[f.ID] = newID
	}
	return out, nil
}

// copyFlowSteps replicates flow_step rows under every flow named by
// flowRemap. from/to card ids are remapped via the value-card remap.
// requires_role_id is left as-is (roles are install-global; new project
// uses the same roles).
func copyFlowSteps(ctx context.Context, tx pgx.Tx, flowRemap, cardRemap map[int64]int64) error {
	for oldFlowID, newFlowID := range flowRemap {
		rows, err := tx.Query(ctx, `
			SELECT id, from_card_id, to_card_id, label, requires_role_id, sort_order
			FROM flow_step WHERE flow_id = $1
		`, oldFlowID)
		if err != nil {
			return err
		}
		type srcStep struct {
			ID         int64
			From, To   int64
			Label      string
			RoleID     *int64
			SortOrder  int32
		}
		var src []srcStep
		for rows.Next() {
			var s srcStep
			if err := rows.Scan(&s.ID, &s.From, &s.To, &s.Label, &s.RoleID, &s.SortOrder); err != nil {
				rows.Close()
				return err
			}
			src = append(src, s)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, s := range src {
			from, fok := cardRemap[s.From]
			to, tok := cardRemap[s.To]
			if !fok || !tok {
				// from/to points outside the template's value cards.
				// Skip — the admin can re-add the missing transitions
				// after the stamp. (Defensive; in well-formed templates
				// every from/to lives inside the project scope.)
				continue
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO flow_step (flow_id, from_card_id, to_card_id, label, requires_role_id, sort_order)
				VALUES ($1, $2, $3, $4, $5, $6)
			`, newFlowID, from, to, s.Label, s.RoleID, s.SortOrder); err != nil {
				return fmt.Errorf("copy flow_step %d: %w", s.ID, err)
			}
		}
	}
	return nil
}

// copyAttributeValues walks every descendant card and replicates its
// attribute_value rows with the appropriate remap applied per
// (attribute_def, value_type). The activity-row pattern matches
// screen_seed.writeAttr — one attr_update per attribute write so the
// audit trail mirrors the original.
func copyAttributeValues(
	ctx context.Context,
	tx pgx.Tx,
	descendants []templateCard,
	cardRemap, flowRemap map[int64]int64,
	actorID int64,
	snap *schema.Snapshot,
) error {
	for _, src := range descendants {
		newID := cardRemap[src.ID]
		rows, err := tx.Query(ctx, `
			SELECT attribute_def_id, value FROM attribute_value WHERE card_id = $1
		`, src.ID)
		if err != nil {
			return err
		}
		type srcAttr struct {
			DefID int64
			Value json.RawMessage
		}
		var attrs []srcAttr
		for rows.Next() {
			var a srcAttr
			if err := rows.Scan(&a.DefID, &a.Value); err != nil {
				rows.Close()
				return err
			}
			attrs = append(attrs, a)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, a := range attrs {
			ad, ok := snap.AttrByID[a.DefID]
			if !ok {
				continue
			}
			newVal := remapAttributeValue(ad, a.Value, cardRemap, flowRemap)
			if err := writeAttributeValue(ctx, tx, newID, a.DefID, newVal, actorID); err != nil {
				return fmt.Errorf("copy attribute_value (card %d, attr %s): %w", src.ID, ad.Name, err)
			}
		}
	}
	return nil
}

// remapAttributeValue rewrites a single attribute_value through the
// remap. Behaviour depends on (attribute name, value_type):
//
//   - attribute name "predicate" (filter cards) → walk the predicate
//     tree and rewrite card-id values via RemapPredicateTree.
//   - attribute name "flow_ref" (screen cards, value_type=number) →
//     interpret the number as a flow id and rewrite via flowRemap.
//   - value_type card_ref → if value is a number in cardRemap, swap.
//   - value_type card_ref[] → walk the array, swap any matching ids.
//   - everything else → return unchanged.
//
// Unchanged values still go through the writer so the new project's
// attribute_value rows get fresh last_activity_id values pointing at
// activity rows under the new card.
func remapAttributeValue(
	ad schema.AttributeDef,
	raw json.RawMessage,
	cardRemap, flowRemap map[int64]int64,
) json.RawMessage {
	if len(raw) == 0 {
		return raw
	}
	switch ad.Name {
	case "predicate":
		out, ok := remapPredicateRaw(raw, cardRemap)
		if ok {
			return out
		}
		return raw
	case "flow_ref":
		// Stored as a JSON number = flow id. Remap if present.
		var n int64
		if err := json.Unmarshal(raw, &n); err == nil {
			if mapped, ok := flowRemap[n]; ok {
				out, _ := json.Marshal(mapped)
				return out
			}
		}
		return raw
	}
	switch ad.ValueType {
	case "card_ref":
		return remapCardRefValue(raw, cardRemap)
	case "card_ref[]":
		return remapCardRefArray(raw, cardRemap)
	}
	return raw
}

func remapCardRefValue(raw json.RawMessage, remap map[int64]int64) json.RawMessage {
	// card_ref values may be JSON number or JSON string (digits). Accept
	// both; emit canonical JSON number on remap.
	var n int64
	if err := json.Unmarshal(raw, &n); err == nil && n != 0 {
		if mapped, ok := remap[n]; ok {
			out, _ := json.Marshal(mapped)
			return out
		}
		return raw
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		if parsed, err := strconv.ParseInt(s, 10, 64); err == nil {
			if mapped, ok := remap[parsed]; ok {
				out, _ := json.Marshal(mapped)
				return out
			}
		}
	}
	return raw
}

func remapCardRefArray(raw json.RawMessage, remap map[int64]int64) json.RawMessage {
	var arr []json.RawMessage
	if err := json.Unmarshal(raw, &arr); err != nil {
		return raw
	}
	out := make([]json.RawMessage, len(arr))
	changed := false
	for i, el := range arr {
		mapped := remapCardRefValue(el, remap)
		if string(mapped) != string(el) {
			changed = true
		}
		out[i] = mapped
	}
	if !changed {
		return raw
	}
	encoded, err := json.Marshal(out)
	if err != nil {
		return raw
	}
	return encoded
}

// remapPredicateRaw parses a filter card's predicate (stored as a JSON
// string containing a small predicate-tree object — see V11) and rewrites
// every card_ref value via the remap. Returns (remappedJSON, true) if a
// remap was applied; (raw, false) if the predicate is empty / malformed
// (in which case the caller leaves the raw value alone).
//
// The wire shape: attribute_value.value is a JSON string whose contents
// are either the legacy single-condition predicate (`{attr, op, values}`)
// or the v2 tree (`{connective, children:[...]}`).
func remapPredicateRaw(raw json.RawMessage, remap map[int64]int64) (json.RawMessage, bool) {
	if len(raw) == 0 {
		return raw, false
	}
	// Predicate is stored as a JSON-string-of-JSON. Decode the outer
	// string layer first.
	var inner string
	if err := json.Unmarshal(raw, &inner); err == nil {
		remapped, ok := remapPredicateString(inner, remap)
		if !ok {
			return raw, false
		}
		out, err := json.Marshal(remapped)
		if err != nil {
			return raw, false
		}
		return out, true
	}
	// Some callers may store the predicate as a raw object (not a
	// JSON-encoded string). Try parsing as object directly.
	out, ok := remapPredicateString(string(raw), remap)
	if !ok {
		return raw, false
	}
	return json.RawMessage(out), true
}

// remapPredicateString rewrites a predicate-tree-shaped JSON string,
// returning the new string and a "changed" flag. Whether the input is
// the legacy single-condition shape (`{attr, op, values}`) or the v2
// tree (`{connective, children:[...]}`), the walker descends through
// any object and looks for `op` + `values` pairs on every leaf.
func remapPredicateString(s string, remap map[int64]int64) (string, bool) {
	var node map[string]json.RawMessage
	if err := json.Unmarshal([]byte(s), &node); err != nil {
		return s, false
	}
	changed := remapPredicateNode(node, remap)
	if !changed {
		return s, false
	}
	out, err := json.Marshal(node)
	if err != nil {
		return s, false
	}
	return string(out), true
}

// remapPredicateNode mutates the in-memory map representation of one
// predicate node. Returns true if any value was rewritten. Recurses
// into `children`; rewrites `values` on leaves whose `op` is in the
// set of operators that carry card-id values (=, !=, in, not in).
func remapPredicateNode(node map[string]json.RawMessage, remap map[int64]int64) bool {
	changed := false
	// Recurse into children if present.
	if rawChildren, ok := node["children"]; ok {
		var children []map[string]json.RawMessage
		if err := json.Unmarshal(rawChildren, &children); err == nil {
			subChanged := false
			for _, c := range children {
				if remapPredicateNode(c, remap) {
					subChanged = true
				}
			}
			if subChanged {
				encoded, err := json.Marshal(children)
				if err == nil {
					node["children"] = encoded
					changed = true
				}
			}
		}
	}
	// Leaf detection: an `op` field plus a `values` array. The relevant
	// ops carry card-id values when the leaf's attr is a card_ref —
	// since the stamp handler can't easily know the attribute's
	// value_type from the predicate alone, we try to remap any numeric
	// value through the cardRemap; non-matching numbers pass through.
	rawOp, hasOp := node["op"]
	rawValues, hasValues := node["values"]
	if hasOp && hasValues {
		var op string
		if err := json.Unmarshal(rawOp, &op); err == nil && isCardIDOp(op) {
			var values []json.RawMessage
			if err := json.Unmarshal(rawValues, &values); err == nil {
				valChanged := false
				newValues := make([]json.RawMessage, len(values))
				for i, v := range values {
					mapped := remapPredicateValue(v, remap)
					if string(mapped) != string(v) {
						valChanged = true
					}
					newValues[i] = mapped
				}
				if valChanged {
					encoded, err := json.Marshal(newValues)
					if err == nil {
						node["values"] = encoded
						changed = true
					}
				}
			}
		}
	}
	return changed
}

// isCardIDOp reports whether `op` is one of the operators that carries
// card-id values when the leaf's attr is a card_ref. These are the same
// ops the predicate compiler in card/where.go recognises as card-ref
// shaped: equality, inequality, set membership, set non-membership.
// Phase ops, contains, exists / not exists do not carry card ids and
// pass through unchanged.
func isCardIDOp(op string) bool {
	switch op {
	case "=", "eq", "!=", "ne", "in", "not in":
		return true
	}
	return false
}

// remapPredicateValue swaps one leaf value through the remap. Handles
// numeric and string-of-digits forms; everything else passes through
// (non-numeric values are not card ids and shouldn't be touched).
func remapPredicateValue(raw json.RawMessage, remap map[int64]int64) json.RawMessage {
	var n int64
	if err := json.Unmarshal(raw, &n); err == nil && n != 0 {
		if mapped, ok := remap[n]; ok {
			out, _ := json.Marshal(mapped)
			return out
		}
		return raw
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		if parsed, err := strconv.ParseInt(s, 10, 64); err == nil {
			if mapped, ok := remap[parsed]; ok {
				out, _ := json.Marshal(mapped)
				return out
			}
		}
	}
	return raw
}

// RemapPredicateTree is the exported variant used by external callers
// (e.g., admin migrations, tests). Takes a parsed CardWhereGroup and
// returns a new group with every card-id leaf value remapped. The
// internal stamp path works on raw JSON to preserve the on-disk shape;
// this exported helper exists so calling code that already has a
// parsed tree can reuse the same remap logic.
func RemapPredicateTree(g card.CardWhereGroup, remap map[int64]int64) card.CardWhereGroup {
	return card.CardWhereGroup{
		Connective: g.Connective,
		Children:   remapTreeNodes(g.Children, remap),
	}
}

func remapTreeNodes(nodes []card.CardWhereTreeNode, remap map[int64]int64) []card.CardWhereTreeNode {
	if nodes == nil {
		return nil
	}
	out := make([]card.CardWhereTreeNode, len(nodes))
	for i, n := range nodes {
		out[i] = remapTreeNode(n, remap)
	}
	return out
}

func remapTreeNode(n card.CardWhereTreeNode, remap map[int64]int64) card.CardWhereTreeNode {
	cp := card.CardWhereTreeNode{
		Connective: n.Connective,
		Attr:       n.Attr,
		Op:         n.Op,
	}
	if n.Children != nil {
		cp.Children = remapTreeNodes(n.Children, remap)
	}
	if n.Values != nil {
		if isCardIDOp(n.Op) {
			cp.Values = make([]json.RawMessage, len(n.Values))
			for i, v := range n.Values {
				cp.Values[i] = remapPredicateValue(v, remap)
			}
		} else {
			cp.Values = append([]json.RawMessage{}, n.Values...)
		}
	}
	return cp
}

// insertCardWithTitle is a stripped-down version of the card.insert
// path: insert one card, emit card_create activity, write the title
// attribute_value. Used to land the new project row without firing the
// project-screen-seed hook that card.insert installs.
func insertCardWithTitle(
	ctx context.Context,
	tx pgx.Tx,
	cardTypeID int64,
	parentID *int64,
	title string,
	actorID int64,
	snap *schema.Snapshot,
) (int64, error) {
	titleAD, ok := snap.AttrByName["title"]
	if !ok {
		return 0, fmt.Errorf("insertCardWithTitle: title attribute_def missing")
	}
	var newID int64
	if err := tx.QueryRow(ctx, `
		INSERT INTO card (card_type_id, parent_card_id) VALUES ($1, $2) RETURNING id
	`, cardTypeID, parentID).Scan(&newID); err != nil {
		return 0, fmt.Errorf("insert card: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO activity (card_id, kind, actor_id) VALUES ($1, 'card_create', $2)
	`, newID, actorID); err != nil {
		return 0, fmt.Errorf("card_create activity: %w", err)
	}
	titleJSON, _ := json.Marshal(title)
	if err := writeAttributeValue(ctx, tx, newID, titleAD.ID, titleJSON, actorID); err != nil {
		return 0, fmt.Errorf("write title: %w", err)
	}
	return newID, nil
}

// writeAttributeValue emits one attr_update activity + attribute_value
// upsert linked through last_activity_id (same shape as
// card/screen_seed.go's writeAttr).
func writeAttributeValue(
	ctx context.Context,
	tx pgx.Tx,
	cardID, attributeDefID int64,
	value json.RawMessage,
	actorID int64,
) error {
	var activityID int64
	if err := tx.QueryRow(ctx, `
		INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
		VALUES ($1, 'attr_update', $2, NULL, $3::jsonb, $4)
		RETURNING id
	`, cardID, attributeDefID, value, actorID).Scan(&activityID); err != nil {
		return fmt.Errorf("activity: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
		VALUES ($1, $2, $3::jsonb, $4)
		ON CONFLICT (card_id, attribute_def_id) DO UPDATE
			SET value = EXCLUDED.value,
			    last_activity_id = EXCLUDED.last_activity_id
	`, cardID, attributeDefID, value, activityID); err != nil {
		return fmt.Errorf("attribute_value: %w", err)
	}
	return nil
}
