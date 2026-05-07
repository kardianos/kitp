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
// attributes to apply on insert. Returns the project id and the slice
// of inserted task ids in the same order as `specs`.
func seedTasks(t *testing.T, srv *api.Server, specs []map[string]any) (int64, []int64) {
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

	ids := make([]int64, len(specs))
	for i, s := range specs {
		attrs, _ := json.Marshal(s)
		body := fmt.Sprintf(
			`{"card_type_name":"task","parent_card_id":%d,"title":"t%d","attributes":%s}`,
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
	return pOut.ID, ids
}

// queryTree runs a select_with_attributes with the given tree payload
// and returns the matched rows.
func queryTree(t *testing.T, srv *api.Server, parent int64, tree string) []card.CardWithAttrs {
	t.Helper()
	ctx := auth.WithSystemUser(context.Background())
	body := fmt.Sprintf(
		`{"parent_card_id":%d,"card_type_name":"task","tree":%s}`, parent, tree)
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
	_, ids := seedTasks(t, srv, []map[string]any{
		{"status": "open", "assignee": 1},
		{"status": "done", "assignee": 1},
		{"status": "open", "assignee": 2},
	})
	rows := queryTree(t, srv, parentOf(t, srv, ids[0]),
		`{"connective":"and","children":[{"attr":"status","op":"=","values":["open"]}]}`)
	want := sortedInts(ids[0], ids[2])
	if got := rowIDs(rows); !equalIDs(got, want) {
		t.Errorf("eq: got %v, want %v", got, want)
	}
}

// TestTree_Ne: leaf with the != operator.
func TestTree_Ne(t *testing.T) {
	srv, _ := setupAttr(t, "kitp_test_card_tree_ne")
	_, ids := seedTasks(t, srv, []map[string]any{
		{"status": "open"},
		{"status": "done"},
		{"status": "open"},
	})
	rows := queryTree(t, srv, parentOf(t, srv, ids[0]),
		`{"connective":"and","children":[{"attr":"status","op":"!=","values":["done"]}]}`)
	want := sortedInts(ids[0], ids[2])
	if got := rowIDs(rows); !equalIDs(got, want) {
		t.Errorf("ne: got %v, want %v", got, want)
	}
}

// TestTree_In: in operator with multiple values.
func TestTree_In(t *testing.T) {
	srv, _ := setupAttr(t, "kitp_test_card_tree_in")
	_, ids := seedTasks(t, srv, []map[string]any{
		{"status": "todo"},
		{"status": "doing"},
		{"status": "done"},
		{"status": "review"},
	})
	rows := queryTree(t, srv, parentOf(t, srv, ids[0]),
		`{"connective":"and","children":[{"attr":"status","op":"in","values":["todo","doing"]}]}`)
	want := sortedInts(ids[0], ids[1])
	if got := rowIDs(rows); !equalIDs(got, want) {
		t.Errorf("in: got %v, want %v", got, want)
	}
}

// TestTree_NotIn: not-in operator excludes named values, includes
// missing-attribute rows.
func TestTree_NotIn(t *testing.T) {
	srv, _ := setupAttr(t, "kitp_test_card_tree_notin")
	_, ids := seedTasks(t, srv, []map[string]any{
		{"status": "todo"},
		{"status": "doing"},
		{"status": "done"},
		// no status attribute at all on the fourth task.
		{},
	})
	rows := queryTree(t, srv, parentOf(t, srv, ids[0]),
		`{"connective":"and","children":[{"attr":"status","op":"not in","values":["done"]}]}`)
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
	_, ids := seedTasks(t, srv, []map[string]any{
		{"status": "open", "milestone_ref": 11},
		{"status": "open"},
		// no attributes at all.
		{},
	})

	// exists: status set on tasks 0,1.
	rows := queryTree(t, srv, parentOf(t, srv, ids[0]),
		`{"connective":"and","children":[{"attr":"status","op":"exists"}]}`)
	want := sortedInts(ids[0], ids[1])
	if got := rowIDs(rows); !equalIDs(got, want) {
		t.Errorf("exists: got %v, want %v", got, want)
	}

	// not exists: only task 2 has no status.
	rows = queryTree(t, srv, parentOf(t, srv, ids[0]),
		`{"connective":"and","children":[{"attr":"status","op":"not exists"}]}`)
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
	_, ids := seedTasks(t, srv, []map[string]any{
		{"status": "open", "assignee": 1}, // match  (status=open & assignee=1)
		{"status": "open", "assignee": 2}, // no     (status=open but assignee=2)
		{"status": "open"},                 // match  (status=open & no assignee)
		{"status": "done", "assignee": 1}, // no     (status!=open)
	})
	tree := `{
		"connective":"and",
		"children":[
			{"attr":"status","op":"=","values":["open"]},
			{
				"connective":"or",
				"children":[
					{"attr":"assignee","op":"=","values":[1]},
					{"connective":"not","children":[{"attr":"assignee","op":"exists"}]}
				]
			}
		]
	}`
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
	_, ids := seedTasks(t, srv, []map[string]any{
		{"status": "open"},
		{"status": "done"},
	})
	ctx := auth.WithSystemUser(context.Background())
	body := fmt.Sprintf(
		`{"parent_card_id":%d,"card_type_name":"task","where":[{"attr":"status","op":"=","value":"open"}]}`,
		parentOf(t, srv, ids[0]))
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
