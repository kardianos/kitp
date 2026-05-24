package comm_test

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/dom/comm"
)

// mockSMTPServer is a minimal in-process SMTP listener used by Gate
// 5's tests. It accepts a connection, walks through HELO / MAIL FROM
// / RCPT TO / DATA / QUIT, records each piece, and replays a
// configurable script of response codes.
//
// The server is intentionally tiny: no STARTTLS, no AUTH (the
// production transport handles those; tests inject a stub via
// SMTPSender.SetTransport so they never hit this path through
// smtp.NewClient — see usage below).
type recordedMessage struct {
	From    string
	To      []string
	Data    []byte
	Headers map[string]string
}

type mockSMTPServer struct {
	t          *testing.T
	ln         net.Listener
	stop       chan struct{}
	done       chan struct{}
	mu         sync.Mutex
	received   []recordedMessage
	dataResult string // e.g. "250 OK", "550 mailbox unavailable"
	disconnect bool   // if true, hang up before sending the response
}

func startMockSMTP(t *testing.T) *mockSMTPServer {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	srv := &mockSMTPServer{
		t:          t,
		ln:         ln,
		stop:       make(chan struct{}),
		done:       make(chan struct{}),
		dataResult: "250 OK",
	}
	go srv.serve()
	t.Cleanup(srv.close)
	return srv
}

func (m *mockSMTPServer) addr() string { return m.ln.Addr().String() }

func (m *mockSMTPServer) close() {
	select {
	case <-m.stop:
	default:
		close(m.stop)
	}
	_ = m.ln.Close()
	select {
	case <-m.done:
	case <-time.After(2 * time.Second):
		m.t.Log("mock smtp shutdown timeout")
	}
}

func (m *mockSMTPServer) serve() {
	defer close(m.done)
	for {
		conn, err := m.ln.Accept()
		if err != nil {
			return
		}
		go m.handle(conn)
	}
}

// handle walks one SMTP session. Tests only need MAIL FROM / RCPT TO
// / DATA / QUIT; we accept anything else with a 250 response.
func (m *mockSMTPServer) handle(conn net.Conn) {
	defer conn.Close()
	br := bufio.NewReader(conn)
	w := bufio.NewWriter(conn)
	writeLine := func(s string) {
		_, _ = w.WriteString(s + "\r\n")
		_ = w.Flush()
	}
	writeLine("220 mock.local ESMTP ready")

	msg := recordedMessage{Headers: map[string]string{}}
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			return
		}
		line = strings.TrimRight(line, "\r\n")
		up := strings.ToUpper(line)
		switch {
		case strings.HasPrefix(up, "EHLO"), strings.HasPrefix(up, "HELO"):
			writeLine("250-mock.local hi")
			writeLine("250 OK")
		case strings.HasPrefix(up, "MAIL FROM:"):
			msg.From = extractAddr(line)
			writeLine("250 OK")
		case strings.HasPrefix(up, "RCPT TO:"):
			msg.To = append(msg.To, extractAddr(line))
			writeLine("250 OK")
		case strings.HasPrefix(up, "DATA"):
			writeLine("354 send away")
			var data []byte
			for {
				bline, err := br.ReadString('\n')
				if err != nil {
					return
				}
				if bline == ".\r\n" || bline == ".\n" {
					break
				}
				data = append(data, bline...)
			}
			msg.Data = data
			msg.Headers = parseHeaders(data)
			if m.disconnect {
				return
			}
			writeLine(m.dataResult)
			if strings.HasPrefix(m.dataResult, "5") {
				// Permanent bounce — record nothing on the server's
				// "successfully received" list; let the client drive
				// its own status update.
				continue
			}
			m.mu.Lock()
			m.received = append(m.received, msg)
			m.mu.Unlock()
			msg = recordedMessage{Headers: map[string]string{}}
		case strings.HasPrefix(up, "QUIT"):
			writeLine("221 bye")
			return
		case strings.HasPrefix(up, "NOOP"), strings.HasPrefix(up, "RSET"):
			writeLine("250 OK")
		default:
			writeLine("250 OK")
		}
	}
}

func (m *mockSMTPServer) messages() []recordedMessage {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]recordedMessage, len(m.received))
	copy(out, m.received)
	return out
}

func extractAddr(line string) string {
	if i := strings.Index(line, "<"); i >= 0 {
		if j := strings.Index(line[i:], ">"); j > 0 {
			return line[i+1 : i+j]
		}
	}
	if i := strings.Index(line, ":"); i >= 0 {
		return strings.TrimSpace(line[i+1:])
	}
	return ""
}

func parseHeaders(data []byte) map[string]string {
	out := map[string]string{}
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			return out // headers terminated by blank line
		}
		idx := strings.Index(line, ":")
		if idx <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:idx])
		val := strings.TrimSpace(line[idx+1:])
		out[key] = val
	}
	return out
}

// ---- helpers ----

// recordingTransport is the canonical test SMTP transport. It records
// every call and replays a configurable result + per-call error.
type recordingTransport struct {
	mu       sync.Mutex
	calls    []recordedCall
	results  []error // pop one per call; nil = success
	errIndex int
}

type recordedCall struct {
	host     string
	port     int
	username string
	password string
	from     string
	to       string
	msg      []byte
}

func (rt *recordingTransport) fn(ctx context.Context, host string, port int, username, password, from, to string, msg []byte) error {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	rt.calls = append(rt.calls, recordedCall{
		host: host, port: port, username: username, password: password,
		from: from, to: to, msg: append([]byte{}, msg...),
	})
	if rt.errIndex < len(rt.results) {
		err := rt.results[rt.errIndex]
		rt.errIndex++
		return err
	}
	return nil
}

// seedPendingReply seeds a channel + comm + reply_body row in pending
// state under the fixture's task. Returns the channel and reply ids.
// Auto-seeds alice@example.com as the comm's recipient so reply.post
// can resolve the To: list.
func seedPendingReply(t *testing.T, f *fixture, fromAddress string) (channelID, replyID int64) {
	t.Helper()
	return seedPendingReplyWithRecipients(t, f, fromAddress, []string{"alice@example.com"})
}

// seedPendingReplyWithRecipients is the explicit variant used by tests
// that need a specific recipient set (e.g. multi-recipient SMTP RCPT
// expansion).
func seedPendingReplyWithRecipients(t *testing.T, f *fixture, fromAddress string, recipientEmails []string) (channelID, replyID int64) {
	t.Helper()
	body := fmt.Sprintf(`{"project_id":"%d","name":"Support","channel_type":"email","smtp_host":"127.0.0.1","smtp_port":587,"smtp_username":"u","smtp_password":"p"`, f.projectID)
	if fromAddress != "" {
		body += fmt.Sprintf(`,"from_address":%q`, fromAddress)
	}
	body += `}`
	var setOut comm.ChannelSetOutput
	dispatch(t, f, api.SubRequest{
		ID: "ch", Endpoint: "comm_channel", Action: "set", Data: json.RawMessage(body),
	}, &setOut)

	// Resolve each recipient email to a person id, then create the
	// comm with that initial recipient set.
	idsJSON := "["
	for i, email := range recipientEmails {
		var pOut comm.PersonUpsertByEmailOutput
		dispatch(t, f, api.SubRequest{
			ID: fmt.Sprintf("p%d", i), Endpoint: "person", Action: "upsert_by_email",
			Data: json.RawMessage(fmt.Sprintf(`{"email":%q,"kind":"contact"}`, email)),
		}, &pOut)
		if i > 0 {
			idsJSON += ","
		}
		idsJSON += fmt.Sprintf(`"%d"`, pOut.PersonID)
	}
	idsJSON += "]"

	var ccOut comm.CommCreateOutput
	dispatch(t, f, api.SubRequest{
		ID: "c", Endpoint: "comm", Action: "create", Data: json.RawMessage(
			fmt.Sprintf(`{"task_id":"%d","channel_id":"%d","subject":"Bug report","recipient_person_ids":%s}`,
				f.taskID, setOut.ChannelID, idsJSON)),
	}, &ccOut)
	var rpOut comm.ReplyPostOutput
	dispatch(t, f, api.SubRequest{
		ID: "r", Endpoint: "reply", Action: "post", Data: json.RawMessage(
			fmt.Sprintf(`{"comm_id":"%d","body":"The body text."}`, ccOut.CommID)),
	}, &rpOut)
	return setOut.ChannelID, rpOut.ReplyID
}

// statusOf returns the delivery_status attribute_value for a
// reply_body card. Used by every assertion below.
func statusOf(t *testing.T, f *fixture, replyID int64) string {
	t.Helper()
	var status string
	if err := f.sp.P.QueryRow(context.Background(), `
		SELECT COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1 AND ad.name='delivery_status'),'')
	`, replyID).Scan(&status); err != nil {
		t.Fatalf("read delivery_status: %v", err)
	}
	return status
}

// logKindOf returns the comm_log kind matching channel + recipient,
// or "" when no row exists. We restrict by channel id so cross-test
// schemas remain isolated.
func logKindOf(t *testing.T, f *fixture, channelID int64) (string, json.RawMessage) {
	t.Helper()
	var kind string
	var detail []byte
	err := f.sp.P.QueryRow(context.Background(), `
		SELECT kind, COALESCE(detail::text, '{}')::jsonb
		FROM comm_log WHERE channel_id=$1 ORDER BY at DESC, id DESC LIMIT 1
	`, channelID).Scan(&kind, &detail)
	if err != nil {
		return "", nil
	}
	return kind, json.RawMessage(detail)
}

// ---- tests ----

func TestSMTPSenderSendsPending(t *testing.T) {
	f := setupAdmin(t, "kitp_test_smtp_sends")
	channelID, replyID := seedPendingReply(t, f, "kitp@example.com")

	rt := &recordingTransport{}
	s := comm.NewSMTPSenderForTest(f.sp, channelID, time.Second)
	s.SetTransport(rt.fn)
	if err := s.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	if len(rt.calls) != 1 {
		t.Fatalf("expected 1 send, got %d", len(rt.calls))
	}
	call := rt.calls[0]
	if call.host != "127.0.0.1" || call.port != 587 {
		t.Errorf("host/port = %s:%d, want 127.0.0.1:587", call.host, call.port)
	}
	if call.username != "u" || call.password != "p" {
		t.Errorf("auth = %s/%s, want u/p", call.username, call.password)
	}
	if call.from != "kitp@example.com" || call.to != "alice@example.com" {
		t.Errorf("envelope = %s -> %s", call.from, call.to)
	}

	if got := statusOf(t, f, replyID); got != "sent" {
		t.Errorf("delivery_status=%q want sent", got)
	}
	kind, detail := logKindOf(t, f, channelID)
	if kind != "send_ok" {
		t.Errorf("comm_log.kind=%q want send_ok", kind)
	}
	var d map[string]any
	_ = json.Unmarshal(detail, &d)
	if d["recipient"] != "alice@example.com" {
		t.Errorf("detail.recipient=%v want alice@example.com", d["recipient"])
	}
}

func TestSMTPSenderMIMEHeaders(t *testing.T) {
	f := setupAdmin(t, "kitp_test_smtp_mime")
	channelID, _ := seedPendingReply(t, f, "kitp@example.com")

	// Resolve the comm's thread id so we can confirm the suffix is
	// the SAME value the sender sees.
	var threadID string
	if err := f.sp.P.QueryRow(context.Background(), `
		SELECT av.value #>> '{}' FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		JOIN card c ON c.id = av.card_id
		JOIN card_type ct ON ct.id = c.card_type_id
		WHERE ct.name='comm' AND ad.name='thread_id'
		ORDER BY c.id DESC LIMIT 1
	`).Scan(&threadID); err != nil {
		t.Fatalf("resolve thread_id: %v", err)
	}

	rt := &recordingTransport{}
	s := comm.NewSMTPSenderForTest(f.sp, channelID, time.Second)
	s.SetTransport(rt.fn)
	if err := s.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if len(rt.calls) != 1 {
		t.Fatalf("expected 1 send, got %d", len(rt.calls))
	}
	msg := string(rt.calls[0].msg)
	t.Logf("MIME message:\n%s", msg)

	// Subject is now derived server-side as "{thread_id} {task.title}"
	// (see runReplyPost); the SMTP builder appends the threading suffix.
	wantSubject := "Subject: " + threadID + " Issue 1 [#" + threadID + "]"
	wantThreadHdr := "X-Kitp-Thread-Id: " + threadID
	wantRef := "Ref: " + threadID

	for _, w := range []string{
		"From: kitp@example.com",
		"To: alice@example.com",
		wantSubject,
		wantThreadHdr,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"The body text.",
		wantRef,
	} {
		if !strings.Contains(msg, w) {
			t.Errorf("missing %q in MIME:\n%s", w, msg)
		}
	}
	// CRLF line endings throughout.
	if strings.Contains(msg, "\n") && !strings.Contains(msg, "\r\n") {
		t.Errorf("MIME should use CRLF, got bare LF")
	}
}

func TestSMTPSenderBounce(t *testing.T) {
	f := setupAdmin(t, "kitp_test_smtp_bounce")
	channelID, replyID := seedPendingReply(t, f, "kitp@example.com")

	rt := &recordingTransport{
		results: []error{&comm.SMTPBounceError{Code: 550, Msg: "mailbox unavailable"}},
	}
	s := comm.NewSMTPSenderForTest(f.sp, channelID, time.Second)
	s.SetTransport(rt.fn)
	// RunOnce intentionally surfaces the first error so the loop can
	// log it; we expect that to be the bounce.
	if err := s.RunOnce(context.Background()); err == nil {
		t.Fatal("expected bounce error from RunOnce")
	}

	if got := statusOf(t, f, replyID); got != "bounced" {
		t.Errorf("delivery_status=%q want bounced", got)
	}
	kind, detail := logKindOf(t, f, channelID)
	if kind != "send_bounce" {
		t.Errorf("comm_log.kind=%q want send_bounce", kind)
	}
	var d map[string]any
	_ = json.Unmarshal(detail, &d)
	if d["smtp_code"] != float64(550) {
		t.Errorf("detail.smtp_code=%v want 550", d["smtp_code"])
	}
	if d["error"] != "mailbox unavailable" {
		t.Errorf("detail.error=%v want mailbox unavailable", d["error"])
	}
	if d["recipient"] != "alice@example.com" {
		t.Errorf("detail.recipient=%v", d["recipient"])
	}
}

func TestSMTPSenderFailure(t *testing.T) {
	f := setupAdmin(t, "kitp_test_smtp_failure")
	channelID, replyID := seedPendingReply(t, f, "kitp@example.com")

	rt := &recordingTransport{
		results: []error{io.ErrUnexpectedEOF},
	}
	s := comm.NewSMTPSenderForTest(f.sp, channelID, time.Second)
	s.SetTransport(rt.fn)
	if err := s.RunOnce(context.Background()); err == nil {
		t.Fatal("expected error from RunOnce")
	}
	if got := statusOf(t, f, replyID); got != "failed" {
		t.Errorf("delivery_status=%q want failed", got)
	}
	kind, detail := logKindOf(t, f, channelID)
	if kind != "send_fail" {
		t.Errorf("comm_log.kind=%q want send_fail", kind)
	}
	var d map[string]any
	_ = json.Unmarshal(detail, &d)
	if d["error"] != io.ErrUnexpectedEOF.Error() {
		t.Errorf("detail.error=%v want %q", d["error"], io.ErrUnexpectedEOF.Error())
	}
}

func TestSMTPSenderIgnoresOtherChannel(t *testing.T) {
	f := setupAdmin(t, "kitp_test_smtp_ignores_other")
	// Channel A + pending reply.
	channelA, replyA := seedPendingReply(t, f, "kitp@example.com")

	// Channel B (different) — make a second task so we can attach a
	// comm to it under channel B without sharing channel A's comm.
	var t2Out struct {
		ID int64 `json:"id,string"`
	}
	resp := f.srv.Dispatch(f.ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "t2", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"Issue 2","attributes":{"status":"%d"}}`,
				f.projectID, f.statusID))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("task 2: %+v", resp.Subresponses[0])
	}
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &t2Out)

	body := fmt.Sprintf(`{"project_id":"%d","name":"Other","channel_type":"email","smtp_host":"x","smtp_port":587,"from_address":"other@example.com"}`, f.projectID)
	var chB comm.ChannelSetOutput
	dispatch(t, f, api.SubRequest{
		ID: "chB", Endpoint: "comm_channel", Action: "set", Data: json.RawMessage(body),
	}, &chB)
	var pB comm.PersonUpsertByEmailOutput
	dispatch(t, f, api.SubRequest{
		ID: "pB", Endpoint: "person", Action: "upsert_by_email",
		Data: json.RawMessage(`{"email":"bob@example.com","kind":"contact"}`),
	}, &pB)
	var ccB comm.CommCreateOutput
	dispatch(t, f, api.SubRequest{
		ID: "ccB", Endpoint: "comm", Action: "create", Data: json.RawMessage(
			fmt.Sprintf(`{"task_id":"%d","channel_id":"%d","subject":"Other thread","recipient_person_ids":["%d"]}`,
				t2Out.ID, chB.ChannelID, pB.PersonID)),
	}, &ccB)
	var rpB comm.ReplyPostOutput
	dispatch(t, f, api.SubRequest{
		ID: "rB", Endpoint: "reply", Action: "post", Data: json.RawMessage(
			fmt.Sprintf(`{"comm_id":"%d","body":"hello"}`, ccB.CommID)),
	}, &rpB)

	// Run channel B's sender; channel A's pending row MUST stay pending.
	rt := &recordingTransport{}
	s := comm.NewSMTPSenderForTest(f.sp, chB.ChannelID, time.Second)
	s.SetTransport(rt.fn)
	if err := s.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if len(rt.calls) != 1 {
		t.Fatalf("expected 1 send for channel B, got %d", len(rt.calls))
	}
	if rt.calls[0].to != "bob@example.com" {
		t.Errorf("channel B sender hit the wrong reply: to=%s", rt.calls[0].to)
	}
	if got := statusOf(t, f, replyA); got != "pending" {
		t.Errorf("channel A reply status=%q, want pending (untouched by channel B)", got)
	}
	if got := statusOf(t, f, rpB.ReplyID); got != "sent" {
		t.Errorf("channel B reply status=%q want sent", got)
	}

	// Now run channel A — it should pick up its pending row.
	rtA := &recordingTransport{}
	sA := comm.NewSMTPSenderForTest(f.sp, channelA, time.Second)
	sA.SetTransport(rtA.fn)
	if err := sA.RunOnce(context.Background()); err != nil {
		t.Fatalf("channel A RunOnce: %v", err)
	}
	if len(rtA.calls) != 1 {
		t.Fatalf("expected 1 send for channel A, got %d", len(rtA.calls))
	}
	if got := statusOf(t, f, replyA); got != "sent" {
		t.Errorf("channel A reply status=%q want sent (after its own scan)", got)
	}
}

// TestSMTPSenderEndToEnd drives the sender against the in-process mock
// SMTP listener via the real net/smtp transport. Confirms the production
// path (sendSMTP) walks MAIL FROM / RCPT TO / DATA correctly and that
// the recorded headers match what buildMIME constructed.
func TestSMTPSenderEndToEnd(t *testing.T) {
	f := setupAdmin(t, "kitp_test_smtp_e2e")
	mock := startMockSMTP(t)

	// Resolve mock's host:port and seed a channel pointed at it. Use
	// port 25-equivalent (any non-465) so the production transport
	// tries STARTTLS optimistically but doesn't fail when the mock
	// advertises nothing — see sendSMTP's STARTTLS Extension check.
	host, portStr, err := net.SplitHostPort(mock.addr())
	if err != nil {
		t.Fatal(err)
	}
	var port int
	if _, err := fmt.Sscanf(portStr, "%d", &port); err != nil {
		t.Fatal(err)
	}
	// The mock listens on 127.0.0.1, which the SSRF dial guard (SEC-4 /
	// A9) blocks by default. Allowlist it — exactly how an operator
	// permits an internal relay — so the production sendSMTP path can
	// reach the local mock.
	t.Setenv("KITP_COMM_HOST_ALLOWLIST", host)

	body := fmt.Sprintf(`{"project_id":"%d","name":"E2E","channel_type":"email","smtp_host":%q,"smtp_port":%d,"from_address":"kitp@example.com"}`,
		f.projectID, host, port)
	var setOut comm.ChannelSetOutput
	dispatch(t, f, api.SubRequest{
		ID: "ch", Endpoint: "comm_channel", Action: "set", Data: json.RawMessage(body),
	}, &setOut)
	var pE comm.PersonUpsertByEmailOutput
	dispatch(t, f, api.SubRequest{
		ID: "pE", Endpoint: "person", Action: "upsert_by_email",
		Data: json.RawMessage(`{"email":"alice@example.com","kind":"contact"}`),
	}, &pE)
	var ccOut comm.CommCreateOutput
	dispatch(t, f, api.SubRequest{
		ID: "c", Endpoint: "comm", Action: "create", Data: json.RawMessage(
			fmt.Sprintf(`{"task_id":"%d","channel_id":"%d","subject":"E2E","recipient_person_ids":["%d"]}`,
				f.taskID, setOut.ChannelID, pE.PersonID)),
	}, &ccOut)
	var rpOut comm.ReplyPostOutput
	dispatch(t, f, api.SubRequest{
		ID: "r", Endpoint: "reply", Action: "post", Data: json.RawMessage(
			fmt.Sprintf(`{"comm_id":"%d","body":"end-to-end"}`, ccOut.CommID)),
	}, &rpOut)

	// Use the production transport (sendSMTP) — do NOT call SetTransport.
	s := comm.NewSMTPSenderForTest(f.sp, setOut.ChannelID, time.Second)
	if err := s.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	msgs := mock.messages()
	if len(msgs) != 1 {
		t.Fatalf("mock received %d messages, want 1", len(msgs))
	}
	m := msgs[0]
	if m.From != "kitp@example.com" {
		t.Errorf("MAIL FROM=%q", m.From)
	}
	if len(m.To) != 1 || m.To[0] != "alice@example.com" {
		t.Errorf("RCPT TO=%v", m.To)
	}
	if m.Headers["X-Kitp-Thread-Id"] == "" {
		t.Errorf("missing X-Kitp-Thread-Id header: %+v", m.Headers)
	}
	if !strings.Contains(m.Headers["Subject"], "[#") {
		t.Errorf("subject missing [#thread] suffix: %q", m.Headers["Subject"])
	}
	if got := statusOf(t, f, rpOut.ReplyID); got != "sent" {
		t.Errorf("delivery_status=%q want sent", got)
	}
	kind, _ := logKindOf(t, f, setOut.ChannelID)
	if kind != "send_ok" {
		t.Errorf("comm_log.kind=%q want send_ok", kind)
	}
}

// TestBuildMIMEIdempotentSubject confirms the [#<thread_id>] suffix
// is not appended twice if the operator already included it manually.
func TestBuildMIMEIdempotentSubject(t *testing.T) {
	msg := comm.BuildMIMEForTest("k@example.com", "a@example.com",
		"Re: Bug [#abc1234567]", "body", "abc1234567")
	s := string(msg)
	if strings.Count(s, "[#abc1234567]") != 1 {
		t.Errorf("expected exactly one [#abc1234567] occurrence, got %d in:\n%s",
			strings.Count(s, "[#abc1234567]"), s)
	}
}

// TestBuildMIMEEmptySubject ensures we still emit a subject containing
// the thread id when the operator's draft was blank.
func TestBuildMIMEEmptySubject(t *testing.T) {
	msg := comm.BuildMIMEForTest("k@example.com", "a@example.com", "",
		"body", "zzz1234567")
	if !strings.Contains(string(msg), "Subject: [#zzz1234567]") {
		t.Errorf("missing fallback subject in:\n%s", msg)
	}
}
