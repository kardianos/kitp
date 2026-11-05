// Package comm — SMTP sender goroutine (Gate 5 of email_comm_spec.md).
//
// One SMTPSender goroutine runs per comm_channel card. On every tick
// (default 10s; tunable via KITP_COMM_SMTP_TICK_SEC) the sender scans
// for reply_body cards with delivery_status='pending' that belong to a
// comm whose channel_ref matches this sender. For each:
//
//  1. Build a plain-text MIME message (From, To, Subject with
//     [#<thread_id>] suffix, X-Kitp-Thread-Id header, body, Ref:
//     trailer).
//  2. Decrypt the channel's SMTP password from comm_secret.
//  3. Connect with STARTTLS (port 587) or implicit TLS (port 465).
//  4. On success: flip delivery_status to 'sent', log comm_log
//     kind='send_ok'.
//  5. On a 5xx response: flip delivery_status to 'bounced', log
//     kind='send_bounce'.
//  6. On any other error: flip delivery_status to 'failed', log
//     kind='send_fail'.
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
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"mime"
	"mime/multipart"
	"net"
	"net/mail"
	"net/smtp"
	"net/textproto"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/job"
	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
	"github.com/kitp/kitp/server/internal/textnorm"
)

// MaxReplyAttachmentBytes caps the *raw* size of attachments per
// outgoing reply. Base64 inflates roughly 4/3 on the wire, so 20 MB
// of raw payload lands at ~27 MB encoded — comfortably under the
// 25/30 MB ceiling most receiving providers enforce on raw MIME but
// the user-facing cap is on payload (predictable) not wire size.
const MaxReplyAttachmentBytes int64 = 20 * 1024 * 1024

// SMTPSender owns one channel's outbound state (just the transport seam).
// An [SMTPPool] holds one sender per channel and drives them from a single
// scheduler job via TickOnce; RunOnce sends the pending replies for one
// channel and is exported so tests can drive it synchronously.
type SMTPSender struct {
	pool      *store.Pool
	channelID int64
	tick      time.Duration
	dryRun    bool
	logger    *slog.Logger
	// publicURL is the install's externally-reachable base URL
	// (KITP_PUBLIC_URL). When set, outbound mail to a recipient who is a
	// kitp USER (a person linked to a login via user_account_person) gets a
	// "<publicURL>/task/<id>" deep link appended below the signature. Empty
	// (the default) disables the footer link entirely.
	publicURL string
	// transport is the function the loop calls to actually ship a
	// message. Tests swap it for a recording stub; production sets it
	// to sendSMTP. Nil = use the default (sendSMTP, or a no-op in
	// dry-run mode).
	transport SMTPTransport
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

// NewSMTPSenderForTest builds an SMTPSender so tests can drive RunOnce /
// TickOnce synchronously. Production builds them through an [SMTPPool],
// which reconciles one sender per channel and ticks them via the
// scheduler. Exported because the test lives in the comm_test package
// (external) — see smtp_test.go.
func NewSMTPSenderForTest(pool *store.Pool, channelID int64, tick time.Duration) *SMTPSender {
	return newSMTPSender(pool, channelID, tick)
}

// BuildMIMEForTest exposes the MIME builder so external tests can
// assert idempotency / formatting without round-tripping a full
// reply_body card. Internal callers (processOne) use buildMIME
// directly.
func BuildMIMEForTest(from, to, subject, body, threadID string) []byte {
	return buildMIME(from, to, subject, body, "", threadID, "", "", 0, nil)
}

// BuildMIMEWithFileForTest is BuildMIMEForTest with one attached file.
func BuildMIMEWithFileForTest(from, to, subject, body, threadID, filename, mimeType string, data []byte) []byte {
	return buildMIME(from, to, subject, body, "", threadID, "", "", 0,
		[]mimeAttachment{{Filename: filename, MimeType: mimeType, Bytes: data}})
}

// BuildMIMEWithQuoteForTest is BuildMIMEForTest with a quote block (as
// formatQuote renders it) and a task id, for the quoting tests.
func BuildMIMEWithQuoteForTest(from, to, subject, body, signature, threadID, quote string, taskID int64) []byte {
	return buildMIME(from, to, subject, body, signature, threadID, "", quote, taskID, nil)
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

// SetPublicURL sets the install's external base URL (KITP_PUBLIC_URL),
// used to build the "/task/<id>" deep link appended to mail sent to kitp
// users. Empty leaves the footer link off.
func (s *SMTPSender) SetPublicURL(u string) {
	s.publicURL = strings.TrimRight(strings.TrimSpace(u), "/")
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
// TickOnce sends one channel's pending replies, under a 30s budget and
// the System actor (the sender is a backend worker, not a user request;
// logging + delivery_status flips reference SystemUserID via
// auth.ActorOrSystem inside RunOnce). Logs and returns the RunOnce error;
// the [SMTPPool] sweep discards it so one bad channel doesn't fail the
// send job. There's no persistent connection between ticks.
func (s *SMTPSender) TickOnce(ctx context.Context) error {
	runCtx, cancel := context.WithTimeout(ctx, sendTickBudget)
	defer cancel()
	runCtx = auth.WithSystemUser(runCtx)
	if err := s.RunOnce(runCtx); err != nil {
		s.logger.LogAttrs(runCtx, slog.LevelError, "smtp sender RunOnce",
			slog.Int64("channel_id", s.channelID),
			slog.String("err", err.Error()))
		return err
	}
	return nil
}

// pendingReply is the read-side row materialised before we build the
// MIME message + connect to SMTP. We keep all the data we need on the
// struct so the per-reply transaction is short (a couple of UPDATEs)
// and never overlaps the network call.
type pendingReply struct {
	attempts    int // tries before this one (comm_send_attempt)
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
	// signature is the resolved text appended to the body as "-<signature>"
	// (empty = append nothing). It's derived from signatureMode + the two
	// candidate names below, picked in loadPending after the scan.
	signature     string
	signatureMode string // channel's signature_mode: '' | none | comm_name | user_name
	channelName   string // comm_channel title (for comm_name mode)
	authorName    string // reply author's user_label — an agent names its owner (for user_name mode)
	// taskID is the comm's parent task card id (0 for a thread on its own);
	// toIsUser is true when the To address matches a person linked to a
	// login (user_account_person). Both gate the "/task/<id>" deep link
	// appended to the body (see processOne).
	taskID   int64
	toIsUser bool
	// replyQuote is the channel's resolved reply_quote: off | last | all.
	replyQuote string
	// relayOf is the message this one is a copy of, when kitp is sending
	// an emailed reply on to the rest of the thread (relay.go); 0 for a
	// message written in kitp.
	relayOf int64
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
	// Honour the comm_channel's tri-state status. A disabled channel
	// still holds its pending reply rows in delivery_status='pending'
	// — those resume sending the next tick after the channel is
	// re-enabled. We don't fail them so the admin can pause/resume a
	// channel without losing outbound mail.
	status, _, err := ReadChannelStatus(ctx, s.pool.P, s.channelID)
	if err != nil {
		return fmt.Errorf("smtp sender: read status: %w", err)
	}
	if status != ChannelStatusEnabled {
		return nil
	}

	rows, err := s.loadPending(ctx, 10)
	if err != nil {
		return fmt.Errorf("smtp sender: load pending: %w", err)
	}
	var firstErr error
	for _, r := range rows {
		// A send starts only with its whole budget left in the tick; the
		// rest wait for the next one (review 2026-11-03 round 5 #4).
		if dl, ok := ctx.Deadline(); ok && time.Until(dl) < sendTimeout {
			break
		}
		// Claim it first: with kitpd on more than one replica, two senders
		// saw the same pending message and both sent it (review 2026-11-03
		// round 4). A message another sender claimed in between is left to it.
		attempts, ok, err := s.claim(ctx, r.replyID)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if !ok {
			continue
		}
		r.attempts = attempts
		if err := s.processOne(ctx, r); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// sendClaim is how long a sender holds a message it is sending; one that
// stopped mid-send (kitpd ended) lets another try after it. It outlasts
// any send (sendTimeout).
const sendClaim = 10 * time.Minute

// sendTickBudget is one channel's share of a send sweep; sendTimeout is
// one message's — the connection, the DATA and the answer. Each send has
// its own budget, and its result is recorded on a context of its own
// (resultCtx): with one 30-second budget for ten messages, a send that
// ran into it was neither counted as a try nor recorded as sent, so it
// was sent again or retried for ever (review 2026-11-03 round 5 #4).
const (
	sendTickBudget = 2 * time.Minute
	resultTimeout  = 15 * time.Second
)

var sendTimeout = 75 * time.Second // a var so tests can shorten it

// resultCtx is the context a send's result is written on: ctx's values
// (the actor) without its deadline, which the send may have used up.
func resultCtx(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), resultTimeout)
}

// maxSendAttempts is how many tries a passing failure gets before the
// message is marked failed; sendBackoff is the wait after each.
const maxSendAttempts = 6

var sendBackoff = []time.Duration{time.Minute, 5 * time.Minute, 15 * time.Minute, time.Hour, 3 * time.Hour}

// claim takes a pending message for this sender (comm_send_attempt) and
// returns how many tries it had before. ok is false when another sender
// holds it, it is waiting out a retry, or it isn't pending any more.
//
// The message's delivery_status row is locked and must still say
// pending: a sender working from an older list claimed a message another
// had just sent (its attempt row gone), and sent it again (review
// 2026-11-03 round 5 #3). Under the lock, a status a concurrent sender is
// writing is read once it commits. Times are the database's (now()), as
// they are compared with it.
func (s *SMTPSender) claim(ctx context.Context, replyID int64) (int, bool, error) {
	b := named.New()
	b.Set("reply", replyID)
	b.Set("claim_secs", int(sendClaim.Seconds()))
	q, args, err := b.Compile(`
		WITH pending AS (
			SELECT av.card_id
			FROM attribute_value av
			WHERE av.card_id = :reply
			  AND av.attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'delivery_status')
			  AND av.value = '"pending"'::jsonb
			FOR UPDATE
		)
		INSERT INTO comm_send_attempt (reply_id, claimed_until)
		SELECT p.card_id, now() + make_interval(secs => :claim_secs) FROM pending p
		ON CONFLICT (reply_id) DO UPDATE SET claimed_until = EXCLUDED.claimed_until
		WHERE (comm_send_attempt.claimed_until IS NULL OR comm_send_attempt.claimed_until <= now())
		  AND (comm_send_attempt.next_attempt_at IS NULL OR comm_send_attempt.next_attempt_at <= now())
		RETURNING attempts
	`)
	if err != nil {
		return 0, false, fmt.Errorf("smtp sender: claim: compile: %w", err)
	}
	var attempts int
	if err := s.pool.P.QueryRow(ctx, q, args...).Scan(&attempts); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, false, nil
		}
		return 0, false, fmt.Errorf("smtp sender: claim reply %d: %w", replyID, err)
	}
	return attempts, true, nil
}

// retryLater keeps a message pending after a passing failure, to be tried
// again after its backoff: the claim is dropped and the try counted.
func (s *SMTPSender) retryLater(ctx context.Context, r pendingReply, sendErr error, wait time.Duration) error {
	b := named.New()
	b.Set("reply", r.replyID)
	b.Set("wait_secs", int(wait.Seconds()))
	b.Set("error", textnorm.Storable(truncateString(sendErr.Error(), 500)))
	q, args, err := b.Compile(`
		UPDATE comm_send_attempt
		   SET claimed_until = NULL, attempts = attempts + 1,
		       next_attempt_at = now() + make_interval(secs => :wait_secs), last_error = :error
		 WHERE reply_id = :reply
	`)
	if err != nil {
		return fmt.Errorf("smtp sender: retry: compile: %w", err)
	}
	if _, err := s.pool.P.Exec(ctx, q, args...); err != nil {
		return fmt.Errorf("smtp sender: retry reply %d: %w", r.replyID, err)
	}
	detail := map[string]any{"recipient": r.to, "error": sendErr.Error(), "attempt": r.attempts + 1, "retry_in": wait.String()}
	if err := LogEvent(ctx, s.pool.P, r.projectID, r.channelID, "send_retry", detail); err != nil {
		s.logger.LogAttrs(ctx, slog.LevelWarn, "smtp sender: log a retry",
			slog.Int64("reply_id", r.replyID), slog.String("err", err.Error()))
	}
	return nil
}

// truncateString cuts s to at most n bytes.
func truncateString(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// processOne handles a single pending reply: builds the MIME, attempts
// the send, updates the delivery_status, writes a comm_log entry. All
// state mutations happen in a single dedicated tx after the network
// call returns.
func (s *SMTPSender) processOne(ctx context.Context, r pendingReply) error {
	// Check the stored sizes before reading a byte: a reply naming many
	// large files would otherwise be buffered whole first (review
	// 2026-11-03 #19).
	if total, err := s.replyAttachmentBytes(ctx, r.replyID); err != nil {
		return fmt.Errorf("smtp sender: attachment sizes for reply %d: %w", r.replyID, err)
	} else if total > MaxReplyAttachmentBytes {
		s.recordFailure(ctx, r, map[string]any{
			"error":    "attachments exceed per-reply size cap",
			"cap":      MaxReplyAttachmentBytes,
			"total":    total,
			"reply_id": r.replyID,
		})
		return fmt.Errorf("smtp sender: reply %d attachments %d > cap %d",
			r.replyID, total, MaxReplyAttachmentBytes)
	}
	atts, err := s.loadReplyAttachments(ctx, r.replyID)
	if err != nil {
		// Couldn't read attachment bytes — fail the row loudly rather
		// than ship a body-only message the user didn't intend.
		s.recordFailure(ctx, r,
			map[string]any{"error": "load attachments: " + err.Error()})
		return fmt.Errorf("smtp sender: load attachments for reply %d: %w", r.replyID, err)
	}
	var total int64
	for _, a := range atts {
		total += int64(len(a.Bytes))
	}
	if total > MaxReplyAttachmentBytes {
		s.recordFailure(ctx, r, map[string]any{
			"error":    "attachments exceed per-reply size cap",
			"cap":      MaxReplyAttachmentBytes,
			"total":    total,
			"reply_id": r.replyID,
		})
		return fmt.Errorf("smtp sender: reply %d attachments %d > cap %d",
			r.replyID, total, MaxReplyAttachmentBytes)
	}
	// Append a task deep link only for kitp users, and only when a public
	// base URL is configured.
	taskURL := ""
	if s.publicURL != "" && r.toIsUser && r.taskID > 0 {
		taskURL = s.publicURL + "/task/" + strconv.FormatInt(r.taskID, 10)
	}
	quote := ""
	var extra []mimeHeader
	if r.relayOf != 0 {
		// A copy of someone's emailed reply: their words only — no
		// signature, quote or deep link of ours — and marked as sent on
		// automatically (RFC 3834), so an auto-reply to it isn't sent on.
		r.signature = ""
		taskURL = ""
		extra = append(extra, mimeHeader{"Auto-Submitted", "auto-forwarded"})
		// X-Loop names the account that sent it on: such mail coming back
		// in is never sent on again (automaticKind).
		if a, err := ParseAddress(r.from); err == nil {
			extra = append(extra, mimeHeader{"X-Loop", a.Address})
		}
	} else if r.replyQuote != QuoteOff {
		earlier, err := s.loadEarlier(ctx, r)
		if err != nil {
			// Quoting is a courtesy; a failed read sends the reply without it.
			s.logger.LogAttrs(ctx, slog.LevelWarn, "smtp sender: load quoted messages",
				slog.Int64("reply_id", r.replyID),
				slog.String("err", err.Error()))
		}
		quote = formatQuote(earlier)
	}
	msg := buildMIME(r.from, r.to, r.subject, r.body, r.signature, r.threadID, taskURL, quote, r.taskID, atts, extra...)
	// The envelope sender is the bare address; the From header may name
	// someone ("Ada via Support" <support@…>) for a copy.
	envelopeFrom := r.from
	if a, err := mail.ParseAddress(r.from); err == nil {
		envelopeFrom = a.Address
	}

	var sendErr error
	if s.dryRun {
		s.logger.LogAttrs(ctx, slog.LevelInfo, "smtp dry-run",
			slog.Int64("reply_id", r.replyID),
			slog.Int64("channel_id", r.channelID),
			slog.String("to", r.to),
			slog.Int("message_bytes", len(msg)))
	} else {
		sendCtx, cancel := context.WithTimeout(ctx, sendTimeout)
		sendErr = s.transport(sendCtx, r.smtpHost, r.smtpPort, r.smtpUser, r.smtpPass, envelopeFrom, r.to, msg)
		cancel()
	}

	// The result is written whatever is left of the tick's budget.
	ctx, cancel := resultCtx(ctx)
	defer cancel()
	newStatus, logKind, detail := classifySendResult(sendErr, r.to)
	// A failure that may pass — a 4xx answer, a dropped connection, a
	// timeout — is tried again after a backoff, up to maxSendAttempts;
	// only a bounce (5xx) or the last try fails it for good (review
	// 2026-11-03 round 4).
	if newStatus == "failed" && r.attempts+1 < maxSendAttempts {
		wait := sendBackoff[min(r.attempts, len(sendBackoff)-1)]
		if err := s.retryLater(ctx, r, sendErr, wait); err != nil {
			return err
		}
		return sendErr
	}
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
	b := named.New()
	b.Set("channel_id", s.channelID)
	b.Set("limit", limit)
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
			-- task_id: the comm's task; 0 for a thread on its own (its parent
			-- is the project), which gets no Task: line or deep link.
			COALESCE((SELECT p.id FROM card p JOIN card_type pct ON pct.id = p.card_type_id
			          WHERE p.id = cm.parent_card_id AND pct.name = 'task'), 0)                                                                                     AS task_id,
			-- to_is_user: does the To address (reply_to) belong to a kitp USER,
			-- i.e. a person card linked to a login via user_account_person?
			-- Drives the "/task/<id>" deep link appended for users only.
			EXISTS (
				SELECT 1
				FROM attribute_value pe
				JOIN attribute_def adpe ON adpe.id = pe.attribute_def_id AND adpe.name = 'email'
				JOIN card p ON p.id = pe.card_id AND p.deleted_at IS NULL
				JOIN card_type ctp ON ctp.id = p.card_type_id AND ctp.name = 'person'
				JOIN user_account_person uap ON uap.person_card_id = p.id
				WHERE lower(pe.value #>> '{}') = lower(COALESCE((
					SELECT value #>> '{}' FROM attribute_value av2 JOIN attribute_def ad2 ON ad2.id = av2.attribute_def_id
					WHERE av2.card_id = rb.id AND ad2.name='reply_to'), ''))
				  AND lower(pe.value #>> '{}') <> ''
			)                                                                                                                                                          AS to_is_user,
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = ch.id AND ad.name='smtp_host'), '')       AS smtp_host,
			COALESCE((SELECT (value)::text::int FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = ch.id AND ad.name='smtp_port' AND jsonb_typeof(value)='number'), 0) AS smtp_port,
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = ch.id AND ad.name='smtp_username'), '')   AS smtp_username,
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = ch.id AND ad.name='from_address'), '')    AS from_address,
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = ch.id AND ad.name='title'), '')           AS channel_name,
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = ch.id AND ad.name='signature_mode'), '')  AS signature_mode,
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = ch.id AND ad.name='reply_quote'), '')     AS reply_quote,
			COALESCE((SELECT user_label(ua.id)
			          FROM attribute_value av
			          JOIN attribute_def ad ON ad.id = av.attribute_def_id
			          JOIN user_account ua ON ua.id = (av.value)::text::bigint
			          WHERE av.card_id = rb.id AND ad.name='reply_author'
			            AND jsonb_typeof(av.value)='number'), '')                                                                                                                     AS author_name,
			COALESCE((SELECT (value)::text::bigint FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = rb.id AND ad.name='relay_of' AND jsonb_typeof(value)='number'), 0) AS relay_of,
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
			AND jsonb_typeof(rep_av.value) = 'array' AND rep_av.value @> to_jsonb(rb.id)
		JOIN card cm ON cm.id = rep_av.card_id
		JOIN card_type ct_cm ON ct_cm.id = cm.card_type_id AND ct_cm.name = 'comm'
		-- channel_ref → comm_channel card
		JOIN attribute_value cref_av ON cref_av.card_id = cm.id
			AND cref_av.attribute_def_id = (SELECT id FROM attribute_def WHERE name='channel_ref')
		JOIN card ch ON ch.id = (cref_av.value)::text::bigint
		WHERE rb.deleted_at IS NULL
		  AND cm.deleted_at IS NULL
		  -- A thread in an area that is switched off waits: its queued
		  -- replies send once the area is back on (review A3).
		  AND NOT card_in_off_area(cm.id)
		  AND ch.deleted_at IS NULL
		  AND ch.id = :channel_id
		  -- Not one another sender has claimed, nor one waiting out a
		  -- retry (comm_send_attempt).
		  AND NOT EXISTS (SELECT 1 FROM comm_send_attempt sa
		                  WHERE sa.reply_id = rb.id
		                    AND (sa.claimed_until > now() OR sa.next_attempt_at > now()))
		ORDER BY rb.id
		LIMIT :limit
	`
	sql, args, err := b.Compile(q)
	if err != nil {
		return nil, fmt.Errorf("loadPending: compile: %w", err)
	}
	pgRows, err := s.pool.P.Query(ctx, sql, args...)
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
			&r.taskID, &r.toIsUser,
			&r.smtpHost, &r.smtpPort, &r.smtpUser, &r.fromAddress,
			&r.channelName, &r.signatureMode, &r.replyQuote, &r.authorName,
			&r.relayOf,
			&r.smtpPass,
		); err != nil {
			return nil, err
		}
		r.from = sendingFrom(r.from, r.fromAddress)
		r.signature = resolveSignature(r.signatureMode, r.channelName, r.authorName)
		r.replyQuote = ResolveReplyQuote(r.replyQuote)
		out = append(out, r)
	}
	if err := pgRows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// sendingFrom is the From a queued message goes out with: the one stored
// when it was written, but always at the sending account's own address
// (from_address). A message queued before its thread moved to another
// project (task.move) goes out through the new project's account, and its
// login would refuse — or SPF/DMARC fail — the old account's address
// (review 2026-11-03 round 3 #10). The stored display name ("Ada via
// Support") is kept. No stored From, or no account address: the other one.
//
// The account's address may carry a display name ("Support <support@x>"),
// which comm_channel.set no longer takes but older accounts may hold: only
// its bare address is put in the From (review 2026-11-03 round 4 #8).
func sendingFrom(stored, accountAddr string) string {
	accountAddr = strings.TrimSpace(accountAddr)
	if stored == "" || accountAddr == "" {
		if stored == "" {
			return accountAddr
		}
		return stored
	}
	bare, accountName := accountAddr, ""
	if a, err := ParseAddress(accountAddr); err == nil {
		bare, accountName = a.Address, a.Name
	}
	a, err := ParseAddress(stored)
	if err != nil {
		return (&mail.Address{Name: accountName, Address: bare}).String()
	}
	if strings.EqualFold(a.Address, bare) {
		return stored
	}
	name := a.Name
	if name == "" {
		name = accountName
	}
	return (&mail.Address{Name: name, Address: bare}).String()
}

// loadEarlier reads the messages of r's thread that came before it, newest
// first — only the one before when the channel quotes the last message.
// Failed and bounced messages never reached anyone and are skipped, and so
// are copies kitp sent on (relay.go), which repeat an earlier message. An
// outbound message's sender is the channel's from address, named with the
// channel's title when the stored From is a bare address.
func (s *SMTPSender) loadEarlier(ctx context.Context, r pendingReply) ([]quotedMessage, error) {
	b := named.New()
	b.Set("comm_id", r.commID)
	b.Set("reply_id", r.replyID)
	limit := 50
	if r.replyQuote == QuoteLast {
		limit = 1
	}
	b.Set("limit", limit)
	q, args, err := b.Compile(`
		SELECT rb.id,
		       COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = rb.id AND ad.name='reply_from'), ''),
		       COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = rb.id AND ad.name='reply_body_text'), ''),
		       COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = rb.id AND ad.name='delivery_status'), ''),
		       rb.created_at
		FROM attribute_value rep
		JOIN attribute_def rad ON rad.id = rep.attribute_def_id AND rad.name = 'replies'
		CROSS JOIN LATERAL jsonb_array_elements(rep.value) AS e(v)
		JOIN card rb ON rb.id = (e.v #>> '{}')::bigint AND rb.deleted_at IS NULL
		WHERE rep.card_id = :comm_id
		  AND jsonb_typeof(rep.value) = 'array'
		  AND jsonb_typeof(e.v) IN ('number', 'string')
		  AND (e.v #>> '{}') ~ '^\d+$'
		  AND rb.id < :reply_id
		  AND COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = rb.id AND ad.name='delivery_status'), '') NOT IN ('failed', 'bounced')
		  -- A copy kitp sent on repeats a message already quoted.
		  AND NOT EXISTS (SELECT 1 FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = rb.id AND ad.name='relay_of')
		ORDER BY rb.id DESC
		LIMIT :limit
	`)
	if err != nil {
		return nil, fmt.Errorf("loadEarlier: compile: %w", err)
	}
	rows, err := s.pool.P.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("loadEarlier: %w", err)
	}
	defer rows.Close()
	var out []quotedMessage
	for rows.Next() {
		var id int64
		var m quotedMessage
		var status string
		if err := rows.Scan(&id, &m.From, &m.Body, &status, &m.At); err != nil {
			return nil, fmt.Errorf("loadEarlier: scan: %w", err)
		}
		if status == "received" {
			// Stored as it came before kitp decoded it at intake.
			m.From = displayAddress(m.From)
		} else {
			if m.From == "" {
				m.From = r.fromAddress
			}
			if m.From != "" && !strings.Contains(m.From, "<") && r.channelName != "" {
				m.From = r.channelName + " <" + m.From + ">"
			}
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("loadEarlier: rows: %w", err)
	}
	return out, nil
}

// recordResult flips delivery_status and inserts the matching
// comm_log row in one transaction. The attribute write goes through
// the package's writeAttributeValue helper so the activity row is
// shaped identically to every other attribute_update in kitp.
// recordFailure marks a reply failed before it was sent. A failure to record
// it is logged: the reply stays pending and the next sweep tries again.
func (s *SMTPSender) recordFailure(ctx context.Context, r pendingReply, detail map[string]any) {
	if err := s.recordResult(ctx, r, "failed", "send_fail", detail); err != nil {
		s.logger.LogAttrs(ctx, slog.LevelWarn, "smtp sender: record a failed reply",
			slog.Int64("reply_id", r.replyID),
			slog.String("err", err.Error()))
	}
}

func (s *SMTPSender) recordResult(ctx context.Context, r pendingReply, newStatus, logKind string, detail map[string]any) error {
	actorID := auth.ActorOrSystem(ctx)
	tx, err := s.pool.Begin(ctx)
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
	if err := namedExec(ctx, tx, `
		INSERT INTO comm_log (project_id, channel_id, kind, detail)
		VALUES (:project, :channel, :kind, :detail::jsonb)
	`, map[string]any{"project": r.projectID, "channel": r.channelID, "kind": logKind, "detail": detailJSON}); err != nil {
		return fmt.Errorf("comm_log: %w", err)
	}
	// Done with: no claim or retry left on it.
	if err := namedExec(ctx, tx, `DELETE FROM comm_send_attempt WHERE reply_id = :reply`,
		map[string]any{"reply": r.replyID}); err != nil {
		return fmt.Errorf("comm_send_attempt: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	if s.pool != nil {
		s.pool.NoteWrite()
	}
	return nil
}

// resolveSignature maps the channel's signature_mode to the text appended to
// outbound reply bodies as "-<signature>". An unset/unknown mode preserves the
// legacy behaviour (sign with the channel name); 'none' signs nothing;
// 'user_name' signs with the reply author's display name (empty when the author
// can't be resolved — no dangling dash).
func resolveSignature(mode, channelName, authorName string) string {
	switch mode {
	case "none":
		return ""
	case "user_name":
		return authorName
	case "comm_name":
		return channelName
	default: // "" (unset) or any unexpected value → legacy default
		return channelName
	}
}

// ---- MIME ----

// buildMIME assembles the plain-text RFC822 message we hand to the
// SMTP server. The subject's [#<thread_id>] suffix is appended only
// when the caller didn't already include it (idempotency for users
// who hand-edit the draft). The X-Kitp-Thread-Id header + body
// trailer 'Ref:' line are always added — Gate 6's inbound parser
// looks for any of the three. When taskID > 0 a "Task: <id>" line sits
// directly above the Ref: line, so every recipient (user or not, link
// or not) can quote the task number back. A non-empty quote (the earlier
// messages, formatQuote) goes below the signature and link, above the
// trailer, which stays last where the inbound parser looks for it.
//
// We deliberately use \r\n line endings (SMTP convention; required by
// the wire protocol) and emit a single Content-Type header for
// plain-text UTF-8. Quoted-printable / multipart MIME is out of scope
// for v1 (the spec calls out "plain text only").
func buildMIME(from, to, subject, body, signature, threadID, taskURL, quote string, taskID int64, atts []mimeAttachment, extra ...mimeHeader) []byte {
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
	// Auto-sign with the channel name, before the machine Ref: trailer, so the
	// recipient sees "…body…\n\n-<channel>". Skipped when unnamed.
	if sig := strings.TrimSpace(signature); sig != "" {
		bodyNorm += "\r\n\r\n-" + sig
	}
	// For mail to a kitp user, append the task deep link below the signature
	// (caller passes a non-empty taskURL only for user recipients with a
	// configured public URL).
	if link := strings.TrimSpace(taskURL); link != "" {
		bodyNorm += "\r\n\r\n" + link
	}
	if q := strings.TrimRight(quote, "\r\n"); strings.TrimSpace(q) != "" {
		q = strings.ReplaceAll(q, "\r\n", "\n")
		bodyNorm += "\r\n\r\n" + strings.ReplaceAll(q, "\n", "\r\n")
	}
	trailer := "Ref: " + threadID + "\r\n"
	if taskID > 0 {
		trailer = "Task: " + strconv.FormatInt(taskID, 10) + "\r\n" + trailer
	}
	bodyWithRef := bodyNorm + "\r\n\r\n" + trailer

	// Common headers. A value never carries a line break: a subject or
	// name taken from mail (a decoded =?…?= word can hold CR LF) would
	// otherwise start a header of the sender's choosing.
	// A message carries its Date and a Message-ID (RFC 5322 §3.6), and a
	// subject outside ASCII goes as encoded words (RFC 2047), not raw UTF-8
	// (review 2026-11-03 round 2 #21).
	var hdr strings.Builder
	fmt.Fprintf(&hdr, "From: %s\r\n", oneLine(from))
	fmt.Fprintf(&hdr, "To: %s\r\n", oneLine(to))
	fmt.Fprintf(&hdr, "Subject:%s\r\n", foldSubject(oneLine(subjectFinal)))
	fmt.Fprintf(&hdr, "Date: %s\r\n", time.Now().UTC().Format(time.RFC1123Z))
	fmt.Fprintf(&hdr, "Message-ID: %s\r\n", replyMessageID(from))
	fmt.Fprintf(&hdr, "X-Kitp-Thread-Id: %s\r\n", oneLine(threadID))
	for _, h := range extra {
		fmt.Fprintf(&hdr, "%s: %s\r\n", h.Key, oneLine(h.Value))
	}
	hdr.WriteString("MIME-Version: 1.0\r\n")

	if len(atts) == 0 {
		// Plain-text single-part — unchanged shape from the pre-V2 path.
		hdr.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
		hdr.WriteString("\r\n")
		hdr.WriteString(bodyWithRef)
		return []byte(hdr.String())
	}

	// Multipart/mixed: one text part + one base64 part per attachment.
	// Use mime/multipart to handle boundary generation + part headers
	// so we don't hand-roll RFC2046 framing.
	var body64 bytes.Buffer
	mw := multipart.NewWriter(&body64)
	fmt.Fprintf(&hdr, "Content-Type: multipart/mixed; boundary=\"%s\"\r\n", mw.Boundary())
	hdr.WriteString("\r\n")

	// Body part.
	textHdr := textproto.MIMEHeader{}
	textHdr.Set("Content-Type", "text/plain; charset=utf-8")
	// The parts write into body64, a bytes.Buffer: a write there can't
	// fail, so its error is not checked.
	if w, err := mw.CreatePart(textHdr); err == nil {
		_, _ = w.Write([]byte(bodyWithRef))
	}

	for _, a := range atts {
		ah := textproto.MIMEHeader{}
		ah.Set("Content-Type", partContentType(a.MimeType))
		ah.Set("Content-Transfer-Encoding", "base64")
		ah.Set("Content-Disposition", attachmentDisposition(a.Filename))
		w, err := mw.CreatePart(ah)
		if err != nil {
			continue
		}
		// base64 wrapped at 76 chars per RFC 2045.
		encoded := base64.StdEncoding.EncodeToString(a.Bytes)
		for i := 0; i < len(encoded); i += 76 {
			end := i + 76
			if end > len(encoded) {
				end = len(encoded)
			}
			_, _ = w.Write([]byte(encoded[i:end] + "\r\n")) // into body64; can't fail
		}
	}
	_ = mw.Close()

	out := make([]byte, 0, len(hdr.String())+body64.Len())
	out = append(out, hdr.String()...)
	out = append(out, body64.Bytes()...)
	return out
}

// headerBreaks turns line breaks into spaces (oneLine).
var headerBreaks = strings.NewReplacer("\r\n", " ", "\r", " ", "\n", " ")

// oneLine is a header value with its line breaks turned into spaces.
func oneLine(v string) string { return headerBreaks.Replace(v) }

// foldSubject is a Subject's value, folded, after "Subject:". Lines stay
// within RFC 5322's 78 characters and an encoded word's line within RFC
// 2047's 76 (review 2026-11-03 round 3, round 4 #19). Non-ASCII text is
// Q-encoded into words of at most 75 characters, each on a line of its
// own; plain text is folded at spaces. Folding adds only line breaks before
// a space, so the unfolded value is the same.
func foldSubject(v string) string {
	if enc := mime.QEncoding.Encode("utf-8", v); enc != v {
		return "\r\n " + strings.ReplaceAll(enc, "?= =?", "?=\r\n =?")
	}
	var b strings.Builder
	b.WriteByte(' ')
	lineLen := len("Subject: ")
	for i, w := range strings.Split(v, " ") {
		if i > 0 {
			if lineLen+1+len(w) > 78 {
				b.WriteString("\r\n ")
				lineLen = 1
			} else {
				b.WriteByte(' ')
				lineLen++
			}
		}
		b.WriteString(w)
		lineLen += len(w)
	}
	return b.String()
}

// replyMessageID is a new Message-ID for a message kitp sends on a thread,
// at the domain of its From address.
func replyMessageID(from string) string {
	domain := "kitp.invalid"
	if a, err := ParseAddress(from); err == nil {
		if at := strings.LastIndexByte(a.Address, '@'); at >= 0 && at < len(a.Address)-1 {
			domain = strings.ToLower(a.Address[at+1:])
		}
	}
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand doesn't fail on the systems kitp runs on; the time
		// still makes the id unique enough.
		return fmt.Sprintf("<kitp.%d@%s>", time.Now().UnixNano(), oneLine(domain))
	}
	return fmt.Sprintf("<kitp.%x@%s>", b, oneLine(domain))
}

// mimeHeader is one extra header line on an outgoing message (a relayed
// copy's Auto-Submitted, its X-Loop). Key and Value are kitp's own, never
// taken from mail.
type mimeHeader struct {
	Key   string
	Value string
}

// mimeAttachment is one attachment payload bound for an outgoing
// reply. Fields mirror the file row that backs it; Bytes holds the
// inlined chunk content (CAS bytes joined in seq order).
type mimeAttachment struct {
	Filename string
	MimeType string
	Bytes    []byte
}

// loadReplyAttachments resolves every attachment linked to [replyID]
// (via reply_body_attachment) into in-memory bytes. Joins through
// attachment → file → file_chunk → cas_blob_data; multi-chunk files
// are reassembled in seq order. Returns an empty slice when the
// reply has no linked attachments.
// partContentType is an attachment part's Content-Type: the file's media
// type when it is a well-formed one, else application/octet-stream. Written
// through mime.FormatMediaType, never pasted, so a stored value can't add
// header lines (review 2026-11-03 #11).
func partContentType(stored string) string {
	mt, params, err := mime.ParseMediaType(stored)
	if err != nil || mt == "" {
		return "application/octet-stream"
	}
	if out := mime.FormatMediaType(mt, params); out != "" {
		return out
	}
	return "application/octet-stream"
}

// attachmentDisposition is `attachment; filename=…` for a file name: cleaned
// of control and bidi runes and path separators (textnorm.FilenameLoose),
// then quoted or RFC 2231-encoded by mime.FormatMediaType. A name written in
// raw let CR/LF add headers to the part (review 2026-11-03 #11).
func attachmentDisposition(name string) string {
	name = textnorm.FilenameLoose(name)
	if name == "" {
		name = "attachment"
	}
	if out := mime.FormatMediaType("attachment", map[string]string{"filename": name}); out != "" {
		return out
	}
	return "attachment"
}

// replyAttachmentBytes is the stored size of the files a reply carries.
func (s *SMTPSender) replyAttachmentBytes(ctx context.Context, replyID int64) (int64, error) {
	b := named.New()
	b.Set("reply", replyID)
	q, args, err := b.Compile(`
		SELECT COALESCE(sum(f.size_bytes), 0)
		FROM reply_body_attachment rba
		JOIN attachment a ON a.id = rba.attachment_id AND a.deleted_at IS NULL
		JOIN file f ON f.id = a.file_id
		WHERE rba.reply_body_id = :reply
	`)
	if err != nil {
		return 0, err
	}
	var total int64
	if err := s.pool.P.QueryRow(ctx, q, args...).Scan(&total); err != nil {
		return 0, err
	}
	return total, nil
}

func (s *SMTPSender) loadReplyAttachments(ctx context.Context, replyID int64) ([]mimeAttachment, error) {
	b := named.New()
	b.Set("reply", replyID)
	q, args, err := b.Compile(`
		SELECT a.id, f.filename, f.mime_type, fc.seq,
		       coalesce(cd.data, ''::bytea)
		FROM reply_body_attachment rba
		JOIN attachment a    ON a.id = rba.attachment_id AND a.deleted_at IS NULL
		JOIN file f          ON f.id = a.file_id
		JOIN file_chunk fc   ON fc.file_id = f.id
		LEFT JOIN cas_blob_data cd ON cd.address = fc.cas_address
		WHERE rba.reply_body_id = :reply
		ORDER BY a.id, fc.seq
	`)
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.P.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type acc struct {
		filename, mime string
		buf            *bytes.Buffer
	}
	byAttachment := map[int64]*acc{}
	order := []int64{}
	for rows.Next() {
		var aID int64
		var filename, mt string
		var seq int
		var chunk []byte
		if err := rows.Scan(&aID, &filename, &mt, &seq, &chunk); err != nil {
			return nil, err
		}
		entry, ok := byAttachment[aID]
		if !ok {
			entry = &acc{filename: filename, mime: mt, buf: &bytes.Buffer{}}
			byAttachment[aID] = entry
			order = append(order, aID)
		}
		_, _ = entry.buf.Write(chunk)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]mimeAttachment, 0, len(order))
	for _, id := range order {
		e := byAttachment[id]
		out = append(out, mimeAttachment{Filename: e.filename, MimeType: e.mime, Bytes: e.buf.Bytes()})
	}
	return out, nil
}

// ---- transport ----

// smtpSessionTimeout bounds one SMTP conversation when the caller's context
// has no sooner deadline: dial to QUIT, a 20 MB message included.
const smtpSessionTimeout = 5 * time.Minute

// sendSMTP is the production SMTP transport. Port 465 uses implicit
// TLS (the connection is encrypted before the SMTP handshake); every
// other port uses STARTTLS upgrade (port 587 is the standard
// submission port for that flow). Both paths AUTH with the supplied
// username/password using PLAIN over the encrypted channel.
//
// Tests substitute a recording stub via SMTPSender.SetTransport.
func sendSMTP(ctx context.Context, host string, port int, username, password, from, to string, msg []byte) error {
	// SSRF guard (SEC-4 / A9): reject internal / loopback / link-local
	// dial targets before opening the socket.
	if err := guardDialHost(ctx, host); err != nil {
		return err
	}
	addr := net.JoinHostPort(host, fmt.Sprintf("%d", port))
	d := net.Dialer{Timeout: 15 * time.Second}
	rawConn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return fmt.Errorf("smtp dial %s: %w", addr, err)
	}
	// net/smtp has no context: the whole conversation gets a deadline (the
	// caller's, or smtpSessionTimeout), and the connection is closed if ctx
	// ends first, so a server that stops answering can't hold the sender —
	// and every account after it — forever (review 2026-11-03 round 4 #6).
	deadline := time.Now().Add(smtpSessionTimeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	if err := rawConn.SetDeadline(deadline); err != nil {
		if cerr := rawConn.Close(); cerr != nil {
			return fmt.Errorf("smtp set deadline: %w (and close: %v)", err, cerr)
		}
		return fmt.Errorf("smtp set deadline: %w", err)
	}
	stop := context.AfterFunc(ctx, func() {
		if err := rawConn.Close(); err != nil {
			return // closing either way
		}
	})
	defer stop()
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
	rcpts, err := parseRecipients(to)
	if err != nil {
		return fmt.Errorf("smtp parse recipients %q: %w", to, err)
	}
	if len(rcpts) == 0 {
		return fmt.Errorf("smtp: no recipients parsed from %q", to)
	}
	for _, rc := range rcpts {
		if err := client.Rcpt(rc); err != nil {
			return wrapSMTPError(err, "smtp RCPT TO")
		}
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
		// The DATA phase already returned success, so the server has
		// accepted the message; a QUIT failure (connection reset on
		// teardown, slow close) does not un-send it. Intentionally
		// ignored — flipping the row to 'failed' here would cause a
		// duplicate resend. Not wrapped/returned per the CLAUDE.md error
		// rule's "safe to drop, with a comment explaining why" clause
		// (A15e / BE-L5).
		_ = err
	}
	return nil
}

// parseRecipients splits a To: header value into bare RFC 5321
// envelope addresses. Tries ParseAddressList first so
// "Alice <alice@x>, bob@y" works; falls back to a comma split so a
// loosely-formatted value still produces RCPT entries rather than
// failing the whole send. Either way only plain addresses
// (PlainAddress) are sent to: an odd stored address is left off rather
// than split into others (review 2026-11-03 round 3 #9). Empty input
// returns an empty slice (the caller treats that as a hard error).
func parseRecipients(to string) ([]string, error) {
	trimmed := strings.TrimSpace(to)
	if trimmed == "" {
		return nil, nil
	}
	if addrs, err := ParseAddressList(trimmed); err == nil {
		out := make([]string, 0, len(addrs))
		for _, a := range addrs {
			if a.Address != "" {
				out = append(out, a.Address)
			}
		}
		if len(out) > 0 {
			return out, nil
		}
	}
	parts := strings.Split(trimmed, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		s := strings.TrimSpace(p)
		if a, err := ParseAddress(s); err == nil {
			out = append(out, a.Address)
		} else if PlainAddress(s) {
			// A bare address net/mail won't parse but email_plain let onto
			// the To list (an old "taro..yamada@" mobile address): sent as
			// is, so the two agree (review 2026-11-03 round 4 #9).
			out = append(out, s)
		}
	}
	return out, nil
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
		  -- A channel in a project whose Conversations area is off gets no
		  -- worker: intake and sending pause until it's switched on.
		  AND NOT card_in_off_area(c.id)
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

// SMTPPool drives outbound sending for every comm_channel from a single
// scheduler job. Each RunOnce reconciles one [SMTPSender] per live channel
// and ticks each one. Construct with [NewSMTPPool] and call RunOnce from
// the `comm.smtp_send` job (see cmd/kitpd/main.go).
type SMTPPool struct {
	pool *store.Pool
	wp   *job.WorkerPool[int64, *SMTPSender]
}

// NewSMTPPool builds the pool. tick is the per-sender cadence hint (the
// real cadence is the owning job's Interval); logger is threaded to each
// sender. publicURL (KITP_PUBLIC_URL) is threaded to each sender so mail to
// kitp users carries a task deep link; empty disables the link.
func NewSMTPPool(pool *store.Pool, tick time.Duration, logger *slog.Logger, publicURL string) *SMTPPool {
	m := &SMTPPool{pool: pool}
	m.wp = job.NewWorkerPool[int64, *SMTPSender](
		func(id int64) *SMTPSender {
			s := newSMTPSender(pool, id, tick)
			s.SetLogger(logger)
			s.SetPublicURL(publicURL)
			return s
		},
		// Discard the per-channel error: TickOnce already logged it, and
		// one bad channel must not flip the whole send job red.
		func(ctx context.Context, s *SMTPSender) error { _ = s.TickOnce(ctx); return nil },
	)
	return m
}

// RunOnce is the `comm.smtp_send` job body: list every channel and sweep
// its sender. Returns only a channel-enumeration error.
func (m *SMTPPool) RunOnce(ctx context.Context) error {
	ids, err := ListChannelIDs(ctx, m.pool)
	if err != nil {
		return fmt.Errorf("smtp send: list channels: %w", err)
	}
	return m.wp.Sweep(ctx, ids)
}
