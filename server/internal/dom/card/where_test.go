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

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/card"
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

	ids := make([]int64, len(specs))
	for i, s := range specs {
		// Substitute string milestone_ref values with their freshly-minted ids.
		patched := make(map[string]any, len(s))
		for k, v := range s {
			if k == "milestone_ref" {
				if sv, ok := v.(string); ok {
					patched[k] = byName[sv]
					continue
				}
			}
			patched[k] = v
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
