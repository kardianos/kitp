package comm_test

// Outgoing mail threads and survives one refused recipient (2026-11-05,
// the final review check's "worth a look").

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/mail"
	"strings"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/dom/comm"
)

// storedMessageID reads a reply's reply_message_id ("" when none).
func storedMessageID(t *testing.T, f *fixture, replyID int64) string {
	t.Helper()
	var mid string
	if err := f.sp.P.QueryRow(context.Background(), `
		SELECT COALESCE((SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
		                 WHERE av.card_id = $1 AND ad.name = 'reply_message_id'), '')`, replyID).Scan(&mid); err != nil {
		t.Fatal(err)
	}
	return mid
}

// TestRepliesCarryTheThread: an incoming message's Message-ID is kept, and
// each reply kitp sends names the thread's messages in In-Reply-To and
// References, its own included once it is sent.
func TestRepliesCarryTheThread(t *testing.T) {
	f := setupAdmin(t, "kitp_test_r7_threading")
	ctx := context.Background()
	ch := seedChannelWith(t, f, `"intake_mode":"thread"`)
	first := inbound(10, "Question", "help please")
	first.MessageID = "in-1@example.com"
	pollOnce(t, f, ch, first)
	var commID, inReply int64
	if err := f.sp.P.QueryRow(ctx, `
		SELECT c.id, (SELECT (e #>> '{}')::bigint FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id,
		                   jsonb_array_elements(av.value) e WHERE av.card_id = c.id AND ad.name = 'replies' LIMIT 1)
		FROM card c JOIN card_type ct ON ct.id = c.card_type_id WHERE ct.name = 'comm' ORDER BY c.id DESC LIMIT 1`).Scan(&commID, &inReply); err != nil {
		t.Fatal(err)
	}
	if got := storedMessageID(t, f, inReply); got != "<in-1@example.com>" {
		t.Fatalf("the incoming message's id: %q", got)
	}

	rt := &recordingTransport{}
	s := comm.NewSMTPSenderForTest(f.sp, ch, time.Second)
	s.SetTransport(rt.fn)
	send := func(body string) (int64, mail.Header) {
		t.Helper()
		var out comm.ReplyPostOutput
		dispatch(t, f, api.SubRequest{ID: "r", Endpoint: "reply", Action: "post", Data: json.RawMessage(
			fmt.Sprintf(`{"comm_id":"%d","body":%q}`, commID, body))}, &out)
		n := len(rt.calls)
		if err := s.RunOnce(ctx); err != nil {
			t.Fatalf("RunOnce: %v", err)
		}
		if len(rt.calls) != n+1 {
			t.Fatalf("%d messages sent, want %d", len(rt.calls), n+1)
		}
		m, err := mail.ReadMessage(bytes.NewReader(rt.calls[n].msg))
		if err != nil {
			t.Fatal(err)
		}
		return out.ReplyID, m.Header
	}
	r1, h1 := send("first answer")
	if h1.Get("In-Reply-To") != "<in-1@example.com>" || h1.Get("References") != "<in-1@example.com>" {
		t.Errorf("first answer: In-Reply-To %q, References %q", h1.Get("In-Reply-To"), h1.Get("References"))
	}
	m1 := h1.Get("Message-ID")
	if got := storedMessageID(t, f, r1); got != m1 || m1 == "" {
		t.Errorf("the sent answer's stored id %q, sent as %q", got, m1)
	}
	_, h2 := send("second answer")
	if h2.Get("In-Reply-To") != m1 {
		t.Errorf("second answer In-Reply-To %q, want the first answer's %q", h2.Get("In-Reply-To"), m1)
	}
	if got := strings.Fields(h2.Get("References")); fmt.Sprint(got) != fmt.Sprint([]string{"<in-1@example.com>", m1}) {
		t.Errorf("second answer References %v", got)
	}
}

// TestRefusedRecipientDoesNotStopTheRest: a recipient the server refuses
// for good is left off and logged; the others get the message. When every
// recipient is refused, it bounces.
func TestRefusedRecipientDoesNotStopTheRest(t *testing.T) {
	f := setupAdmin(t, "kitp_test_r7_refused_rcpt")
	ctx := context.Background()
	mock := startMockSMTP(t)
	mock.refuseRcpt = map[string]bool{"bob@example.com": true}
	host, portStr, err := net.SplitHostPort(mock.addr())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("KITP_COMM_HOST_ALLOWLIST", host)
	var setOut comm.ChannelSetOutput
	dispatch(t, f, api.SubRequest{ID: "ch", Endpoint: "comm_channel", Action: "set", Data: json.RawMessage(fmt.Sprintf(
		`{"project_id":"%d","name":"Support","channel_type":"email","smtp_host":%q,"smtp_port":%s,"from_address":"kitp@example.com"}`,
		f.projectID, host, portStr))}, &setOut)
	ids := make([]string, 0, 2)
	for _, email := range []string{"alice@example.com", "bob@example.com"} {
		var p comm.PersonUpsertByEmailOutput
		dispatch(t, f, api.SubRequest{ID: "p", Endpoint: "person", Action: "upsert_by_email",
			Data: json.RawMessage(fmt.Sprintf(`{"email":%q,"kind":"contact"}`, email))}, &p)
		ids = append(ids, fmt.Sprintf("%q", fmt.Sprint(p.PersonID)))
	}
	var cc comm.CommCreateOutput
	dispatch(t, f, api.SubRequest{ID: "c", Endpoint: "comm", Action: "create", Data: json.RawMessage(fmt.Sprintf(
		`{"task_id":"%d","channel_id":"%d","subject":"Two","recipient_person_ids":[%s]}`, f.taskID, setOut.ChannelID, strings.Join(ids, ",")))}, &cc)
	post := func(body string) int64 {
		t.Helper()
		var out comm.ReplyPostOutput
		dispatch(t, f, api.SubRequest{ID: "r", Endpoint: "reply", Action: "post", Data: json.RawMessage(
			fmt.Sprintf(`{"comm_id":"%d","body":%q}`, cc.CommID, body))}, &out)
		return out.ReplyID
	}
	s := comm.NewSMTPSenderForTest(f.sp, setOut.ChannelID, time.Second)
	reply := post("to both")
	if err := s.RunOnce(ctx); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if msgs := mock.messages(); len(msgs) != 1 || fmt.Sprint(msgs[0].To) != "[alice@example.com]" {
		t.Fatalf("delivered %+v, want one message to alice", msgs)
	}
	if got := statusOf(t, f, reply); got != "sent" {
		t.Errorf("delivery_status %q, want sent", got)
	}
	if d := logDetail(t, f, setOut.ChannelID, "send_bounce"); d["recipient"] != "bob@example.com" || d["others_sent"] != true {
		t.Errorf("send_bounce detail %v", d)
	}
	if d := logDetail(t, f, setOut.ChannelID, "send_ok"); d["refused"] == nil {
		t.Errorf("send_ok detail names no refused recipient: %v", d)
	}

	mock.mu.Lock()
	mock.refuseRcpt["alice@example.com"] = true
	mock.mu.Unlock()
	reply = post("to nobody")
	if err := s.RunOnce(ctx); err == nil {
		t.Error("RunOnce: want the bounce")
	}
	if got := statusOf(t, f, reply); got != "bounced" {
		t.Errorf("every recipient refused: delivery_status %q, want bounced", got)
	}
}
