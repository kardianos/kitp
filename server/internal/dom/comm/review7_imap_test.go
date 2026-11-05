package comm_test

// A message that keeps failing to file for a passing reason (2026-11-05,
// the final review check's "worth a look").

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/dom/comm"
)

// poisonFiling makes filing any message titled "Poison" fail with an error
// kitp can't tell from a passing one (P0001).
func poisonFiling(t *testing.T, f *fixture) {
	t.Helper()
	for _, q := range []string{
		`CREATE FUNCTION poison_filing() RETURNS trigger LANGUAGE plpgsql AS $$
		 BEGIN
		     IF NEW.value = to_jsonb('Poison'::text) THEN RAISE EXCEPTION 'poisoned'; END IF;
		     RETURN NEW;
		 END $$`,
		`CREATE TRIGGER poison_filing BEFORE INSERT ON attribute_value FOR EACH ROW EXECUTE FUNCTION poison_filing()`,
	} {
		if _, err := f.sp.P.Exec(context.Background(), q); err != nil {
			t.Fatal(err)
		}
	}
}

// TestFailingMessageDoesNotStopIntake: the poll files the other mail, isn't
// failed itself, logs the failure once, and sets the message aside only
// after it has kept failing while other mail filed.
func TestFailingMessageDoesNotStopIntake(t *testing.T) {
	f := setupAdmin(t, "kitp_test_r7_imap_failing")
	poisonFiling(t, f)
	ch := seedChannelWith(t, f, `"intake_mode":"thread"`)
	poison := inbound(10, "Poison", "never files")
	poison.MessageID = "<poison-r7@example.com>"
	good := inbound(11, "Fine", "files")
	good.MessageID = "<fine-r7@example.com>"
	stub := &stubIMAPClient{messages: []comm.InboundMessage{poison, good}}
	p := comm.NewIMAPPollerForTest(f.sp, ch, 5*time.Second)
	p.SetDialFunc(func(context.Context, comm.IMAPConfig) (comm.InboundClient, error) { return stub, nil })
	defer comm.SetFileFailureSetAsideAfterForTest(0)()
	for i := 1; i <= 3; i++ {
		if err := p.RunOnce(context.Background()); err != nil {
			t.Fatalf("poll %d failed: %v", i, err)
		}
		if i == 1 {
			if fmt.Sprint(stub.marks()) != "[11]" {
				t.Fatalf("after the first poll marked %v, want the other message filed", stub.marks())
			}
			if d := logDetail(t, f, ch, "file_retry"); d["subject"] != "Poison" {
				t.Errorf("file_retry detail: %v", d)
			}
			stub.mu.Lock()
			stub.messages = []comm.InboundMessage{poison}
			stub.mu.Unlock()
		}
	}
	var retries int
	if err := f.sp.P.QueryRow(context.Background(), `SELECT count(*) FROM comm_log WHERE channel_id = $1 AND kind = 'file_retry'`, ch).Scan(&retries); err != nil {
		t.Fatal(err)
	}
	if retries != 1 {
		t.Errorf("%d file_retry rows, want 1 (the first failure)", retries)
	}
	if len(stub.archived) != 0 {
		t.Fatalf("set aside after %v, before its third failure", stub.archived)
	}
	if err := p.RunOnce(context.Background()); err != nil {
		t.Fatalf("poll 4: %v", err)
	}
	if fmt.Sprint(stub.marks()) != "[11 10]" || fmt.Sprint(stub.archived) != "[10]" {
		t.Errorf("marked %v, set aside %v; want 10 set aside after three failures", stub.marks(), stub.archived)
	}
	if d := logDetail(t, f, ch, "file_error"); !strings.Contains(fmt.Sprint(d["error"]), "set aside") || d["subject"] != "Poison" {
		t.Errorf("file_error detail: %v", d)
	}
}

// TestFailureOnEveryMessageSetsNothingAside: when nothing files (a kitp bug
// or the database), the failing mail stays in the inbox however long it
// fails.
func TestFailureOnEveryMessageSetsNothingAside(t *testing.T) {
	f := setupAdmin(t, "kitp_test_r7_imap_all_failing")
	poisonFiling(t, f)
	ch := seedChannelWith(t, f, `"intake_mode":"thread"`)
	poison := inbound(10, "Poison", "never files")
	poison.MessageID = "<poison-all-r7@example.com>"
	stub := &stubIMAPClient{messages: []comm.InboundMessage{poison}}
	p := comm.NewIMAPPollerForTest(f.sp, ch, 5*time.Second)
	p.SetDialFunc(func(context.Context, comm.IMAPConfig) (comm.InboundClient, error) { return stub, nil })
	defer comm.SetFileFailureSetAsideAfterForTest(0)()
	for i := 1; i <= 5; i++ {
		if err := p.RunOnce(context.Background()); err != nil {
			t.Fatalf("poll %d failed: %v", i, err)
		}
	}
	if len(stub.marks()) != 0 || len(stub.archived) != 0 {
		t.Errorf("marked %v, set aside %v; want the message left in the inbox", stub.marks(), stub.archived)
	}
}
