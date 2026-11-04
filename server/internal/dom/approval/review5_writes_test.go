package approval_test

// Regression test for the fifth 2026-11-03 review (an item left open after
// round 4 #13).

import (
	"context"
	"fmt"
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
