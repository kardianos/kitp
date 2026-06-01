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
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"mime/multipart"
	"net"
	"net/mail"
	"net/smtp"
	"net/textproto"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/job"
	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
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
	return buildMIME(from, to, subject, body, "", threadID, "", nil)
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
	runCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
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
	authorName    string // reply author's user_account.display_name (for user_name mode)
	// taskID is the comm's parent task card id; toIsUser is true when the To
	// address matches a person linked to a login (user_account_person). Both
	// gate the "/task/<id>" deep link appended to the body (see processOne).
	taskID   int64
	toIsUser bool
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
	atts, err := s.loadReplyAttachments(ctx, r.replyID)
	if err != nil {
		// Couldn't read attachment bytes — fail the row loudly rather
		// than ship a body-only message the user didn't intend.
		_ = s.recordResult(ctx, r, "failed", "send_fail",
			map[string]any{"error": "load attachments: " + err.Error()})
		return fmt.Errorf("smtp sender: load attachments for reply %d: %w", r.replyID, err)
	}
	var total int64
	for _, a := range atts {
		total += int64(len(a.Bytes))
	}
	if total > MaxReplyAttachmentBytes {
		_ = s.recordResult(ctx, r, "failed", "send_fail", map[string]any{
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
	msg := buildMIME(r.from, r.to, r.subject, r.body, r.signature, r.threadID, taskURL, atts)

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
			COALESCE(cm.parent_card_id, 0)                                                                                                                              AS task_id,
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
			COALESCE((SELECT ua.display_name
			          FROM attribute_value av
			          JOIN attribute_def ad ON ad.id = av.attribute_def_id
			          JOIN user_account ua ON ua.id = (av.value)::text::bigint
			          WHERE av.card_id = rb.id AND ad.name='reply_author'
			            AND jsonb_typeof(av.value)='number'), '')                                                                                                                     AS author_name,
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
		  AND ch.id = :channel_id
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
			&r.channelName, &r.signatureMode, &r.authorName,
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
		r.signature = resolveSignature(r.signatureMode, r.channelName, r.authorName)
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
// looks for any of the three.
//
// We deliberately use \r\n line endings (SMTP convention; required by
// the wire protocol) and emit a single Content-Type header for
// plain-text UTF-8. Quoted-printable / multipart MIME is out of scope
// for v1 (the spec calls out "plain text only").
func buildMIME(from, to, subject, body, signature, threadID, taskURL string, atts []mimeAttachment) []byte {
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
	bodyWithRef := bodyNorm + "\r\n\r\nRef: " + threadID + "\r\n"

	// Common headers.
	var hdr strings.Builder
	fmt.Fprintf(&hdr, "From: %s\r\n", from)
	fmt.Fprintf(&hdr, "To: %s\r\n", to)
	fmt.Fprintf(&hdr, "Subject: %s\r\n", subjectFinal)
	fmt.Fprintf(&hdr, "X-Kitp-Thread-Id: %s\r\n", threadID)
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
	if w, err := mw.CreatePart(textHdr); err == nil {
		_, _ = w.Write([]byte(bodyWithRef))
	}

	for _, a := range atts {
		ah := textproto.MIMEHeader{}
		ctype := a.MimeType
		if ctype == "" {
			ctype = "application/octet-stream"
		}
		ah.Set("Content-Type", ctype)
		ah.Set("Content-Transfer-Encoding", "base64")
		// Strip embedded quotes so the filename always sits in a clean
		// quoted-string. mime.FormatMediaType returns "" for an empty
		// media type, so build the disposition by hand.
		safeName := strings.ReplaceAll(a.Filename, `"`, ``)
		ah.Set("Content-Disposition",
			fmt.Sprintf(`attachment; filename="%s"`, safeName))
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
			_, _ = w.Write([]byte(encoded[i:end] + "\r\n"))
		}
	}
	_ = mw.Close()

	out := make([]byte, 0, len(hdr.String())+body64.Len())
	out = append(out, hdr.String()...)
	out = append(out, body64.Bytes()...)
	return out
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
func (s *SMTPSender) loadReplyAttachments(ctx context.Context, replyID int64) ([]mimeAttachment, error) {
	rows, err := s.pool.P.Query(ctx, `
		SELECT a.id, f.filename, f.mime_type, fc.seq,
		       coalesce(cd.data, ''::bytea)
		FROM reply_body_attachment rba
		JOIN attachment a    ON a.id = rba.attachment_id AND a.deleted_at IS NULL
		JOIN file f          ON f.id = a.file_id
		JOIN file_chunk fc   ON fc.file_id = f.id
		LEFT JOIN cas_blob_data cd ON cd.address = fc.cas_address
		WHERE rba.reply_body_id = $1
		ORDER BY a.id, fc.seq
	`, replyID)
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
// envelope addresses. Tries net/mail.ParseAddressList first so
// "Alice <alice@x>, bob@y" works; falls back to a comma split so a
// loosely-formatted value still produces RCPT entries rather than
// failing the whole send. Empty input returns an empty slice (the
// caller treats that as a hard error).
func parseRecipients(to string) ([]string, error) {
	trimmed := strings.TrimSpace(to)
	if trimmed == "" {
		return nil, nil
	}
	if addrs, err := mail.ParseAddressList(trimmed); err == nil {
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
		if s != "" {
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
