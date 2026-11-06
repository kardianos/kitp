package card_test

// review8_reads_test.go: the 2026-11-06 security review's read fixes — what
// the export, a thread and a moved task showed a project-scoped worker that
// the read handlers hide from them (#5, L4, L5, L6, L7).

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/activity"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/comm"
	"github.com/kitp/kitp/server/internal/dom/comment"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/dom/projectexport"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

type r8ReadsEnv struct {
	t   *testing.T
	srv *api.Server
	sp  *store.Pool
}

func r8ReadsSetup(t *testing.T, schema string) *r8ReadsEnv {
	t.Helper()
	reg.Reset()
	pool := store.TestPool(t, schema)
	sp := store.NewPool(pool)
	echo.Register()
	cardtype.Register()
	card.Register(sp)
	attribute.Register(sp)
	activity.Register(sp)
	comment.Register(sp)
	comm.Register(sp)
	return &r8ReadsEnv{t: t, srv: api.NewServer(sp), sp: sp}
}

func (e *r8ReadsEnv) as(uid int64) context.Context {
	return auth.WithUser(context.Background(), &auth.UserCtx{ID: uid, DisplayName: fmt.Sprintf("u%d", uid)})
}

func (e *r8ReadsEnv) call(ctx context.Context, endpoint, action, data string) api.SubResponse {
	e.t.Helper()
	resp := e.srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "x", Endpoint: endpoint, Action: action, Data: json.RawMessage(data)},
	}})
	return resp.Subresponses[0]
}

func (e *r8ReadsEnv) mustID(sr api.SubResponse, what string) int64 {
	e.t.Helper()
	if !sr.OK {
		e.t.Fatalf("%s: %+v", what, sr.Error)
	}
	var o struct {
		ID     int64 `json:"id,string"`
		CommID int64 `json:"comm_id,string"`
	}
	buf, _ := json.Marshal(sr.Data)
	_ = json.Unmarshal(buf, &o)
	if o.ID != 0 {
		return o.ID
	}
	return o.CommID
}

func (e *r8ReadsEnv) sys() context.Context { return auth.WithSystemUser(context.Background()) }

func (e *r8ReadsEnv) insert(payload string) int64 {
	e.t.Helper()
	return e.mustID(e.call(e.sys(), "card", "insert", payload), payload)
}

func (e *r8ReadsEnv) user(name, role string, scope int64) int64 {
	e.t.Helper()
	ctx := context.Background()
	var uid int64
	if err := e.sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ($1) RETURNING id`, name).Scan(&uid); err != nil {
		e.t.Fatalf("user %s: %v", name, err)
	}
	if role != "" {
		var sc any
		if scope != 0 {
			sc = scope
		}
		if _, err := e.sp.P.Exec(ctx, `INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT $1, id, $2 FROM role WHERE name = $3`, uid, sc, role); err != nil {
			e.t.Fatalf("role %s: %v", name, err)
		}
	}
	return uid
}

func (e *r8ReadsEnv) export(uid, projectID int64, suffix string) (int, string) {
	e.t.Helper()
	rt := api.NewTestRouter(&auth.UserCtx{ID: uid})
	projectexport.Mount(rt, projectexport.Config{Pool: e.sp})
	mux := http.NewServeMux()
	mux.Handle("/api/", rt.Mux())
	req := httptest.NewRequest("GET", fmt.Sprintf("/api/v1/project/%d/%s", projectID, suffix), nil)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)
	body, _ := io.ReadAll(rr.Body)
	return rr.Code, string(body)
}

func r8CSVColumn(t *testing.T, body, col string) []string {
	t.Helper()
	cr := csv.NewReader(strings.NewReader(body))
	cr.FieldsPerRecord = -1
	recs, err := cr.ReadAll()
	if err != nil {
		t.Fatalf("csv: %v\n%s", err, body)
	}
	idx := -1
	for i, h := range recs[0] {
		if h == col {
			idx = i
		}
	}
	if idx < 0 {
		t.Fatalf("no column %q in %v", col, recs[0])
	}
	var out []string
	for _, r := range recs[1:] {
		if idx < len(r) {
			out = append(out, r[idx])
		}
	}
	return out
}

// TestAWorkerCantNameAnyPersonInTheWorkspace (#5, L7): a worker scoped to
// project A can't point a task's originator at a contact only project B
// knows, nor its assignee at a staff member with no role in A, nor address
// a thread to them — so A's export and the thread never print their names
// and emails. A refusal reads the same for a hidden card and a missing one.
func TestAWorkerCantNameAnyPersonInTheWorkspace(t *testing.T) {
	e := r8ReadsSetup(t, "kitp_test_r8_reads_person")
	pA := e.insert(`{"card_type_name":"project","title":"Team A"}`)
	pB := e.insert(`{"card_type_name":"project","title":"Team B helpdesk"}`)
	sA := store.TemplateStatusID(t, e.sp.P, pA, "Todo")
	tA := e.insert(fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"mine","attributes":{"status":"%d"}}`, pA, sA))

	// A contact that only project B's helpdesk knows about.
	zed := e.insert(`{"card_type_name":"person","title":"Zed Customer (HIV clinic)","attributes":{"email":"zed@customer-b.example","person_kind":"contact"}}`)
	// A staff member who works only in B.
	carol := e.insert(`{"card_type_name":"person","title":"Carol Payroll","attributes":{"email":"carol.private@corp.example","person_kind":"member"}}`)
	carolUser := e.user("Carol Payroll", "worker", pB)
	if _, err := e.sp.P.Exec(context.Background(), `INSERT INTO user_account_person (user_account_id, person_card_id) VALUES ($1, $2)`, carolUser, carol); err != nil {
		t.Fatalf("link carol: %v", err)
	}

	w := e.user("worker-a", "worker", pA)
	wctx := e.as(w)

	// The worker can't read either person card.
	sr := e.call(wctx, "card", "select_with_attributes", fmt.Sprintf(`{"ids":["%d","%d"]}`, zed, carol))
	if !sr.OK {
		t.Fatalf("select: %+v", sr.Error)
	}
	buf, _ := json.Marshal(sr.Data)
	t.Logf("worker card.select_with_attributes on the two persons: %s", buf)

	// Plant the references on the worker's own task.
	for _, set := range []string{
		fmt.Sprintf(`{"card_id":"%d","attribute_name":"originator","value":"%d"}`, tA, zed),
		fmt.Sprintf(`{"card_id":"%d","attribute_name":"assignee","value":"%d"}`, tA, carol),
	} {
		sr := e.call(wctx, "attribute", "update", set)
		if sr.OK || sr.Error.Code != "cross_project_ref" {
			t.Errorf("attribute.update %s: %+v, want cross_project_ref", set, sr)
		}
	}

	// activity.select hides their titles (refs only for visible cards).
	sr = e.call(wctx, "activity", "select", fmt.Sprintf(`{"card_id":"%d"}`, tA))
	buf, _ = json.Marshal(sr.Data)
	if strings.Contains(string(buf), "Zed Customer") || strings.Contains(string(buf), "Carol Payroll") {
		t.Errorf("activity.select shows a hidden person's title: %s", buf)
	}

	code, body := e.export(w, pA, "export.csv")
	t.Logf("export.csv as worker-a: %d\n%s", code, body)
	if code != 200 {
		t.Fatalf("export: %d %s", code, body)
	}
	orig := r8CSVColumn(t, body, "originator")
	email := r8CSVColumn(t, body, "assignee_email")
	name := r8CSVColumn(t, body, "assignee_name")
	if len(orig) == 1 && orig[0] == "Zed Customer (HIV clinic)" {
		t.Errorf("originator column = %q (a person card the worker can't read)", orig[0])
	}
	if len(email) == 1 && email[0] == "carol.private@corp.example" {
		t.Errorf("assignee_email = %q, assignee_name = %q", email[0], name[0])
	}

	// The ZIP export's persons.csv also carries the assignee's email.
	if _, zbody := e.export(w, pA, "export.zip"); strings.Contains(zbody, "carol.private@corp.example") {
		t.Error("the ZIP export carries the hidden staff member's email")
	}

	// Second path: a thread in A addressed to the hidden people by id. The
	// first message's To: snapshot is their email addresses, shown on the
	// thread (and the message is queued to them).
	ch := e.insert(fmt.Sprintf(`{"card_type_name":"comm_channel","parent_card_id":"%d","title":"A mail","attributes":{"channel_type":"email","from_address":"a@corp.example"}}`, pA))
	sr = e.call(wctx, "comm", "create", fmt.Sprintf(
		`{"task_id":"%d","channel_id":"%d","subject":"hi","recipient_person_ids":["%d","%d"],"initial_message":"hello"}`, tA, ch, zed, carol))
	if sr.OK || sr.Error.Code != "invalid_recipient" {
		t.Errorf("comm.create to hidden persons: %+v, want invalid_recipient", sr)
	}
	sr = e.call(wctx, "comm", "list_for_task", fmt.Sprintf(`{"task_id":"%d"}`, tA))
	buf, _ = json.Marshal(sr.Data)
	t.Logf("comm.list_for_task: %s", buf)
	if strings.Contains(string(buf), "zed@customer-b.example") {
		t.Error("the thread shows the hidden contact's email address")
	}

	// Oracle: attribute.update's refusal names the project of any card id.
	sB := store.TemplateStatusID(t, e.sp.P, pB, "Todo")
	tB := e.insert(fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"B secret","attributes":{"status":"%d"}}`, pB, sB))
	var msgs []string
	for _, v := range []int64{tB, tB + 100000} {
		sr = e.call(wctx, "attribute", "update", fmt.Sprintf(`{"card_id":"%d","attribute_name":"parent_task","value":"%d"}`, tA, v))
		if sr.OK {
			t.Fatalf("parent_task=%d went through", v)
		}
		msgs = append(msgs, strings.ReplaceAll(sr.Error.Message, fmt.Sprint(v), "N"))
	}
	if msgs[0] != msgs[1] {
		t.Errorf("a hidden task and a missing one are refused differently: %q vs %q", msgs[0], msgs[1])
	}
}

// TestTheExportNamesNoThreadInAnAreaThatIsOff (L4): with Conversations
// switched off in project A, the task's threads are gone from
// comm.list_for_task, search — and the export's `comms` column.
func TestTheExportNamesNoThreadInAnAreaThatIsOff(t *testing.T) {
	e := r8ReadsSetup(t, "kitp_test_r8_reads_offarea")
	pA := e.insert(`{"card_type_name":"project","title":"Clinic"}`)
	sA := store.TemplateStatusID(t, e.sp.P, pA, "Todo")
	tA := e.insert(fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"intake","attributes":{"status":"%d"}}`, pA, sA))
	ch := e.insert(fmt.Sprintf(`{"card_type_name":"comm_channel","parent_card_id":"%d","title":"Clinic mail","attributes":{"channel_type":"email"}}`, pA))

	w := e.user("worker-a", "worker", pA)
	wctx := e.as(w)
	sr := e.call(wctx, "comm", "create", fmt.Sprintf(`{"task_id":"%d","channel_id":"%d","subject":"Lab results for patient 4711: positive"}`, tA, ch))
	commID := e.mustID(sr, "comm.create")
	t.Logf("thread %d created", commID)

	// Conversations off in A (as a manager would with area.set).
	if _, err := e.sp.P.Exec(context.Background(),
		`INSERT INTO project_area (project_id, area_key, state) VALUES ($1, 'conversations', 'off')`, pA); err != nil {
		t.Fatalf("area off: %v", err)
	}

	sr = e.call(wctx, "comm", "list_for_task", fmt.Sprintf(`{"task_id":"%d"}`, tA))
	buf, _ := json.Marshal(sr.Data)
	t.Logf("comm.list_for_task after off: %s", buf)
	sr = e.call(wctx, "card", "search", `{"card_type_name":"comm","query":"patient"}`)
	buf, _ = json.Marshal(sr.Data)
	t.Logf("card.search comm after off: %s", buf)

	code, body := e.export(w, pA, "export.csv")
	t.Logf("export.csv after off: %d\n%s", code, body)
	if code != 200 {
		t.Fatalf("export: %d", code)
	}
	comms := r8CSVColumn(t, body, "comms")
	if len(comms) == 1 && strings.Contains(comms[0], "patient 4711") {
		t.Errorf("comms column = %q while Conversations is off", comms[0])
	}
}

// TestAMovedTaskLeavesItsParentBehind (L5): task.move of a subtask drops
// its parent_task when the parent stays in the source project, so the
// destination's export doesn't print the source task's title to people who
// only see the destination.
func TestAMovedTaskLeavesItsParentBehind(t *testing.T) {
	e := r8ReadsSetup(t, "kitp_test_r8_reads_move")
	pA := e.insert(`{"card_type_name":"project","title":"Legal"}`)
	pB := e.insert(`{"card_type_name":"project","title":"Ops"}`)
	sA := store.TemplateStatusID(t, e.sp.P, pA, "Todo")
	parent := e.insert(fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"Settle lawsuit with Acme","attributes":{"status":"%d"}}`, pA, sA))
	sub := e.insert(fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"order supplies","attributes":{"status":"%d","parent_task":"%d"}}`, pA, sA, parent))
	mover := e.user("mover", "worker", 0)
	sr := e.call(e.as(mover), "task", "move", fmt.Sprintf(`{"card_id":"%d","new_project_id":"%d"}`, sub, pB))
	if !sr.OK {
		t.Fatalf("task.move: %+v", sr.Error)
	}
	bOnly := e.user("ops-only", "worker", pB)
	sr = e.call(e.as(bOnly), "card", "select_with_attributes", fmt.Sprintf(`{"ids":["%d"]}`, parent))
	buf, _ := json.Marshal(sr.Data)
	t.Logf("ops-only reads the parent: %s", buf)
	code, body := e.export(bOnly, pB, "export.csv")
	t.Logf("Ops export as ops-only: %d\n%s", code, body)
	if code != 200 {
		t.Fatalf("export: %d", code)
	}
	if strings.Contains(body, "Settle lawsuit with Acme") {
		t.Error("the destination export names the source project's task")
	}
}

// TestAThreadShowsNoApprovalWhileApprovalsIsOff (L6): with Approvals
// switched off, the approval card that started a thread is gone from
// comm.list_for_task too, as from every other read.
func TestAThreadShowsNoApprovalWhileApprovalsIsOff(t *testing.T) {
	e := r8ReadsSetup(t, "kitp_test_r8_reads_appr")
	ctx := context.Background()
	pA := e.insert(`{"card_type_name":"project","title":"Clinic"}`)
	sA := store.TemplateStatusID(t, e.sp.P, pA, "Todo")
	tA := e.insert(fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"intake","attributes":{"status":"%d"}}`, pA, sA))
	ch := e.insert(fmt.Sprintf(`{"card_type_name":"comm_channel","parent_card_id":"%d","title":"Clinic mail","attributes":{"channel_type":"email"}}`, pA))
	w := e.user("worker-a", "worker", pA)
	wctx := e.as(w)
	commID := e.mustID(e.call(wctx, "comm", "create", fmt.Sprintf(`{"task_id":"%d","channel_id":"%d","subject":"vote"}`, tA, ch)), "comm.create")

	// The approval request approval.set would have written (fixture).
	var ap int64
	if err := e.sp.P.QueryRow(ctx, `INSERT INTO card (card_type_id, parent_card_id) SELECT id, $1 FROM card_type WHERE name='approval' RETURNING id`, tA).Scan(&ap); err != nil {
		t.Fatal(err)
	}
	for _, kv := range []struct {
		name string
		val  string
	}{{"approval_action", `"Discharge patient 4711"`}, {"approval_from", fmt.Sprint(sA)}, {"approval_to", fmt.Sprint(sA)}, {"approval_comm", fmt.Sprint(commID)}} {
		if _, err := e.sp.P.Exec(ctx, `INSERT INTO attribute_value (card_id, attribute_def_id, value) SELECT $1, id, $2::jsonb FROM attribute_def WHERE name=$3`, ap, kv.val, kv.name); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := e.sp.P.Exec(ctx, `INSERT INTO project_area (project_id, area_key, state) VALUES ($1, 'approvals', 'off')`, pA); err != nil {
		t.Fatal(err)
	}
	sr := e.call(wctx, "card", "select_with_attributes", fmt.Sprintf(`{"ids":["%d"]}`, ap))
	buf, _ := json.Marshal(sr.Data)
	t.Logf("approval card via select after off: %s", buf)
	sr = e.call(wctx, "comm", "list_for_task", fmt.Sprintf(`{"task_id":"%d"}`, tA))
	buf, _ = json.Marshal(sr.Data)
	t.Logf("comm.list_for_task after Approvals off: %s", buf)
	if strings.Contains(string(buf), "Discharge patient 4711") {
		t.Error("the off-area approval's action shows on the thread")
	}
}
