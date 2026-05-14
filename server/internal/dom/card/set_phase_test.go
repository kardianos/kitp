package card_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/activity"
	"github.com/kitp/kitp/server/internal/dom/card"
)

// readPhase pulls the structural `phase` column for one status card.
// We fan out under its parent project and pick by id — select_with_
// attributes has no `card_ids` filter, and adding a SQL probe just for
// this test would couple the test to internals.
func readPhase(t *testing.T, srv *api.Server, projectID, cardID int64) string {
	t.Helper()
	ctx := auth.WithSystemUser(context.Background())
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "g", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(
			fmt.Sprintf(`{"parent_card_id":"%d","card_type_name":"status"}`, projectID))},
	}})
	mustOK(t, resp.Subresponses[0])
	var out card.SelectWithAttributesOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &out)
	for _, r := range out.Rows {
		if r.ID == cardID {
			return r.Phase
		}
	}
	t.Fatalf("readPhase: card %d not found under project %d", cardID, projectID)
	return ""
}

// TestSetPhase_FlipsAndLogsActivity verifies the happy path: a freshly
// inserted status card lands on its default phase ('triage'), set_phase
// flips it, and the activity row records the prev/new values.
func TestSetPhase_FlipsAndLogsActivity(t *testing.T) {
	srv, _ := setupAttr(t, "kitp_test_card_set_phase_ok")
	ctx := auth.WithSystemUser(context.Background())

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
	}})
	mustOK(t, resp.Subresponses[0])
	pID := idsOf(t, resp.Subresponses[0])

	sID := mkStatusUnder(t, srv, pID)
	if got := readPhase(t, srv, pID, sID); got != "triage" {
		t.Fatalf("default phase: got %q, want %q", got, "triage")
	}

	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "sp", Endpoint: "card", Action: "set_phase", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d","phase":"terminal"}`, sID))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("set_phase: %+v", resp.Subresponses[0])
	}
	if got := readPhase(t, srv, pID, sID); got != "terminal" {
		t.Errorf("after set: got %q, want %q", got, "terminal")
	}

	// Activity tail should carry the kind + old/new values.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "a", Endpoint: "activity", Action: "select", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d"}`, sID))},
	}})
	var aOut activity.SelectOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &aOut)
	last := aOut.Rows[len(aOut.Rows)-1]
	if last.Kind != "card_set_phase" {
		t.Errorf("activity[last].kind: got %q, want %q", last.Kind, "card_set_phase")
	}
	if string(last.ValueOld) != `"triage"` {
		t.Errorf("activity[last].value_old: got %s, want \"triage\"", string(last.ValueOld))
	}
	if string(last.ValueNew) != `"terminal"` {
		t.Errorf("activity[last].value_new: got %s, want \"terminal\"", string(last.ValueNew))
	}
}

// TestSetPhase_RejectsBadValue confirms the validator stops typos at the
// boundary so the DB CHECK constraint never has to.
func TestSetPhase_RejectsBadValue(t *testing.T) {
	srv, _ := setupAttr(t, "kitp_test_card_set_phase_bad")
	ctx := auth.WithSystemUser(context.Background())
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
	}})
	mustOK(t, resp.Subresponses[0])
	pID := idsOf(t, resp.Subresponses[0])
	sID := mkStatusUnder(t, srv, pID)

	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "sp", Endpoint: "card", Action: "set_phase", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d","phase":"shipping"}`, sID))},
	}})
	if resp.Subresponses[0].OK {
		t.Fatalf("expected failure for bad phase; got OK")
	}
	if resp.Subresponses[0].Error.Code != "validation" {
		t.Errorf("error code: got %q, want %q", resp.Subresponses[0].Error.Code, "validation")
	}
	if got := readPhase(t, srv, pID, sID); got != "triage" {
		t.Errorf("phase after rejected set: got %q, want %q", got, "triage")
	}
}

// TestSetPhase_RejectsMissingCard surfaces a friendly card_not_found
// instead of letting a 0-row UPDATE silently succeed.
func TestSetPhase_RejectsMissingCard(t *testing.T) {
	srv, _ := setupAttr(t, "kitp_test_card_set_phase_404")
	ctx := auth.WithSystemUser(context.Background())
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "sp", Endpoint: "card", Action: "set_phase", Data: json.RawMessage(
			`{"card_id":"99999","phase":"active"}`)},
	}})
	if resp.Subresponses[0].OK {
		t.Fatalf("expected failure for missing card; got OK")
	}
	if resp.Subresponses[0].Error.Code != "card_not_found" {
		t.Errorf("error code: got %q, want %q", resp.Subresponses[0].Error.Code, "card_not_found")
	}
}

// TestInsert_AcceptsPhase verifies card.insert can land a value-card on a
// chosen phase directly, skipping the "insert as triage then flip" dance.
func TestInsert_AcceptsPhase(t *testing.T) {
	srv, _ := setupAttr(t, "kitp_test_card_insert_phase")
	ctx := auth.WithSystemUser(context.Background())

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
	}})
	mustOK(t, resp.Subresponses[0])
	pID := idsOf(t, resp.Subresponses[0])

	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "s", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"status","parent_card_id":"%d","title":"Done","phase":"terminal"}`,
				pID))},
	}})
	mustOK(t, resp.Subresponses[0])
	sID := idsOf(t, resp.Subresponses[0])
	if got := readPhase(t, srv, pID, sID); got != "terminal" {
		t.Errorf("phase: got %q, want %q", got, "terminal")
	}
}

// TestInsert_RejectsBadPhase keeps the boundary validation consistent
// across the two write paths.
func TestInsert_RejectsBadPhase(t *testing.T) {
	srv, _ := setupAttr(t, "kitp_test_card_insert_bad_phase")
	ctx := auth.WithSystemUser(context.Background())

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
	}})
	mustOK(t, resp.Subresponses[0])
	pID := idsOf(t, resp.Subresponses[0])

	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "s", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"status","parent_card_id":"%d","title":"Done","phase":"shipping"}`,
				pID))},
	}})
	if resp.Subresponses[0].OK {
		t.Fatalf("expected failure for bad phase; got OK")
	}
	if resp.Subresponses[0].Error.Code != "validation" {
		t.Errorf("error code: got %q, want %q", resp.Subresponses[0].Error.Code, "validation")
	}
}
