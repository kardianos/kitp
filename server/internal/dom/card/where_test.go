// Tests for the v2 predicate-tree shape on card.select_with_attributes.
// Each test seeds a small project + tasks, then issues a select with a
// `tree` payload exercising one operator (or one nested combination)
// and asserts the rows that come back.
package card_test

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/store"
)

// seedTasks bootstraps one project + tasks; each task spec carries the
// attributes to apply on insert. Returns the project id, the slice of
// inserted task ids in the same order as `specs`, and a `milestone_ref`
// title -> milestone card id map (built lazily for any string values
// referenced by the specs so tests can keep writing
// `{"milestone_ref":"M1"}` as a convenience for "match this row group").
//
// The kernel no longer ships a workflow type; the predicate-tree tests
// here use `milestone_ref` (a card_ref → milestone) as their grouping
// attribute — same machinery, no privileged status concept.
func seedTasks(t *testing.T, srv *api.Server, specs []map[string]any) (int64, []int64, map[string]int64) {
	t.Helper()
	ctx := auth.WithSystemUser(context.Background())

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("project insert: %+v", resp.Subresponses[0])
	}
	var pOut card.InsertOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &pOut)

	// Materialise milestone cards for every distinct string value referenced.
	byName := make(map[string]int64)
	for _, s := range specs {
		v, ok := s["milestone_ref"].(string)
		if !ok {
			continue
		}
		if _, seen := byName[v]; seen {
			continue
		}
		body := fmt.Sprintf(
			`{"card_type_name":"milestone","parent_card_id":"%d","title":%q}`,
			pOut.ID, v)
		r := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "m_" + v, Endpoint: "card", Action: "insert", Data: json.RawMessage(body)},
		}})
		if !r.Subresponses[0].OK {
			t.Fatalf("milestone %q insert: %+v", v, r.Subresponses[0])
		}
		var mOut card.InsertOutput
		b, _ := json.Marshal(r.Subresponses[0].Data)
		_ = json.Unmarshal(b, &mOut)
		byName[v] = mOut.ID
	}

	// Gate 6: every task needs a status (required edge). Seed a single
	// status card under the project and stamp it on every task that
	// doesn't already have one in its spec.
	taskStatusID := mkStatusUnder(t, srv, pOut.ID)

	ids := make([]int64, len(specs))
	for i, s := range specs {
		// Substitute string milestone_ref values with their freshly-minted ids.
		patched := make(map[string]any, len(s)+1)
		for k, v := range s {
			if k == "milestone_ref" {
				if sv, ok := v.(string); ok {
					patched[k] = byName[sv]
					continue
				}
			}
			patched[k] = v
		}
		if _, hasStatus := patched["status"]; !hasStatus {
			patched["status"] = taskStatusID
		}
		attrs, _ := json.Marshal(patched)
		body := fmt.Sprintf(
			`{"card_type_name":"task","parent_card_id":"%d","title":"t%d","attributes":%s}`,
			pOut.ID, i, attrs)
		resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: fmt.Sprintf("t%d", i), Endpoint: "card", Action: "insert", Data: json.RawMessage(body)},
		}})
		if !resp.Subresponses[0].OK {
			t.Fatalf("task insert %d: %+v", i, resp.Subresponses[0])
		}
		var o card.InsertOutput
		b, _ := json.Marshal(resp.Subresponses[0].Data)
		_ = json.Unmarshal(b, &o)
		ids[i] = o.ID
	}
	return pOut.ID, ids, byName
}

// queryTree runs a select_with_attributes with the given tree payload
// and returns the matched rows.
func queryTree(t *testing.T, srv *api.Server, parent int64, tree string) []card.CardWithAttrs {
	t.Helper()
	ctx := auth.WithSystemUser(context.Background())
	body := fmt.Sprintf(
		`{"parent_card_id":"%d","card_type_name":"task","tree":%s}`, parent, tree)
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "g", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(body)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("select tree=%s: %+v", tree, resp.Subresponses[0])
	}
	var out card.SelectWithAttributesOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &out)
	return out.Rows
}

// rowIDs is a helper for asserting row sets without ordering noise.
func rowIDs(rows []card.CardWithAttrs) []int64 {
	out := make([]int64, len(rows))
	for i, r := range rows {
		out[i] = r.ID
	}
	slices.Sort(out)
	return out
}

func sortedInts(ids ...int64) []int64 {
	out := append([]int64(nil), ids...)
	slices.Sort(out)
	return out
}

// TestTree_Eq: one leaf, eq.
func TestTree_Eq(t *testing.T) {
	srv, _ := setupAttr(t, "kitp_test_card_tree_eq")
	_, ids, sm := seedTasks(t, srv, []map[string]any{
		{"milestone_ref": "open", "assignee": 1},
		{"milestone_ref": "done", "assignee": 1},
		{"milestone_ref": "open", "assignee": 2},
	})
	rows := queryTree(t, srv, parentOf(t, srv, ids[0]),
		fmt.Sprintf(`{"connective":"and","children":[{"attr":"milestone_ref","op":"=","values":[%d]}]}`, sm["open"]))
	want := sortedInts(ids[0], ids[2])
	if got := rowIDs(rows); !equalIDs(got, want) {
		t.Errorf("eq: got %v, want %v", got, want)
	}
}

// TestTree_Ne: leaf with the != operator.
func TestTree_Ne(t *testing.T) {
	srv, _ := setupAttr(t, "kitp_test_card_tree_ne")
	_, ids, sm := seedTasks(t, srv, []map[string]any{
		{"milestone_ref": "open"},
		{"milestone_ref": "done"},
		{"milestone_ref": "open"},
	})
	rows := queryTree(t, srv, parentOf(t, srv, ids[0]),
		fmt.Sprintf(`{"connective":"and","children":[{"attr":"milestone_ref","op":"!=","values":[%d]}]}`, sm["done"]))
	want := sortedInts(ids[0], ids[2])
	if got := rowIDs(rows); !equalIDs(got, want) {
		t.Errorf("ne: got %v, want %v", got, want)
	}
}

// TestTree_In: in operator with multiple values.
func TestTree_In(t *testing.T) {
	srv, _ := setupAttr(t, "kitp_test_card_tree_in")
	_, ids, sm := seedTasks(t, srv, []map[string]any{
		{"milestone_ref": "todo"},
		{"milestone_ref": "doing"},
		{"milestone_ref": "done"},
		{"milestone_ref": "review"},
	})
	rows := queryTree(t, srv, parentOf(t, srv, ids[0]),
		fmt.Sprintf(`{"connective":"and","children":[{"attr":"milestone_ref","op":"in","values":[%d,%d]}]}`, sm["todo"], sm["doing"]))
	want := sortedInts(ids[0], ids[1])
	if got := rowIDs(rows); !equalIDs(got, want) {
		t.Errorf("in: got %v, want %v", got, want)
	}
}

// TestTree_NotIn: not-in operator excludes named values, includes
// missing-attribute rows.
func TestTree_NotIn(t *testing.T) {
	srv, _ := setupAttr(t, "kitp_test_card_tree_notin")
	_, ids, sm := seedTasks(t, srv, []map[string]any{
		{"milestone_ref": "todo"},
		{"milestone_ref": "doing"},
		{"milestone_ref": "done"},
		// no status attribute at all on the fourth task.
		{},
	})
	rows := queryTree(t, srv, parentOf(t, srv, ids[0]),
		fmt.Sprintf(`{"connective":"and","children":[{"attr":"milestone_ref","op":"not in","values":[%d]}]}`, sm["done"]))
	// "not in" wraps NOT EXISTS, so a missing attribute also counts as
	// "not in done".
	want := sortedInts(ids[0], ids[1], ids[3])
	if got := rowIDs(rows); !equalIDs(got, want) {
		t.Errorf("not in: got %v, want %v", got, want)
	}
}

// TestTree_TagsMembership: a card_ref[] attribute (tags) filters by ARRAY
// MEMBERSHIP, not scalar equality. Each card stores ONE `tags` row holding
// a JSON array, so "tags = X" must mean "the array CONTAINS X". This is the
// regression that left every tag filter returning zero rows — scalar
// `av.value = X` / `av.value IN (…)` against a stored array `[…]` never
// matched (while single card_ref attrs like milestone_ref worked). Values
// arrive as the UI sends them — JSON strings — to also pin the
// string→number canonicalisation that membership needs.
func TestTree_TagsMembership(t *testing.T) {
	srv, _ := setupAttr(t, "kitp_test_card_tree_tags")
	ctx := auth.WithSystemUser(context.Background())

	insert := func(body string) int64 {
		resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "i", Endpoint: "card", Action: "insert", Data: json.RawMessage(body)},
		}})
		if !resp.Subresponses[0].OK {
			t.Fatalf("insert %s: %+v", body, resp.Subresponses[0])
		}
		var o card.InsertOutput
		b, _ := json.Marshal(resp.Subresponses[0].Data)
		_ = json.Unmarshal(b, &o)
		return o.ID
	}

	proj := insert(`{"card_type_name":"project","title":"P"}`)
	status := mkStatusUnder(t, srv, proj)
	// tag cards require title + path (a slash-delimited label).
	tagA := insert(fmt.Sprintf(`{"card_type_name":"tag","parent_card_id":"%d","title":"A","attributes":{"path":"a"}}`, proj))
	tagB := insert(fmt.Sprintf(`{"card_type_name":"tag","parent_card_id":"%d","title":"B","attributes":{"path":"b"}}`, proj))
	tagC := insert(fmt.Sprintf(`{"card_type_name":"tag","parent_card_id":"%d","title":"C","attributes":{"path":"c"}}`, proj))

	task := func(tags ...int64) int64 {
		ids, _ := json.Marshal(tags)
		return insert(fmt.Sprintf(
			`{"card_type_name":"task","parent_card_id":"%d","title":"t","attributes":{"status":%d,"tags":%s}}`,
			proj, status, ids))
	}
	tAB := task(tagA, tagB)
	_ = task(tagB) // tB — has B only; never in the eq=A / "no A,B" sets.
	tC := task(tagC)
	tNone := task()

	// eq → membership: "has tag A" → only the A,B task.
	got := rowIDs(queryTree(t, srv, proj,
		fmt.Sprintf(`{"connective":"and","children":[{"attr":"tags","op":"=","values":["%d"]}]}`, tagA)))
	if want := sortedInts(tAB); !equalIDs(got, want) {
		t.Errorf("tags = A: got %v, want %v", got, want)
	}

	// in → OR of memberships: "has tag A OR C".
	got = rowIDs(queryTree(t, srv, proj,
		fmt.Sprintf(`{"connective":"and","children":[{"attr":"tags","op":"in","values":["%d","%d"]}]}`, tagA, tagC)))
	if want := sortedInts(tAB, tC); !equalIDs(got, want) {
		t.Errorf("tags in (A,C): got %v, want %v", got, want)
	}

	// not in → "has NEITHER A nor B": the C-only task + the untagged task.
	got = rowIDs(queryTree(t, srv, proj,
		fmt.Sprintf(`{"connective":"and","children":[{"attr":"tags","op":"not in","values":["%d","%d"]}]}`, tagA, tagB)))
	if want := sortedInts(tC, tNone); !equalIDs(got, want) {
		t.Errorf("tags not in (A,B): got %v, want %v", got, want)
	}
}

// TestTree_ExistsAndNotExists: exists / not exists.
func TestTree_ExistsAndNotExists(t *testing.T) {
	srv, _ := setupAttr(t, "kitp_test_card_tree_exist")
	// The first task carries a non-card_ref attribute (sort_order) so the
	// exists test isn't gated on a value-card actually existing — this
	// keeps the test focused on the exists predicate, not project scoping.
	_, ids, _ := seedTasks(t, srv, []map[string]any{
		{"milestone_ref": "open", "sort_order": 100},
		{"milestone_ref": "open"},
		// no attributes at all.
		{},
	})

	// exists: status set on tasks 0,1.
	rows := queryTree(t, srv, parentOf(t, srv, ids[0]),
		`{"connective":"and","children":[{"attr":"milestone_ref","op":"exists"}]}`)
	want := sortedInts(ids[0], ids[1])
	if got := rowIDs(rows); !equalIDs(got, want) {
		t.Errorf("exists: got %v, want %v", got, want)
	}

	// not exists: only task 2 has no status.
	rows = queryTree(t, srv, parentOf(t, srv, ids[0]),
		`{"connective":"and","children":[{"attr":"milestone_ref","op":"not exists"}]}`)
	want = sortedInts(ids[2])
	if got := rowIDs(rows); !equalIDs(got, want) {
		t.Errorf("not exists: got %v, want %v", got, want)
	}
}

// TestTree_NestedAndOrNot exercises one nested case combining all three
// connectives:  status = "open" AND ((assignee = 1) OR (NOT (assignee
// exists))).
func TestTree_NestedAndOrNot(t *testing.T) {
	srv, _ := setupAttr(t, "kitp_test_card_tree_nest")
	_, ids, sm := seedTasks(t, srv, []map[string]any{
		{"milestone_ref": "open", "assignee": 1}, // match  (status=open & assignee=1)
		{"milestone_ref": "open", "assignee": 2}, // no     (status=open but assignee=2)
		{"milestone_ref": "open"},                 // match  (status=open & no assignee)
		{"milestone_ref": "done", "assignee": 1}, // no     (status!=open)
	})
	tree := fmt.Sprintf(`{
		"connective":"and",
		"children":[
			{"attr":"milestone_ref","op":"=","values":[%d]},
			{
				"connective":"or",
				"children":[
					{"attr":"assignee","op":"=","values":[1]},
					{"connective":"not","children":[{"attr":"assignee","op":"exists"}]}
				]
			}
		]
	}`, sm["open"])
	rows := queryTree(t, srv, parentOf(t, srv, ids[0]), tree)
	want := sortedInts(ids[0], ids[2])
	if got := rowIDs(rows); !equalIDs(got, want) {
		t.Errorf("nested: got %v, want %v", got, want)
	}
}

// TestTree_HasPhase exercises the new has_phase op: dereference a
// card_ref attribute to its value-card and gate on phase membership.
// The test stages three milestone "value cards" with phases
// {triage, active, terminal} and three tasks each pointing at one of
// them via milestone_ref, then issues has_phase queries to verify the
// phase set drives the row set.
func TestTree_HasPhase(t *testing.T) {
	srv, sp := setupAttr(t, "kitp_test_card_tree_has_phase")
	_, ids, sm := seedTasks(t, srv, []map[string]any{
		{"milestone_ref": "triage_m"},
		{"milestone_ref": "active_m"},
		{"milestone_ref": "term_m"},
	})
	// card.insert defaults phase='triage' for new value-cards; fast-
	// forward two of them to active / terminal so the test covers all
	// three buckets. UPDATE rather than going through attribute.update
	// because phase is a structural column, not an attribute_value.
	ctx := context.Background()
	for name, want := range map[string]string{
		"active_m": "active",
		"term_m":   "terminal",
	} {
		if _, err := sp.P.Exec(ctx,
			`UPDATE card SET phase = $1 WHERE id = $2`, want, sm[name]); err != nil {
			t.Fatalf("set phase %s=%s: %v", name, want, err)
		}
	}

	// has_phase=['active'] picks only the active task.
	rows := queryTree(t, srv, parentOf(t, srv, ids[0]),
		`{"connective":"and","children":[{"attr":"milestone_ref","op":"has_phase","values":["active"]}]}`)
	if got, want := rowIDs(rows), sortedInts(ids[1]); !equalIDs(got, want) {
		t.Errorf("has_phase=[active]: got %v, want %v", got, want)
	}

	// has_phase=['triage','active'] picks both non-terminal tasks —
	// the seeded notTerminal alias maps to the same set.
	rows = queryTree(t, srv, parentOf(t, srv, ids[0]),
		`{"connective":"and","children":[{"attr":"milestone_ref","op":"has_phase","values":["triage","active"]}]}`)
	if got, want := rowIDs(rows), sortedInts(ids[0], ids[1]); !equalIDs(got, want) {
		t.Errorf("has_phase=[triage,active]: got %v, want %v", got, want)
	}

	// has_phase=['terminal'] picks only the terminal task.
	rows = queryTree(t, srv, parentOf(t, srv, ids[0]),
		`{"connective":"and","children":[{"attr":"milestone_ref","op":"has_phase","values":["terminal"]}]}`)
	if got, want := rowIDs(rows), sortedInts(ids[2]); !equalIDs(got, want) {
		t.Errorf("has_phase=[terminal]: got %v, want %v", got, want)
	}

	// Empty values → vacuously false: no rows match.
	rows = queryTree(t, srv, parentOf(t, srv, ids[0]),
		`{"connective":"and","children":[{"attr":"milestone_ref","op":"has_phase","values":[]}]}`)
	if got := rowIDs(rows); len(got) != 0 {
		t.Errorf("has_phase=[]: got %v, want empty", got)
	}
}

// TestTree_ParentStatusPhase exercises the 2-hop `parent_status_phase`
// op: a row qualifies when its `parent_task` ref points at a task whose
// `status` ref points at a value-card with one of the listed phases.
//
// Setup builds two parent tasks (one with status='Open', one with
// status='Done' — phase flipped to terminal via UPDATE) and two child
// tasks pointing at each parent, then runs the op for each phase set
// and confirms the row sets. Caps with the "heads" expression the
// op was introduced for: `parent_task not exists OR
// parent_status_phase=[terminal]`.
func TestTree_ParentStatusPhase(t *testing.T) {
	srv, sp := setupAttr(t, "kitp_test_card_tree_parent_status_phase")
	ctx := auth.WithSystemUser(context.Background())

	// Project + two status cards with distinct phases.
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("project insert: %+v", resp.Subresponses[0])
	}
	projID := idsOf(t, resp.Subresponses[0])

	openID := mkStatusUnder(t, srv, projID)
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "sd", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"status","parent_card_id":"%d","title":"Done"}`,
				projID))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("status Done insert: %+v", resp.Subresponses[0])
	}
	doneID := idsOf(t, resp.Subresponses[0])

	// Status cards default to phase='triage'. Flip Open→active and
	// Done→terminal directly so the parent_status_phase predicate has
	// distinct buckets to gate on.
	if _, err := sp.P.Exec(ctx.(context.Context),
		`UPDATE card SET phase = 'active' WHERE id = $1`, openID); err != nil {
		t.Fatalf("flip Open phase: %v", err)
	}
	if _, err := sp.P.Exec(ctx.(context.Context),
		`UPDATE card SET phase = 'terminal' WHERE id = $1`, doneID); err != nil {
		t.Fatalf("flip Done phase: %v", err)
	}

	// Four tasks: two roots (one Open, one Done) and two children
	// pointing at each.
	insertTask := func(name, parentTask string, status int64) int64 {
		t.Helper()
		body := fmt.Sprintf(
			`{"card_type_name":"task","parent_card_id":"%d","title":%q,"attributes":{"status":%d`,
			projID, name, status)
		if parentTask != "" {
			body += `,"parent_task":` + parentTask
		}
		body += `}}`
		r := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: name, Endpoint: "card", Action: "insert", Data: json.RawMessage(body)},
		}})
		if !r.Subresponses[0].OK {
			t.Fatalf("insert %s: %+v", name, r.Subresponses[0])
		}
		return idsOf(t, r.Subresponses[0])
	}

	rootOpen := insertTask("root_open", "", openID)
	rootDone := insertTask("root_done", "", doneID)
	childOfOpen := insertTask("child_of_open", fmt.Sprintf("%d", rootOpen), openID)
	childOfDone := insertTask("child_of_done", fmt.Sprintf("%d", rootDone), openID)

	parent := parentOf(t, srv, rootOpen)

	// parent_status_phase=['terminal'] → only the child whose parent
	// is the Done-status root.
	rows := queryTree(t, srv, parent,
		`{"connective":"and","children":[{"attr":"parent_task","op":"parent_status_phase","values":["terminal"]}]}`)
	if got, want := rowIDs(rows), sortedInts(childOfDone); !equalIDs(got, want) {
		t.Errorf("parent_status_phase=[terminal]: got %v, want %v", got, want)
	}

	// parent_status_phase=['active'] → only the child whose parent
	// is the Open-status root.
	rows = queryTree(t, srv, parent,
		`{"connective":"and","children":[{"attr":"parent_task","op":"parent_status_phase","values":["active"]}]}`)
	if got, want := rowIDs(rows), sortedInts(childOfOpen); !equalIDs(got, want) {
		t.Errorf("parent_status_phase=[active]: got %v, want %v", got, want)
	}

	// parent_status_phase=['terminal','active'] → both children, never
	// the root tasks (they have no parent_task at all).
	rows = queryTree(t, srv, parent,
		`{"connective":"and","children":[{"attr":"parent_task","op":"parent_status_phase","values":["terminal","active"]}]}`)
	if got, want := rowIDs(rows), sortedInts(childOfOpen, childOfDone); !equalIDs(got, want) {
		t.Errorf("parent_status_phase=[terminal,active]: got %v, want %v", got, want)
	}

	// Empty values → vacuously false: nothing matches.
	rows = queryTree(t, srv, parent,
		`{"connective":"and","children":[{"attr":"parent_task","op":"parent_status_phase","values":[]}]}`)
	if got := rowIDs(rows); len(got) != 0 {
		t.Errorf("parent_status_phase=[]: got %v, want empty", got)
	}

	// "Heads" expression: tasks with no parent OR whose parent's
	// status is terminal. This is the filter the op was introduced
	// for — both roots qualify (no parent), childOfDone qualifies
	// (parent's status is terminal), childOfOpen does not.
	rows = queryTree(t, srv, parent, `{
		"connective":"or",
		"children":[
			{"attr":"parent_task","op":"not exists"},
			{"attr":"parent_task","op":"parent_status_phase","values":["terminal"]}
		]
	}`)
	want := sortedInts(rootOpen, rootDone, childOfDone)
	if got := rowIDs(rows); !equalIDs(got, want) {
		t.Errorf("heads expression: got %v, want %v", got, want)
	}

	// Validation: op only legal on `parent_task`. Wrong attr → server
	// returns a handler error.
	bad := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "x", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(
			fmt.Sprintf(`{"parent_card_id":"%d","card_type_name":"task","tree":{"connective":"and","children":[{"attr":"milestone_ref","op":"parent_status_phase","values":["terminal"]}]}}`, parent))},
	}})
	if bad.Subresponses[0].OK {
		t.Fatalf("expected parent_status_phase on milestone_ref to be rejected, got OK: %+v", bad.Subresponses[0])
	}
}

// TestTree_BeforeToday + TestTree_WithinDays cover the relative-date
// ops that the "Overdue" and "Due soon" named-filter snippets rely
// on. The server resolves `today` via now()::date so the same
// predicate keeps producing different row sets across days — no
// stale absolute dates in saved filters.
func TestTree_BeforeToday(t *testing.T) {
	srv, sp := setupAttr(t, "kitp_test_card_tree_before_today")
	ctx := context.Background()

	// Seed a `due_date` attribute_def (text, ISO date strings) so
	// tasks can carry a comparable date. setupAttr already loaded
	// the install seed; we add the def + edge here so the
	// attribute.update path accepts it on tasks.
	if _, err := sp.P.Exec(ctx, `
		INSERT INTO attribute_def (name, value_type, is_built_in)
		VALUES ('due_date', 'text', false)
		ON CONFLICT (name) DO NOTHING
	`); err != nil {
		t.Fatalf("seed due_date def: %v", err)
	}
	if _, err := sp.P.Exec(ctx, `
		INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
		SELECT (SELECT id FROM card_type WHERE name='task'),
		       (SELECT id FROM attribute_def WHERE name='due_date'),
		       false, 99
		ON CONFLICT DO NOTHING
	`); err != nil {
		t.Fatalf("seed due_date edge: %v", err)
	}

	// Anchor "today" to the DB's own clock so the test is stable across
	// local vs server timezone drift. The SQL compiler resolves
	// `before_today` / `within_days` against now()::date in Postgres'
	// TimeZone; comparing against Go's time.Now() in the test process
	// flakes near any TZ midnight boundary.
	today := serverToday(t, sp)
	yesterday := today.AddDate(0, 0, -1).Format("2006-01-02")
	tomorrow := today.AddDate(0, 0, 1).Format("2006-01-02")
	_, ids, _ := seedTasks(t, srv, []map[string]any{
		{"due_date": yesterday}, // overdue
		{"due_date": tomorrow},  // not overdue
		{},                       // no due_date — predicate skips
	})

	rows := queryTree(t, srv, parentOf(t, srv, ids[0]),
		`{"connective":"and","children":[{"attr":"due_date","op":"before_today"}]}`)
	if got, want := rowIDs(rows), sortedInts(ids[0]); !equalIDs(got, want) {
		t.Errorf("before_today: got %v, want %v", got, want)
	}
}

// serverToday returns the DB's notion of today (now()::date) parsed as
// a Go time.Time at UTC midnight. Used by the relative-date tests so
// "today" is consistent with the SQL compiler's reference.
func serverToday(t *testing.T, sp *store.Pool) time.Time {
	t.Helper()
	var s string
	if err := sp.P.QueryRow(context.Background(), `SELECT now()::date::text`).Scan(&s); err != nil {
		t.Fatalf("server today: %v", err)
	}
	d, err := time.Parse("2006-01-02", s)
	if err != nil {
		t.Fatalf("parse server today %q: %v", s, err)
	}
	return d
}

func TestTree_WithinDays(t *testing.T) {
	srv, sp := setupAttr(t, "kitp_test_card_tree_within_days")
	ctx := context.Background()
	if _, err := sp.P.Exec(ctx, `
		INSERT INTO attribute_def (name, value_type, is_built_in)
		VALUES ('due_date', 'text', false)
		ON CONFLICT (name) DO NOTHING;
		INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
		SELECT (SELECT id FROM card_type WHERE name='task'),
		       (SELECT id FROM attribute_def WHERE name='due_date'),
		       false, 99
		ON CONFLICT DO NOTHING;
	`); err != nil {
		t.Fatalf("seed due_date schema: %v", err)
	}

	anchor := serverToday(t, sp)
	today := anchor.Format("2006-01-02")
	twoDaysOut := anchor.AddDate(0, 0, 2).Format("2006-01-02")
	tenDaysOut := anchor.AddDate(0, 0, 10).Format("2006-01-02")
	yesterday := anchor.AddDate(0, 0, -1).Format("2006-01-02")
	_, ids, _ := seedTasks(t, srv, []map[string]any{
		{"due_date": today},      // in [today, +3]
		{"due_date": twoDaysOut}, // in [today, +3]
		{"due_date": tenDaysOut}, // out (too far)
		{"due_date": yesterday},  // out (past)
	})

	rows := queryTree(t, srv, parentOf(t, srv, ids[0]),
		`{"connective":"and","children":[{"attr":"due_date","op":"within_days","values":[3]}]}`)
	if got, want := rowIDs(rows), sortedInts(ids[0], ids[1]); !equalIDs(got, want) {
		t.Errorf("within_days=3: got %v, want %v", got, want)
	}

	// Negative N is rejected at compile time.
	bad := srv.Dispatch(auth.WithSystemUser(context.Background()), api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "g", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(
			fmt.Sprintf(`{"parent_card_id":"%d","card_type_name":"task","tree":{"connective":"and","children":[{"attr":"due_date","op":"within_days","values":[-1]}]}}`,
				parentOf(t, srv, ids[0])))},
	}})
	if bad.Subresponses[0].OK {
		t.Errorf("within_days=-1: expected rejection, got OK")
	}
}

// TestTree_Snippet exercises the `snippet` leaf op: a leaf carrying a
// predicate_snippet card id is expanded at compile time by fetching
// the snippet's stored predicate JSON and inlining the compiled SQL.
//
// Coverage:
//   - Bare snippet ref resolves to the stored predicate.
//   - AND-composing a snippet with a sibling leaf narrows correctly
//     (the "Named dropdown checks Heads + something else" path).
//   - Nested snippet (snippet A references snippet B) expands both hops.
//   - Cycle (A → B → A) surfaces as a compile error, not a stack
//     overflow / loop.
//   - Dangling reference (snippet id doesn't exist) compiles to FALSE
//     so a stale reference can't widen the result set.
func TestTree_Snippet(t *testing.T) {
	srv, _ := setupAttr(t, "kitp_test_card_tree_snippet")
	ctx := auth.WithSystemUser(context.Background())

	// Three tasks under one project, distinguished by milestone_ref so
	// we can write a snippet that picks a known subset.
	projID, ids, sm := seedTasks(t, srv, []map[string]any{
		{"milestone_ref": "open"},
		{"milestone_ref": "done"},
		{"milestone_ref": "open"},
	})

	// Insert a snippet under the project. The `predicate` attribute is
	// the JSON-encoded predicate tree the snippet stands for. Here:
	// milestone_ref = open  →  matches ids[0] and ids[2].
	insertSnippet := func(name, predicateJSON string) int64 {
		t.Helper()
		body := fmt.Sprintf(
			`{"card_type_name":"predicate_snippet","parent_card_id":"%d","title":%q,"attributes":{"predicate":%s}}`,
			projID, name, mustJSONString(predicateJSON))
		r := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "snip_" + name, Endpoint: "card", Action: "insert", Data: json.RawMessage(body)},
		}})
		if !r.Subresponses[0].OK {
			t.Fatalf("snippet %q insert: %+v", name, r.Subresponses[0])
		}
		return idsOf(t, r.Subresponses[0])
	}

	openPred := fmt.Sprintf(
		`{"attr":"milestone_ref","op":"=","values":["%d"]}`, sm["open"])
	openSnip := insertSnippet("OpenSet", openPred)

	parent := parentOf(t, srv, ids[0])

	// Bare snippet ref: same row set as the stored predicate.
	rows := queryTree(t, srv, parent, fmt.Sprintf(
		`{"connective":"and","children":[{"attr":"_snippet","op":"snippet","values":["%d"]}]}`,
		openSnip))
	if got, want := rowIDs(rows), sortedInts(ids[0], ids[2]); !equalIDs(got, want) {
		t.Errorf("bare snippet: got %v, want %v", got, want)
	}

	// Compose with a sibling leaf via AND — the "Named dropdown + extra
	// constraint" path. Adds milestone_ref filter that matches NOTHING
	// in the snippet's set, so the AND must come back empty.
	rows = queryTree(t, srv, parent, fmt.Sprintf(`{
		"connective":"and",
		"children":[
			{"attr":"_snippet","op":"snippet","values":["%d"]},
			{"attr":"milestone_ref","op":"=","values":["%d"]}
		]
	}`, openSnip, sm["done"]))
	if got := rowIDs(rows); len(got) != 0 {
		t.Errorf("AND-composed snippet (conflicting): got %v, want empty", got)
	}

	// Nested snippet (A references B). The outer snippet's predicate is
	// itself a snippet ref to OpenSet.
	nestedJSON := fmt.Sprintf(
		`{"attr":"_snippet","op":"snippet","values":["%d"]}`, openSnip)
	nestedSnip := insertSnippet("Wrapper", nestedJSON)
	rows = queryTree(t, srv, parent, fmt.Sprintf(
		`{"connective":"and","children":[{"attr":"_snippet","op":"snippet","values":["%d"]}]}`,
		nestedSnip))
	if got, want := rowIDs(rows), sortedInts(ids[0], ids[2]); !equalIDs(got, want) {
		t.Errorf("nested snippet: got %v, want %v", got, want)
	}

	// Cycle: edit Wrapper's predicate to point at a third snippet that
	// points back at Wrapper. The select must return an error, not
	// loop forever. Build C first (pointing at Wrapper), then update
	// Wrapper to point at C.
	cyclePoint := insertSnippet("CycleC", fmt.Sprintf(
		`{"attr":"_snippet","op":"snippet","values":["%d"]}`, nestedSnip))
	updateBody := fmt.Sprintf(
		`{"card_id":"%d","attribute_name":"predicate","value":%s}`,
		nestedSnip,
		mustJSONString(fmt.Sprintf(
			`{"attr":"_snippet","op":"snippet","values":["%d"]}`, cyclePoint)))
	if r := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "u", Endpoint: "attribute", Action: "update", Data: json.RawMessage(updateBody)},
	}}); !r.Subresponses[0].OK {
		t.Fatalf("rewire Wrapper for cycle: err=%v data=%+v body=%s",
			r.Subresponses[0].Error, r.Subresponses[0], updateBody)
	}
	cyc := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "g", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(
			fmt.Sprintf(`{"parent_card_id":"%d","card_type_name":"task","tree":{"connective":"and","children":[{"attr":"_snippet","op":"snippet","values":["%d"]}]}}`,
				parent, nestedSnip))},
	}})
	if cyc.Subresponses[0].OK {
		t.Fatalf("expected cycle to be rejected, got OK: %+v", cyc.Subresponses[0])
	}

	// Dangling reference: an id that doesn't name any predicate_snippet
	// compiles to FALSE — zero rows, no error, so the rest of the
	// surrounding AND stays evaluable.
	rows = queryTree(t, srv, parent,
		`{"connective":"and","children":[{"attr":"_snippet","op":"snippet","values":["999999"]}]}`)
	if got := rowIDs(rows); len(got) != 0 {
		t.Errorf("dangling snippet: got %v, want empty", got)
	}
}

// mustJSONString JSON-encodes [s] as a string literal so it can be
// embedded inside another JSON document — used to nest a predicate
// tree as the value of the `predicate` text attribute.
func mustJSONString(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		panic(err)
	}
	return string(b)
}

// TestTree_NotTerminal_PhaseSemantics confirms the legacy "not terminal"
// op now reads `target.phase = 'terminal'` (was `target.is_terminal =
// TRUE` before Gate 1). The shape is unchanged — a task whose ref
// points at a terminal-phase value-card is hidden, every other case
// passes — but the underlying gate uses phase.
func TestTree_NotTerminal_PhaseSemantics(t *testing.T) {
	srv, sp := setupAttr(t, "kitp_test_card_tree_not_terminal_phase")
	_, ids, sm := seedTasks(t, srv, []map[string]any{
		{"milestone_ref": "m_active"}, // phase='triage' by default;
		{"milestone_ref": "m_done"},   // we'll flip to active / terminal
		{},                             // no milestone_ref at all
	})
	ctx := context.Background()
	if _, err := sp.P.Exec(ctx,
		`UPDATE card SET phase = 'active' WHERE id = $1`, sm["m_active"]); err != nil {
		t.Fatalf("set active phase: %v", err)
	}
	if _, err := sp.P.Exec(ctx,
		`UPDATE card SET phase = 'terminal' WHERE id = $1`, sm["m_done"]); err != nil {
		t.Fatalf("set terminal phase: %v", err)
	}

	rows := queryTree(t, srv, parentOf(t, srv, ids[0]),
		`{"connective":"and","children":[{"attr":"milestone_ref","op":"not terminal"}]}`)
	// Tasks pointing at active milestones survive; the terminal one
	// is hidden; the no-attribute task passes (missing attribute is
	// treated as non-terminal).
	want := sortedInts(ids[0], ids[2])
	if got := rowIDs(rows); !equalIDs(got, want) {
		t.Errorf("not terminal: got %v, want %v", got, want)
	}
}

// TestTree_BackwardCompatFlat ensures the legacy flat where[] still
// works untouched when no `tree` is set.
func TestTree_BackwardCompatFlat(t *testing.T) {
	srv, _ := setupAttr(t, "kitp_test_card_tree_compat")
	_, ids, sm := seedTasks(t, srv, []map[string]any{
		{"milestone_ref": "open"},
		{"milestone_ref": "done"},
	})
	ctx := auth.WithSystemUser(context.Background())
	body := fmt.Sprintf(
		`{"parent_card_id":"%d","card_type_name":"task","where":[{"attr":"milestone_ref","op":"=","value":%d}]}`,
		parentOf(t, srv, ids[0]), sm["open"])
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "g", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(body)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("legacy where: %+v", resp.Subresponses[0])
	}
	var out card.SelectWithAttributesOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &out)
	want := sortedInts(ids[0])
	if got := rowIDs(out.Rows); !equalIDs(got, want) {
		t.Errorf("legacy where: got %v, want %v", got, want)
	}
}

// parentOf returns the parent_card_id for the given task id by reading
// its row back. Used so the seedTasks helper doesn't need to leak the
// project id through return value chains.
func parentOf(t *testing.T, srv *api.Server, taskID int64) int64 {
	t.Helper()
	ctx := auth.WithSystemUser(context.Background())
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "g", Endpoint: "card", Action: "select_with_attributes",
			Data: json.RawMessage(`{"card_type_name":"task"}`)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("parentOf: %+v", resp.Subresponses[0])
	}
	var out card.SelectWithAttributesOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &out)
	for _, r := range out.Rows {
		if r.ID == taskID && r.ParentCardID != nil {
			return *r.ParentCardID
		}
	}
	t.Fatalf("parentOf: task %d not found", taskID)
	return 0
}

func equalIDs(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
