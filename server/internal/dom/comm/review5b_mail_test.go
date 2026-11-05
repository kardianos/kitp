package comm_test

// Regression tests for the mail findings of the fifth 2026-11-03 review
// (#3, #4, #9).

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/dom/comm"
)

// TestRefusedFetchDoesNotStopIntake (#9): a message the server refuses to
// fetch doesn't stop the account's mail: the others are filed, and after
// two refusals it is set aside.
func TestRefusedFetchDoesNotStopIntake(t *testing.T) {
	f := setupAdmin(t, "kitp_test_r5_imap_refused")
	ch := seedChannelWith(t, f, `"intake_mode":"thread"`)
	stuck := inbound(10, "Stuck", "never fetched")
	stuck.MessageID = "<stuck-r5@example.com>"
	good := inbound(11, "Fine", "read me")
	good.MessageID = "<fine-r5b@example.com>"
	stub := &stubIMAPClient{messages: []comm.InboundMessage{stuck, good}, refuse: map[uint32]bool{10: true}}
	p := comm.NewIMAPPollerForTest(f.sp, ch, 5*time.Second)
	p.SetDialFunc(func(context.Context, comm.IMAPConfig) (comm.InboundClient, error) { return stub, nil })
	for i := 0; i < 3; i++ {
		if err := p.RunOnce(context.Background()); err != nil {
			t.Fatalf("poll %d: %v", i+1, err)
		}
		if i == 0 && fmt.Sprint(stub.marks()) != "[11]" {
			t.Fatalf("after the first poll marked %v, want the other message filed", stub.marks())
		}
		stub.mu.Lock()
		stub.messages = []comm.InboundMessage{stuck}
		stub.mu.Unlock()
	}
	if fmt.Sprint(stub.marks()) != "[11 10]" || fmt.Sprint(stub.archived) != "[10]" {
		t.Errorf("marked %v, set aside %v; want 10 set aside after two refusals", stub.marks(), stub.archived)
	}
}

// TestSendResultOutlivesTheTick (#4): a send that used up its tick's
// budget is still recorded — counted as a try, or as sent.
func TestSendResultOutlivesTheTick(t *testing.T) {
	f := setupAdmin(t, "kitp_test_r5_send_deadline")
	ch, reply := seedPendingReply(t, f, "support@example.com")
	s := comm.NewSMTPSenderForTest(f.sp, ch, time.Second)
	slow := func(ctx context.Context, host string, port int, user, pass, from, to string, msg []byte) error {
		<-ctx.Done() // the budget runs out mid-send
		return ctx.Err()
	}
	s.SetTransport(slow)
	defer comm.SetSendTimeoutForTest(200 * time.Millisecond)()
	if err := s.RunOnce(context.Background()); err == nil {
		t.Fatal("RunOnce: want the send's error")
	}
	var attempts int
	if err := f.sp.P.QueryRow(context.Background(), `SELECT attempts FROM comm_send_attempt WHERE reply_id = $1`, reply).Scan(&attempts); err != nil {
		t.Fatal(err)
	}
	if attempts != 1 {
		t.Errorf("a send that ran out of budget counted %d tries, want 1", attempts)
	}
	if d := logDetail(t, f, ch, "send_retry"); d["attempt"] == nil {
		t.Errorf("no send_retry row: %v", d)
	}
}

// TestStaleListDoesNotSendAgain (#3): a sender working from a list read
// before another sender sent a message doesn't send it again.
func TestStaleListDoesNotSendAgain(t *testing.T) {
	f := setupAdmin(t, "kitp_test_r5_send_twice")
	ch, reply := seedPendingReply(t, f, "support@example.com")
	ctx := context.Background()
	first := &recordingTransport{}
	a := comm.NewSMTPSenderForTest(f.sp, ch, time.Second)
	a.SetTransport(first.fn)
	if err := a.RunOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if statusOf(t, f, reply) != "sent" {
		t.Fatalf("not sent: %s", statusOf(t, f, reply))
	}
	// Sender B's stale list still names the message: its claim fails.
	b := comm.NewSMTPSenderForTest(f.sp, ch, time.Second)
	ok, err := comm.ClaimForTest(ctx, b, reply)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Error("a sent message was claimed again")
	}
	if errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}
