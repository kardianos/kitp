package comm_test

// Files from email, the attachments setting, and sending a reply on
// (docs/MAIL_INTAKE_AND_CALENDARS.md, "Files from email" and "Sending
// replies on").

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/dom/comm"
)

// listThread loads one thread through comm.list_for_task.
func listThread(t *testing.T, f *fixture, commID int64) comm.CommRow {
	t.Helper()
	var out comm.CommListForTaskOutput
	dispatch(t, f, api.SubRequest{ID: "l", Endpoint: "comm", Action: "list_for_task",
		Data: json.RawMessage(fmt.Sprintf(`{"comm_id":"%d"}`, commID))}, &out)
	if len(out.Rows) != 1 {
		t.Fatalf("list_for_task rows = %d", len(out.Rows))
	}
	return out.Rows[0]
}

// logDetail returns the detail of the channel's newest Comm log row of kind.
func logDetail(t *testing.T, f *fixture, channelID int64, kind string) map[string]any {
	t.Helper()
	var raw []byte
	if err := f.sp.P.QueryRow(context.Background(), `
		SELECT detail FROM comm_log WHERE channel_id = $1 AND kind = $2 ORDER BY id DESC LIMIT 1`,
		channelID, kind).Scan(&raw); err != nil {
		t.Fatalf("comm_log %s: %v", kind, err)
	}
	var d map[string]any
	if err := json.Unmarshal(raw, &d); err != nil {
		t.Fatal(err)
	}
	return d
}

func pdf(name, body string) comm.InboundAttachment {
	return comm.InboundAttachment{Filename: name, MimeType: "application/pdf", Bytes: []byte(body)}
}

// TestEmailFilesLiveOnTheThread: a file on new mail that becomes a task and
// a thread is stored on the thread, not the task; the same bytes again are
// linked, not stored twice; Add to task moves it (the message keeps it) and
// later copies link the task's file.
func TestEmailFilesLiveOnTheThread(t *testing.T) {
	f := setupAdmin(t, "kitp_test_email_files_thread")
	ch := seedChannelWith(t, f, fmt.Sprintf(`"intake_mode":"task","intake_status_id":"%d"`, f.statusID))
	first := inbound(1, "Invoice", "See attached.")
	first.Attachments = []comm.InboundAttachment{pdf("invoice.pdf", "%PDF one"), pdf("copy.pdf", "%PDF one")}
	pollOnce(t, f, ch, first)

	var task, thread int64
	if err := f.sp.P.QueryRow(context.Background(), `
		SELECT c.parent_card_id, c.id FROM card c JOIN card_type ct ON ct.id = c.card_type_id
		WHERE ct.name = 'comm' AND c.deleted_at IS NULL ORDER BY c.id DESC LIMIT 1`).Scan(&task, &thread); err != nil {
		t.Fatal(err)
	}
	if got := attachmentCount(t, f, thread); got != 1 {
		t.Errorf("files on the thread = %d, want 1 (the same bytes twice in one message are one file)", got)
	}
	if got := attachmentCount(t, f, task); got != 0 {
		t.Errorf("files on the task = %d, want 0", got)
	}

	// The same file in a reply is linked to the thread's copy.
	again := inbound(2, "Re: Invoice", "Here it is again.")
	again.ThreadIDHdr = threadIDOf(t, f, thread)
	again.Attachments = []comm.InboundAttachment{pdf("invoice-again.pdf", "%PDF one")}
	pollOnce(t, f, ch, again)
	if got := attachmentCount(t, f, thread); got != 1 {
		t.Errorf("files on the thread after a repeat = %d, want 1", got)
	}

	row := listThread(t, f, thread)
	if len(row.Replies) != 2 {
		t.Fatalf("messages = %d, want 2", len(row.Replies))
	}
	for i, r := range row.Replies {
		if len(r.Attachments) != 1 || !r.Attachments[0].OnThread || r.Attachments[0].Filename != "invoice.pdf" || r.Attachments[0].Kind != "pdf" {
			t.Errorf("message %d files = %+v, want invoice.pdf (a pdf) on the thread", i, r.Attachments)
		}
	}
	attID := row.Replies[0].Attachments[0].ID

	// Add to task.
	var moved comm.CommAttachmentToTaskOutput
	dispatch(t, f, api.SubRequest{ID: "m", Endpoint: "comm", Action: "attachment_to_task",
		Data: json.RawMessage(fmt.Sprintf(`{"comm_id":"%d","attachment_id":"%d"}`, thread, attID))}, &moved)
	if moved.AttachmentID != attID || moved.TaskID != task {
		t.Errorf("attachment_to_task = %+v, want %d on %d", moved, attID, task)
	}
	if got := attachmentCount(t, f, task); got != 1 {
		t.Errorf("files on the task after Add to task = %d, want 1", got)
	}
	if got := attachmentCount(t, f, thread); got != 0 {
		t.Errorf("files on the thread after Add to task = %d, want 0", got)
	}
	row = listThread(t, f, thread)
	for i, r := range row.Replies {
		if len(r.Attachments) != 1 || r.Attachments[0].OnThread || r.Attachments[0].ID != attID {
			t.Errorf("message %d files after the move = %+v, want the same file, now the task's", i, r.Attachments)
		}
	}
	var activity int
	if err := f.sp.P.QueryRow(context.Background(), `
		SELECT count(*) FROM activity WHERE card_id = $1 AND kind = 'attachment_create'`, task).Scan(&activity); err != nil {
		t.Fatal(err)
	}
	if activity != 1 {
		t.Errorf("attachment_create activity on the task = %d, want 1", activity)
	}
	// Again: already there, no change.
	dispatch(t, f, api.SubRequest{ID: "m2", Endpoint: "comm", Action: "attachment_to_task",
		Data: json.RawMessage(fmt.Sprintf(`{"comm_id":"%d","attachment_id":"%d"}`, thread, attID))}, &moved)
	if got := attachmentCount(t, f, task); got != 1 {
		t.Errorf("files on the task after a second Add = %d, want 1", got)
	}

	// The same bytes once more: linked to the task's file, nothing new stored.
	third := inbound(3, "Re: Invoice", "And once more.")
	third.ThreadIDHdr = threadIDOf(t, f, thread)
	third.Attachments = []comm.InboundAttachment{pdf("x.pdf", "%PDF one")}
	pollOnce(t, f, ch, third)
	if a, b := attachmentCount(t, f, thread), attachmentCount(t, f, task); a != 0 || b != 1 {
		t.Errorf("after a third copy: thread %d / task %d files, want 0 / 1", a, b)
	}
	row = listThread(t, f, thread)
	last := row.Replies[len(row.Replies)-1]
	if len(last.Attachments) != 1 || last.Attachments[0].ID != attID {
		t.Errorf("third message files = %+v, want the task's file %d", last.Attachments, attID)
	}
}

// TestAttachmentToTaskMergesAndRefuses: when the task already has the same
// bytes, Add to task links the messages to the task's file and drops the
// thread's copy; a thread on its own and a file not on the thread are
// refused.
func TestAttachmentToTaskMergesAndRefuses(t *testing.T) {
	f := setupAdmin(t, "kitp_test_attachment_to_task")
	ch := seedChannelWith(t, f, `"intake_mode":"thread"`)
	msg := inbound(1, "Contract", "Signed copy attached.")
	msg.Attachments = []comm.InboundAttachment{pdf("contract.pdf", "%PDF signed")}
	pollOnce(t, f, ch, msg)
	thread := commsUnder(t, f, f.projectID)[0]
	threadFile := listThread(t, f, thread).Replies[0].Attachments[0].ID

	// A thread on its own has no task to add to.
	e := dispatchExpectErr(t, f, api.SubRequest{ID: "a", Endpoint: "comm", Action: "attachment_to_task",
		Data: json.RawMessage(fmt.Sprintf(`{"comm_id":"%d","attachment_id":"%d"}`, thread, threadFile))})
	if e.Code != "not_on_task" {
		t.Errorf("thread on its own: code %q, want not_on_task", e.Code)
	}

	// On a task that already has the same bytes.
	taskFile, _ := seedAttachment(t, f, f.taskID, "contract-final.pdf", "application/pdf", []byte("%PDF signed"))
	var att comm.CommAttachOutput
	dispatch(t, f, api.SubRequest{ID: "at", Endpoint: "comm", Action: "attach",
		Data: json.RawMessage(fmt.Sprintf(`{"comm_id":"%d","task_id":"%d"}`, thread, f.taskID))}, &att)
	var out comm.CommAttachmentToTaskOutput
	dispatch(t, f, api.SubRequest{ID: "b", Endpoint: "comm", Action: "attachment_to_task",
		Data: json.RawMessage(fmt.Sprintf(`{"comm_id":"%d","attachment_id":"%d"}`, thread, threadFile))}, &out)
	if out.AttachmentID != taskFile {
		t.Errorf("merged into %d, want the task's file %d", out.AttachmentID, taskFile)
	}
	if a, b := attachmentCount(t, f, thread), attachmentCount(t, f, f.taskID); a != 0 || b != 1 {
		t.Errorf("after the merge: thread %d / task %d files, want 0 / 1", a, b)
	}
	if got := listThread(t, f, thread).Replies[0].Attachments; len(got) != 1 || got[0].ID != taskFile {
		t.Errorf("message files after the merge = %+v, want the task's %d", got, taskFile)
	}

	// A file on another thread isn't this thread's to move.
	second := inbound(2, "Another matter", "Unrelated.")
	second.Attachments = []comm.InboundAttachment{pdf("other.pdf", "%PDF other")}
	pollOnce(t, f, ch, second)
	threads := commsUnder(t, f, f.projectID)
	if len(threads) != 1 {
		t.Fatalf("threads on their own = %v", threads)
	}
	otherFile := listThread(t, f, threads[0]).Replies[0].Attachments[0].ID
	e = dispatchExpectErr(t, f, api.SubRequest{ID: "c", Endpoint: "comm", Action: "attachment_to_task",
		Data: json.RawMessage(fmt.Sprintf(`{"comm_id":"%d","attachment_id":"%d"}`, thread, otherFile))})
	if e.Code != "not_on_thread" {
		t.Errorf("another thread's file: code %q, want not_on_thread", e.Code)
	}
}

// TestEmailAttachmentsDrop: an account that drops files files the message
// without them, says how many were left off and logs which.
func TestEmailAttachmentsDrop(t *testing.T) {
	f := setupAdmin(t, "kitp_test_email_attachments_drop")
	ch := seedChannelWith(t, f, `"intake_mode":"thread","email_attachments":"drop"`)
	msg := inbound(1, "Photos", "Two photos.")
	msg.Attachments = []comm.InboundAttachment{pdf("a.jpg", "jpg a"), pdf("b.jpg", "jpg b")}
	pollOnce(t, f, ch, msg)
	thread := commsUnder(t, f, f.projectID)[0]
	if got := attachmentCount(t, f, thread); got != 0 {
		t.Errorf("files kept = %d, want 0", got)
	}
	row := listThread(t, f, thread)
	if r := row.Replies[0]; r.AttachmentsLeftOff != 2 || len(r.Attachments) != 0 || r.BodyText != "Two photos." {
		t.Errorf("message = %+v, want filed with 2 left off", r)
	}
	d := logDetail(t, f, ch, "attachments_dropped")
	if d["count"] != float64(2) || fmt.Sprint(d["files"]) != "[a.jpg b.jpg]" {
		t.Errorf("attachments_dropped detail = %v", d)
	}
}

// TestChannelRelayAndFilesSettings: the settings take only their values; a
// new account sends replies on, one updated without the field keeps its
// value, and comm_channel.list reports both.
func TestChannelRelayAndFilesSettings(t *testing.T) {
	f := setupAdmin(t, "kitp_test_channel_relay_files")
	for _, bad := range []string{`"relay_replies":"yes"`, `"email_attachments":"some"`} {
		body := fmt.Sprintf(`{"project_id":"%d","name":"X","channel_type":"email",%s}`, f.projectID, bad)
		if e := dispatchExpectErr(t, f, api.SubRequest{ID: "s", Endpoint: "comm_channel", Action: "set", Data: json.RawMessage(body)}); e.Code != "validation" {
			t.Errorf("%s: code %s, want validation", bad, e.Code)
		}
	}
	fresh := seedChannelWith(t, f, "")
	off := seedChannelWith(t, f, `"relay_replies":"off","email_attachments":"drop"`)
	// An update without the fields keeps them.
	dispatch(t, f, api.SubRequest{ID: "u", Endpoint: "comm_channel", Action: "set",
		Data: json.RawMessage(fmt.Sprintf(`{"id":"%d","project_id":"%d","name":"Renamed","channel_type":"email"}`, off, f.projectID))}, &comm.ChannelSetOutput{})
	var out comm.ChannelListOutput
	dispatch(t, f, api.SubRequest{ID: "l", Endpoint: "comm_channel", Action: "list",
		Data: json.RawMessage(fmt.Sprintf(`{"project_id":"%d"}`, f.projectID))}, &out)
	got := map[int64]comm.ChannelRow{}
	for _, r := range out.Rows {
		got[r.ID] = r
	}
	if r := got[fresh]; r.RelayReplies != "on" || r.EmailAttachments != "" {
		t.Errorf("a new account: relay %q, files %q; want on and unset (keep)", r.RelayReplies, r.EmailAttachments)
	}
	if r := got[off]; r.RelayReplies != "off" || r.EmailAttachments != "drop" {
		t.Errorf("updated account: relay %q, files %q; want off / drop kept", r.RelayReplies, r.EmailAttachments)
	}
	// An account from before the settings (no values) reads as off / keep.
	if comm.ResolveRelay("") || !comm.ResolveRelay("on") || !comm.ResolveKeepAttachments("") || comm.ResolveKeepAttachments("drop") {
		t.Error("unset relay must read as off and unset attachments as keep")
	}
}

// relayFixture is a thread between the account, Ada (who wrote first), Bob
// (a contact) and Carol (a kitp user), on an account with relay_replies
// set by extra.
type relayFixture struct {
	f      *fixture
	ch     int64
	thread int64
}

func newRelayFixture(t *testing.T, schema, extra string) relayFixture {
	t.Helper()
	f := setupAdmin(t, schema)
	ch := seedChannelWith(t, f, `"intake_mode":"thread"`+extra)
	pollOnce(t, f, ch, inbound(1, "Broken printer", "It's on fire."))
	thread := commsUnder(t, f, f.projectID)[0]
	person := func(title, email, tier string) int64 {
		var out comm.PersonCreateOutput
		dispatch(t, f, api.SubRequest{ID: "p", Endpoint: "person", Action: "create",
			Data: json.RawMessage(fmt.Sprintf(`{"title":%q,"email":%q,"tier":%q}`, title, email, tier))}, &out)
		return out.PersonCardID
	}
	bob := person("Bob", "bob@example.com", "contact")
	carol := person("Carol", "carol@ourco.example", "user")
	recips := listThread(t, f, thread).Recipients
	ids := []string{}
	for _, id := range recips {
		ids = append(ids, fmt.Sprintf("%q", fmt.Sprint(id)))
	}
	ids = append(ids, fmt.Sprintf("%q", fmt.Sprint(bob)), fmt.Sprintf("%q", fmt.Sprint(carol)))
	dispatch(t, f, api.SubRequest{ID: "r", Endpoint: "comm", Action: "set_recipients",
		Data: json.RawMessage(fmt.Sprintf(`{"comm_id":"%d","recipient_person_ids":[%s]}`, thread, strings.Join(ids, ",")))}, &comm.CommSetRecipientsOutput{})
	return relayFixture{f: f, ch: ch, thread: thread}
}

func (r relayFixture) reply(t *testing.T, uid uint32, mutate func(*comm.InboundMessage)) {
	t.Helper()
	m := inbound(uid, "Re: Broken printer", "Still on fire.\n\nOn Mon, Support wrote:\n> earlier")
	m.ThreadIDHdr = threadIDOf(t, r.f, r.thread)
	if mutate != nil {
		mutate(&m)
	}
	pollOnce(t, r.f, r.ch, m)
}

// TestRelaySendsAReplyOn: Ada's reply to the account alone is sent on to
// Bob — not to Ada, not to Carol (a kitp user) — as "Ada Lovelace via
// Support" from the account's address, with her words only and her file,
// marked Auto-Submitted; the thread shows it under her message.
func TestRelaySendsAReplyOn(t *testing.T) {
	r := newRelayFixture(t, "kitp_test_relay_sends", "")
	r.reply(t, 2, func(m *comm.InboundMessage) {
		m.Attachments = []comm.InboundAttachment{pdf("smoke.jpg", "jpg smoke")}
	})

	row := listThread(t, r.f, r.thread)
	if len(row.Replies) != 2 {
		t.Fatalf("messages = %d, want 2 (the copy isn't a message of its own)", len(row.Replies))
	}
	got := row.Replies[1]
	if got.Relay == nil || got.Relay.To != "bob@example.com" || got.Relay.DeliveryStatus != "pending" {
		t.Fatalf("relay = %+v, want a pending copy to bob@example.com only", got.Relay)
	}
	if row.Replies[0].Relay != nil {
		t.Errorf("the first message (a new thread) was sent on: %+v", row.Replies[0].Relay)
	}
	if d := logDetail(t, r.f, r.ch, "relay_queued"); d["to"] != "bob@example.com" {
		t.Errorf("relay_queued detail = %v", d)
	}

	rt := &recordingTransport{}
	s := comm.NewSMTPSenderForTest(r.f.sp, r.ch, time.Second)
	s.SetTransport(rt.fn)
	if err := s.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if len(rt.calls) != 1 {
		t.Fatalf("sent %d messages, want 1", len(rt.calls))
	}
	call := rt.calls[0]
	msg := string(call.msg)
	if call.from != "support@example.com" || call.to != "bob@example.com" {
		t.Errorf("envelope %q → %q", call.from, call.to)
	}
	for _, want := range []string{
		"From: \"Ada Lovelace via Support\" <support@example.com>\r\n",
		"Auto-Submitted: auto-forwarded\r\n",
		"Still on fire.",
		`filename="smoke.jpg"`,
		"Ref: " + threadIDOf(t, r.f, r.thread),
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("copy lacks %q:\n%s", want, msg)
		}
	}
	if strings.Contains(msg, "-Support") {
		t.Errorf("copy carries the account's signature:\n%s", msg)
	}
	if got := listThread(t, r.f, r.thread).Replies[1].Relay; got == nil || got.DeliveryStatus != "sent" {
		t.Errorf("relay after sending = %+v, want sent", got)
	}

	// An operator reply afterwards quotes Ada's message once, not the copy.
	var rp comm.ReplyPostOutput
	dispatch(t, r.f, api.SubRequest{ID: "op", Endpoint: "reply", Action: "post",
		Data: json.RawMessage(fmt.Sprintf(`{"comm_id":"%d","body":"Fire brigade is on the way."}`, r.thread))}, &rp)
	rt2 := &recordingTransport{}
	s.SetTransport(rt2.fn)
	if err := s.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if len(rt2.calls) != 1 {
		t.Fatalf("operator reply sends = %d", len(rt2.calls))
	}
	if body := string(rt2.calls[0].msg); strings.Contains(body, "Ada Lovelace via Support") {
		t.Errorf("the operator's reply quotes the copy:\n%s", body)
	}
}

// TestRelaySkips: nothing is sent on for an auto-reply (logged), for mail
// that already reached everyone (silently), for a parsed bounce, or on an
// account with relay off.
func TestRelaySkips(t *testing.T) {
	r := newRelayFixture(t, "kitp_test_relay_skips", "")
	copies := func() int {
		n := 0
		for _, m := range listThread(t, r.f, r.thread).Replies {
			if m.Relay != nil {
				n++
			}
		}
		return n
	}
	r.reply(t, 2, func(m *comm.InboundMessage) { m.AutoKind = "auto_submitted" })
	if n := copies(); n != 0 {
		t.Errorf("an auto-reply was sent on (%d copies)", n)
	}
	if d := logDetail(t, r.f, r.ch, "relay_skipped"); d["reason"] != "auto_submitted" {
		t.Errorf("relay_skipped detail = %v", d)
	}
	r.reply(t, 3, func(m *comm.InboundMessage) { m.Cc = "Bob <bob@example.com>" })
	if n := copies(); n != 0 {
		t.Errorf("a reply that reached everyone was sent on (%d copies)", n)
	}
	if got := logKinds(t, r.f, r.ch)["relay_skipped"]; got != 1 {
		t.Errorf("relay_skipped rows = %d, want 1 (nobody left is not a skip)", got)
	}

	off := newRelayFixture(t, "kitp_test_relay_off", `,"relay_replies":"off"`)
	off.reply(t, 2, nil)
	for _, m := range listThread(t, off.f, off.thread).Replies {
		if m.Relay != nil {
			t.Errorf("an account with relay off sent a copy: %+v", m.Relay)
		}
	}
}

// TestAutomaticKind: machine-written mail is recognised from its headers.
func TestAutomaticKind(t *testing.T) {
	cases := []struct {
		name, headers, want string
	}{
		{"person", "From: Ada <ada@example.com>\r\n", ""},
		{"auto-submitted no", "From: ada@example.com\r\nAuto-Submitted: no\r\n", ""},
		{"out of office", "From: ada@example.com\r\nAuto-Submitted: auto-replied\r\n", "auto_submitted"},
		{"precedence", "From: ada@example.com\r\nPrecedence: bulk\r\n", "precedence"},
		{"x-autoreply", "From: ada@example.com\r\nX-Autoreply: yes\r\n", "auto_reply"},
		{"list", "From: ada@example.com\r\nList-Id: <dev.example.com>\r\n", "mailing_list"},
		{"report", "From: ada@example.com\r\nContent-Type: multipart/report; report-type=delivery-status; boundary=b\r\n", "report"},
		{"daemon", "From: Mail Delivery System <MAILER-DAEMON@mx.example.com>\r\n", "bounce"},
		{"empty return path", "Return-Path: <>\r\nFrom: ada@example.com\r\n", "bounce"},
	}
	for _, c := range cases {
		raw := c.headers + "Subject: hi\r\n\r\nbody\r\n"
		m, err := comm.ParseInboundMessage(1, []byte(raw))
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if m.AutoKind != c.want {
			t.Errorf("%s: AutoKind %q, want %q", c.name, m.AutoKind, c.want)
		}
	}
}

// TestBuildMIMEHeadersStayOneLine: a subject carrying CR LF (an encoded word
// decodes to one) can't start a header of its own.
func TestBuildMIMEHeadersStayOneLine(t *testing.T) {
	msg := string(comm.BuildMIMEForTest("support@example.com", "bob@example.com",
		"Hello\r\nBcc: victim@example.com\r\nX-Evil: 1", "body", "abc123"))
	head := msg[:strings.Index(msg, "\r\n\r\n")]
	for _, line := range strings.Split(head, "\r\n") {
		if strings.HasPrefix(line, "Bcc:") || strings.HasPrefix(line, "X-Evil:") {
			t.Errorf("injected header line %q in:\n%s", line, head)
		}
	}
}
