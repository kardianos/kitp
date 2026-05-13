package card_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/card"
)

// TestSearch covers the typeahead read used by the value-picker UI:
// substring + ids filters, ordering, and the empty-query "top N" mode.
func TestSearch(t *testing.T) {
	srv, _ := setupAttr(t, "kitp_test_card_search")
	ctx := auth.WithSystemUser(context.Background())

	// Seed: one project + four tasks under it with distinct titles.
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

	statusID := mkStatusUnder(t, srv, pOut.ID)
	titles := []string{"Alpha task", "Beta task", "Gamma quest", "Delta task"}
	taskIDs := make([]int64, 0, len(titles))
	for i, title := range titles {
		resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: fmt.Sprintf("t%d", i), Endpoint: "card", Action: "insert", Data: json.RawMessage(
				fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":%q,"attributes":{"status":"%d"}}`,
					pOut.ID, title, statusID))},
		}})
		if !resp.Subresponses[0].OK {
			t.Fatalf("task insert %d: %+v", i, resp.Subresponses[0])
		}
		var o card.InsertOutput
		b, _ := json.Marshal(resp.Subresponses[0].Data)
		_ = json.Unmarshal(b, &o)
		taskIDs = append(taskIDs, o.ID)
	}

	dispatchSearch := func(t *testing.T, body string) card.SearchOutput {
		t.Helper()
		resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "s", Endpoint: "card", Action: "search", Data: json.RawMessage(body)},
		}})
		if !resp.Subresponses[0].OK {
			t.Fatalf("search %s: %+v", body, resp.Subresponses[0])
		}
		var out card.SearchOutput
		b, _ := json.Marshal(resp.Subresponses[0].Data)
		_ = json.Unmarshal(b, &out)
		return out
	}

	// The test schema is shared with other suites and pre-seeded with extra
	// rows. Filter to titles we actually inserted by id so assertions are
	// stable regardless of the ambient row count.
	idsBody := fmt.Sprintf(`%d,%d,%d,%d`, taskIDs[0], taskIDs[1], taskIDs[2], taskIDs[3])

	t.Run("empty query returns the seeded tasks ordered by title", func(t *testing.T) {
		out := dispatchSearch(t, fmt.Sprintf(
			`{"card_type_name":"task","ids":[%s]}`, idsBody))
		if len(out.Rows) != 4 {
			t.Fatalf("expected 4 rows, got %d: %+v", len(out.Rows), out.Rows)
		}
		want := []string{"Alpha task", "Beta task", "Delta task", "Gamma quest"}
		for i, w := range want {
			if out.Rows[i].Title != w {
				t.Errorf("row %d: title %q, want %q", i, out.Rows[i].Title, w)
			}
		}
	})

	t.Run("query filters by substring case-insensitively", func(t *testing.T) {
		out := dispatchSearch(t, fmt.Sprintf(
			`{"card_type_name":"task","ids":[%s],"query":"task"}`, idsBody))
		if len(out.Rows) != 3 {
			t.Fatalf("expected 3 task rows, got %d: %+v", len(out.Rows), out.Rows)
		}
		out = dispatchSearch(t, fmt.Sprintf(
			`{"card_type_name":"task","ids":[%s],"query":"GAMMA"}`, idsBody))
		if len(out.Rows) != 1 || out.Rows[0].Title != "Gamma quest" {
			t.Fatalf("expected single Gamma row, got %+v", out.Rows)
		}
	})

	t.Run("ids filter resolves specific cards", func(t *testing.T) {
		body := fmt.Sprintf(`{"card_type_name":"task","ids":[%d,%d]}`, taskIDs[0], taskIDs[2])
		out := dispatchSearch(t, body)
		if len(out.Rows) != 2 {
			t.Fatalf("expected 2 rows, got %+v", out.Rows)
		}
		// Ordered by title — Alpha then Gamma.
		if out.Rows[0].Title != "Alpha task" || out.Rows[1].Title != "Gamma quest" {
			t.Errorf("unexpected order: %+v", out.Rows)
		}
	})

	t.Run("ids and query AND together", func(t *testing.T) {
		body := fmt.Sprintf(`{"card_type_name":"task","ids":[%d,%d],"query":"task"}`,
			taskIDs[0], taskIDs[2])
		out := dispatchSearch(t, body)
		if len(out.Rows) != 1 || out.Rows[0].Title != "Alpha task" {
			t.Fatalf("expected single Alpha row (ids∩query), got %+v", out.Rows)
		}
	})

	t.Run("limit caps results", func(t *testing.T) {
		out := dispatchSearch(t, fmt.Sprintf(
			`{"card_type_name":"task","ids":[%s],"limit":2}`, idsBody))
		if len(out.Rows) != 2 {
			t.Fatalf("expected 2 rows after limit, got %d", len(out.Rows))
		}
	})

	t.Run("parent_card_id filter scopes typeahead to in-project cards", func(t *testing.T) {
		// Build a second project with one task; the parent_card_id
		// filter must hide it from the first project's typeahead.
		resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "p2", Endpoint: "card", Action: "insert", Data: json.RawMessage(
				`{"card_type_name":"project","title":"P2"}`)},
		}})
		if !resp.Subresponses[0].OK {
			t.Fatalf("project 2 insert: %+v", resp.Subresponses[0])
		}
		var p2 card.InsertOutput
		b, _ := json.Marshal(resp.Subresponses[0].Data)
		_ = json.Unmarshal(b, &p2)
		s2 := mkStatusUnder(t, srv, p2.ID)
		resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "tx", Endpoint: "card", Action: "insert", Data: json.RawMessage(
				fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"Other Alpha","attributes":{"status":"%d"}}`,
					p2.ID, s2))},
		}})
		if !resp.Subresponses[0].OK {
			t.Fatalf("other-project task insert: %+v", resp.Subresponses[0])
		}

		// Without the filter, "alpha" matches across both projects.
		out := dispatchSearch(t, `{"card_type_name":"task","query":"alpha"}`)
		if len(out.Rows) < 2 {
			t.Fatalf("expected >= 2 alpha tasks (both projects), got %+v", out.Rows)
		}

		// With parent_card_id set, the typeahead is restricted to that
		// project — the other project's "Other Alpha" must drop out.
		out = dispatchSearch(t, fmt.Sprintf(
			`{"card_type_name":"task","query":"alpha","parent_card_id":"%d"}`, pOut.ID))
		if len(out.Rows) != 1 || out.Rows[0].Title != "Alpha task" {
			t.Fatalf("parent-scoped search: expected single Alpha task; got %+v", out.Rows)
		}
	})

	t.Run("missing card_type_name is rejected", func(t *testing.T) {
		resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "s", Endpoint: "card", Action: "search", Data: json.RawMessage(`{}`)},
		}})
		if resp.Subresponses[0].OK {
			t.Fatalf("expected rejection, got OK: %+v", resp.Subresponses[0])
		}
		if resp.Subresponses[0].Error == nil ||
			resp.Subresponses[0].Error.Code != "validation" {
			t.Fatalf("expected validation error, got %+v", resp.Subresponses[0])
		}
	})
}
