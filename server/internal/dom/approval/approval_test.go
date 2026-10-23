// approval_test.go: approval requests and votes end to end through the
// dispatcher — asking, voting (asked or not, agents too), the tally, the
// task's approval properties (the Approvals column, the "vote needed from"
// / state / asked filters and sorts, in both predicate compilers), rounds
// settled by reaching the step's target, removal keeping votes, and the
// audit rows.
package approval_test

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/activity"
	"github.com/kitp/kitp/server/internal/dom/approval"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/comm"
	"github.com/kitp/kitp/server/internal/dom/comment"
	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/schema"
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
	comm.Register(sp)
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

// tasks reads the project's tasks with their approvals through
// card.select_with_attributes as ctx, narrowed by a predicate tree and
// ordered by order (both JSON; "" for none).
func (f fixture) tasks(t *testing.T, ctx context.Context, tree, order string) []card.CardWithAttrs {
	t.Helper()
	extra := ""
	if tree != "" {
		extra += `,"tree":` + tree
	}
	if order != "" {
		extra += `,"order":` + order
	}
	var o card.SelectWithAttributesOutput
	decode(t, call(f, ctx, "card", "select_with_attributes", fmt.Sprintf(
		`{"parent_card_id":"%d","card_type_name":"task","with_approvals":true%s}`, f.project, extra)), &o)
	return o.Rows
}

// waiting is the "Vote needed from: Me" filter as p: the tasks an open
// request asks p to vote on that p hasn't.
func (f fixture) waiting(t *testing.T, p person) []card.CardWithAttrs {
	t.Helper()
	return f.tasks(t, p.ctx, `{"connective":"and","children":[{"attr":"approval_waiting_on","op":"in","values":["@me"]}]}`, "")
}

// ids lists rows' card ids in order.
func ids(rows []card.CardWithAttrs) []int64 {
	out := make([]int64, len(rows))
	for i, r := range rows {
		out[i] = r.ID
	}
	return out
}

func (f fixture) decide(t *testing.T, ctx context.Context, body string) approval.DecideOutput {
	t.Helper()
	var o approval.DecideOutput
	decode(t, call(f, ctx, "approval", "decide", fmt.Sprintf(`{"task_id":"%d",%s}`, f.task, body)), &o)
	return o
}

// badge reads the task's Approvals column through card.select_with_attributes
// as ctx.
func (f fixture) badge(t *testing.T, ctx context.Context) *card.ApprovalSummary {
	t.Helper()
	for _, r := range f.tasks(t, ctx, "", "") {
		if r.ID == f.task {
			return r.Approvals
		}
	}
	t.Fatalf("task %d not in the select", f.task)
	return nil
}

// counts is a summary's state and tally, or "none".
func counts(b *card.ApprovalSummary) string {
	if b == nil {
		return "none"
	}
	return fmt.Sprintf("%s %d/%d/%d", b.State, b.Asked, b.Approved, b.Rejected)
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

	// Waiting on both, nobody has voted; Pat isn't asked.
	if w := f.waiting(t, f.dana); !slices.Equal(ids(w), []int64{f.task}) {
		t.Fatalf("waiting on dana = %v, want the task", ids(w))
	}
	if w := f.waiting(t, f.pat); len(w) != 0 {
		t.Errorf("waiting on pat (not asked) = %v", ids(w))
	}
	b := f.badge(t, f.dana.ctx)
	if counts(b) != "open 2/0/0" || !b.WaitingOnMe || b.AskedAt.IsZero() {
		t.Errorf("approvals for dana = %+v, want open, 2 asked, none voted, waiting on her", b)
	}
	if b := f.badge(t, f.pat.ctx); b == nil || b.WaitingOnMe {
		t.Errorf("approvals for pat = %+v, want not waiting on him", b)
	}

	// Voting. Dana's agent votes too, named with her, but it doesn't answer
	// the request for her. A repeat is a no-op; voting takes it off her list.
	f.decide(t, f.agentCtx, fmt.Sprintf(`"approval_id":"%d","decision":"approve","reason":"Tests pass"`, set.ApprovalID))
	if w := f.waiting(t, f.dana); len(w) != 1 || counts(w[0].Approvals) != "open 2/0/0" {
		t.Errorf("after the agent's vote, waiting on dana = %v, want hers still needed, none approved", ids(w))
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
	if w := f.waiting(t, f.dana); len(w) != 0 {
		t.Errorf("still waiting on dana after her vote: %v", ids(w))
	}
	if b := f.badge(t, f.dana.ctx); b == nil || b.WaitingOnMe {
		t.Errorf("approvals for dana after her vote = %+v, want not waiting on her", b)
	}
	if w := f.waiting(t, f.lee); len(w) != 1 || counts(w[0].Approvals) != "open 2/1/0" {
		t.Errorf("waiting on lee = %v, want the task with 1 approved", ids(w))
	}

	// Lee rejects, then approves: the later vote wins. Pat, unasked, votes on
	// the edge directly; he isn't counted in the tally.
	f.decide(t, f.lee.ctx, fmt.Sprintf(`"approval_id":"%d","decision":"reject","reason":"Typo in the heading"`, set.ApprovalID))
	if b := f.badge(t, sysCtx()); counts(b) != "rejected 2/1/1" {
		t.Errorf("approvals after reject = %s", counts(b))
	}
	if w := f.waiting(t, f.lee); len(w) != 0 {
		t.Errorf("a reject still leaves it waiting on lee: %v", ids(w))
	}
	f.decide(t, f.lee.ctx, fmt.Sprintf(`"approval_id":"%d","decision":"approve"`, set.ApprovalID))
	f.decide(t, f.pat.ctx, fmt.Sprintf(`"from_status_id":"%d","to_status_id":"%d","decision":"approve"`, review, done))
	if b := f.badge(t, sysCtx()); counts(b) != "approved 2/2/0" {
		t.Errorf("approvals after both approve = %s", counts(b))
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

	// Reaching Done settles the round: off the Approvals column, kept on the
	// task with the request marked reached.
	f.move(t, "Done")
	if b := f.badge(t, sysCtx()); b != nil {
		t.Errorf("approvals after Done = %+v, want none", b)
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
	if b := f.badge(t, sysCtx()); counts(b) != "open 2/1/0" {
		t.Errorf("approvals in the new round = %s, want only Dana's new vote", counts(b))
	}
	if w := f.waiting(t, f.lee); !slices.Equal(ids(w), []int64{f.task}) {
		t.Errorf("waiting on lee in the new round = %v", ids(w))
	}
	if w := f.waiting(t, f.dana); len(w) != 0 {
		t.Errorf("waiting on dana in the new round = %v, want none (she voted)", ids(w))
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
	// its round isn't settled. A closed task has no open request.
	f.move(t, "Cancelled")
	l := f.list(t, sysCtx())
	if d := l.Decisions[0]; !d.Stale || d.Settled {
		t.Errorf("vote after cancelling = %+v, want stale, not settled", d)
	}
	if b := f.badge(t, sysCtx()); b != nil {
		t.Errorf("approvals on a cancelled task = %s, want none", counts(b))
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
	f.move(t, "Todo")
	if w := f.waiting(t, f.lee); len(w) != 0 {
		t.Errorf("a removed request still waits on lee: %v", ids(w))
	}

	// Someone without access to the project sees none of it.
	if sr := call(f, f.sam.ctx, "approval", "list", fmt.Sprintf(`{"task_id":"%d"}`, f.task)); sr.OK {
		t.Errorf("a caller who can't see the project read its approvals")
	}
}

// goMatch runs tree through the Go predicate compiler (card.CompileTree,
// what the activity-sink pump and project export use) over the project's
// tasks and returns the matched ids, sorted.
func (f fixture) goMatch(t *testing.T, tree string) []int64 {
	t.Helper()
	var g card.CardWhereGroup
	if err := json.Unmarshal([]byte(tree), &g); err != nil {
		t.Fatalf("tree %s: %v", tree, err)
	}
	ctx := sysCtx()
	tx, err := f.sp.P.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx)
	snap, err := schema.Load(ctx, tx)
	if err != nil {
		t.Fatalf("schema load: %v", err)
	}
	b := named.New()
	b.Set("project_id", f.project)
	clause, err := card.CompileTree(ctx, tx, g, b.Bind, snap)
	if err != nil {
		t.Fatalf("CompileTree %s: %v", tree, err)
	}
	sql, args, err := b.Compile(`
		SELECT c.id FROM card c JOIN card_type ct ON ct.id = c.card_type_id
		WHERE ct.name = 'task' AND c.parent_card_id = :project_id AND c.deleted_at IS NULL
		  AND (` + clause + `)
		ORDER BY c.id`)
	if err != nil {
		t.Fatalf("compile named: %v", err)
	}
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		t.Fatalf("Go-compiled query %s: %v", tree, err)
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}
	return out
}

// TestApprovalFiltersAndSorts covers the task's approval properties as
// filters and sorts: approval_state, approval_waiting_on ("vote needed
// from") and approval_asked_at, compiled the same by card_compile_predicate
// (card.select_with_attributes) and card.CompileTree.
func TestApprovalFiltersAndSorts(t *testing.T) {
	f := setup(t, "kitp_test_approval_filters")
	f.move(t, "Doing")
	f.move(t, "Review")
	newTask := func(title, status string) int64 {
		return insertCard(t, f, fmt.Sprintf(
			`{"card_type_name":"task","parent_card_id":"%d","title":"%s","attributes":{"status":"%d"}}`,
			f.project, title, f.statuses[status]))
	}
	ask := func(task int64, from, to string, people ...person) {
		var ppl []string
		for _, p := range people {
			ppl = append(ppl, fmt.Sprintf(`"%d"`, p.personID))
		}
		decode(t, call(f, sysCtx(), "approval", "set", fmt.Sprintf(
			`{"task_id":"%d","from_status_id":"%d","to_status_id":"%d","approver_ids":[%s]}`,
			task, f.statuses[from], f.statuses[to], strings.Join(ppl, ","))), &approval.SetOutput{})
	}
	vote := func(p person, task int64, from, to, decision string) {
		decode(t, call(f, p.ctx, "approval", "decide", fmt.Sprintf(
			`{"task_id":"%d","from_status_id":"%d","to_status_id":"%d","decision":"%s"}`,
			task, f.statuses[from], f.statuses[to], decision)), &approval.DecideOutput{})
	}

	// a: Dana asked and approved. b: Dana and Lee asked, Lee rejected.
	// c: nothing asked. d: Pat asked, no votes yet.
	a := f.task
	b := newTask("Bravo", "Doing")
	c := newTask("Charlie", "Todo")
	d := newTask("Delta", "Todo")
	ask(a, "Review", "Done", f.dana)
	ask(b, "Doing", "Done", f.dana, f.lee)
	ask(d, "Todo", "Done", f.pat)
	vote(f.dana, a, "Review", "Done", "approve")
	vote(f.lee, b, "Doing", "Done", "reject")

	leaf := func(attr, op, values string) string {
		return fmt.Sprintf(`{"connective":"and","children":[{"attr":"%s","op":"%s","values":%s}]}`, attr, op, values)
	}
	sorted := func(v []int64) []int64 {
		out := slices.Clone(v)
		slices.Sort(out)
		return out
	}
	cases := []struct {
		name string
		tree string
		want []int64
	}{
		{"state open", leaf("approval_state", "=", `["open"]`), []int64{d}},
		{"state approved or rejected", leaf("approval_state", "in", `["approved","rejected"]`), []int64{a, b}},
		{"state not none", leaf("approval_state", "!=", `["none"]`), []int64{a, b, d}},
		{"state none", leaf("approval_state", "in", `["none"]`), []int64{c}},
		{"state not open or none", leaf("approval_state", "not in", `["open","none"]`), []int64{a, b}},
		{"vote needed from dana", leaf("approval_waiting_on", "in", fmt.Sprintf(`["%d"]`, f.dana.personID)), []int64{b}},
		{"vote needed from lee or pat", leaf("approval_waiting_on", "in", fmt.Sprintf(`[%d,"%d"]`, f.lee.personID, f.pat.personID)), []int64{d}},
		{"vote not needed from dana", leaf("approval_waiting_on", "not in", fmt.Sprintf(`["%d"]`, f.dana.personID)), []int64{a, c, d}},
		{"vote needed from no one named", leaf("approval_waiting_on", "in", `["@me"]`), nil},
		{"asked in the last day", leaf("approval_asked_at", "within_last_days", `[1]`), []int64{a, b, d}},
	}
	for _, tc := range cases {
		got := sorted(ids(f.tasks(t, sysCtx(), tc.tree, "")))
		want := sorted(tc.want)
		if !slices.Equal(got, want) {
			t.Errorf("%s: select = %v, want %v", tc.name, got, want)
		}
		if g := f.goMatch(t, tc.tree); !slices.Equal(g, want) {
			t.Errorf("%s: Go compiler = %v, want %v", tc.name, g, want)
		}
	}

	// "@me" resolves to the viewer's person.
	if w := f.waiting(t, f.dana); !slices.Equal(ids(w), []int64{b}) {
		t.Errorf("waiting on dana (@me) = %v, want b", ids(w))
	}

	// Sorts: votes missing first, then rejected, approved, none; and by the
	// oldest open request (none last).
	if got := ids(f.tasks(t, sysCtx(), "", `[{"field":"approval_state","direction":"ASC"},{"field":"created_at","direction":"ASC"}]`)); !slices.Equal(got, []int64{d, b, a, c}) {
		t.Errorf("by approval state = %v, want d, b, a, c", got)
	}
	if got := ids(f.tasks(t, sysCtx(), "", `[{"field":"approval_asked_at","direction":"ASC"}]`)); !slices.Equal(got, []int64{a, b, d, c}) {
		t.Errorf("by approval asked = %v, want a, b, d, c", got)
	}

	// A value or op the property doesn't take is refused.
	for _, tree := range []string{
		leaf("approval_state", "=", `["maybe"]`),
		leaf("approval_state", "exists", `[]`),
		leaf("approval_waiting_on", "contains", `["x"]`),
		leaf("approval_asked_at", "=", `["2026-01-01"]`),
	} {
		if sr := call(f, sysCtx(), "card", "select_with_attributes", fmt.Sprintf(
			`{"parent_card_id":"%d","card_type_name":"task","tree":%s}`, f.project, tree)); sr.OK {
			t.Errorf("select accepted %s", tree)
		}
	}
}

// TestApprovalEmail covers asking with email: the request also starts an
// email thread (a comm) to the people asked with the note as its message,
// each links to the other, the checks run before anything is written, and
// the two live on separately once made.
func TestApprovalEmail(t *testing.T) {
	f := setup(t, "kitp_test_approval_email")
	f.move(t, "Doing")
	f.move(t, "Review")
	review, done := f.statuses["Review"], f.statuses["Done"]
	ctx := context.Background()
	if _, err := f.sp.P.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		SELECT $1, id, to_jsonb('dana@example.com'::text) FROM attribute_def WHERE name = 'email'`, f.dana.personID); err != nil {
		t.Fatalf("dana email: %v", err)
	}
	channelIn := func(project int64) int64 {
		var id int64
		if err := f.sp.P.QueryRow(ctx, `
			INSERT INTO card (card_type_id, parent_card_id)
			SELECT id, $1 FROM card_type WHERE name = 'comm_channel' RETURNING id`, project).Scan(&id); err != nil {
			t.Fatalf("channel: %v", err)
		}
		return id
	}
	channel := channelIn(f.project)
	ask := func(ctx context.Context, approvers, extra string) api.SubResponse {
		return call(f, ctx, "approval", "set", fmt.Sprintf(
			`{"task_id":"%d","from_status_id":"%d","to_status_id":"%d","approver_ids":[%s]%s}`,
			f.task, review, done, approvers, extra))
	}
	both := fmt.Sprintf(`"%d","%d"`, f.dana.personID, f.lee.personID)
	email := fmt.Sprintf(`,"email":{"channel_id":"%d"}`, channel)
	threads := func() []comm.CommRow {
		var o comm.CommListForTaskOutput
		decode(t, call(f, sysCtx(), "comm", "list_for_task", fmt.Sprintf(`{"task_id":"%d"}`, f.task)), &o)
		return o.Rows
	}

	// Checks first; none of them leaves a request or a thread behind.
	wantCode(t, ask(f.dana.ctx, both, email), "validation") // no note: it's the message
	wantCode(t, ask(f.dana.ctx, fmt.Sprintf(`"%d"`, f.lee.personID), `,"note":"Please look"`+email), "no_email")
	wantCode(t, ask(f.dana.ctx, both, fmt.Sprintf(`,"note":"Please look","email":{"channel_id":"%d"}`, channelIn(insertCard(t, f, `{"card_type_name":"project","title":"Other"}`)))), "project_mismatch")
	if l := f.list(t, f.dana.ctx); len(l.Requests) != 0 {
		t.Fatalf("a failed ask left requests: %+v", l.Requests)
	}
	if rows := threads(); len(rows) != 0 {
		t.Fatalf("a failed ask left threads: %+v", rows)
	}

	var set approval.SetOutput
	decode(t, ask(f.dana.ctx, both, `,"note":"Please look"`+email), &set)
	if !set.Created || set.CommID == 0 {
		t.Fatalf("set = %+v, want a request and a thread", set)
	}

	req := f.list(t, f.dana.ctx).Requests[0]
	if req.Comm == nil || req.Comm.ID != set.CommID || req.Comm.Messages != 1 ||
		req.Comm.Subject != "Vote requested: Ship it — Review → Done (Approve)" || req.Note != "Please look" {
		t.Errorf("request = %+v comm %+v", req, req.Comm)
	}
	rows := threads()
	if len(rows) != 1 {
		t.Fatalf("threads = %+v", rows)
	}
	th := rows[0]
	if th.ID != set.CommID || th.ChannelID != channel || th.Title != req.Comm.Subject {
		t.Errorf("thread = %+v", th)
	}
	if a := th.Approval; a == nil || a.ID != set.ApprovalID || a.Action != "Approve" || a.From != "Review" || a.To != "Done" {
		t.Errorf("thread's vote = %+v", th.Approval)
	}
	// Everyone asked is a recipient; only those with an address are mailed.
	if !slices.Equal([]int64(th.Recipients), []int64{f.dana.personID, f.lee.personID}) {
		t.Errorf("recipients = %v", th.Recipients)
	}
	if len(th.Replies) != 1 || th.Replies[0].BodyText != "Please look" ||
		th.Replies[0].DeliveryStatus != "pending" || th.Replies[0].To != "dana@example.com" {
		t.Errorf("first message = %+v", th.Replies)
	}

	// Email goes with a new request only.
	wantCode(t, call(f, f.dana.ctx, "approval", "set", fmt.Sprintf(
		`{"id":"%d","task_id":"%d","note":"Again"%s}`, set.ApprovalID, f.task, email)), "validation")

	// Removing the request leaves the thread, no longer tied to a vote.
	decode(t, call(f, f.dana.ctx, "approval", "remove", fmt.Sprintf(`{"id":"%d"}`, set.ApprovalID)), &approval.RemoveOutput{})
	if rows := threads(); len(rows) != 1 || rows[0].Approval != nil {
		t.Errorf("threads after remove = %+v", rows)
	}

	// Emailing needs comm create rights of its own: someone who can edit
	// the task but not start comms can still ask, just not email.
	if _, err := f.sp.P.Exec(ctx, `
		DELETE FROM role_grant
		WHERE role_id = (SELECT id FROM role WHERE name = 'worker')
		  AND card_type_id = (SELECT id FROM card_type WHERE name = 'comm')
		  AND process_id = (SELECT id FROM process WHERE name = 'card.create')`); err != nil {
		t.Fatalf("drop grant: %v", err)
	}
	wantCode(t, ask(f.dana.ctx, both, `,"note":"Please look"`+email), "unauthorized")
	var plain approval.SetOutput
	decode(t, ask(f.dana.ctx, both, `,"note":"Please look"`), &plain)
	if !plain.Created || plain.CommID != 0 {
		t.Errorf("an ask without email = %+v, want a request and no thread", plain)
	}
}
