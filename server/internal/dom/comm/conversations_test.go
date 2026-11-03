package comm_test

// Threads on their own, intake modes, comm.attach and quoting in replies
// (docs/CONVERSATIONS.md).

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

// seedChannelWith creates an IMAP+SMTP channel under the fixture's project
// with extra comm_channel.set fields (a JSON object body without braces).
func seedChannelWith(t *testing.T, f *fixture, extra string) int64 {
	t.Helper()
	body := fmt.Sprintf(`{
		"project_id":"%d","name":"Support","channel_type":"email",
		"imap_host":"127.0.0.1","imap_port":993,
		"imap_username":"u","imap_password":"p",
		"smtp_host":"127.0.0.1","smtp_port":587,
		"smtp_username":"u","smtp_password":"p",
		"from_address":"support@example.com"`, f.projectID)
	if extra != "" {
		body += "," + extra
	}
	body += "}"
	var out comm.ChannelSetOutput
	dispatch(t, f, api.SubRequest{ID: "ch", Endpoint: "comm_channel", Action: "set", Data: json.RawMessage(body)}, &out)
	return out.ChannelID
}

// pollOnce runs one IMAP cycle over msgs.
func pollOnce(t *testing.T, f *fixture, channelID int64, msgs ...comm.InboundMessage) {
	t.Helper()
	stub := &stubIMAPClient{messages: msgs}
	p := comm.NewIMAPPollerForTest(f.sp, channelID, 5*time.Second)
	p.SetDialFunc(func(context.Context, comm.IMAPConfig) (comm.InboundClient, error) { return stub, nil })
	if err := p.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
}

// commsUnder lists comm ids whose parent is parentID.
func commsUnder(t *testing.T, f *fixture, parentID int64) []int64 {
	t.Helper()
	rows, err := f.sp.P.Query(context.Background(), `
		SELECT c.id FROM card c JOIN card_type ct ON ct.id = c.card_type_id
		WHERE ct.name = 'comm' AND c.parent_card_id = $1 AND c.deleted_at IS NULL ORDER BY c.id`, parentID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	return ids
}

func countCards(t *testing.T, f *fixture, typeName string) int {
	t.Helper()
	var n int
	if err := f.sp.P.QueryRow(context.Background(), `
		SELECT count(*) FROM card c JOIN card_type ct ON ct.id = c.card_type_id
		WHERE ct.name = $1 AND c.deleted_at IS NULL`, typeName).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func taskComms(t *testing.T, f *fixture, taskID int64) []int64 {
	t.Helper()
	var raw []byte
	err := f.sp.P.QueryRow(context.Background(), `
		SELECT av.value FROM attribute_value av
		WHERE av.card_id = $1 AND av.attribute_def_id = $2`, taskID, f.commsAttrID).Scan(&raw)
	if err != nil {
		return nil
	}
	var ids []int64
	if err := json.Unmarshal(raw, &ids); err != nil {
		t.Fatalf("comms %s: %v", raw, err)
	}
	return ids
}

func inbound(uid uint32, subject, body string) comm.InboundMessage {
	return comm.InboundMessage{UID: uid, From: "Ada Lovelace <ada@example.com>", To: "support@example.com", Subject: subject, Body: body}
}

// TestIntakeModes: what an unmatched message becomes, by the channel's New
// mail setting (and the legacy default when it is unset).
func TestIntakeModes(t *testing.T) {
	cases := []struct {
		name         string
		extra        func(f *fixture) string
		tasks, comms int // new cards
		onProject    int // new comms directly in the project
	}{
		{"unset, no intake status: ignored", func(*fixture) string { return "" }, 0, 0, 0},
		{"unset, intake status: task", func(f *fixture) string { return fmt.Sprintf(`"intake_status_id":"%d"`, f.statusID) }, 1, 1, 0},
		{"thread", func(*fixture) string { return `"intake_mode":"thread"` }, 0, 1, 1},
		{"task without intake status: flow default", func(*fixture) string { return `"intake_mode":"task"` }, 1, 1, 0},
		{"ignore beats an intake status", func(f *fixture) string {
			return fmt.Sprintf(`"intake_mode":"ignore","intake_status_id":"%d"`, f.statusID)
		}, 0, 0, 0},
	}
	for i, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := setupAdmin(t, fmt.Sprintf("kitp_test_intake_mode_%d", i))
			ch := seedChannelWith(t, f, c.extra(f))
			tasks0, comms0 := countCards(t, f, "task"), countCards(t, f, "comm")
			pollOnce(t, f, ch, inbound(1, "Printer on fire", "It is on fire.\n"))
			if got := countCards(t, f, "task") - tasks0; got != c.tasks {
				t.Errorf("new tasks = %d, want %d", got, c.tasks)
			}
			if got := countCards(t, f, "comm") - comms0; got != c.comms {
				t.Errorf("new comms = %d, want %d", got, c.comms)
			}
			standalone := commsUnder(t, f, f.projectID)
			if len(standalone) != c.onProject {
				t.Fatalf("comms in the project = %v, want %d", standalone, c.onProject)
			}
			if c.onProject == 1 {
				// The thread lists by id, carries the message, and the next
				// message on the thread lands on it.
				var out comm.CommListForTaskOutput
				dispatch(t, f, api.SubRequest{ID: "l", Endpoint: "comm", Action: "list_for_task",
					Data: json.RawMessage(fmt.Sprintf(`{"comm_id":"%d"}`, standalone[0]))}, &out)
				if len(out.Rows) != 1 || out.Rows[0].Title != "Printer on fire" || len(out.Rows[0].Replies) != 1 {
					t.Fatalf("list_for_task by comm_id = %+v", out.Rows)
				}
				pollOnce(t, f, ch, inbound(2, "Re: Printer on fire [#"+out.Rows[0].ThreadID+"]", "Still on fire."))
				if n := replyCountOf(t, f, standalone[0]); n != 2 {
					t.Errorf("replies after a threaded answer = %d, want 2", n)
				}
			}
		})
	}
}

// TestChannelModeValidation: the two settings only take their values, and
// comm_channel.list reports them.
func TestChannelModeValidation(t *testing.T) {
	f := setupAdmin(t, "kitp_test_channel_modes")
	for _, bad := range []string{`"intake_mode":"later"`, `"reply_quote":"some"`} {
		body := fmt.Sprintf(`{"project_id":"%d","name":"X","channel_type":"email",%s}`, f.projectID, bad)
		if e := dispatchExpectErr(t, f, api.SubRequest{ID: "s", Endpoint: "comm_channel", Action: "set", Data: json.RawMessage(body)}); e.Code != "validation" {
			t.Errorf("%s: code %s, want validation", bad, e.Code)
		}
	}
	ch := seedChannelWith(t, f, `"intake_mode":"thread","reply_quote":"all"`)
	var out comm.ChannelListOutput
	dispatch(t, f, api.SubRequest{ID: "l", Endpoint: "comm_channel", Action: "list",
		Data: json.RawMessage(fmt.Sprintf(`{"project_id":"%d"}`, f.projectID))}, &out)
	found := false
	for _, r := range out.Rows {
		if r.ID == ch {
			found = true
			if r.IntakeMode != "thread" || r.ReplyQuote != "all" {
				t.Errorf("listed modes = %q / %q", r.IntakeMode, r.ReplyQuote)
			}
		}
	}
	if !found {
		t.Fatalf("channel %d not listed", ch)
	}
}

// TestCommAttach: a thread on its own moves onto a task and back, keeping
// the task's comms list in step; its email files stay on the thread
// (docs/MAIL_INTAKE_AND_CALENDARS.md, "Files from email").
func TestCommAttach(t *testing.T) {
	f := setupAdmin(t, "kitp_test_comm_attach")
	ch := seedChannelWith(t, f, `"intake_mode":"thread"`)
	msg := inbound(1, "Invoice question", "Why two invoices?")
	msg.Attachments = []comm.InboundAttachment{{Filename: "invoice.pdf", MimeType: "application/pdf", Bytes: []byte("%PDF-1 fake")}}
	pollOnce(t, f, ch, msg)
	threads := commsUnder(t, f, f.projectID)
	if len(threads) != 1 {
		t.Fatalf("threads in the project = %v", threads)
	}
	thread := threads[0]
	attachedTo := func() int64 {
		var card int64
		if err := f.sp.P.QueryRow(context.Background(), `
			SELECT a.card_id FROM attachment a JOIN reply_body_attachment rba ON rba.attachment_id = a.id
			WHERE a.deleted_at IS NULL ORDER BY a.id LIMIT 1`).Scan(&card); err != nil {
			t.Fatalf("attachment: %v", err)
		}
		return card
	}
	if got := attachedTo(); got != thread {
		t.Errorf("a thread on its own keeps its attachment on card %d, want the thread %d", got, thread)
	}

	attach := func(taskID int64) comm.CommAttachOutput {
		var out comm.CommAttachOutput
		dispatch(t, f, api.SubRequest{ID: "a", Endpoint: "comm", Action: "attach",
			Data: json.RawMessage(fmt.Sprintf(`{"comm_id":"%d","task_id":"%d"}`, thread, taskID))}, &out)
		return out
	}
	out := attach(f.taskID)
	if out.ParentID != f.taskID || out.TaskID != f.taskID {
		t.Errorf("attach = %+v", out)
	}
	if got := commsUnder(t, f, f.taskID); len(got) != 1 || got[0] != thread {
		t.Errorf("comms under the task = %v", got)
	}
	if got := taskComms(t, f, f.taskID); len(got) != 1 || got[0] != thread {
		t.Errorf("task comms list = %v", got)
	}
	if got := attachedTo(); got != thread {
		t.Errorf("after attach the attachment is on %d, want still the thread %d", got, thread)
	}
	attach(f.taskID) // again: no change, no duplicate
	if got := taskComms(t, f, f.taskID); len(got) != 1 {
		t.Errorf("re-attach duplicated the comms list: %v", got)
	}

	out = attach(0)
	if out.ParentID != f.projectID || out.TaskID != 0 {
		t.Errorf("detach = %+v", out)
	}
	if got := taskComms(t, f, f.taskID); len(got) != 0 {
		t.Errorf("task comms list after detach = %v", got)
	}
	if got := commsUnder(t, f, f.projectID); len(got) != 1 {
		t.Errorf("threads in the project after detach = %v", got)
	}

	for _, c := range []struct{ name, data, code string }{
		{"no comm", `{"task_id":"1"}`, "validation"},
		{"unknown task", fmt.Sprintf(`{"comm_id":"%d","task_id":"999999999"}`, thread), "task_not_found"},
		{"not a task", fmt.Sprintf(`{"comm_id":"%d","task_id":"%d"}`, thread, f.statusID), "validation"},
		{"not a comm", fmt.Sprintf(`{"comm_id":"%d","task_id":"%d"}`, f.taskID, f.taskID), "comm_wrong_type"},
	} {
		t.Run(c.name, func(t *testing.T) {
			if e := dispatchExpectErr(t, f, api.SubRequest{ID: "a", Endpoint: "comm", Action: "attach", Data: json.RawMessage(c.data)}); e.Code != c.code {
				t.Errorf("code %s (%s), want %s", e.Code, e.Message, c.code)
			}
		})
	}
}

// TestReplyQuoting: a reply on a thread on its own quotes the message before
// it (cut to its own text), has no Task: line, and keeps Ref: last; with
// quoting off it carries no quote.
func TestReplyQuoting(t *testing.T) {
	for _, c := range []struct {
		name, mode string
		quoted     bool
	}{
		{"default quotes the last message", "", true},
		{"off", "off", false},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := setupAdmin(t, "kitp_test_reply_quote_"+map[string]string{"": "default", "off": "off"}[c.mode])
			extra := `"intake_mode":"thread"`
			if c.mode != "" {
				extra += fmt.Sprintf(`,"reply_quote":%q`, c.mode)
			}
			ch := seedChannelWith(t, f, extra)
			pollOnce(t, f, ch, inbound(1, "Login broken", "I can't log in.\n\nOn Sun, Support <support@example.com> wrote:\n> older text"))
			thread := commsUnder(t, f, f.projectID)[0]

			var rp comm.ReplyPostOutput
			dispatch(t, f, api.SubRequest{ID: "r", Endpoint: "reply", Action: "post",
				Data: json.RawMessage(fmt.Sprintf(`{"comm_id":"%d","body":"Try resetting your password."}`, thread))}, &rp)

			s := comm.NewSMTPSenderForTest(f.sp, ch, time.Second)
			rt := &recordingTransport{}
			s.SetTransport(rt.fn)
			if err := s.RunOnce(context.Background()); err != nil {
				t.Fatalf("RunOnce: %v", err)
			}
			if len(rt.calls) != 1 {
				t.Fatalf("sent %d messages, want 1", len(rt.calls))
			}
			msg := string(rt.calls[0].msg)
			body := msg[strings.Index(msg, "\r\n\r\n")+4:]
			today := comm.QuoteDate(time.Now())
			header := "On " + today + ", Ada Lovelace <ada@example.com> wrote:\r\n> I can't log in."
			if got := strings.Contains(body, header); got != c.quoted {
				t.Errorf("quote present = %v, want %v; body:\n%s", got, c.quoted, body)
			}
			if strings.Contains(body, "older text") {
				t.Errorf("the quote repeats the customer's own quoted history:\n%s", body)
			}
			if strings.Contains(body, "Task:") {
				t.Errorf("a thread on its own got a Task: line:\n%s", body)
			}
			if !strings.HasSuffix(strings.TrimRight(body, "\r\n"), "Ref: "+threadIDOf(t, f, thread)) {
				t.Errorf("Ref: is not last:\n%s", body)
			}
			if !strings.HasPrefix(body, "Try resetting your password.") {
				t.Errorf("body does not start with the reply:\n%s", body)
			}
		})
	}
}

func threadIDOf(t *testing.T, f *fixture, commID int64) string {
	t.Helper()
	var id string
	if err := f.sp.P.QueryRow(context.Background(), `
		SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1 AND ad.name = 'thread_id'`, commID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}
