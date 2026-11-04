package comm_test

// Regression tests for the mail items left open after the fourth
// 2026-11-03 review: sender claims and retries, loop protection, the relay
// rate limit, and moving never-fileable mail out of INBOX.

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/dom/comm"
)

func deliveryStatus(t *testing.T, f *fixture, replyID int64) string {
	t.Helper()
	var s string
	if err := f.sp.P.QueryRow(context.Background(), `
		SELECT COALESCE((SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
		                 WHERE av.card_id = $1 AND ad.name = 'delivery_status'), '')`, replyID).Scan(&s); err != nil {
		t.Fatal(err)
	}
	return s
}

// TestSenderClaimsAndRetries: a message another sender has claimed isn't
// sent; a passing failure keeps it pending with a backoff; the last try
// fails it.
func TestSenderClaimsAndRetries(t *testing.T) {
	f := setupAdmin(t, "kitp_test_r5_sender")
	ctx := context.Background()
	ch, reply := seedPendingReply(t, f, "support@example.com")
	rt := &recordingTransport{}
	s := comm.NewSMTPSenderForTest(f.sp, ch, time.Second)
	s.SetTransport(rt.fn)

	if _, err := f.sp.P.Exec(ctx, `INSERT INTO comm_send_attempt (reply_id, claimed_until) VALUES ($1, now() + interval '5 minutes')`, reply); err != nil {
		t.Fatal(err)
	}
	if err := s.RunOnce(ctx); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if len(rt.calls) != 0 {
		t.Fatalf("a message another sender claimed was sent (%d calls)", len(rt.calls))
	}

	if _, err := f.sp.P.Exec(ctx, `DELETE FROM comm_send_attempt WHERE reply_id = $1`, reply); err != nil {
		t.Fatal(err)
	}
	rt.results = []error{errors.New("connection reset by peer")}
	if err := s.RunOnce(ctx); err == nil {
		t.Fatal("RunOnce: want the transport error")
	}
	if got := deliveryStatus(t, f, reply); got != "pending" {
		t.Errorf("after a passing failure the message is %q, want pending", got)
	}
	var attempts int
	var later bool
	if err := f.sp.P.QueryRow(ctx, `SELECT attempts, next_attempt_at > now() FROM comm_send_attempt WHERE reply_id = $1`, reply).Scan(&attempts, &later); err != nil {
		t.Fatal(err)
	}
	if attempts != 1 || !later {
		t.Errorf("attempts %d, next attempt later %v; want 1 and true", attempts, later)
	}
	if d := logDetail(t, f, ch, "send_retry"); d["attempt"] == nil {
		t.Errorf("no send_retry row: %v", d)
	}
	// Waiting out the backoff: not tried.
	if err := s.RunOnce(ctx); err != nil {
		t.Fatalf("RunOnce during the backoff: %v", err)
	}
	if len(rt.calls) != 1 {
		t.Errorf("tried during its backoff (%d calls)", len(rt.calls))
	}
	// The last try fails it for good.
	if _, err := f.sp.P.Exec(ctx, `UPDATE comm_send_attempt SET attempts = 5, next_attempt_at = now() - interval '1 second' WHERE reply_id = $1`, reply); err != nil {
		t.Fatal(err)
	}
	rt.results = append(rt.results, errors.New("connection reset by peer"))
	if err := s.RunOnce(ctx); err == nil {
		t.Fatal("RunOnce: want the transport error")
	}
	if got := deliveryStatus(t, f, reply); got != "failed" {
		t.Errorf("after the last try the message is %q, want failed", got)
	}
	var left int
	if err := f.sp.P.QueryRow(ctx, `SELECT count(*) FROM comm_send_attempt WHERE reply_id = $1`, reply).Scan(&left); err != nil {
		t.Fatal(err)
	}
	if left != 0 {
		t.Error("a failed message kept its attempt row")
	}
}

// TestXLoopIsNeverSentOn: mail carrying X-Loop counts as automatic.
func TestXLoopIsNeverSentOn(t *testing.T) {
	m, err := comm.ParseInboundMessage(1, []byte("From: Ada <ada@example.com>\r\nTo: support@example.com\r\nSubject: Re: x\r\nX-Loop: support@other.example\r\n\r\nhi\r\n"))
	if err != nil {
		t.Fatal(err)
	}
	if m.AutoKind != "loop" {
		t.Errorf("AutoKind = %q, want loop", m.AutoKind)
	}
}

// TestRelayRateLimit: a thread sends at most 20 copies in an hour.
func TestRelayRateLimit(t *testing.T) {
	r := newRelayFixture(t, "kitp_test_r5_relay_rate", "")
	for i := range 21 {
		uid := uint32(500 + i)
		r.reply(t, uid, func(m *comm.InboundMessage) {
			m.MessageID = fmt.Sprintf("<bob-rate-%d@example.com>", uid)
			m.From = "Bob <bob@example.com>"
		})
	}
	if got := relayCopies(t, r); len(got) != 20 {
		t.Errorf("copies = %d, want 20", len(got))
	}
	if d := logDetail(t, r.f, r.ch, "relay_skipped"); d["reason"] != "rate_limited" {
		t.Errorf("relay_skipped = %v, want rate_limited", d)
	}
}

// TestUnreadableMailIsMovedAside: a message kitp can never file is marked
// read and moved to the set-aside folder.
func TestUnreadableMailIsMovedAside(t *testing.T) {
	f := setupAdmin(t, "kitp_test_r5_imap_archive")
	ch := seedChannelWith(t, f, `"intake_mode":"thread"`)
	bad := comm.InboundMessage{UID: 90, ParseError: "not mail"}
	good := inbound(91, "Fine", "read me")
	good.MessageID = "<fine-r5@example.com>"
	stub := &stubIMAPClient{messages: []comm.InboundMessage{bad, good}}
	p := comm.NewIMAPPollerForTest(f.sp, ch, 5*time.Second)
	p.SetDialFunc(func(context.Context, comm.IMAPConfig) (comm.InboundClient, error) { return stub, nil })
	if err := p.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if fmt.Sprint(stub.archived) != "[90]" || stub.archiveFolder != comm.DefaultSetAsideFolder {
		t.Errorf("archived %v to %q, want [90] to %q", stub.archived, stub.archiveFolder, comm.DefaultSetAsideFolder)
	}
	if fmt.Sprint(stub.marks()) != "[90 91]" {
		t.Errorf("marked seen %v, want both", stub.marks())
	}
}
