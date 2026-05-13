package card_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
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

// mkStatusUnder inserts one status card under projectID and returns its
// id. Helper for Gate 6's required-attribute check on card.insert: any
// task created under projectID needs a same-project status to pass
// validation. Caller picks the phase ('triage' / 'active' / 'terminal')
// based on what the test is exercising; default callers pass 'active'.
func mkStatusUnder(t *testing.T, srv *api.Server, projectID int64) int64 {
	t.Helper()
	ctx := auth.WithSystemUser(context.Background())
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "s", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"status","parent_card_id":"%d","title":"Todo"}`,
				projectID))},
	}})
	mustOK(t, resp.Subresponses[0])
	var out card.InsertOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &out)
	return out.ID
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
	ctx := auth.WithSystemUser(context.Background())

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

	statusID := mkStatusUnder(t, srv, projectID)
	resp2 := srv.Dispatch(ctx, api.BatchRequest{
		Subrequests: []api.SubRequest{
			{ID: "ins", Endpoint: "card", Action: "insert", Data: rawf(
				`{"card_type_name":"task","parent_card_id":"%d","title":"Do thing","attributes":{"status":"%d"}}`,
				projectID, statusID)},
			{ID: "list", Endpoint: "card", Action: "select", Data: rawf(
				`{"parent_card_id":"%d","card_type_name":"task"}`, projectID)},
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
	ctx := auth.WithSystemUser(context.Background())

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
				`{"card_type_name":"tag","parent_card_id":"%d","title":"priority/high","attributes":{"path":"priority/high"}}`, pid)},
		},
	})
	tagID := idsOf(t, resp.Subresponses[0])

	// Task under tag -> rejected.
	resp = srv.Dispatch(ctx, api.BatchRequest{
		Subrequests: []api.SubRequest{
			{ID: "bad", Endpoint: "card", Action: "insert", Data: rawf(
				`{"card_type_name":"task","parent_card_id":"%d","title":"bad"}`, tagID)},
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
	// the one we made plus the two seeded projects ('Default Project' from
	// the demo seed and 'Standard Project Template' from the install seed,
	// Gate 11).
	resp = srv.Dispatch(ctx, api.BatchRequest{
		Subrequests: []api.SubRequest{
			{ID: "list", Endpoint: "card", Action: "select", Data: json.RawMessage(
				`{"card_type_name":"project"}`)},
		},
	})
	rows := rowsOf(t, resp.Subresponses[0])
	if len(rows) != 3 {
		t.Errorf("project rollback: got %d projects, want 3 (our P + Default Project + Standard Project Template)", len(rows))
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
	ctx := auth.WithSystemUser(context.Background())

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
	ctx := auth.WithSystemUser(context.Background())

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
	}})
	pid := idsOf(t, resp.Subresponses[0])
	sid := mkStatusUnder(t, srv, pid)

	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "t", Endpoint: "card", Action: "insert", Data: rawf(
			`{"card_type_name":"task","parent_card_id":"%d","title":"parent task","attributes":{"status":"%d"}}`,
			pid, sid)},
	}})
	tid := idsOf(t, resp.Subresponses[0])

	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "sub", Endpoint: "card", Action: "insert", Data: rawf(
			`{"card_type_name":"task","parent_card_id":"%d","title":"sub task","attributes":{"status":"%d"}}`,
			tid, sid)},
	}})
	mustOK(t, resp.Subresponses[0])
}

// TestRequiredAttributeOnInsert is Gate 6's server-side boundary
// check: card.insert rejects with edge_violation when a required
// attribute is missing from the payload. Today (task, status) is the
// only non-title required edge; the test inserts a task without
// status and expects the rejection plus a message that names the
// attribute so an operator can diagnose the failure.
//
// Symmetric check: a task WITH status passes, demonstrating that the
// boundary doesn't over-reject when the caller threads the required
// attribute through (the client's default-create-status chain).
func TestRequiredAttributeOnInsert(t *testing.T) {
	srv, _ := setup(t, "kitp_test_card_required_insert")
	ctx := auth.WithSystemUser(context.Background())

	// Project + status (under that project).
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
	}})
	pid := idsOf(t, resp.Subresponses[0])
	sid := mkStatusUnder(t, srv, pid)

	t.Run("missing required status rejects with edge_violation", func(t *testing.T) {
		resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "bad", Endpoint: "card", Action: "insert", Data: rawf(
				`{"card_type_name":"task","parent_card_id":"%d","title":"no-status"}`, pid)},
		}})
		sr := resp.Subresponses[0]
		if sr.OK {
			t.Fatalf("expected edge_violation; got OK")
		}
		if sr.Error == nil || sr.Error.Code != "edge_violation" {
			t.Fatalf("expected edge_violation; got %+v", sr.Error)
		}
		if !strings.Contains(sr.Error.Message, "status") {
			t.Errorf("error message must name the missing attribute; got %q",
				sr.Error.Message)
		}
		if !strings.Contains(sr.Error.Message, "required") {
			t.Errorf("error message should mention 'required'; got %q",
				sr.Error.Message)
		}
	})

	t.Run("null required status rejects with edge_violation", func(t *testing.T) {
		// Explicit null is equivalent to missing — the (task, status)
		// edge is required so a null write at insert is not allowed.
		resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "bad_null", Endpoint: "card", Action: "insert", Data: rawf(
				`{"card_type_name":"task","parent_card_id":"%d","title":"null-status","attributes":{"status":null}}`,
				pid)},
		}})
		sr := resp.Subresponses[0]
		if sr.OK {
			t.Fatalf("expected edge_violation; got OK")
		}
		if sr.Error == nil || sr.Error.Code != "edge_violation" {
			t.Fatalf("expected edge_violation; got %+v", sr.Error)
		}
	})

	t.Run("required status present passes", func(t *testing.T) {
		resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "ok", Endpoint: "card", Action: "insert", Data: rawf(
				`{"card_type_name":"task","parent_card_id":"%d","title":"with-status","attributes":{"status":"%d"}}`,
				pid, sid)},
		}})
		mustOK(t, resp.Subresponses[0])
	})
}

// rawf is a tiny json.RawMessage helper.
func rawf(format string, args ...any) json.RawMessage {
	return json.RawMessage(fmt.Sprintf(format, args...))
}
