// Package comm — SMTP sender goroutine (Gate 5 of email_comm_spec.md).
//
// One SMTPSender goroutine runs per comm_channel card. On every tick
// (default 10s; tunable via KITP_COMM_SMTP_TICK_SEC) the sender scans
// for reply_body cards with delivery_status='pending' that belong to a
// comm whose channel_ref matches this sender. For each:
//
//   1. Build a plain-text MIME message (From, To, Subject with
//      [#<thread_id>] suffix, X-Kitp-Thread-Id header, body, Ref:
//      trailer).
//   2. Decrypt the channel's SMTP password from comm_secret.
//   3. Connect with STARTTLS (port 587) or implicit TLS (port 465).
//   4. On success: flip delivery_status to 'sent', log comm_log
//      kind='send_ok'.
//   5. On a 5xx response: flip delivery_status to 'bounced', log
//      kind='send_bounce'.
//   6. On any other error: flip delivery_status to 'failed', log
//      kind='send_fail'.
//
// Tests in smtp_test.go drive RunOnce against an in-process SMTP
// listener that records MAIL FROM / RCPT TO / DATA and replays
// deterministic responses.
//
// KITP_COMM_SMTP_DRY_RUN=1 short-circuits the network transport: the
// sender logs the would-be message and records delivery_status='sent'
// without opening a socket. Useful for local dev / smoke tests.
package comm

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/smtp"
	"net/textproto"
	"os"
	"strings"
	"time"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

// SMTPSender owns the per-channel poll loop. Construct with
// StartSMTPSender; the returned value's Stop() drains the goroutine
// cleanly. RunOnce is exported so tests can drive one iteration
// synchronously without waiting on the ticker.
type SMTPSender struct {
	pool      *store.Pool
	channelID int64
	tick      time.Duration
	dryRun    bool
	logger    *slog.Logger
	// transport is the function the loop calls to actually ship a
	// message. Tests swap it for a recording stub; production sets it
	// to sendSMTP. Nil = use the default (sendSMTP, or a no-op in
	// dry-run mode).
	transport SMTPTransport
	stop      chan struct{}
	done      chan struct{}
}

// SMTPTransport is the seam between the queue scanner and the wire.
// host:port + auth username/password + the raw RFC822 bytes. Returns
// nil on success, *SMTPBounceError when the server replied with a
// 5xx code (permanent), or any other error for transient failure.
type SMTPTransport func(ctx context.Context, host string, port int, username, password, from, to string, msg []byte) error

// SMTPBounceError wraps a permanent 5xx SMTP failure. delivery_status
// flips to 'bounced' on this error; anything else flips to 'failed'.
type SMTPBounceError struct {
	Code int
	Msg  string
}

// Error implements error.
func (e *SMTPBounceError) Error() string {
	return fmt.Sprintf("smtp bounce %d: %s", e.Code, e.Msg)
}

// StartSMTPSender spawns the poll goroutine for one channel. tick is
// the poll cadence (clamped to >=1s; production defaults to 10s). The
// returned sender is ready immediately; the first scan fires on the
// first ticker tick. Call Stop() to drain.
func StartSMTPSender(pool *store.Pool, channelID int64, tick time.Duration) *SMTPSender {
	s := newSMTPSender(pool, channelID, tick)
	go s.run()
	return s
}

// NewSMTPSenderForTest builds an unstarted SMTPSender so tests can
// drive RunOnce synchronously. Production callers go through
// StartSMTPSender. Exported because the test lives in the comm_test
// package (external) — see smtp_test.go.
func NewSMTPSenderForTest(pool *store.Pool, channelID int64, tick time.Duration) *SMTPSender {
	return newSMTPSender(pool, channelID, tick)
}

// BuildMIMEForTest exposes the MIME builder so external tests can
// assert idempotency / formatting without round-tripping a full
// reply_body card. Internal callers (processOne) use buildMIME
// directly.
func BuildMIMEForTest(from, to, subject, body, threadID string) []byte {
	return buildMIME(from, to, subject, body, threadID)
}

// newSMTPSender builds the struct without starting the goroutine.
// Tests use this so they can call RunOnce directly.
func newSMTPSender(pool *store.Pool, channelID int64, tick time.Duration) *SMTPSender {
	if tick < time.Second {
		tick = time.Second
	}
	s := &SMTPSender{
		pool:      pool,
		channelID: channelID,
		tick:      tick,
		dryRun:    os.Getenv("KITP_COMM_SMTP_DRY_RUN") == "1",
		logger:    slog.Default(),
		stop:      make(chan struct{}),
		done:      make(chan struct{}),
	}
	s.transport = sendSMTP
	return s
}

// SetLogger lets the registrar override the default slog.Default()
// logger. Useful for the main process where obs.NewLogger emits JSON.
func (s *SMTPSender) SetLogger(l *slog.Logger) {
	if l != nil {
		s.logger = l
	}
}

// SetTransport swaps the SMTP transport. Tests inject a recording
// stub here; production leaves it alone (sendSMTP is the default).
func (s *SMTPSender) SetTransport(t SMTPTransport) {
	if t != nil {
		s.transport = t
	}
}

// Stop signals the goroutine to exit and waits for it to drain. Safe
// to call multiple times — additional calls block on the same done
// channel.
func (s *SMTPSender) Stop() {
	select {
	case <-s.stop:
		// already stopped
	default:
		close(s.stop)
	}
	<-s.done
}

func (s *SMTPSender) run() {
	defer close(s.done)
	t := time.NewTicker(s.tick)
	defer t.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-t.C:
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			// All SMTP traffic runs under the System actor — the sender
			// is a backend worker, not a user-driven request. Logging
			// + delivery_status flips reference SystemUserID via
			// auth.ActorOrSystem inside RunOnce.
			ctx = auth.WithSystemUser(ctx)
			if err := s.RunOnce(ctx); err != nil {
				s.logger.LogAttrs(ctx, slog.LevelError, "smtp sender RunOnce",
					slog.Int64("channel_id", s.channelID),
					slog.String("err", err.Error()))
			}
			cancel()
		}
	}
}

// pendingReply is the read-side row materialised before we build the
// MIME message + connect to SMTP. We keep all the data we need on the
// struct so the per-reply transaction is short (a couple of UPDATEs)
// and never overlaps the network call.
type pendingReply struct {
	replyID     int64
	commID      int64
	channelID   int64
	projectID   int64
	threadID    string
	to          string
	from        string
	subject     string
	body        string
	smtpHost    string
	smtpPort    int
	smtpUser    string
	smtpPass    string
	fromAddress string
}

// RunOnce executes one scan + send cycle synchronously. Exported so
// tests can drive the loop without waiting on the ticker. Returns the
// first transport / SQL error encountered, but only after attempting
// every pending row.
//
// Concurrency note: we open one short tx to read the queue, then per
// row we open a *separate* tx after the SMTP call completes so the
// network round-trip never holds an in-progress write transaction
// open. (Postgres connections in this pool are otherwise idle during
// network I/O.)
func (s *SMTPSender) RunOnce(ctx context.Context) error {
	rows, err := s.loadPending(ctx, 10)
	if err != nil {
		return fmt.Errorf("smtp sender: load pending: %w", err)
	}
	var firstErr error
	for _, r := range rows {
		if err := s.processOne(ctx, r); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// processOne handles a single pending reply: builds the MIME, attempts
// the send, updates the delivery_status, writes a comm_log entry. All
// state mutations happen in a single dedicated tx after the network
// call returns.
func (s *SMTPSender) processOne(ctx context.Context, r pendingReply) error {
	msg := buildMIME(r.from, r.to, r.subject, r.body, r.threadID)

	var sendErr error
	if s.dryRun {
		s.logger.LogAttrs(ctx, slog.LevelInfo, "smtp dry-run",
			slog.Int64("reply_id", r.replyID),
			slog.Int64("channel_id", r.channelID),
			slog.String("to", r.to),
			slog.Int("message_bytes", len(msg)))
	} else {
		sendErr = s.transport(ctx, r.smtpHost, r.smtpPort, r.smtpUser, r.smtpPass, r.from, r.to, msg)
	}

	newStatus, logKind, detail := classifySendResult(sendErr, r.to)
	if err := s.recordResult(ctx, r, newStatus, logKind, detail); err != nil {
		return fmt.Errorf("smtp sender: record result for reply %d: %w", r.replyID, err)
	}
	return sendErr
}

// classifySendResult maps the transport's error into a new
// delivery_status, the matching comm_log kind, and the structured
// detail payload. nil → sent / send_ok; *SMTPBounceError → bounced /
// send_bounce; anything else → failed / send_fail.
func classifySendResult(sendErr error, recipient string) (string, string, map[string]any) {
	if sendErr == nil {
		return "sent", "send_ok", map[string]any{"recipient": recipient}
	}
	var be *SMTPBounceError
	if errors.As(sendErr, &be) {
		return "bounced", "send_bounce", map[string]any{
			"recipient": recipient,
			"error":     be.Msg,
			"smtp_code": be.Code,
		}
	}
	return "failed", "send_fail", map[string]any{
		"recipient": recipient,
		"error":     sendErr.Error(),
	}
}

// loadPending scans up to `limit` pending reply_body rows whose comm's
// channel_ref equals this sender's channelID, returning the full row
// we need to ship the MIME + record the result. The SMTP password
// comes back decrypted via pgp_sym_decrypt(comm_secret.smtp_password,
// current_setting('app.comm_secret_key')).
//
// One SELECT joins attribute_value many times (each lookup is a cheap
// PK seek); the project_id comes from the channel's parent_card_id
// directly because comm_channel cards are always direct children of
// a project per the seed schema. Keeps the queue scan at one round-
// trip per tick regardless of pending depth.
func (s *SMTPSender) loadPending(ctx context.Context, limit int) ([]pendingReply, error) {
	q := `
		SELECT
			rb.id                                                                                                                                                       AS reply_id,
			cm.id                                                                                                                                                       AS comm_id,
			ch.id                                                                                                                                                       AS channel_id,
			COALESCE(ch.parent_card_id, 0)                                                                                                                              AS project_id,
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = rb.id AND ad.name='reply_to'), '')        AS reply_to,
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = rb.id AND ad.name='reply_from'), '')      AS reply_from,
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = rb.id AND ad.name='reply_subject'), '')   AS reply_subject,
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = rb.id AND ad.name='reply_body_text'), '') AS reply_body,
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = cm.id AND ad.name='thread_id'), '')       AS thread_id,
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = ch.id AND ad.name='smtp_host'), '')       AS smtp_host,
			COALESCE((SELECT (value)::text::int FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = ch.id AND ad.name='smtp_port' AND jsonb_typeof(value)='number'), 0) AS smtp_port,
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = ch.id AND ad.name='smtp_username'), '')   AS smtp_username,
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = ch.id AND ad.name='from_address'), '')    AS from_address,
			COALESCE(
				(SELECT pgp_sym_decrypt(cs.smtp_password, current_setting('app.comm_secret_key'))
					FROM comm_secret cs WHERE cs.channel_card_id = ch.id AND cs.smtp_password IS NOT NULL),
				''
			) AS smtp_password
		FROM card rb
		JOIN card_type ct_rb ON ct_rb.id = rb.card_type_id AND ct_rb.name = 'reply_body'
		JOIN attribute_value status_av ON status_av.card_id = rb.id
			AND status_av.attribute_def_id = (SELECT id FROM attribute_def WHERE name='delivery_status')
			AND status_av.value = to_jsonb('pending'::text)
		-- locate the comm whose 'replies' attribute_value lists rb.id
		JOIN attribute_value rep_av ON rep_av.attribute_def_id = (SELECT id FROM attribute_def WHERE name='replies')
			AND rep_av.value @> to_jsonb(rb.id)
		JOIN card cm ON cm.id = rep_av.card_id
		JOIN card_type ct_cm ON ct_cm.id = cm.card_type_id AND ct_cm.name = 'comm'
		-- channel_ref → comm_channel card
		JOIN attribute_value cref_av ON cref_av.card_id = cm.id
			AND cref_av.attribute_def_id = (SELECT id FROM attribute_def WHERE name='channel_ref')
		JOIN card ch ON ch.id = (cref_av.value)::text::bigint
		WHERE rb.deleted_at IS NULL
		  AND cm.deleted_at IS NULL
		  AND ch.deleted_at IS NULL
		  AND ch.id = $1
		ORDER BY rb.id
		LIMIT $2
	`
	pgRows, err := s.pool.P.Query(ctx, q, s.channelID, limit)
	if err != nil {
		return nil, err
	}
	defer pgRows.Close()
	var out []pendingReply
	for pgRows.Next() {
		var r pendingReply
		if err := pgRows.Scan(
			&r.replyID, &r.commID, &r.channelID, &r.projectID,
			&r.to, &r.from, &r.subject, &r.body,
			&r.threadID,
			&r.smtpHost, &r.smtpPort, &r.smtpUser, &r.fromAddress,
			&r.smtpPass,
		); err != nil {
			return nil, err
		}
		// If the reply has no explicit from but the channel does, fall
		// back to the channel's from_address so the wire envelope is
		// always populated.
		if r.from == "" {
			r.from = r.fromAddress
		}
		out = append(out, r)
	}
	if err := pgRows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// recordResult flips delivery_status and inserts the matching
// comm_log row in one transaction. The attribute write goes through
// the package's writeAttributeValue helper so the activity row is
// shaped identically to every other attribute_update in kitp.
func (s *SMTPSender) recordResult(ctx context.Context, r pendingReply, newStatus, logKind string, detail map[string]any) error {
	actorID := auth.ActorOrSystem(ctx)
	tx, err := s.pool.BeginTx(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	snap, err := schema.Load(ctx, tx)
	if err != nil {
		return fmt.Errorf("load schema: %w", err)
	}
	deliveryStatusAD, err := resolveAttr(snap, "delivery_status")
	if err != nil {
		return err
	}
	statusJSON, err := json.Marshal(newStatus)
	if err != nil {
		return err
	}
	if err := writeAttributeValue(ctx, tx, r.replyID, deliveryStatusAD, statusJSON, actorID); err != nil {
		return fmt.Errorf("delivery_status: %w", err)
	}

	detailJSON, err := json.Marshal(detail)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO comm_log (project_id, channel_id, kind, detail)
		VALUES ($1, $2, $3, $4::jsonb)
	`, r.projectID, r.channelID, logKind, detailJSON); err != nil {
		return fmt.Errorf("comm_log: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	if s.pool != nil {
		s.pool.NoteWrite()
	}
	return nil
}

// ---- MIME ----

// buildMIME assembles the plain-text RFC822 message we hand to the
// SMTP server. The subject's [#<thread_id>] suffix is appended only
// when the caller didn't already include it (idempotency for users
// who hand-edit the draft). The X-Kitp-Thread-Id header + body
// trailer 'Ref:' line are always added — Gate 6's inbound parser
// looks for any of the three.
//
// We deliberately use \r\n line endings (SMTP convention; required by
// the wire protocol) and emit a single Content-Type header for
// plain-text UTF-8. Quoted-printable / multipart MIME is out of scope
// for v1 (the spec calls out "plain text only").
func buildMIME(from, to, subject, body, threadID string) []byte {
	suffix := "[#" + threadID + "]"
	subjectFinal := subject
	switch {
	case strings.Contains(subjectFinal, suffix):
		// already threaded; leave alone
	case subjectFinal == "":
		subjectFinal = suffix
	default:
		subjectFinal = subjectFinal + " " + suffix
	}
	// Normalise the body's line endings to CRLF (SMTP wire convention)
	// and strip trailing whitespace so the Ref: trailer sits on its
	// own line.
	bodyNorm := strings.TrimRight(body, "\r\n")
	bodyNorm = strings.ReplaceAll(bodyNorm, "\r\n", "\n")
	bodyNorm = strings.ReplaceAll(bodyNorm, "\n", "\r\n")

	var b strings.Builder
	fmt.Fprintf(&b, "From: %s\r\n", from)
	fmt.Fprintf(&b, "To: %s\r\n", to)
	fmt.Fprintf(&b, "Subject: %s\r\n", subjectFinal)
	fmt.Fprintf(&b, "X-Kitp-Thread-Id: %s\r\n", threadID)
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
	b.WriteString("\r\n") // header / body separator
	b.WriteString(bodyNorm)
	fmt.Fprintf(&b, "\r\n\r\nRef: %s\r\n", threadID)
	return []byte(b.String())
}

// ---- transport ----

// sendSMTP is the production SMTP transport. Port 465 uses implicit
// TLS (the connection is encrypted before the SMTP handshake); every
// other port uses STARTTLS upgrade (port 587 is the standard
// submission port for that flow). Both paths AUTH with the supplied
// username/password using PLAIN over the encrypted channel.
//
// Tests substitute a recording stub via SMTPSender.SetTransport.
func sendSMTP(ctx context.Context, host string, port int, username, password, from, to string, msg []byte) error {
	addr := net.JoinHostPort(host, fmt.Sprintf("%d", port))
	d := net.Dialer{Timeout: 15 * time.Second}
	rawConn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return fmt.Errorf("smtp dial %s: %w", addr, err)
	}
	// We hand the live conn to net/smtp via NewClient; smtp.Client
	// closes the underlying conn on Quit/Close.
	var client *smtp.Client
	if port == 465 {
		tlsConn := tls.Client(rawConn, &tls.Config{ServerName: host})
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			_ = rawConn.Close()
			return fmt.Errorf("smtp tls handshake: %w", err)
		}
		client, err = smtp.NewClient(tlsConn, host)
	} else {
		client, err = smtp.NewClient(rawConn, host)
	}
	if err != nil {
		_ = rawConn.Close()
		return fmt.Errorf("smtp NewClient: %w", err)
	}
	defer client.Close()

	if port != 465 {
		if ok, _ := client.Extension("STARTTLS"); ok {
			if err := client.StartTLS(&tls.Config{ServerName: host}); err != nil {
				return fmt.Errorf("smtp STARTTLS: %w", err)
			}
		}
	}
	if username != "" {
		// Local var named saslAuth to avoid shadowing the imported
		// `auth` package (kitp's user-auth surface).
		saslAuth := smtp.PlainAuth("", username, password, host)
		if err := client.Auth(saslAuth); err != nil {
			return wrapSMTPError(err, "smtp AUTH")
		}
	}
	if err := client.Mail(from); err != nil {
		return wrapSMTPError(err, "smtp MAIL FROM")
	}
	if err := client.Rcpt(to); err != nil {
		return wrapSMTPError(err, "smtp RCPT TO")
	}
	w, err := client.Data()
	if err != nil {
		return wrapSMTPError(err, "smtp DATA")
	}
	if _, err := w.Write(msg); err != nil {
		return fmt.Errorf("smtp write body: %w", err)
	}
	if err := w.Close(); err != nil {
		return wrapSMTPError(err, "smtp DATA end")
	}
	if err := client.Quit(); err != nil {
		// Quit failures are noisy; the message has already been
		// accepted at this point so swallow the error rather than
		// flipping the row to 'failed'.
		_ = err
	}
	return nil
}

// wrapSMTPError converts net/smtp's *textproto.Error (5xx vs 4xx)
// into a *SMTPBounceError so the caller can choose 'bounced' vs
// 'failed'. Any non-textproto error stays untouched (transient
// network failures, timeouts, etc.). net/smtp uses textproto.Error
// for every protocol-level response, so the errors.As assertion
// catches both AUTH and RCPT/MAIL bounces uniformly.
func wrapSMTPError(err error, op string) error {
	var tp *textproto.Error
	if errors.As(err, &tp) && tp.Code >= 500 && tp.Code < 600 {
		return &SMTPBounceError{Code: tp.Code, Msg: tp.Msg}
	}
	return fmt.Errorf("%s: %w", op, err)
}

// ---- startup helpers ----

// ListChannelIDs returns every comm_channel card id currently
// configured in the install. main.go calls this at startup to spawn
// one SMTPSender per channel. Adding a new channel currently requires
// a kitpd restart; auto-detect is a follow-up gate.
func ListChannelIDs(ctx context.Context, pool *store.Pool) ([]int64, error) {
	rows, err := pool.P.Query(ctx, `
		SELECT c.id
		FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id
		WHERE ct.name = 'comm_channel' AND c.deleted_at IS NULL
		ORDER BY c.id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// StartSMTPSenderPool spawns one SMTPSender per existing
// comm_channel card. Returns every sender so the caller can collect
// them for shutdown. Errors loading the channel list are returned
// directly; per-channel goroutines never fail-fast (they log errors
// and retry on the next tick).
func StartSMTPSenderPool(ctx context.Context, pool *store.Pool, tick time.Duration, logger *slog.Logger) ([]*SMTPSender, error) {
	ids, err := ListChannelIDs(ctx, pool)
	if err != nil {
		return nil, fmt.Errorf("smtp sender pool: %w", err)
	}
	out := make([]*SMTPSender, 0, len(ids))
	for _, id := range ids {
		s := StartSMTPSender(pool, id, tick)
		s.SetLogger(logger)
		out = append(out, s)
	}
	return out, nil
}
