package approval_test

// Regression test for the fifth 2026-11-03 review (an item left open after
// round 4 #13).

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

// TestWaitingOnlyOnVoters: a person asked who has since lost their comment
// rights on the project can't vote, so no task waits on them.
func TestWaitingOnlyOnVoters(t *testing.T) {
	f := setup(t, "kitp_test_r5_waiting_voters")
	ctx := context.Background()
	sr := call(f, f.dana.ctx, "approval", "set", fmt.Sprintf(
		`{"task_id":"%d","from_status_id":"%d","to_status_id":"%d","approver_ids":["%d"]}`,
		f.task, f.statuses["Review"], f.statuses["Done"], f.lee.personID))
	if !sr.OK {
		t.Fatalf("approval.set: %+v", sr.Error)
	}
	waiting := func() bool {
		t.Helper()
		var w bool
		if err := f.sp.P.QueryRow(ctx, `SELECT approval_waiting_on($1, ARRAY[$2::bigint])`, f.task, f.lee.personID).Scan(&w); err != nil {
			t.Fatal(err)
		}
		return w
	}
	if !waiting() {
		t.Fatal("not waiting on Lee, who was asked")
	}
	if _, err := f.sp.P.Exec(ctx, `DELETE FROM user_role WHERE user_id = $1`, f.lee.userID); err != nil {
		t.Fatal(err)
	}
	if waiting() {
		t.Error("still waiting on Lee, who can no longer vote")
	}
}

// TestEditedReasonKeepsItsCap (round 5 #17): a vote's reason, edited, stays
// within approval.decide's 20,000 characters.
func TestEditedReasonKeepsItsCap(t *testing.T) {
	f := setup(t, "kitp_test_r5_reason_cap")
	out := f.decide(t, f.dana.ctx, fmt.Sprintf(`"from_status_id":"%d","to_status_id":"%d","decision":"reject","reason":"first reason"`,
		f.statuses["Review"], f.statuses["Done"]))
	sr := call(f, f.dana.ctx, "comment", "update", fmt.Sprintf(`{"activity_id":"%d","body":%q}`, out.DecisionID, strings.Repeat("x", 20001)))
	if sr.OK || sr.Error.Code != "validation" {
		t.Errorf("editing a reason to 20,001 characters: %+v, want validation", sr)
	}
	if sr := call(f, f.dana.ctx, "comment", "update", fmt.Sprintf(`{"activity_id":"%d","body":"shorter"}`, out.DecisionID)); !sr.OK {
		t.Errorf("a short edit: %+v", sr.Error)
	}
}

// TestTallyLeavesOutWhoCannotVote: someone asked who lost their comment
// rights and hasn't voted doesn't hold the request open; a request nobody
// it asks can vote on any more stays open rather than counting as approved.
func TestTallyLeavesOutWhoCannotVote(t *testing.T) {
	f := setup(t, "kitp_test_r5_tally_voters")
	ctx := context.Background()
	sr := call(f, f.dana.ctx, "approval", "set", fmt.Sprintf(
		`{"task_id":"%d","from_status_id":"%d","to_status_id":"%d","approver_ids":["%d","%d"]}`,
		f.task, f.statuses["Review"], f.statuses["Done"], f.lee.personID, f.pat.personID))
	if !sr.OK {
		t.Fatalf("approval.set: %+v", sr.Error)
	}
	var set struct {
		ApprovalID string `json:"approval_id"`
	}
	decode(t, sr, &set)
	if sr := call(f, f.pat.ctx, "approval", "decide", fmt.Sprintf(`{"task_id":"%d","approval_id":"%s","decision":"approve"}`, f.task, set.ApprovalID)); !sr.OK {
		t.Fatalf("pat's vote: %+v", sr.Error)
	}
	summary := func() (state string, asked int) {
		t.Helper()
		if err := f.sp.P.QueryRow(ctx, `SELECT s->>'state', (s->>'asked')::int FROM approval_summary($1, NULL) s`, f.task).Scan(&state, &asked); err != nil {
			t.Fatal(err)
		}
		return
	}
	if state, _ := summary(); state != "open" {
		t.Fatalf("before: %q, want open (Lee hasn't voted)", state)
	}
	if _, err := f.sp.P.Exec(ctx, `DELETE FROM user_role WHERE user_id = $1`, f.lee.userID); err != nil {
		t.Fatal(err)
	}
	if state, asked := summary(); state != "approved" || asked != 1 {
		t.Errorf("Lee can no longer vote: %q of %d asked, want approved of 1", state, asked)
	}
	if _, err := f.sp.P.Exec(ctx, `DELETE FROM user_role WHERE user_id = $1`, f.pat.userID); err != nil {
		t.Fatal(err)
	}
	if state, asked := summary(); state != "approved" || asked != 1 {
		t.Errorf("Pat's vote, cast while Pat could: %q of %d, want approved of 1", state, asked)
	}

	// A second request asking only Dana, who then loses access: nobody is
	// left to answer it.
	sr = call(f, f.dana.ctx, "approval", "set", fmt.Sprintf(
		`{"task_id":"%d","from_status_id":"%d","to_status_id":"%d","approver_ids":["%d"]}`,
		f.task, f.statuses["Todo"], f.statuses["Doing"], f.dana.personID))
	if !sr.OK {
		t.Fatalf("approval.set for Dana: %+v", sr.Error)
	}
	if _, err := f.sp.P.Exec(ctx, `DELETE FROM user_role WHERE user_id = $1`, f.dana.userID); err != nil {
		t.Fatal(err)
	}
	if state, _ := summary(); state != "open" {
		t.Errorf("a request nobody can answer: %q, want open", state)
	}
}
