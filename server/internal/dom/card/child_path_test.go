// child_path_test.go: the `<child_type>.<attr>` leaf path (e.g.
// `link.link_state`), which filters a card by its live child cards. Each
// tree runs through BOTH predicate compilers — card_compile_predicate.sql
// (via card.select_with_attributes) and card.CompileTree — and both must
// return the expected tasks.
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
	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/schema"
)

func TestPredicateCompiler_ChildPath(t *testing.T) {
	srv, pool := setupAttr(t, "kitp_test_predicate_child_path")
	ctx := auth.WithSystemUser(context.Background())
	projectID, ids, ms := seedTasks(t, srv, []map[string]any{
		{"milestone_ref": "M1"}, // 0: merged
		{"milestone_ref": "M1"}, // 1: open
		{"milestone_ref": "M2"}, // 2: open + a deleted merged link
		{"milestone_ref": "M2"}, // 3: no links
		{"milestone_ref": "M2"}, // 4: merged + abandoned
	})

	call := func(action, data string) json.RawMessage {
		t.Helper()
		resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "x", Endpoint: "card", Action: action, Data: json.RawMessage(data)},
		}})
		if !resp.Subresponses[0].OK {
			t.Fatalf("card.%s %s: %+v", action, data, resp.Subresponses[0])
		}
		buf, err := json.Marshal(resp.Subresponses[0].Data)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		return buf
	}
	addLink := func(task int64, state string) int64 {
		t.Helper()
		attrs, err := json.Marshal(map[string]string{
			"link_url":   fmt.Sprintf("https://gerrit.example.com/c/kitp/+/%d%s", task, state),
			"link_kind":  "gerrit",
			"link_state": state,
		})
		if err != nil {
			t.Fatalf("marshal attrs: %v", err)
		}
		var out card.InsertOutput
		if err := json.Unmarshal(call("insert", fmt.Sprintf(
			`{"card_type_name":"link","parent_card_id":"%d","title":"change","attributes":%s}`,
			task, attrs)), &out); err != nil {
			t.Fatalf("decode insert: %v", err)
		}
		return out.ID
	}
	addLink(ids[0], "merged")
	addLink(ids[1], "open")
	addLink(ids[2], "open")
	gone := addLink(ids[2], "merged")
	call("delete", fmt.Sprintf(`{"card_id":"%d"}`, gone))
	addLink(ids[4], "merged")
	addLink(ids[4], "abandoned")

	seeded := map[int64]bool{}
	for _, id := range ids {
		seeded[id] = true
	}
	intersect := func(in []int64) []int64 {
		var out []int64
		for _, id := range in {
			if seeded[id] {
				out = append(out, id)
			}
		}
		slices.Sort(out)
		return out
	}
	pick := func(is ...int) []int64 {
		out := make([]int64, len(is))
		for i, n := range is {
			out[i] = ids[n]
		}
		slices.Sort(out)
		return out
	}

	tests := []struct {
		name string
		tree string
		want []int64
	}{
		{"has a merged link",
			`{"connective":"and","children":[{"attr":"link.link_state","op":"=","values":["merged"]}]}`,
			pick(0, 4)},
		{"in: open or abandoned",
			`{"connective":"and","children":[{"attr":"link.link_state","op":"in","values":["open","abandoned"]}]}`,
			pick(1, 2, 4)},
		{"existential ne: a link that isn't merged",
			`{"connective":"and","children":[{"attr":"link.link_state","op":"!=","values":["merged"]}]}`,
			pick(1, 2, 4)},
		{"not group: no merged link",
			`{"connective":"not","children":[{"attr":"link.link_state","op":"=","values":["merged"]}]}`,
			pick(1, 2, 3)},
		{"has any link",
			`{"connective":"and","children":[{"attr":"link.link_url","op":"exists"}]}`,
			pick(0, 1, 2, 4)},
		{"composes with the task's own attributes",
			fmt.Sprintf(`{"connective":"and","children":[{"attr":"link.link_state","op":"=","values":["merged"]},{"attr":"milestone_ref","op":"=","values":[%d]}]}`, ms["M1"]),
			pick(0)},
		{"unknown child type matches nothing",
			`{"connective":"and","children":[{"attr":"nosuch.link_state","op":"=","values":["merged"]}]}`,
			nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var tree card.CardWhereGroup
			if err := json.Unmarshal([]byte(tc.tree), &tree); err != nil {
				t.Fatalf("decode tree: %v", err)
			}
			sqlIDs := intersect(rowIDs(queryTree(t, srv, projectID, tc.tree)))
			goIDs := intersect(goCompileMatch(t, pool, projectID, tree))
			if !equalIDs(sqlIDs, tc.want) {
				t.Errorf("SQL compiler: got %v, want %v", sqlIDs, tc.want)
			}
			if !equalIDs(goIDs, tc.want) {
				t.Errorf("Go compiler: got %v, want %v", goIDs, tc.want)
			}
		})
	}

	// Paths the compilers refuse: a malformed path, and last_activity_at
	// (read off the outer query's lateral, which a child can't re-bind).
	for _, attr := range []string{"link.link-state", "link.last_activity_at", "a.b.c"} {
		g := card.CardWhereGroup{Connective: "and", Children: []card.CardWhereTreeNode{
			{Attr: attr, Op: "within_last_days", Values: []json.RawMessage{json.RawMessage(`3`)}},
		}}
		tx, err := pool.P.Begin(ctx)
		if err != nil {
			t.Fatalf("begin: %v", err)
		}
		snap, err := schema.Load(ctx, tx)
		if err != nil {
			t.Fatalf("schema load: %v", err)
		}
		if _, err := card.CompileTree(ctx, tx, g, named.New().Bind, snap); err == nil {
			t.Errorf("Go compiler accepted attr %q", attr)
		}
		if err := tx.Rollback(ctx); err != nil {
			t.Fatalf("rollback: %v", err)
		}
		body := fmt.Sprintf(`{"parent_card_id":"%d","card_type_name":"task","tree":{"connective":"and","children":[{"attr":%q,"op":"within_last_days","values":[3]}]}}`,
			projectID, attr)
		resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "g", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(body)},
		}})
		if resp.Subresponses[0].OK {
			t.Errorf("SQL compiler accepted attr %q", attr)
		}
	}
}
