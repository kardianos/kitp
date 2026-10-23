// approval_test.go: approval requests and votes end to end through the
// dispatcher — asking, voting (asked or not, agents refused), the tally,
// the queue, the list badge, rounds settled by reaching the edge's target,
// removal keeping votes, and the audit rows.
package approval_test

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/activity"
	"github.com/kitp/kitp/server/internal/dom/approval"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/comment"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

type person struct {
	userID, personID int64
	ctx              context.Context
}

type fixture struct {
	srv      *api.Server
	sp       *store.Pool
	project  int64
	task     int64
	statuses map[string]int64
	dana     person
	lee      person
	pat      person // a project member nobody asks
	sam      person // has a login but no role on the project
	agentCtx context.Context
}

func setup(t *testing.T, schemaName string) fixture {
	t.Helper()
	reg.Reset()
	pool := store.TestPool(t, schemaName)
	sp := store.NewPool(pool)
	cardtype.Register()
	card.Register(sp)
	attribute.Register(sp)
	activity.Register(sp)
	comment.Register(sp)
	approval.Register(sp)
	f := fixture{srv: api.NewServer(sp), sp: sp, statuses: map[string]int64{}}

	f.project = insertCard(t, f, `{"card_type_name":"project","title":"Apollo"}`)
	for _, name := range []string{"New idea", "Todo", "Doing", "Review", "Done", "Cancelled"} {
		f.statuses[name] = store.TemplateStatusID(t, pool, f.project, name)
	}
	f.task = insertCard(t, f, fmt.Sprintf(
		`{"card_type_name":"task","parent_card_id":"%d","title":"Ship it","attributes":{"status":"%d"}}`,
		f.project, f.statuses["Todo"]))
	f.dana = f.newPerson(t, "Dana", true)
	f.lee = f.newPerson(t, "Lee", true)
	f.pat = f.newPerson(t, "Pat", true)
	f.sam = f.newPerson(t, "Sam", false)

	var agentID int64
	if err := pool.QueryRow(context.Background(), `
		INSERT INTO user_account (display_name, is_agent, parent_user_id) VALUES ('claude', true, $1) RETURNING id
	`, f.dana.userID).Scan(&agentID); err != nil {
		t.Fatalf("agent: %v", err)
	}
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT $1, id, $2 FROM role WHERE name = 'worker'
	`, agentID, f.project); err != nil {
		t.Fatalf("agent role: %v", err)
	}
	f.agentCtx = auth.WithUser(context.Background(), &auth.UserCtx{ID: agentID, DisplayName: "claude"})
	return f
}

// newPerson provisions a login + linked person card; member gets a worker
// role on the fixture project.
func (f fixture) newPerson(t *testing.T, name string, member bool) person {
	t.Helper()
	ctx := context.Background()
	var p person
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ($1) RETURNING id`, name).Scan(&p.userID); err != nil {
		t.Fatalf("user %s: %v", name, err)
	}
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'person' RETURNING id`).Scan(&p.personID); err != nil {
		t.Fatalf("person %s: %v", name, err)
	}
	stmts := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO attribute_value (card_id, attribute_def_id, value) SELECT $1, id, to_jsonb($2::text) FROM attribute_def WHERE name = 'title'`, []any{p.personID, name}},
		{`INSERT INTO user_account_person (user_account_id, person_card_id) VALUES ($1, $2)`, []any{p.userID, p.personID}},
	}
	if member {
		stmts = append(stmts, struct {
			sql  string
			args []any
		}{`INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT $1, id, $2 FROM role WHERE name = 'worker'`, []any{p.userID, f.project}})
	}
	for _, s := range stmts {
		if _, err := f.sp.P.Exec(ctx, s.sql, s.args...); err != nil {
			t.Fatalf("person %s setup: %v", name, err)
		}
	}
	p.ctx = auth.WithUser(ctx, &auth.UserCtx{ID: p.userID, DisplayName: name})
	return p
}

func sysCtx() context.Context { return auth.WithSystemUser(context.Background()) }

func call(f fixture, ctx context.Context, endpoint, action, data string) api.SubResponse {
	resp := f.srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "x", Endpoint: endpoint, Action: action, Data: json.RawMessage(data)},
	}})
	return resp.Subresponses[0]
}

func decode(t *testing.T, sr api.SubResponse, out any) {
	t.Helper()
	if !sr.OK {
		t.Fatalf("want OK; got %+v", sr.Error)
	}
	raw, err := json.Marshal(sr.Data)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		t.Fatalf("unmarshal %s: %v", raw, err)
	}
}

func wantCode(t *testing.T, sr api.SubResponse, code string) {
	t.Helper()
	if sr.OK {
		t.Fatalf("want %s; got OK", code)
	}
	if sr.Error == nil || sr.Error.Code != code {
		t.Fatalf("want code %s; got %+v", code, sr.Error)
	}
}

func insertCard(t *testing.T, f fixture, data string) int64 {
	t.Helper()
	var o card.InsertOutput
	decode(t, call(f, sysCtx(), "card", "insert", data), &o)
	return o.ID
}

func (f fixture) move(t *testing.T, to string) {
	t.Helper()
	decode(t, call(f, sysCtx(), "attribute", "update", fmt.Sprintf(
		`{"card_id":"%d","attribute_name":"status","value":"%d"}`, f.task, f.statuses[to])), &attribute.UpdateOutput{})
}

func (f fixture) list(t *testing.T, ctx context.Context) approval.ListOutput {
	t.Helper()
	var o approval.ListOutput
	decode(t, call(f, ctx, "approval", "list", fmt.Sprintf(`{"task_id":"%d"}`, f.task)), &o)
	return o
}

func (f fixture) queue(t *testing.T, p person) []approval.QueueRow {
	t.Helper()
	var o approval.QueueOutput
	decode(t, call(f, p.ctx, "approval", "queue", `{}`), &o)
	return o.Rows
}

func (f fixture) decide(t *testing.T, ctx context.Context, body string) approval.DecideOutput {
	t.Helper()
	var o approval.DecideOutput
	decode(t, call(f, ctx, "approval", "decide", fmt.Sprintf(`{"task_id":"%d",%s}`, f.task, body)), &o)
	return o
}

// badge reads the task's list badge through card.select_with_attributes.
func (f fixture) badge(t *testing.T) *card.ApprovalSummary {
	t.Helper()
	var o card.SelectWithAttributesOutput
	decode(t, call(f, sysCtx(), "card", "select_with_attributes", fmt.Sprintf(
		`{"parent_card_id":"%d","card_type_name":"task","with_approvals":true}`, f.project)), &o)
	for _, r := range o.Rows {
		if r.ID == f.task {
			return r.Approvals
		}
	}
	t.Fatalf("task %d not in the select", f.task)
	return nil
}

func TestApprovalRequestVoteSettle(t *testing.T) {
	f := setup(t, "kitp_test_approval_flow")
	f.move(t, "Doing")
	f.move(t, "Review")
	review, done := f.statuses["Review"], f.statuses["Done"]

	// Asking: validation first.
	wantCode(t, call(f, sysCtx(), "approval", "set", fmt.Sprintf(
		`{"task_id":"%d","from_status_id":"%d","to_status_id":"%d","approver_ids":["%d"]}`,
		f.task, f.statuses["Todo"], review, f.dana.personID)), "approval_no_such_action")
	wantCode(t, call(f, sysCtx(), "approval", "set", fmt.Sprintf(
		`{"task_id":"%d","from_status_id":"%d","to_status_id":"%d","approver_ids":["%d"]}`,
		f.task, review, done, f.sam.personID)), "approver_invalid")
	wantCode(t, call(f, sysCtx(), "approval", "set", fmt.Sprintf(
		`{"task_id":"%d","from_status_id":"%d","to_status_id":"%d","approver_ids":[]}`,
		f.task, review, done)), "validation")

	var set approval.SetOutput
	decode(t, call(f, sysCtx(), "approval", "set", fmt.Sprintf(
		`{"task_id":"%d","from_status_id":"%d","to_status_id":"%d","approver_ids":["%d","%d"],"note":"Please check the copy"}`,
		f.task, review, done, f.lee.personID, f.dana.personID)), &set)
	if !set.Created || set.ApprovalID == 0 {
		t.Fatalf("set = %+v", set)
	}

	l := f.list(t, f.dana.ctx)
	if len(l.Requests) != 1 {
		t.Fatalf("requests = %+v", l.Requests)
	}
	req := l.Requests[0]
	if req.Action != "Approve" || req.From.Label != "Review" || req.To.Label != "Done" || req.Note != "Please check the copy" ||
		req.RequestedBy != "System" || req.ReachedAt != nil {
		t.Errorf("request = %+v", req)
	}
	var asked []string
	for _, a := range req.Approvers {
		asked = append(asked, a.Name)
	}
	if !slices.Equal(asked, []string{"Dana", "Lee"}) {
		t.Errorf("approvers = %v", asked)
	}
	if l.Status == nil || l.Status.Label != "Review" {
		t.Errorf("status = %+v", l.Status)
	}
	if !slices.ContainsFunc(l.Actions, func(a approval.Action) bool {
		return a.From.ID == review && a.To.ID == done && a.Label == "Approve"
	}) {
		t.Errorf("actions lack Review → Approve → Done: %+v", l.Actions)
	}

	// The queue: both asked, nobody has voted.
	q := f.queue(t, f.dana)
	if len(q) != 1 || q[0].ApprovalID != set.ApprovalID || q[0].Action != "Approve" || q[0].Status.Label != "Review" ||
		q[0].To.Label != "Done" || q[0].TaskTitle != "Ship it" || q[0].ProjectTitle != "Apollo" || q[0].Asked != 2 || q[0].Approved != 0 {
		t.Fatalf("dana's queue = %+v", q)
	}
	if b := f.badge(t); b == nil || *b != (card.ApprovalSummary{Asked: 2}) {
		t.Errorf("badge = %+v, want 2 asked, none decided", b)
	}

	// Voting. Dana's agent votes too, named with her, but it doesn't answer
	// the request for her. A repeat is a no-op; voting leaves the queue.
	f.decide(t, f.agentCtx, fmt.Sprintf(`"approval_id":"%d","decision":"approve","reason":"Tests pass"`, set.ApprovalID))
	if q := f.queue(t, f.dana); len(q) != 1 || q[0].Approved != 0 {
		t.Errorf("after the agent's vote dana's queue = %+v, want hers still waiting, none approved", q)
	}
	if d := f.list(t, sysCtx()).Decisions[0]; d.By != "claude (for Dana)" || d.PersonID != "" || d.Reason != "Tests pass" {
		t.Errorf("agent vote = %+v, want it named with its owner and no person", d)
	}
	first := f.decide(t, f.dana.ctx, fmt.Sprintf(`"approval_id":"%d","decision":"approve","reason":"LGTM"`, set.ApprovalID))
	if !first.Changed {
		t.Errorf("first vote unchanged")
	}
	if again := f.decide(t, f.dana.ctx, fmt.Sprintf(`"approval_id":"%d","decision":"approve"`, set.ApprovalID)); again.Changed || again.DecisionID != first.DecisionID {
		t.Errorf("repeat vote = %+v, want the vote in force unchanged", again)
	}
	if len(f.queue(t, f.dana)) != 0 {
		t.Errorf("dana still has it queued after voting")
	}
	if q := f.queue(t, f.lee); len(q) != 1 || q[0].Approved != 1 {
		t.Errorf("lee's queue = %+v, want it with 1 approved", q)
	}

	// Lee rejects, then approves: the later vote wins. Pat, unasked, votes on
	// the edge directly; he isn't counted in the tally.
	f.decide(t, f.lee.ctx, fmt.Sprintf(`"approval_id":"%d","decision":"reject","reason":"Typo in the heading"`, set.ApprovalID))
	if b := f.badge(t); b == nil || *b != (card.ApprovalSummary{Asked: 2, Approved: 1, Rejected: 1}) {
		t.Errorf("badge after reject = %+v", b)
	}
	f.decide(t, f.lee.ctx, fmt.Sprintf(`"approval_id":"%d","decision":"approve"`, set.ApprovalID))
	f.decide(t, f.pat.ctx, fmt.Sprintf(`"from_status_id":"%d","to_status_id":"%d","decision":"approve"`, review, done))
	if b := f.badge(t); b == nil || *b != (card.ApprovalSummary{Asked: 2, Approved: 2}) {
		t.Errorf("badge after approvals = %+v", b)
	}
	l = f.list(t, sysCtx())
	if len(l.Decisions) != 5 {
		t.Fatalf("decisions = %+v", l.Decisions)
	}
	if d := l.Decisions[3]; d.By != "Dana" || d.Decision != "approve" || d.Reason != "LGTM" || d.Settled || d.Stale ||
		d.FromID != fmt.Sprint(review) || d.ToID != fmt.Sprint(done) || d.Action != "Approve" || d.Status == nil || d.Status.Label != "Review" {
		t.Errorf("dana's vote = %+v", d)
	}
	if d := l.Decisions[0]; d.By != "Pat" || d.PersonID != fmt.Sprint(f.pat.personID) {
		t.Errorf("pat's vote = %+v", d)
	}

	// Reaching Done settles the round: off the badge and every queue, kept on
	// the task with the request marked reached.
	f.move(t, "Done")
	if b := f.badge(t); b != nil {
		t.Errorf("badge after Done = %+v, want none", b)
	}
	l = f.list(t, sysCtx())
	if l.Requests[0].ReachedAt == nil {
		t.Errorf("request not marked reached")
	}
	for _, d := range l.Decisions {
		if !d.Settled {
			t.Errorf("vote %+v not settled after Done", d)
		}
	}

	// Reopened and back in Review: a new round on the same edge. Old votes
	// stay settled; a new vote is current; a new request counts only it.
	f.move(t, "Todo")
	f.move(t, "Doing")
	f.move(t, "Review")
	f.decide(t, f.dana.ctx, fmt.Sprintf(`"from_status_id":"%d","to_status_id":"%d","decision":"approve"`, review, done))
	var again approval.SetOutput
	decode(t, call(f, sysCtx(), "approval", "set", fmt.Sprintf(
		`{"task_id":"%d","from_status_id":"%d","to_status_id":"%d","approver_ids":["%d","%d"]}`,
		f.task, review, done, f.dana.personID, f.lee.personID)), &again)
	if b := f.badge(t); b == nil || *b != (card.ApprovalSummary{Asked: 2, Approved: 1}) {
		t.Errorf("badge in the new round = %+v, want only Dana's new vote", b)
	}
	if q := f.queue(t, f.lee); len(q) != 1 || q[0].ApprovalID != again.ApprovalID {
		t.Errorf("lee's queue in the new round = %+v", q)
	}
	l = f.list(t, sysCtx())
	if l.Decisions[0].Settled || !l.Decisions[1].Settled {
		t.Errorf("newest vote settled=%v, previous settled=%v", l.Decisions[0].Settled, l.Decisions[1].Settled)
	}
}

func TestApprovalStaleAndRemove(t *testing.T) {
	f := setup(t, "kitp_test_approval_remove")
	f.move(t, "Doing")
	f.move(t, "Review")
	review, done := f.statuses["Review"], f.statuses["Done"]
	var set approval.SetOutput
	decode(t, call(f, sysCtx(), "approval", "set", fmt.Sprintf(
		`{"task_id":"%d","from_status_id":"%d","to_status_id":"%d","approver_ids":["%d"]}`,
		f.task, review, done, f.dana.personID)), &set)
	f.decide(t, f.dana.ctx, fmt.Sprintf(`"approval_id":"%d","decision":"approve","reason":"Ship it"`, set.ApprovalID))

	// The task's activity feed carries the vote with its edge named and its
	// reason hydrated like a comment's.
	var feed activity.SelectOutput
	decode(t, call(f, sysCtx(), "activity", "select", fmt.Sprintf(`{"card_id":"%d"}`, f.task)), &feed)
	var vote *activity.Row
	for i := range feed.Rows {
		if feed.Rows[i].Kind == "approval_decision" {
			vote = &feed.Rows[i]
		}
	}
	if vote == nil {
		t.Fatalf("no approval_decision row in the feed")
	}
	var refs map[string]string
	if err := json.Unmarshal(vote.Refs, &refs); err != nil {
		t.Fatalf("refs %s: %v", vote.Refs, err)
	}
	if refs[fmt.Sprint(review)] != "Review" || refs[fmt.Sprint(done)] != "Done" ||
		vote.CommentBody == nil || *vote.CommentBody != "Ship it" || vote.ActorName != "Dana" {
		t.Errorf("feed vote = %+v refs=%v", vote, refs)
	}

	// Moved somewhere other than the edge's target: the vote is stale but
	// its round isn't settled.
	f.move(t, "Cancelled")
	l := f.list(t, sysCtx())
	if d := l.Decisions[0]; !d.Stale || d.Settled {
		t.Errorf("vote after cancelling = %+v, want stale, not settled", d)
	}

	// Changing who is asked is audited; the action can't change.
	decode(t, call(f, sysCtx(), "approval", "set", fmt.Sprintf(
		`{"id":"%d","task_id":"%d","approver_ids":["%d","%d"]}`, set.ApprovalID, f.task, f.dana.personID, f.lee.personID)),
		&approval.SetOutput{})
	wantCode(t, call(f, sysCtx(), "approval", "set", fmt.Sprintf(
		`{"id":"%d","task_id":"%d","from_status_id":"%d","to_status_id":"%d"}`, set.ApprovalID, f.task, f.statuses["Todo"], done)),
		"approval_action_fixed")
	var audited int
	if err := f.sp.P.QueryRow(context.Background(), `
		SELECT count(*) FROM activity a JOIN attribute_def ad ON ad.id = a.attribute_def_id
		WHERE a.card_id = $1 AND a.kind = 'attr_update' AND ad.name = 'approvers'`, set.ApprovalID).Scan(&audited); err != nil {
		t.Fatal(err)
	}
	if audited != 2 {
		t.Errorf("approvers activity rows = %d, want 2 (asked, then changed)", audited)
	}

	// The voter can reword their reason like a comment.
	decode(t, call(f, f.dana.ctx, "comment", "update", fmt.Sprintf(
		`{"activity_id":"%d","body":"Ship it once the copy is fixed"}`, l.Decisions[0].ID)), &comment.UpdateOutput{})
	if got := f.list(t, sysCtx()).Decisions[0].Reason; got != "Ship it once the copy is fixed" {
		t.Errorf("reason after edit = %q", got)
	}

	// Removing the request keeps the vote.
	decode(t, call(f, sysCtx(), "approval", "remove", fmt.Sprintf(`{"id":"%d"}`, set.ApprovalID)), &approval.RemoveOutput{})
	l = f.list(t, sysCtx())
	if len(l.Requests) != 0 || len(l.Decisions) != 1 {
		t.Errorf("after remove: requests=%d decisions=%d, want 0 and 1", len(l.Requests), len(l.Decisions))
	}
	if len(f.queue(t, f.lee)) != 0 {
		t.Errorf("a removed request is still queued")
	}

	// Someone without access to the project sees none of it.
	if sr := call(f, f.sam.ctx, "approval", "list", fmt.Sprintf(`{"task_id":"%d"}`, f.task)); sr.OK {
		t.Errorf("a caller who can't see the project read its approvals")
	}
}
