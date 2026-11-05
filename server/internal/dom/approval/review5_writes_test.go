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
