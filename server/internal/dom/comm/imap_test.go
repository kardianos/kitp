package comm_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/dom/comm"
)

// stubIMAPClient is the in-process imapClient stub Gate 6's tests
// drive RunOnce against. Tests construct one, seed Messages, and
// install it via SetDialFunc. The stub records every MarkSeen call so
// assertions can verify the poller marks only the messages it
// successfully ingested.
type stubIMAPClient struct {
	mu          sync.Mutex
	messages    []comm.InboundMessage
	fetchErr    error
	markSeenErr error
	markedSeen  []uint32
	closed      bool
}

func (s *stubIMAPClient) FetchUnseen(ctx context.Context) ([]comm.InboundMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fetchErr != nil {
		return nil, s.fetchErr
	}
	out := make([]comm.InboundMessage, len(s.messages))
	copy(out, s.messages)
	return out, nil
}

func (s *stubIMAPClient) MarkSeen(ctx context.Context, uids []uint32) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.markSeenErr != nil {
		return s.markSeenErr
	}
	s.markedSeen = append(s.markedSeen, uids...)
	return nil
}

func (s *stubIMAPClient) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	return nil
}

func (s *stubIMAPClient) marks() []uint32 {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]uint32, len(s.markedSeen))
	copy(out, s.markedSeen)
	return out
}

// seedChannelForIMAP creates one comm_channel under the fixture's
// project, with IMAP credentials filled in (host/port/user/pass) so
// the poller's loadChannelConfig round-trips a non-empty config. The
// intake_status_id parameter — when non-zero — is the status assigned
// to tasks auto-created on unmatched inbound mail.
func seedChannelForIMAP(t *testing.T, f *fixture, fromAddress string, intakeStatusID int64) int64 {
	t.Helper()
	body := fmt.Sprintf(`{
		"project_id":"%d","name":"Support","channel_type":"email",
		"imap_host":"127.0.0.1","imap_port":993,
		"imap_username":"u","imap_password":"p",
		"smtp_host":"127.0.0.1","smtp_port":587,
		"smtp_username":"u","smtp_password":"p"`, f.projectID)
	if fromAddress != "" {
		body += fmt.Sprintf(`,"from_address":%q`, fromAddress)
	}
	if intakeStatusID != 0 {
		body += fmt.Sprintf(`,"intake_status_id":"%d"`, intakeStatusID)
	}
	body += "}"
	var setOut comm.ChannelSetOutput
	dispatch(t, f, api.SubRequest{
		ID: "ch", Endpoint: "comm_channel", Action: "set", Data: json.RawMessage(body),
	}, &setOut)
	return setOut.ChannelID
}

// seedCommForIMAP creates a comm under the fixture's task, attached
// to the supplied channel, and returns the comm id + its thread id.
// Tests use this to set up an existing thread the inbound poller can
// match.
func seedCommForIMAP(t *testing.T, f *fixture, channelID int64, subject string) (int64, string) {
	t.Helper()
	var ccOut comm.CommCreateOutput
	dispatch(t, f, api.SubRequest{
		ID: "c", Endpoint: "comm", Action: "create", Data: json.RawMessage(
			fmt.Sprintf(`{"task_id":"%d","channel_id":"%d","subject":%q}`,
				f.taskID, channelID, subject)),
	}, &ccOut)
	return ccOut.CommID, ccOut.ThreadID
}

// replyCountOf returns the number of reply_body ids stored in the
// comm's replies attribute. Used by the threading tests to confirm
// the inbound was appended.
func replyCountOf(t *testing.T, f *fixture, commID int64) int {
	t.Helper()
	var raw []byte
	err := f.sp.P.QueryRow(context.Background(), `
		SELECT av.value FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id=$1 AND ad.name='replies'
	`, commID).Scan(&raw)
	if err != nil {
		return 0
	}
	var ids []int64
	if err := json.Unmarshal(raw, &ids); err != nil {
		return 0
	}
	return len(ids)
}

// firstReplyOf returns the first reply_body row attached to commID,
// or nil when none. Used to assert the inbound body/from/to round-
// tripped into the right card.
func firstReplyOf(t *testing.T, f *fixture, commID int64) *comm.ReplyRow {
	t.Helper()
	var listOut comm.CommListForTaskOutput
	dispatch(t, f, api.SubRequest{
		ID: "l", Endpoint: "comm", Action: "list_for_task", Data: json.RawMessage(
			fmt.Sprintf(`{"task_id":"%d"}`, f.taskID)),
	}, &listOut)
	for _, c := range listOut.Rows {
		if c.ID == commID && len(c.Replies) > 0 {
			r := c.Replies[0]
			return &r
		}
	}
	return nil
}

// ---- threading: header / subject / body ----

// TestIMAPPollerThreadingHeader confirms the X-Kitp-Thread-Id header
// alone is enough to thread an inbound reply onto an existing comm.
// The subject is rewritten by the mailer (no [#id] suffix) and the
// body has no Ref: trailer — header-only threading is the spec's
// most-reliable tier.
func TestIMAPPollerThreadingHeader(t *testing.T) {
	f := setupAdmin(t, "kitp_test_imap_thread_header")
	channelID := seedChannelForIMAP(t, f, "kitp@example.com", 0)
	commID, threadID := seedCommForIMAP(t, f, channelID, "Bug report")

	stub := &stubIMAPClient{
		messages: []comm.InboundMessage{{
			UID:         42,
			MessageID:   "<inbound-1@client.com>",
			From:        "alice@example.com",
			To:          "kitp@example.com",
			Subject:     "Re: Bug report", // no [#id] suffix
			ThreadIDHdr: threadID,
			Body:        "Thanks, I see the issue now.\n",
		}},
	}
	p := comm.NewIMAPPollerForTest(f.sp, channelID, 5*time.Second)
	p.SetDialFunc(func(ctx context.Context, _ comm.IMAPConfig) (comm.InboundClient, error) {
		return stub, nil
	})
	if err := p.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	if got := replyCountOf(t, f, commID); got != 1 {
		t.Errorf("reply count=%d, want 1", got)
	}
	r := firstReplyOf(t, f, commID)
	if r == nil {
		t.Fatal("no reply found on comm")
	}
	if r.DeliveryStatus != "received" {
		t.Errorf("delivery_status=%q want received", r.DeliveryStatus)
	}
	if r.From != "alice@example.com" {
		t.Errorf("from=%q", r.From)
	}
	if !strings.Contains(r.BodyText, "Thanks, I see the issue") {
		t.Errorf("body missing expected text: %q", r.BodyText)
	}
	if got := stub.marks(); len(got) != 1 || got[0] != 42 {
		t.Errorf("MarkSeen=%v want [42]", got)
	}
}

// TestIMAPPollerThreadingSubject covers the second tier: header
// missing, subject carries [#<id>], poller still matches.
func TestIMAPPollerThreadingSubject(t *testing.T) {
	f := setupAdmin(t, "kitp_test_imap_thread_subject")
	channelID := seedChannelForIMAP(t, f, "kitp@example.com", 0)
	commID, threadID := seedCommForIMAP(t, f, channelID, "Question")

	stub := &stubIMAPClient{
		messages: []comm.InboundMessage{{
			UID:     7,
			From:    "alice@example.com",
			To:      "kitp@example.com",
			Subject: "Re: Question [#" + threadID + "]",
			Body:    "Following up.\n",
		}},
	}
	p := comm.NewIMAPPollerForTest(f.sp, channelID, 5*time.Second)
	p.SetDialFunc(func(ctx context.Context, _ comm.IMAPConfig) (comm.InboundClient, error) {
		return stub, nil
	})
	if err := p.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if got := replyCountOf(t, f, commID); got != 1 {
		t.Errorf("reply count=%d, want 1", got)
	}
	if got := stub.marks(); len(got) != 1 || got[0] != 7 {
		t.Errorf("MarkSeen=%v want [7]", got)
	}
}

// TestIMAPPollerThreadingBody covers the third tier: header missing,
// subject mangled (no [#id] suffix), Ref: line in body trailer.
func TestIMAPPollerThreadingBody(t *testing.T) {
	f := setupAdmin(t, "kitp_test_imap_thread_body")
	channelID := seedChannelForIMAP(t, f, "kitp@example.com", 0)
	commID, threadID := seedCommForIMAP(t, f, channelID, "Question")

	body := "Following up on this.\n\nBest,\nAlice\n\nRef: " + threadID + "\n"
	stub := &stubIMAPClient{
		messages: []comm.InboundMessage{{
			UID:     11,
			From:    "alice@example.com",
			To:      "kitp@example.com",
			Subject: "Random rewritten subject",
			Body:    body,
		}},
	}
	p := comm.NewIMAPPollerForTest(f.sp, channelID, 5*time.Second)
	p.SetDialFunc(func(ctx context.Context, _ comm.IMAPConfig) (comm.InboundClient, error) {
		return stub, nil
	})
	if err := p.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if got := replyCountOf(t, f, commID); got != 1 {
		t.Errorf("reply count=%d, want 1", got)
	}
}

// ---- intake / unmatched ----

// TestIMAPPollerNoMatchCreatesTask covers the intake path: unmatched
// inbound, channel has intake_status configured → fresh task + comm
// with the inbound captured as the first received reply.
func TestIMAPPollerNoMatchCreatesTask(t *testing.T) {
	f := setupAdmin(t, "kitp_test_imap_intake")
	channelID := seedChannelForIMAP(t, f, "kitp@example.com", f.statusID)

	stub := &stubIMAPClient{
		messages: []comm.InboundMessage{{
			UID:     99,
			From:    "stranger@example.com",
			To:      "kitp@example.com",
			Subject: "Hello from a new user",
			Body:    "Can you help me?\n",
		}},
	}
	p := comm.NewIMAPPollerForTest(f.sp, channelID, 5*time.Second)
	p.SetDialFunc(func(ctx context.Context, _ comm.IMAPConfig) (comm.InboundClient, error) {
		return stub, nil
	})
	if err := p.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	ctx := context.Background()
	// One new task under the project (the fixture pre-seeded one task
	// at id f.taskID; so we should now have 2 task cards under this
	// project).
	var n int
	if err := f.sp.P.QueryRow(ctx, `
		SELECT count(*) FROM card c JOIN card_type ct ON ct.id=c.card_type_id
		WHERE ct.name='task' AND c.parent_card_id=$1 AND c.deleted_at IS NULL
	`, f.projectID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("task count=%d, want 2 (fixture + intake)", n)
	}

	// Locate the freshly-created task (the one that isn't fixture.taskID)
	// and confirm its title/description/status.
	var newTaskID int64
	var title, description string
	var statusVal int64
	if err := f.sp.P.QueryRow(ctx, `
		SELECT c.id,
		       COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = c.id AND ad.name='title'), ''),
		       COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = c.id AND ad.name='description'), ''),
		       COALESCE((SELECT (value)::text::bigint FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = c.id AND ad.name='status'), 0)
		FROM card c JOIN card_type ct ON ct.id=c.card_type_id
		WHERE ct.name='task' AND c.parent_card_id=$1 AND c.id <> $2 AND c.deleted_at IS NULL
		LIMIT 1
	`, f.projectID, f.taskID).Scan(&newTaskID, &title, &description, &statusVal); err != nil {
		t.Fatal(err)
	}
	if title != "Hello from a new user" {
		t.Errorf("task title=%q want 'Hello from a new user'", title)
	}
	if !strings.Contains(description, "Can you help me?") {
		t.Errorf("task description=%q missing inbound body", description)
	}
	if statusVal != f.statusID {
		t.Errorf("task status=%d want %d (intake)", statusVal, f.statusID)
	}

	// Comm under the new task carries the inbound as a received reply.
	var listOut comm.CommListForTaskOutput
	dispatch(t, f, api.SubRequest{
		ID: "l", Endpoint: "comm", Action: "list_for_task", Data: json.RawMessage(
			fmt.Sprintf(`{"task_id":"%d"}`, newTaskID)),
	}, &listOut)
	if len(listOut.Rows) != 1 {
		t.Fatalf("expected 1 comm on intake task, got %d", len(listOut.Rows))
	}
	if len(listOut.Rows[0].Replies) != 1 {
		t.Fatalf("expected 1 reply on intake comm, got %d", len(listOut.Rows[0].Replies))
	}
	r := listOut.Rows[0].Replies[0]
	if r.DeliveryStatus != "received" {
		t.Errorf("delivery_status=%q want received", r.DeliveryStatus)
	}
	if !strings.Contains(r.BodyText, "Can you help me?") {
		t.Errorf("body=%q missing inbound text", r.BodyText)
	}
	if got := stub.marks(); len(got) != 1 || got[0] != 99 {
		t.Errorf("MarkSeen=%v want [99]", got)
	}
}

// TestIMAPPollerNoMatchNoIntake covers the "discard with log" path:
// unmatched + no intake configured → comm_log row only, no task or
// comm card created.
func TestIMAPPollerNoMatchNoIntake(t *testing.T) {
	f := setupAdmin(t, "kitp_test_imap_unmatched")
	channelID := seedChannelForIMAP(t, f, "kitp@example.com", 0) // intake unset

	// Count cards before so we can assert nothing new appears.
	ctx := context.Background()
	var before int
	if err := f.sp.P.QueryRow(ctx, `SELECT count(*) FROM card`).Scan(&before); err != nil {
		t.Fatal(err)
	}

	stub := &stubIMAPClient{
		messages: []comm.InboundMessage{{
			UID:     7,
			From:    "spammer@example.com",
			To:      "kitp@example.com",
			Subject: "Nothing matches",
			Body:    "no thread tokens here.",
		}},
	}
	p := comm.NewIMAPPollerForTest(f.sp, channelID, 5*time.Second)
	p.SetDialFunc(func(ctx context.Context, _ comm.IMAPConfig) (comm.InboundClient, error) {
		return stub, nil
	})
	if err := p.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	var after int
	if err := f.sp.P.QueryRow(ctx, `SELECT count(*) FROM card`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != before {
		t.Errorf("card count grew from %d to %d on a discarded inbound", before, after)
	}

	// Most recent comm_log row should be kind='unmatched_thread'.
	kind, detail := logKindOf(t, f, channelID)
	// The poll cycle also logs kind='poll'; we want the unmatched row,
	// not the latest. Pull every row in this batch and look for kind.
	var kinds []string
	rows, err := f.sp.P.Query(ctx, `
		SELECT kind FROM comm_log WHERE channel_id=$1 ORDER BY id
	`, channelID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			t.Fatal(err)
		}
		kinds = append(kinds, k)
	}
	found := false
	for _, k := range kinds {
		if k == "unmatched_thread" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected comm_log kind=unmatched_thread among %v (most recent=%q detail=%s)", kinds, kind, detail)
	}
	if got := stub.marks(); len(got) != 1 || got[0] != 7 {
		t.Errorf("MarkSeen=%v want [7]", got)
	}
}

// ---- MIME parsing ----

// TestIMAPPollerMIMEPlainPreferred confirms the multipart parser
// picks the text/plain alternative when both plain and html parts are
// present. We hand-construct a raw RFC822 multipart body so the
// production ParseInboundMessage path actually runs.
func TestIMAPPollerMIMEPlainPreferred(t *testing.T) {
	body := "From: alice@example.com\r\n" +
		"To: kitp@example.com\r\n" +
		"Subject: Mixed\r\n" +
		"X-Kitp-Thread-Id: abcdefghij\r\n" +
		"MIME-Version: 1.0\r\n" +
		"Content-Type: multipart/alternative; boundary=\"BOUND\"\r\n" +
		"\r\n" +
		"--BOUND\r\n" +
		"Content-Type: text/plain; charset=utf-8\r\n" +
		"\r\n" +
		"plain version of message\r\n" +
		"--BOUND\r\n" +
		"Content-Type: text/html; charset=utf-8\r\n" +
		"\r\n" +
		"<p>html version of <b>message</b></p>\r\n" +
		"--BOUND--\r\n"
	m, err := comm.ParseInboundMessage(1, []byte(body))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !strings.Contains(m.Body, "plain version") {
		t.Errorf("expected plain body, got %q", m.Body)
	}
	if strings.Contains(m.Body, "<b>") || strings.Contains(m.Body, "html version") {
		t.Errorf("plain selection failed — got html: %q", m.Body)
	}
	if m.ThreadIDHdr != "abcdefghij" {
		t.Errorf("ThreadIDHdr=%q", m.ThreadIDHdr)
	}
	if m.Subject != "Mixed" {
		t.Errorf("Subject=%q", m.Subject)
	}
}

// TestIMAPPollerHTMLStrip covers the text/html-only path: tags
// stripped to plain text, entities decoded.
func TestIMAPPollerHTMLStrip(t *testing.T) {
	body := "From: alice@example.com\r\n" +
		"To: kitp@example.com\r\n" +
		"Subject: HTML only\r\n" +
		"MIME-Version: 1.0\r\n" +
		"Content-Type: text/html; charset=utf-8\r\n" +
		"\r\n" +
		"<html><body><p>Hello &amp; <b>welcome</b>!</p></body></html>\r\n"
	m, err := comm.ParseInboundMessage(2, []byte(body))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if strings.Contains(m.Body, "<") || strings.Contains(m.Body, ">") {
		t.Errorf("tags remain in body: %q", m.Body)
	}
	if !strings.Contains(m.Body, "Hello & welcome!") {
		t.Errorf("body=%q want stripped Hello & welcome!", m.Body)
	}
}

// ---- backoff ----

// TestIMAPPollerExponentialBackoff drives the internal bumpBackoff
// helper to confirm consecutive failures double the wait up to the
// 10-minute ceiling. We don't run the actual poll loop here — the
// goroutine's tick is a wall clock and the test would otherwise be
// slow + flaky. The bumpBackoff seam is exposed for this exact
// purpose.
func TestIMAPPollerExponentialBackoff(t *testing.T) {
	p := comm.NewIMAPPollerForTest(nil, 0, time.Minute)
	if got := p.Backoff(); got != 0 {
		t.Fatalf("initial backoff=%v, want 0", got)
	}
	p.BumpBackoffForTest()
	first := p.Backoff()
	if first <= 0 {
		t.Fatalf("first bump = %v, want positive", first)
	}
	p.BumpBackoffForTest()
	second := p.Backoff()
	if second != first*2 {
		t.Errorf("second bump = %v, want %v (doubled)", second, first*2)
	}
	// Drive ten more bumps; each one doubles until clamping to the
	// 10-minute ceiling.
	for i := 0; i < 10; i++ {
		p.BumpBackoffForTest()
	}
	if got := p.Backoff(); got != 10*time.Minute {
		t.Errorf("clamped backoff = %v, want 10m", got)
	}
}

// TestIMAPPollerFetchErrorReturned confirms a transient fetch error
// surfaces from RunOnce so the run loop can apply backoff. We don't
// assert backoff math here — that's covered by the dedicated test
// above — only that the error escapes.
func TestIMAPPollerFetchErrorReturned(t *testing.T) {
	f := setupAdmin(t, "kitp_test_imap_fetch_err")
	channelID := seedChannelForIMAP(t, f, "kitp@example.com", 0)

	stub := &stubIMAPClient{fetchErr: errors.New("transient: i/o timeout")}
	p := comm.NewIMAPPollerForTest(f.sp, channelID, 5*time.Second)
	p.SetDialFunc(func(ctx context.Context, _ comm.IMAPConfig) (comm.InboundClient, error) {
		return stub, nil
	})
	if err := p.RunOnce(context.Background()); err == nil {
		t.Fatal("expected error from RunOnce when FetchUnseen fails")
	}
}

// TestIMAPPollerAuthFailLogged confirms a dial failure (e.g. auth
// failure) writes a comm_log kind='imap_auth_fail' row + surfaces the
// error.
func TestIMAPPollerAuthFailLogged(t *testing.T) {
	f := setupAdmin(t, "kitp_test_imap_auth_fail")
	channelID := seedChannelForIMAP(t, f, "kitp@example.com", 0)

	p := comm.NewIMAPPollerForTest(f.sp, channelID, 5*time.Second)
	p.SetDialFunc(func(ctx context.Context, _ comm.IMAPConfig) (comm.InboundClient, error) {
		return nil, errors.New("auth: invalid credentials")
	})
	if err := p.RunOnce(context.Background()); err == nil {
		t.Fatal("expected error from RunOnce when dial fails")
	}

	// Check comm_log for an imap_auth_fail row.
	var kinds []string
	rows, err := f.sp.P.Query(context.Background(), `
		SELECT kind FROM comm_log WHERE channel_id=$1
	`, channelID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			t.Fatal(err)
		}
		kinds = append(kinds, k)
	}
	found := false
	for _, k := range kinds {
		if k == "imap_auth_fail" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected imap_auth_fail in comm_log kinds %v", kinds)
	}
}

// TestIMAPPollerPollLogged confirms every successful RunOnce writes
// a comm_log kind='poll' row recording the message count. Operators
// rely on this for liveness monitoring.
func TestIMAPPollerPollLogged(t *testing.T) {
	f := setupAdmin(t, "kitp_test_imap_poll_log")
	channelID := seedChannelForIMAP(t, f, "kitp@example.com", 0)

	stub := &stubIMAPClient{} // empty inbox
	p := comm.NewIMAPPollerForTest(f.sp, channelID, 5*time.Second)
	p.SetDialFunc(func(ctx context.Context, _ comm.IMAPConfig) (comm.InboundClient, error) {
		return stub, nil
	})
	if err := p.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	kind, _ := logKindOf(t, f, channelID)
	if kind != "poll" {
		t.Errorf("comm_log latest kind=%q want poll", kind)
	}
}
