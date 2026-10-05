package activitysink_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/activitysink"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/comm"
	"github.com/kitp/kitp/server/internal/dom/comment"
)

// subFixture layers an email sink + comm channel + a member (with a
// person card and an email) on top of sinkFixture.
type subFixture struct {
	*sinkFixture
	channelID int64
	sinkID    int64
	member    member
}

type member struct {
	userID   int64
	personID int64
	email    string
	ctx      context.Context
}

func setupSubscriptions(t *testing.T, schemaName string) *subFixture {
	t.Helper()
	f := setupSink(t, schemaName)
	comm.Register(f.sp)
	comment.Register(f.sp)

	var ch comm.ChannelSetOutput
	dispatch(t, f, api.SubRequest{ID: "ch", Endpoint: "comm_channel", Action: "set", Data: json.RawMessage(fmt.Sprintf(
		`{"project_id":"%d","name":"Notify box","channel_type":"email","smtp_host":"smtp.example.com","smtp_port":587,"smtp_username":"u","smtp_password":"p","from_address":"notify@example.com"}`,
		f.projectID))}, &ch)

	var sink activitysink.SinkSetOutput
	dispatch(t, f, api.SubRequest{ID: "sink", Endpoint: "activity_sink", Action: "set", Data: json.RawMessage(fmt.Sprintf(
		`{"project_id":"%d","name":"Email","sink_kind":"email","channel_id":"%d"}`, f.projectID, ch.ChannelID))}, &sink)

	sf := &subFixture{sinkFixture: f, channelID: ch.ChannelID, sinkID: sink.SinkID}
	sf.member = sf.newMember(t, "Sam Lee", "sam@example.com", "worker")
	return sf
}

// newMember provisions a login + linked person card (with email) holding
// `role` scoped to the fixture project.
func (f *subFixture) newMember(t *testing.T, name, email, role string) member {
	t.Helper()
	ctx := context.Background()
	var m member
	m.email = email
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name, email) VALUES ($1, $2) RETURNING id`, name, email).Scan(&m.userID); err != nil {
		t.Fatalf("member user: %v", err)
	}
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name='person' RETURNING id`).Scan(&m.personID); err != nil {
		t.Fatalf("member person: %v", err)
	}
	for _, stmt := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO attribute_value (card_id, attribute_def_id, value) SELECT $1, id, to_jsonb($2::text) FROM attribute_def WHERE name='title'`, []any{m.personID, name}},
		{`INSERT INTO attribute_value (card_id, attribute_def_id, value) SELECT $1, id, to_jsonb($2::text) FROM attribute_def WHERE name='email'`, []any{m.personID, email}},
		{`INSERT INTO user_account_person (user_account_id, person_card_id) VALUES ($1, $2)`, []any{m.userID, m.personID}},
		{`INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT $1, id, $2 FROM role WHERE name=$3`, []any{m.userID, f.projectID, role}},
	} {
		if _, err := f.sp.P.Exec(ctx, stmt.sql, stmt.args...); err != nil {
			t.Fatalf("member setup %q: %v", stmt.sql, err)
		}
	}
	m.ctx = auth.WithUser(ctx, &auth.UserCtx{ID: m.userID, DisplayName: name})
	return m
}

// call dispatches one sub-request as `ctx` and returns the sub-response.
func (f *subFixture) call(ctx context.Context, endpoint, action, body string) api.SubResponse {
	resp := f.srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{{
		ID: "x", Endpoint: endpoint, Action: action, Data: json.RawMessage(body),
	}}})
	return resp.Subresponses[0]
}

func mustOK(t *testing.T, sr api.SubResponse, out any) {
	t.Helper()
	if !sr.OK {
		t.Fatalf("call failed: %+v", sr.Error)
	}
	if out != nil {
		buf, _ := json.Marshal(sr.Data)
		if err := json.Unmarshal(buf, out); err != nil {
			t.Fatalf("decode: %v", err)
		}
	}
}

func errCode(sr api.SubResponse) string {
	if sr.OK || sr.Error == nil {
		return ""
	}
	return sr.Error.Code
}

func (f *subFixture) subscribe(t *testing.T, m member, body string) int64 {
	t.Helper()
	var out activitysink.SubscriptionSetOutput
	mustOK(t, f.call(m.ctx, "activity_subscription", "set",
		fmt.Sprintf(`{"sink_id":"%d",%s}`, f.sinkID, body)), &out)
	return out.SubscriptionID
}

func (f *subFixture) listSubs(t *testing.T, m member) []activitysink.SubscriptionRow {
	t.Helper()
	var out activitysink.SubscriptionListOutput
	mustOK(t, f.call(m.ctx, "activity_subscription", "list", `{}`), &out)
	return out.Rows
}

// newTask inserts a task (as admin), optionally assigned to a person.
func (f *subFixture) newTask(t *testing.T, title string, assignee int64) int64 {
	t.Helper()
	attrs := fmt.Sprintf(`{"status":"%d"`, f.statusID)
	if assignee != 0 {
		attrs += fmt.Sprintf(`,"assignee":"%d"`, assignee)
	}
	attrs += "}"
	var out card.InsertOutput
	dispatch(t, f.sinkFixture, api.SubRequest{ID: "t", Endpoint: "card", Action: "insert", Data: json.RawMessage(fmt.Sprintf(
		`{"card_type_name":"task","parent_card_id":"%d","title":%q,"attributes":%s}`, f.projectID, title, attrs))}, &out)
	return out.ID
}

func (f *subFixture) comment(t *testing.T, taskID int64, body string) {
	t.Helper()
	dispatch(t, f.sinkFixture, api.SubRequest{ID: "c", Endpoint: "comment", Action: "insert", Data: json.RawMessage(fmt.Sprintf(
		`{"card_id":"%d","body":%q}`, taskID, body))}, nil)
}

// sentMail records what the stub SMTP transport was handed.
type sentMail struct {
	mu   sync.Mutex
	msgs []mailRec
	err  error
}

type mailRec struct {
	host, from, to string
	msg            string
}

func (s *sentMail) send(_ context.Context, host string, _ int, _, _, from, to string, msg []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.msgs = append(s.msgs, mailRec{host: host, from: from, to: to, msg: string(msg)})
	return s.err
}

func (f *subFixture) pumper(subID int64, mail *sentMail) *activitysink.Pumper {
	p := activitysink.NewSubscriptionPumperForTest(f.sp, subID, f.sinkID, f.projectID, time.Second)
	p.SetMailer(mail.send)
	p.SetPublicURL("https://kitp.example.com")
	p.SetBatchLimit(10_000)
	return p
}

// decodedBody returns the quoted-printable-decoded body of a sent mail.
func decodedBody(t *testing.T, raw string) string {
	t.Helper()
	_, body, ok := strings.Cut(raw, "\r\n\r\n")
	if !ok {
		t.Fatalf("no body in:\n%s", raw)
	}
	// The digest is ASCII-light; undo soft line breaks + the common
	// escapes we emit for UTF-8 punctuation.
	r := strings.NewReplacer("=\r\n", "", "=E2=80=94", "\u2014", "=E2=86=92", "\u2192", "=E2=80=9C", "\u201c", "=E2=80=9D", "\u201d", "=E2=80=A6", "\u2026", "=3D", "=")
	return r.Replace(body)
}

// ---- handlers ----

func TestEmailSinkSetAndList(t *testing.T) {
	f := setupSubscriptions(t, "kitp_test_sink_email_set")

	// An email sink needs a channel.
	if code := errCode(f.call(f.ctx, "activity_sink", "set", fmt.Sprintf(
		`{"project_id":"%d","name":"No channel","sink_kind":"email"}`, f.projectID))); code != "validation" {
		t.Errorf("email sink without channel: code=%q want validation", code)
	}

	// Filters: set both, then clear the event filter with '' (key present).
	mustOK(t, f.call(f.ctx, "activity_sink", "set", fmt.Sprintf(
		`{"id":"%d","project_id":"%d","name":"Email","sink_kind":"email","activity_filter":"{\"op\":\"kind_in\",\"values\":[\"comment\"]}","card_filter":"{\"attr\":\"status\",\"op\":\"exists\"}"}`,
		f.sinkID, f.projectID)), nil)
	mustOK(t, f.call(f.ctx, "activity_sink", "set", fmt.Sprintf(
		`{"id":"%d","project_id":"%d","name":"Email","sink_kind":"email","activity_filter":""}`, f.sinkID, f.projectID)), nil)
	f.subscribe(t, f.member, `"name":"Mine"`)

	var list activitysink.SinkListOutput
	mustOK(t, f.call(f.ctx, "activity_sink", "list", fmt.Sprintf(`{"project_id":"%d"}`, f.projectID)), &list)
	if len(list.Rows) != 1 {
		t.Fatalf("rows=%d want 1", len(list.Rows))
	}
	r := list.Rows[0]
	if r.SinkKind != "email" || r.ChannelID != f.channelID || r.ChannelName != "Notify box" {
		t.Errorf("email fields: kind=%q channel=%d name=%q", r.SinkKind, r.ChannelID, r.ChannelName)
	}
	if r.ActivityFilter != "" {
		t.Errorf("activity_filter should be cleared, got %q", r.ActivityFilter)
	}
	if r.CardFilter != `{"attr":"status","op":"exists"}` {
		t.Errorf("card_filter = %q", r.CardFilter)
	}
	if r.SubscriptionCount != 1 {
		t.Errorf("subscription_count = %d want 1", r.SubscriptionCount)
	}

	// Can't turn an email sink with subscriptions into a Teams sink.
	if code := errCode(f.call(f.ctx, "activity_sink", "set", fmt.Sprintf(
		`{"id":"%d","project_id":"%d","name":"Email","sink_kind":"msgraph_teams"}`, f.sinkID, f.projectID))); code != "sink_has_subscriptions" {
		t.Errorf("kind switch with subscriptions: code=%q want sink_has_subscriptions", code)
	}
}

func TestSubscriptionLifecycle(t *testing.T) {
	f := setupSubscriptions(t, "kitp_test_sub_lifecycle")
	other := f.newMember(t, "Alex Kim", "alex@example.com", "viewer")

	// The member sees the email sink in the picker.
	var sinks activitysink.SubscriptionSinksOutput
	mustOK(t, f.call(f.member.ctx, "activity_subscription", "sinks", `{}`), &sinks)
	if len(sinks.Rows) != 1 || sinks.Rows[0].SinkID != f.sinkID || sinks.Rows[0].ProjectName != "Sink Test" || sinks.Rows[0].ChannelName != "Notify box" {
		t.Fatalf("sinks = %+v", sinks.Rows)
	}

	// Only email sinks take subscriptions.
	teamsID := seedSink(t, f.sinkFixture, "")
	if code := errCode(f.call(f.member.ctx, "activity_subscription", "set", fmt.Sprintf(
		`{"sink_id":"%d","name":"x"}`, teamsID))); code != "sink_not_email" {
		t.Errorf("subscribe to teams sink: code=%q want sink_not_email", code)
	}

	subID := f.subscribe(t, f.member, `"name":"Assigned to me","rollup_minutes":5,"card_filter":"{\"attr\":\"assignee\",\"op\":\"=\",\"values\":[\"@me\"]}"`)
	rows := f.listSubs(t, f.member)
	if len(rows) != 1 {
		t.Fatalf("list rows = %d want 1", len(rows))
	}
	if r := rows[0]; r.ID != subID || r.Name != "Assigned to me" || r.RollupMinutes != 5 || r.Status != "enabled" ||
		r.SinkID != f.sinkID || r.ProjectID != f.projectID || r.ChannelName != "Notify box" {
		t.Errorf("row = %+v", r)
	}
	if got := f.listSubs(t, other); len(got) != 0 {
		t.Errorf("another member sees %d subscriptions, want 0", len(got))
	}

	// A rename writes exactly one attr_update; resending unchanged
	// values writes none.
	countAttrUpdates := func() int {
		var n int
		if err := f.sp.P.QueryRow(context.Background(),
			`SELECT count(*) FROM activity WHERE card_id = $1 AND kind = 'attr_update'`, subID).Scan(&n); err != nil {
			t.Fatalf("count: %v", err)
		}
		return n
	}
	before := countAttrUpdates()
	mustOK(t, f.call(f.member.ctx, "activity_subscription", "set", fmt.Sprintf(
		`{"id":"%d","name":"Mine","rollup_minutes":5}`, subID)), nil)
	if got := countAttrUpdates() - before; got != 1 {
		t.Errorf("rename wrote %d attr_update rows, want 1", got)
	}

	// Pause; someone else can't touch it.
	mustOK(t, f.call(f.member.ctx, "activity_subscription", "set", fmt.Sprintf(`{"id":"%d","enabled":false}`, subID)), nil)
	if r := f.listSubs(t, f.member)[0]; r.Status != "disabled-admin" || r.Name != "Mine" {
		t.Errorf("after pause: status=%q name=%q", r.Status, r.Name)
	}
	if code := errCode(f.call(other.ctx, "activity_subscription", "set", fmt.Sprintf(`{"id":"%d","name":"hijack"}`, subID))); code != "not_owner" {
		t.Errorf("other member edit: code=%q want not_owner", code)
	}
	if code := errCode(f.call(other.ctx, "activity_subscription", "delete", fmt.Sprintf(`{"id":"%d"}`, subID))); code != "not_owner" {
		t.Errorf("other member delete: code=%q want not_owner", code)
	}
	// A viewer may still manage their own.
	f.subscribe(t, other, `"name":"Viewer digest"`)

	mustOK(t, f.call(f.member.ctx, "activity_subscription", "delete", fmt.Sprintf(`{"id":"%d"}`, subID)), nil)
	if got := f.listSubs(t, f.member); len(got) != 0 {
		t.Errorf("after delete: %d rows, want 0", len(got))
	}
}

// ---- pump ----

func TestSubscriptionPumpDeliversDigest(t *testing.T) {
	f := setupSubscriptions(t, "kitp_test_sub_pump_digest")
	subID := f.subscribe(t, f.member, `"name":"Assigned to me","card_filter":"{\"attr\":\"assignee\",\"op\":\"=\",\"values\":[\"@me\"]}"`)

	mine := f.newTask(t, "Fix the login loop", f.member.personID)
	theirs := f.newTask(t, "Someone else's task", 0)
	f.comment(t, mine, "Looks good.\nShipping tomorrow.")
	f.comment(t, theirs, "not for you")

	mail := &sentMail{}
	p := f.pumper(subID, mail)
	if err := p.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if len(mail.msgs) != 1 {
		t.Fatalf("sent %d mails, want 1", len(mail.msgs))
	}
	m := mail.msgs[0]
	if m.to != "sam@example.com" || m.from != "notify@example.com" || m.host != "smtp.example.com" {
		t.Errorf("envelope: host=%q from=%q to=%q", m.host, m.from, m.to)
	}
	body := decodedBody(t, m.msg)
	for _, want := range []string{
		fmt.Sprintf("#%d Fix the login loop\nhttps://kitp.example.com/task/%d\n", mine, mine),
		"  - Created  \u2014 sink-admin",
		"      Looks good.\n      Shipping tomorrow.",
		"notification subscription \u201cAssigned to me\u201d in Sink Test.",
	} {
		if !strings.Contains(strings.ReplaceAll(body, "\r\n", "\n"), want) {
			t.Errorf("body missing %q:\n%s", want, body)
		}
	}
	if strings.Contains(body, "Someone else") || strings.Contains(body, "not for you") {
		t.Errorf("card filter leaked an unassigned task:\n%s", body)
	}

	var okLogs int
	if err := f.sp.P.QueryRow(context.Background(),
		`SELECT count(*) FROM comm_log WHERE channel_id = $1 AND kind = 'notify_ok'`, f.channelID).Scan(&okLogs); err != nil {
		t.Fatal(err)
	}
	if okLogs != 1 {
		t.Errorf("notify_ok comm_log rows = %d want 1", okLogs)
	}

	// Idle tick: nothing new to send.
	if err := p.RunOnce(context.Background()); err != nil {
		t.Fatalf("idle RunOnce: %v", err)
	}
	if len(mail.msgs) != 1 {
		t.Errorf("idle tick sent %d more mails", len(mail.msgs)-1)
	}
}

func TestSubscriptionRollupHoldsThenDelivers(t *testing.T) {
	f := setupSubscriptions(t, "kitp_test_sub_pump_rollup")
	subID := f.subscribe(t, f.member, `"name":"Digest","rollup_minutes":10`)
	task := f.newTask(t, "Rolled task", 0)
	f.comment(t, task, "first")

	mail := &sentMail{}
	p := f.pumper(subID, mail)
	start := time.Now()
	p.SetNow(func() time.Time { return start.Add(time.Minute) })
	if err := p.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce (hold): %v", err)
	}
	if len(mail.msgs) != 0 {
		t.Fatalf("sent %d mails inside the rollup window", len(mail.msgs))
	}
	var pending *time.Time
	if err := f.sp.P.QueryRow(context.Background(),
		`SELECT pending_since FROM activity_sink_state WHERE sink_card_id = $1`, subID).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending == nil {
		t.Fatal("pending_since not set while holding")
	}

	f.comment(t, task, "second")
	p.SetNow(func() time.Time { return start.Add(11 * time.Minute) })
	if err := p.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce (due): %v", err)
	}
	if len(mail.msgs) != 1 {
		t.Fatalf("sent %d mails after the window, want 1 digest", len(mail.msgs))
	}
	body := decodedBody(t, mail.msgs[0].msg)
	if !strings.Contains(body, "first") || !strings.Contains(body, "second") {
		t.Errorf("digest should hold both comments:\n%s", body)
	}
	if err := f.sp.P.QueryRow(context.Background(),
		`SELECT pending_since FROM activity_sink_state WHERE sink_card_id = $1`, subID).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != nil {
		t.Errorf("pending_since should clear after delivery, got %v", *pending)
	}
}

func TestSubscriptionSkipsWhenSubscriberLosesAccess(t *testing.T) {
	f := setupSubscriptions(t, "kitp_test_sub_pump_access")
	subID := f.subscribe(t, f.member, `"name":"All"`)
	f.newTask(t, "Secret task", 0)
	if _, err := f.sp.P.Exec(context.Background(), `DELETE FROM user_role WHERE user_id = $1`, f.member.userID); err != nil {
		t.Fatal(err)
	}

	mail := &sentMail{}
	p := f.pumper(subID, mail)
	if err := p.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if len(mail.msgs) != 0 {
		t.Fatalf("mailed a subscriber who can't see the project")
	}
	if ptr := pointerOf(t, f.sinkFixture, subID); ptr == 0 {
		t.Error("pointer should advance past rows the subscriber can't see")
	}
}

func TestSubscriptionBounceFaults(t *testing.T) {
	f := setupSubscriptions(t, "kitp_test_sub_pump_bounce")
	subID := f.subscribe(t, f.member, `"name":"All"`)
	f.newTask(t, "Bouncy task", 0)

	mail := &sentMail{err: &comm.SMTPBounceError{Code: 550, Msg: "no such user"}}
	p := f.pumper(subID, mail)
	if err := p.RunOnce(context.Background()); err == nil {
		t.Fatal("expected the bounce to surface from RunOnce")
	}
	status, reason := readSinkStatus(t, f.sinkFixture, subID)
	if status != comm.ChannelStatusDisabledFault || !strings.Contains(reason, "550") {
		t.Errorf("status=%q reason=%q want disabled-fault mentioning 550", status, reason)
	}
	var n int
	if err := f.sp.P.QueryRow(context.Background(),
		`SELECT count(*) FROM comm_log WHERE channel_id = $1 AND kind = 'notify_bounce'`, f.channelID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("notify_bounce rows = %d want 1", n)
	}

	// Faulted → paused: no retries until re-enabled.
	before := len(mail.msgs)
	if err := p.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce while faulted: %v", err)
	}
	if len(mail.msgs) != before {
		t.Error("a faulted subscription kept sending")
	}
}

func TestTeamsSinkPostsOneDigestPerTick(t *testing.T) {
	f := setupSubscriptions(t, "kitp_test_sink_teams_digest")
	teamsID := seedSink(t, f.sinkFixture, `{"op":"kind_in","values":["comment"]}`)
	// Start the Teams sink at the present so the fixture's history is skipped.
	if _, err := f.sp.P.Exec(context.Background(), `
		INSERT INTO activity_sink_state (sink_card_id, last_activity_id)
		VALUES ($1, (SELECT max(id) FROM activity))`, teamsID); err != nil {
		t.Fatal(err)
	}
	a := f.newTask(t, "Task A", 0)
	b := f.newTask(t, "Task B", 0)
	f.comment(t, a, "on a")
	f.comment(t, b, "on b")

	stub := &stubPoster{}
	p := activitysink.NewMSGraphPumperForTest(f.sp, teamsID, f.projectID, time.Second)
	p.SetPoster(stub.post)
	if err := p.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if len(stub.calls) != 1 {
		t.Fatalf("posts = %d want 1 digest", len(stub.calls))
	}
	msg := stub.calls[0]
	for _, want := range []string{"2 updates on 2 tasks", "Task A", "Task B", "on a", "on b"} {
		if !strings.Contains(msg, want) {
			t.Errorf("digest missing %q:\n%s", want, msg)
		}
	}
}
