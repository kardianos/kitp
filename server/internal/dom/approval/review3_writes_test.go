package approval_test

// Regression tests for the approval findings of the third 2026-11-03 review
// (#13, #14).

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// TestAskedCommenterCanVote (round 3 #13): a commenter asked to vote can
// vote; a viewer, who may not comment, can't be asked at all.
func TestAskedCommenterCanVote(t *testing.T) {
	f := setup(t, "kitp_test_r3_commenter_vote")
	ctx := context.Background()
	for _, q := range []string{
		fmt.Sprintf(`DELETE FROM user_role WHERE user_id = %d`, f.pat.userID),
		fmt.Sprintf(`INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT %d, id, %d FROM role WHERE name = 'commenter'`, f.pat.userID, f.project),
		fmt.Sprintf(`DELETE FROM user_role WHERE user_id = %d`, f.sam.userID),
		fmt.Sprintf(`INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT %d, id, %d FROM role WHERE name = 'viewer'`, f.sam.userID, f.project),
	} {
		if _, err := f.sp.P.Exec(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	ask := func(people ...int64) (bool, string, string) {
		ids := make([]string, len(people))
		for i, p := range people {
			ids[i] = fmt.Sprintf("%q", fmt.Sprint(p))
		}
		sr := call(f, f.dana.ctx, "approval", "set", fmt.Sprintf(
			`{"task_id":"%d","from_status_id":"%d","to_status_id":"%d","approver_ids":[%s]}`,
			f.task, f.statuses["Review"], f.statuses["Done"], strings.Join(ids, ",")))
		if !sr.OK {
			return false, sr.Error.Code, ""
		}
		var set struct {
			ApprovalID string `json:"approval_id"`
		}
		decode(t, sr, &set)
		return true, "", set.ApprovalID
	}
	if ok, code, _ := ask(f.sam.personID); ok || code != "approver_invalid" {
		t.Errorf("asking a viewer: ok=%v code=%q, want approver_invalid", ok, code)
	}
	ok, code, approval := ask(f.pat.personID)
	if !ok {
		t.Fatalf("asking a commenter: %s", code)
	}
	sr := call(f, f.pat.ctx, "approval", "decide", fmt.Sprintf(`{"task_id":"%d","approval_id":"%s","decision":"approve"}`, f.task, approval))
	if !sr.OK {
		t.Errorf("the commenter asked couldn't vote: %+v", sr.Error)
	}
}

// TestReasonStaysHiddenWhileApprovalsIsOff (round 3 #14): with Approvals
// off, a vote's reason can't be edited, and an earlier edit of it is hidden
// with the vote.
func TestReasonStaysHiddenWhileApprovalsIsOff(t *testing.T) {
	f := setup(t, "kitp_test_r3_reason_off")
	ctx := context.Background()
	out := f.decide(t, f.dana.ctx, fmt.Sprintf(`"from_status_id":"%d","to_status_id":"%d","decision":"reject","reason":"first reason"`,
		f.statuses["Review"], f.statuses["Done"]))
	if sr := call(f, f.dana.ctx, "comment", "update", fmt.Sprintf(`{"activity_id":"%d","body":"the edited reason"}`, out.DecisionID)); !sr.OK {
		t.Fatalf("comment.update with Approvals on: %+v", sr.Error)
	}
	if _, err := f.sp.P.Exec(ctx, `INSERT INTO project_area (project_id, area_key, state) VALUES ($1, 'approvals', 'off')
		ON CONFLICT (project_id, area_key) DO UPDATE SET state = 'off'`, f.project); err != nil {
		t.Fatal(err)
	}
	sr := call(f, f.dana.ctx, "comment", "update", fmt.Sprintf(`{"activity_id":"%d","body":"edited while off"}`, out.DecisionID))
	if sr.OK || sr.Error.Code != "area_off" {
		t.Errorf("comment.update of a vote's reason with Approvals off: %+v, want area_off", sr)
	}
	var o struct {
		Rows []struct {
			Kind     string          `json:"kind"`
			ValueNew json.RawMessage `json:"value_new"`
		} `json:"rows"`
	}
	decode(t, call(f, f.lee.ctx, "activity", "select", fmt.Sprintf(`{"card_id":"%d"}`, f.task)), &o)
	for _, r := range o.Rows {
		if r.Kind == "approval_decision" || (r.Kind == "comment_edit" && strings.Contains(string(r.ValueNew), "edited reason")) {
			t.Errorf("with Approvals off the feed shows a %s: %s", r.Kind, r.ValueNew)
		}
	}
}
