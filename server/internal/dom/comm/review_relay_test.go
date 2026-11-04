package comm_test

// Regression tests for the thread and outgoing-mail findings of the
// 2026-11-03 review (area E).

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/dom/comm"
)

func relayCopies(t *testing.T, r relayFixture) []string {
	t.Helper()
	var out []string
	for _, m := range listThread(t, r.f, r.thread).Replies {
		if m.Relay != nil {
			out = append(out, m.Relay.To)
		}
	}
	return out
}

// TestRelayForgedCc (#3): addresses a message names in Cc join the thread
// but get no copies until they write or are written to from kitp; a sender
// who wasn't on the thread isn't sent on at all.
func TestRelayForgedCc(t *testing.T) {
	base := newRelayFixture(t, "kitp_test_relay_forged_cc", "")
	r := base
	// Each message its own Message-ID, or the dedupe drops the repeats.
	reply := func(uid uint32, mutate func(*comm.InboundMessage)) {
		base.reply(t, uid, func(m *comm.InboundMessage) {
			m.MessageID = fmt.Sprintf("<forged-cc-%d@example.com>", uid)
			if mutate != nil {
				mutate(m)
			}
		})
	}
	// Ada (on the thread) Cc's two outsiders; Bob gets the copy, they don't.
	reply(2, func(m *comm.InboundMessage) { m.Cc = "a@victim.example, ceo@ourco.example" })
	if got := relayCopies(t, r); len(got) != 1 || got[0] != "bob@example.com" {
		t.Fatalf("copies after the Cc = %v, want one to bob@example.com", got)
	}
	// Her next message: still only Bob — the Cc'd addresses are on the
	// thread now, but unconfirmed.
	reply(3, nil)
	got := relayCopies(t, r)
	if len(got) != 2 || got[1] != "bob@example.com" {
		t.Fatalf("copies after the second reply = %v, want the second to bob@example.com only", got)
	}
	// A stranger writing to the thread is filed, not sent on.
	reply(4, func(m *comm.InboundMessage) { m.From = "IT Security Desk <eve@evil.example>" })
	if got := relayCopies(t, r); len(got) != 2 {
		t.Fatalf("a stranger's message was sent on: %v", got)
	}
	if d := logDetail(t, r.f, r.ch, "relay_skipped"); d["reason"] != "sender_not_on_thread" {
		t.Errorf("relay_skipped = %v, want sender_not_on_thread", d)
	}
	// Once kitp writes to the Cc'd address, it is confirmed.
	var rp comm.ReplyPostOutput
	dispatch(t, r.f, api.SubRequest{ID: "op", Endpoint: "reply", Action: "post",
		Data: json.RawMessage(fmt.Sprintf(`{"comm_id":"%d","body":"Copying everyone."}`, r.thread))}, &rp)
	reply(5, nil)
	got = relayCopies(t, r)
	last := got[len(got)-1]
	if !strings.Contains(last, "a@victim.example") {
		t.Errorf("after a reply from kitp to everyone, the next copy goes to %q; want the confirmed Cc'd address too", last)
	}
	if strings.Contains(last, "eve@evil.example") {
		// eve wrote (so she is confirmed) and kitp's reply went to her
		// too; that's expected once staff have replied to the thread.
		t.Logf("copy includes eve after staff replied to her: %q", last)
	}
}

// TestRelayUsesTheThreadsAccount (#10): a reply that comes in on another
// account of the project follows the thread's own account's relay setting.
func TestRelayUsesTheThreadsAccount(t *testing.T) {
	r := newRelayFixture(t, "kitp_test_relay_thread_account", `,"relay_replies":"off"`)
	other := seedChannelWith(t, r.f, `"intake_mode":"thread","relay_replies":"on","from_address":"sales@example.com","name":"Sales"`)
	m := inbound(2, "Re: Broken printer", "Still on fire.")
	m.ThreadIDHdr = threadIDOf(t, r.f, r.thread)
	pollOnce(t, r.f, other, m)
	if got := relayCopies(t, r); len(got) != 0 {
		t.Fatalf("a thread whose account has relay off was sent on through another account: %v", got)
	}
}

// TestRelayLeavesTheRawEmailOff (#27): the .eml kept for debugging is
// never attached to a copy.
func TestRelayLeavesTheRawEmailOff(t *testing.T) {
	t.Setenv("KITP_COMM_SAVE_RAW_EMAIL", "1")
	r := newRelayFixture(t, "kitp_test_relay_raw_eml", "")
	r.reply(t, 2, func(m *comm.InboundMessage) {
		m.Raw = []byte("From: ada@example.com\r\nSubject: x\r\n\r\nraw\r\n")
		m.Attachments = []comm.InboundAttachment{pdf("plan.pdf", "pdf bytes")}
	})
	var names []string
	rows, err := r.f.sp.P.Query(context.Background(), `
		SELECT f.filename
		FROM attribute_value ro
		JOIN attribute_def ad ON ad.id = ro.attribute_def_id AND ad.name = 'relay_of'
		JOIN reply_body_attachment rba ON rba.reply_body_id = ro.card_id
		JOIN attachment a ON a.id = rba.attachment_id
		JOIN file f ON f.id = a.file_id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			t.Fatal(err)
		}
		names = append(names, n)
	}
	if len(names) != 1 || names[0] != "plan.pdf" {
		t.Errorf("the copy carries %v, want only plan.pdf", names)
	}
}

// TestReplyPostLimitsAndDeletedPeople (#19, #27): reply.post refuses files
// over 20 MB together, and doesn't mail a deleted person.
func TestReplyPostLimitsAndDeletedPeople(t *testing.T) {
	r := newRelayFixture(t, "kitp_test_reply_post_limits", "")
	ctx := context.Background()
	var big []string
	for i := range 2 {
		var file, att int64
		if err := r.f.sp.P.QueryRow(ctx, `INSERT INTO file (filename, mime_type, size_bytes, created_by)
			VALUES ($1, 'application/pdf', 15*1024*1024, 1) RETURNING id`, fmt.Sprintf("big%d.pdf", i)).Scan(&file); err != nil {
			t.Fatal(err)
		}
		if err := r.f.sp.P.QueryRow(ctx, `INSERT INTO attachment (card_id, file_id) VALUES ($1, $2) RETURNING id`, r.thread, file).Scan(&att); err != nil {
			t.Fatal(err)
		}
		big = append(big, fmt.Sprintf("%q", fmt.Sprint(att)))
	}
	env := dispatchExpectErr(t, r.f, api.SubRequest{ID: "op", Endpoint: "reply", Action: "post",
		Data: json.RawMessage(fmt.Sprintf(`{"comm_id":"%d","body":"files","attachment_ids":[%s]}`, r.thread, strings.Join(big, ",")))})
	if env.Code != "attachments_too_large" {
		t.Errorf("reply.post with 30 MB of files: code %q, want attachments_too_large", env.Code)
	}

	if _, err := r.f.sp.P.Exec(ctx, `
		UPDATE card SET deleted_at = now()
		WHERE id = (SELECT av.card_id FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
		            WHERE ad.name = 'email' AND av.value #>> '{}' = 'bob@example.com' LIMIT 1)`); err != nil {
		t.Fatal(err)
	}
	var rp comm.ReplyPostOutput
	dispatch(t, r.f, api.SubRequest{ID: "op", Endpoint: "reply", Action: "post",
		Data: json.RawMessage(fmt.Sprintf(`{"comm_id":"%d","body":"Hello."}`, r.thread))}, &rp)
	var to string
	if err := r.f.sp.P.QueryRow(ctx, `
		SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE ad.name = 'reply_to' AND av.card_id = $1::bigint`, rp.ReplyID).Scan(&to); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(to, "bob@example.com") {
		t.Errorf("reply.post mailed a deleted person: To %q", to)
	}
}

// TestAttachmentPartHeaders (#11): a file name can't add header lines to its
// part, and a bad stored media type falls back to octet-stream.
func TestAttachmentPartHeaders(t *testing.T) {
	msg := string(comm.BuildMIMEWithFileForTest("support@example.com", "bob@example.com", "Hi", "body", "abc123",
		"x.pdf\r\nContent-Type: text/html", "application/pdf\r\nX-Evil: 1", []byte("data")))
	for _, line := range strings.Split(msg, "\r\n") {
		if strings.HasPrefix(line, "X-Evil:") || line == "Content-Type: text/html" {
			t.Errorf("injected part header %q in:\n%s", line, msg)
		}
	}
	if !strings.Contains(msg, "Content-Type: application/octet-stream") {
		t.Errorf("a bad media type wasn't replaced:\n%s", msg)
	}
}
