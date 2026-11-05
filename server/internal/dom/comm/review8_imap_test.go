package comm_test

// Review 2026-11-05 round 6: the IMAP poll's budget, which other mail
// counts as "other mail filed", a last try before a message is set aside,
// and no per-attempt parse_error rows.

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/dom/comm"
)

func pollWith(t *testing.T, f *fixture, ch int64, stub *stubIMAPClient) *comm.IMAPPoller {
	t.Helper()
	p := comm.NewIMAPPollerForTest(f.sp, ch, 5*time.Second)
	p.SetDialFunc(func(context.Context, comm.IMAPConfig) (comm.InboundClient, error) { return stub, nil })
	return p
}

func kindCount(t *testing.T, f *fixture, ch int64, kind string) int {
	t.Helper()
	var n int
	if err := f.sp.P.QueryRow(context.Background(), `SELECT count(*) FROM comm_log WHERE channel_id = $1 AND kind = $2`, ch, kind).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// TestPollBudgetDoesNotFaultTheAccount (#1): a poll that runs out of its
// budget files what it reached, records its poll row, and isn't counted as
// the account failing.
func TestPollBudgetDoesNotFaultTheAccount(t *testing.T) {
	f := setupAdmin(t, "kitp_test_r8_imap_budget")
	ch := seedChannelWith(t, f, `"intake_mode":"thread"`)
	first := inbound(10, "First", "files")
	first.MessageID = "<first-r8@example.com>"
	slow := inbound(11, "Slow", "takes longer than the poll may")
	slow.MessageID = "<slow-r8@example.com>"
	stub := &stubIMAPClient{messages: []comm.InboundMessage{first, slow}, slow: map[uint32]time.Duration{11: time.Minute}}
	p := pollWith(t, f, ch, stub)
	p.SetPollBudgetForTest(2 * time.Second)
	if err := p.Tick(context.Background()); err != nil {
		t.Fatalf("Tick: %v", err)
	}
	if p.Backoff() != 0 {
		t.Errorf("backoff %v after a poll that ran out of time, want none", p.Backoff())
	}
	if fmt.Sprint(stub.marks()) != "[10]" {
		t.Errorf("marked %v, want the first message filed", stub.marks())
	}
	if d := logDetail(t, f, ch, "poll"); fmt.Sprint(d["message_count"]) != "2" {
		t.Errorf("poll row %v, want it written after the budget ran out", d)
	}
	if n := kindCount(t, f, ch, "file_retry"); n != 0 {
		t.Errorf("%d file_retry rows: the slow message didn't fail, the poll ran out", n)
	}
}

// TestNothingFiledBacksOffWithoutFaulting (#2): a poll whose every message
// failed backs the account off, without a step toward its fault switch.
func TestNothingFiledBacksOffWithoutFaulting(t *testing.T) {
	f := setupAdmin(t, "kitp_test_r8_imap_nothing_filed")
	poisonFiling(t, f)
	ch := seedChannelWith(t, f, `"intake_mode":"thread"`)
	poison := inbound(10, "Poison", "never files")
	poison.MessageID = "<poison-r8-backoff@example.com>"
	stub := &stubIMAPClient{messages: []comm.InboundMessage{poison}}
	p := pollWith(t, f, ch, stub)
	if err := p.Tick(context.Background()); !errors.Is(err, comm.ErrNothingFiled) {
		t.Fatalf("Tick: %v, want ErrNothingFiled", err)
	}
	if p.Backoff() == 0 || p.CapHitsForTest() != 0 {
		t.Errorf("backoff %v, cap hits %d; want backed off, nothing counted", p.Backoff(), p.CapHitsForTest())
	}
	if d := logDetail(t, f, ch, "poll"); fmt.Sprint(d["failed"]) != "1" {
		t.Errorf("poll row %v, want failed: 1", d)
	}
	status, _, err := comm.ReadChannelStatus(context.Background(), f.sp.P, ch)
	if err != nil || status != comm.ChannelStatusEnabled {
		t.Errorf("status %q (%v), want enabled", status, err)
	}
}

// TestOnlyMailDownTheSamePathCounts (#2): duplicates (and mail down other
// paths) filing is no sign that a message's failure is its own; fresh mail
// down its path is. Due, it gets a last try before it is set aside.
func TestOnlyMailDownTheSamePathCounts(t *testing.T) {
	f := setupAdmin(t, "kitp_test_r8_imap_same_path")
	poisonFiling(t, f)
	ch := seedChannelWith(t, f, `"intake_mode":"thread"`)
	defer comm.SetFileFailureSetAsideAfterForTest(0)()
	fine := inbound(11, "Fine", "files")
	fine.MessageID = "<fine-r8@example.com>"
	stub := &stubIMAPClient{messages: []comm.InboundMessage{fine}}
	p := pollWith(t, f, ch, stub)
	if err := p.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	poison := inbound(10, "Poison", "never files")
	poison.MessageID = "<poison-r8-path@example.com>"
	again := fine
	again.UID = 12 // a second copy: a duplicate
	stub.mu.Lock()
	stub.messages = []comm.InboundMessage{poison, again}
	stub.mu.Unlock()
	for i := 1; i <= 4; i++ {
		if err := p.RunOnce(context.Background()); !errors.Is(err, comm.ErrNothingFiled) {
			t.Fatalf("poll %d: %v, want ErrNothingFiled (a duplicate isn't filed mail)", i, err)
		}
	}
	if len(stub.archived) != 0 {
		t.Fatalf("set aside %v while only duplicates filed", stub.archived)
	}
	other := inbound(13, "Other", "files")
	other.MessageID = "<other-r8@example.com>"
	stub.mu.Lock()
	stub.messages = append(stub.messages, other)
	stub.mu.Unlock()
	if err := p.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(stub.archived) != 0 {
		t.Fatalf("set aside %v in the poll that first saw mail down its path file", stub.archived)
	}
	if err := p.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(stub.archived) != "[10]" {
		t.Errorf("set aside %v, want 10 after its last try failed", stub.archived)
	}
}

// TestLastTryFilesInstead (#2): a message due to be set aside that files on
// its last try (the fault was fixed meanwhile) is filed, not set aside.
func TestLastTryFilesInstead(t *testing.T) {
	f := setupAdmin(t, "kitp_test_r8_imap_last_try")
	poisonFiling(t, f)
	ch := seedChannelWith(t, f, `"intake_mode":"thread"`)
	defer comm.SetFileFailureSetAsideAfterForTest(0)()
	poison := inbound(10, "Poison", "files once fixed")
	poison.MessageID = "<poison-r8-fixed@example.com>"
	fine := inbound(11, "Fine", "files")
	fine.MessageID = "<fine-r8-fixed@example.com>"
	stub := &stubIMAPClient{messages: []comm.InboundMessage{poison, fine}}
	p := pollWith(t, f, ch, stub)
	for i := 1; i <= 3; i++ {
		if err := p.RunOnce(context.Background()); err != nil && !errors.Is(err, comm.ErrNothingFiled) {
			t.Fatalf("poll %d: %v", i, err)
		}
		stub.mu.Lock()
		stub.messages = []comm.InboundMessage{poison}
		stub.mu.Unlock()
	}
	if _, err := f.sp.P.Exec(context.Background(), `DROP TRIGGER poison_filing ON attribute_value`); err != nil {
		t.Fatal(err)
	}
	if err := p.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(stub.archived) != 0 || fmt.Sprint(stub.marks()) != "[11 10]" {
		t.Errorf("marked %v, set aside %v; want 10 filed on its last try", stub.marks(), stub.archived)
	}
	var left int
	if err := f.sp.P.QueryRow(context.Background(), `SELECT count(*) FROM comm_imap_file_failure WHERE channel_id = $1`, ch).Scan(&left); err != nil || left != 0 {
		t.Errorf("%d failure rows left (%v), want none", left, err)
	}
}

// TestFailedFilingLogsOnce (#3): a failing message isn't logged as a
// parse_error on every poll; POST and SMTP intake log a file_retry instead.
func TestFailedFilingLogsOnce(t *testing.T) {
	f := setupAdmin(t, "kitp_test_r8_imap_logs_once")
	poisonFiling(t, f)
	ch := seedChannelWith(t, f, `"intake_mode":"thread"`)
	poison := inbound(10, "Poison", "never files")
	poison.MessageID = "<poison-r8-once@example.com>"
	p := pollWith(t, f, ch, &stubIMAPClient{messages: []comm.InboundMessage{poison}})
	for i := 0; i < 3; i++ {
		if err := p.RunOnce(context.Background()); !errors.Is(err, comm.ErrNothingFiled) {
			t.Fatal(err)
		}
	}
	if n, r := kindCount(t, f, ch, "parse_error"), kindCount(t, f, ch, "file_retry"); n != 0 || r != 1 {
		t.Errorf("%d parse_error, %d file_retry rows; want 0 and 1", n, r)
	}
	raw := []byte("From: Ada <ada@example.com>\r\nTo: support@example.com\r\nSubject: Poison\r\nMessage-ID: <poison-r8-post@example.com>\r\n\r\nbody\r\n")
	in := &comm.Intake{Pool: f.sp}
	if _, err := in.FileRaw(context.Background(), ch, comm.TransportPOST, 0, raw); err == nil || errors.Is(err, comm.ErrUnfileable) {
		t.Fatalf("POST: %v, want a passing failure", err)
	}
	if n, r := kindCount(t, f, ch, "parse_error"), kindCount(t, f, ch, "file_retry"); n != 0 || r != 2 {
		t.Errorf("after POST: %d parse_error, %d file_retry rows; want 0 and 2", n, r)
	}
	if d := logDetail(t, f, ch, "file_retry"); d["subject"] != "Poison" || fmt.Sprint(d["error"]) == "" {
		t.Errorf("file_retry detail %v", d)
	}
}
