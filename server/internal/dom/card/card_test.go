package card_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

func setup(t *testing.T, schema string) (*api.Server, *store.Pool) {
	t.Helper()
	reg.Reset()
	pool := store.TestPool(t, schema)
	sp := store.NewPool(pool)
	echo.Register()
	cardtype.Register()
	card.Register(sp)
	return api.NewServer(sp), sp
}

func mustOK(t *testing.T, sr api.SubResponse) {
	t.Helper()
	if !sr.OK {
		t.Fatalf("sub %s failed: %+v", sr.ID, sr.Error)
	}
}

// idsOf decodes a card.insert sub-response payload back into []int64.
func idsOf(t *testing.T, sr api.SubResponse) int64 {
	t.Helper()
	mustOK(t, sr)
	buf, err := json.Marshal(sr.Data)
	if err != nil {
		t.Fatal(err)
	}
	var out card.InsertOutput
	if err := json.Unmarshal(buf, &out); err != nil {
		t.Fatal(err)
	}
	return out.ID
}

func rowsOf(t *testing.T, sr api.SubResponse) []card.CardRow {
	t.Helper()
	mustOK(t, sr)
	buf, err := json.Marshal(sr.Data)
	if err != nil {
		t.Fatal(err)
	}
	var out card.SelectOutput
	if err := json.Unmarshal(buf, &out); err != nil {
		t.Fatal(err)
	}
	return out.Rows
}

// TestCardLifecycle covers REQUIREMENTS §F-CARD-1 / F-CARD-5 at the v1 level:
// create project, list projects, create task under project, list tasks.
func TestCardLifecycle(t *testing.T) {
	srv, _ := setup(t, "kitp_test_card_life")
	ctx := context.Background()

	resp := srv.Dispatch(ctx, api.BatchRequest{
		Subrequests: []api.SubRequest{
			{ID: "ins", Endpoint: "card", Action: "insert", Data: json.RawMessage(
				`{"card_type_name":"project","title":"Acme"}`)},
			{ID: "list", Endpoint: "card", Action: "select", Data: json.RawMessage(
				`{"card_type_name":"project"}`)},
		},
	})
	projectID := idsOf(t, resp.Subresponses[0])
	rows := rowsOf(t, resp.Subresponses[1])
	// Migration 0005 seeds a 'Default Project'. We expect at least our newly-
	// inserted project plus the seeded one in the list.
	found := false
	for _, r := range rows {
		if r.ID == projectID && r.CardTypeName == "project" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("inserted project not in list: %+v (id=%d)", rows, projectID)
	}

	resp2 := srv.Dispatch(ctx, api.BatchRequest{
		Subrequests: []api.SubRequest{
			{ID: "ins", Endpoint: "card", Action: "insert", Data: rawf(
				`{"card_type_name":"task","parent_card_id":%d,"title":"Do thing"}`, projectID)},
			{ID: "list", Endpoint: "card", Action: "select", Data: rawf(
				`{"parent_card_id":%d,"card_type_name":"task"}`, projectID)},
		},
	})
	taskID := idsOf(t, resp2.Subresponses[0])
	tasks := rowsOf(t, resp2.Subresponses[1])
	if len(tasks) != 1 || tasks[0].ID != taskID {
		t.Fatalf("task list: %+v", tasks)
	}
}

// TestEdgeViolationRejected: creating a task under a tag must fail with a
// structured error, and the rest of the batch must show as aborted.
func TestEdgeViolationRejected(t *testing.T) {
	srv, _ := setup(t, "kitp_test_card_edge")
	ctx := context.Background()

	// Project to host a tag.
	resp := srv.Dispatch(ctx, api.BatchRequest{
		Subrequests: []api.SubRequest{
			{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
				`{"card_type_name":"project","title":"P"}`)},
		},
	})
	pid := idsOf(t, resp.Subresponses[0])

	resp = srv.Dispatch(ctx, api.BatchRequest{
		Subrequests: []api.SubRequest{
			{ID: "tag", Endpoint: "card", Action: "insert", Data: rawf(
				`{"card_type_name":"tag","parent_card_id":%d,"title":"priority/high"}`, pid)},
		},
	})
	tagID := idsOf(t, resp.Subresponses[0])

	// Task under tag -> rejected.
	resp = srv.Dispatch(ctx, api.BatchRequest{
		Subrequests: []api.SubRequest{
			{ID: "bad", Endpoint: "card", Action: "insert", Data: rawf(
				`{"card_type_name":"task","parent_card_id":%d,"title":"bad"}`, tagID)},
			{ID: "neutral", Endpoint: "card", Action: "select", Data: rawf(
				`{"card_type_name":"project"}`)},
		},
	})
	if resp.Subresponses[0].OK {
		t.Fatalf("expected violation; got %+v", resp.Subresponses[0])
	}
	if resp.Subresponses[0].Error == nil || resp.Subresponses[0].Error.Code != "edge_violation" {
		t.Errorf("offender code: %+v", resp.Subresponses[0].Error)
	}
	if resp.Subresponses[1].OK || resp.Subresponses[1].Error.Code != "aborted" {
		t.Errorf("sibling should be aborted: %+v", resp.Subresponses[1])
	}

	// And nothing should have been written: re-listing projects shows just
	// the one we made plus the seeded 'Default Project' from migration 0005.
	resp = srv.Dispatch(ctx, api.BatchRequest{
		Subrequests: []api.SubRequest{
			{ID: "list", Endpoint: "card", Action: "select", Data: json.RawMessage(
				`{"card_type_name":"project"}`)},
		},
	})
	rows := rowsOf(t, resp.Subresponses[0])
	if len(rows) != 2 {
		t.Errorf("project rollback: got %d projects, want 2 (our P + seeded Default Project)", len(rows))
	}
}

// TestTwoInsertsCoalesceToOneStatement asserts that two card.insert
// sub-requests in one batch produce a small constant number of writer
// statement groups regardless of N (N-SRV-2). card.insert runs two
// statement groups: (1) the card INSERT, (2) a CTE that emits one
// card_create activity per card plus one attr_update activity + one
// attribute_value upsert per initial attribute. Both groups coalesce
// across sub-requests.
func TestTwoInsertsCoalesceToOneStatement(t *testing.T) {
	srv, sp := setup(t, "kitp_test_card_coalesce")
	ctx := context.Background()

	sp.ResetWrites()
	resp := srv.Dispatch(ctx, api.BatchRequest{
		Subrequests: []api.SubRequest{
			{ID: "p1", Endpoint: "card", Action: "insert", Data: json.RawMessage(
				`{"card_type_name":"project","title":"One"}`)},
			{ID: "p2", Endpoint: "card", Action: "insert", Data: json.RawMessage(
				`{"card_type_name":"project","title":"Two"}`)},
		},
	})
	for _, sr := range resp.Subresponses {
		mustOK(t, sr)
	}
	if got := sp.LastWrites(); got != 2 {
		t.Fatalf("LastWrites: got %d, want 2 (two card.insert sub-requests must be one Run = 2 statement groups)", got)
	}
}

// TestTaskUnderTaskAllowed verifies allow_self_parent on the task type.
func TestTaskUnderTaskAllowed(t *testing.T) {
	srv, _ := setup(t, "kitp_test_card_subtask")
	ctx := context.Background()

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
	}})
	pid := idsOf(t, resp.Subresponses[0])

	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "t", Endpoint: "card", Action: "insert", Data: rawf(
			`{"card_type_name":"task","parent_card_id":%d,"title":"parent task"}`, pid)},
	}})
	tid := idsOf(t, resp.Subresponses[0])

	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "sub", Endpoint: "card", Action: "insert", Data: rawf(
			`{"card_type_name":"task","parent_card_id":%d,"title":"sub task"}`, tid)},
	}})
	mustOK(t, resp.Subresponses[0])
}

// rawf is a tiny json.RawMessage helper.
func rawf(format string, args ...any) json.RawMessage {
	return json.RawMessage(fmt.Sprintf(format, args...))
}
