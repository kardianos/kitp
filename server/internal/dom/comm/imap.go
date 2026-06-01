// Package comm — IMAP poller goroutine (Gate 6 of email_comm_spec.md).
//
// One IMAPPoller goroutine runs per comm_channel card. On every tick
// (default 60s; tunable via KITP_COMM_IMAP_TICK_SEC) the poller asks
// its imapClient for unseen messages, parses each (envelope + body),
// then routes via the three-tier threading lookup:
//
//  1. MIME header `X-Kitp-Thread-Id`.
//  2. Subject suffix `[#<id>]`.
//  3. Body trailer line `Ref: <id>` (last ~20 lines).
//
// First match wins. Matched → append a reply_body card (delivery_status
// = 'received') to the matched comm's replies list. Unmatched + the
// channel has intake_status configured → create a new task with the
// inbound subject/body and a fresh comm. Unmatched + no intake →
// comm_log kind='unmatched_thread' and discard.
//
// Concurrency model mirrors SMTP: one poller per channel, never two.
// On IMAP failure (auth, dial, fetch) the poll backs off exponentially
// up to a 10-minute ceiling and logs a comm_log row so operators can
// see why an inbox isn't draining.
//
// The seam between protocol concerns (FETCH / STORE) and our
// threading + insert logic is the imapClient interface; tests inject
// a fake that feeds canned InboundMessage values into RunOnce.
//
//	KITP_COMM_IMAP_TICK_SEC=60     poll interval; default 60s
//	KITP_COMM_IMAP_DRY_RUN=0       when "1", log and continue without
//	                               opening an IMAP connection
//	KITP_COMM_IMAP_INSECURE=0      when "1", allow plaintext IMAP (no
//	                               TLS); dev only
//	KITP_COMM_BODY_PRIORITY=plain,html
//	                               comma-separated order in which to source a
//	                               new task's description from the message's
//	                               body parts. Tokens: "plain" (text/plain via
//	                               mailmd.FromText) and "html" (text/html via
//	                               mailmd.FromHTML). The first token whose part
//	                               is present wins; a part that's absent or
//	                               empty falls through to the next. "plain" or
//	                               "html" alone restricts to that one type.
//	                               Unrecognised / empty → the plain,html
//	                               default.
//	KITP_COMM_SAVE_RAW_EMAIL=0     when "1", attach the verbatim RFC822
//	                               message as a `.eml` file on the task — a
//	                               debugging aid for refining body-conversion
//	                               rules against real problem mail
package comm

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"net/textproto"
	"os"
	"regexp"
	"strings"
	"time"

	imap "github.com/emersion/go-imap"
	imapclient "github.com/emersion/go-imap/client"
	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/job"
	"github.com/kitp/kitp/server/internal/mailmd"
	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

// IMAPPoller owns one channel's poll state (backoff counters + the dial
// seam). An [IMAPPool] holds one poller per channel and drives them from
// a single scheduler job via Tick; RunOnce runs one scan+ingest cycle and
// is exported so tests can drive it synchronously.
type IMAPPoller struct {
	pool      *store.Pool
	channelID int64
	tick      time.Duration
	dryRun    bool
	insecure  bool
	// bodyPriority is the ordered set of body extractors a new task's
	// description is sourced from (resolved once from KITP_COMM_BODY_PRIORITY
	// at construction). The first extractor whose body part exists wins; see
	// resolveBodyPriority / descriptionMarkdown.
	bodyPriority []bodyExtractor
	// saveRawEmail persists the verbatim RFC822 message as a `.eml`
	// attachment on the task when set (KITP_COMM_SAVE_RAW_EMAIL=1). Off by
	// default; a debugging aid for deriving better body-conversion rules
	// from real problem mail.
	saveRawEmail bool
	logger       *slog.Logger

	// dial is the imapClient factory the loop calls each tick. Tests
	// swap it for a stub that returns a fake; production uses the real
	// dialer. Returning a fresh client per tick keeps connection state
	// simple — no long-lived sockets to babysit through transient
	// network failures.
	dial IMAPDialFunc

	// Backoff state. Adjusted on every RunOnce: cleared on success,
	// doubled (up to backoffMax) on each failure. The ticker still
	// fires on its base cadence; we just skip the actual poll while
	// backing off.
	backoff       time.Duration
	nextAttemptAt time.Time
	// capHits is the number of *consecutive* failures we've had while
	// already at backoffMax. Reset to 0 on any success. Once it crosses
	// sustainedFailureCapHits we mark the channel disabled-fault — the
	// "this is no longer transient" signal. See bumpBackoff for the
	// increment rule.
	capHits int
}

// IMAPDialFunc opens an authenticated IMAP session with INBOX selected
// and returns an InboundClient ready for FetchUnseen / MarkSeen /
// Close. Tests replace this with a stub; production uses dialIMAP.
type IMAPDialFunc func(ctx context.Context, cfg IMAPConfig) (InboundClient, error)

// InboundClient is the test-visible alias for the imapClient seam.
// Exposed so the in-process stub in imap_test.go can satisfy the dial
// function's signature without depending on go-imap. Production code
// uses the unexported imapClient interface; the alias keeps the
// public surface intentionally narrow.
type InboundClient = imapClient

// IMAPConfig is the channel-derived dial configuration we hand the
// dialer per tick. All fields come from comm_channel attribute_value
// rows + the decrypted imap_password from comm_secret.
type IMAPConfig struct {
	Host     string
	Port     int
	Username string
	Password string
	Insecure bool // KITP_COMM_IMAP_INSECURE=1; dev only
}

// imapClient is the seam between protocol concerns (IMAP wire) and
// the poller's threading + insert logic. Production uses
// realIMAPClient (wraps emersion/go-imap); tests use a stub that
// returns canned InboundMessage values.
type imapClient interface {
	// FetchUnseen returns every message currently in INBOX without
	// the \Seen flag. UID is set on each message; the caller passes
	// it back to MarkSeen.
	FetchUnseen(ctx context.Context) ([]InboundMessage, error)
	// MarkSeen flips the \Seen flag on the supplied UIDs. The poller
	// only marks messages we successfully ingested — parse failures
	// stay unseen so a retry has a chance.
	MarkSeen(ctx context.Context, uids []uint32) error
	// Close releases the underlying connection. Idempotent.
	Close() error
}

// InboundMessage is the parsed shape of one inbound email. The dialer
// is responsible for converting wire bytes into this struct so the
// rest of the package never touches go-imap types — keeps the unit
// tests independent of the IMAP protocol.
type InboundMessage struct {
	UID         uint32
	MessageID   string // RFC822 Message-ID header (informational)
	From        string // address-list as a single text field
	To          string
	Cc          string // address-list; comma-joined like To
	Subject     string
	ThreadIDHdr string // X-Kitp-Thread-Id header value, if present
	Body        string // plain-text body for the reply bubble (text/plain part, else text/html stripped to plain)
	// BodyPlain is the message's text/plain part ONLY — empty when the
	// message carried no plain arm (unlike Body, which falls back to stripped
	// HTML). The description's body-priority selector uses this to tell "has a
	// real plain part" from "only HTML was available".
	BodyPlain string
	// BodyHTML is the raw text/html part of the message, when one was present
	// (multipart/alternative html arm, or a top-level text/html body). Empty
	// for plain-text-only mail. The description's body-priority selector feeds
	// it to mailmd.FromHTML so the initial task description can keep the
	// sender's formatting.
	BodyHTML string
	// Raw is the verbatim RFC822 byte buffer the message was parsed from.
	// Retained so the ingest path can persist it as a `.eml` attachment when
	// KITP_COMM_SAVE_RAW_EMAIL=1 (a debugging aid for refining the body
	// conversion rules against real problem mail).
	Raw []byte
	// Attachments captures every multipart part with a
	// Content-Disposition of `attachment` (or any non-text part), so
	// the ingest path can recognise round-trip attachments and skip
	// duplicate storage. Empty when the message is single-part or
	// has only text parts.
	Attachments []InboundAttachment
}

// InboundAttachment is one extracted attachment payload. Bytes are
// fully decoded (base64 / quoted-printable already applied by the
// multipart reader). Filename falls back to "attachment-<n>" when the
// Content-Disposition header is missing or unparseable so the file
// row always has a non-empty name.
type InboundAttachment struct {
	Filename string
	MimeType string
	Bytes    []byte
}

// NewIMAPPollerForTest builds an IMAPPoller so tests can drive RunOnce /
// Tick synchronously. Production builds them through an [IMAPPool], which
// reconciles one poller per channel and ticks them via the scheduler.
func NewIMAPPollerForTest(pool *store.Pool, channelID int64, tick time.Duration) *IMAPPoller {
	return newIMAPPoller(pool, channelID, tick)
}

func newIMAPPoller(pool *store.Pool, channelID int64, tick time.Duration) *IMAPPoller {
	if tick < 5*time.Second {
		tick = 5 * time.Second
	}
	p := &IMAPPoller{
		pool:         pool,
		channelID:    channelID,
		tick:         tick,
		dryRun:       os.Getenv("KITP_COMM_IMAP_DRY_RUN") == "1",
		insecure:     os.Getenv("KITP_COMM_IMAP_INSECURE") == "1",
		bodyPriority: resolveBodyPriority(os.Getenv("KITP_COMM_BODY_PRIORITY")),
		saveRawEmail: os.Getenv("KITP_COMM_SAVE_RAW_EMAIL") == "1",
		logger:       slog.Default(),
	}
	p.dial = dialIMAP
	return p
}

// SetLogger lets the registrar override the default slog.Default()
// logger. Useful for the main process where obs.NewLogger emits JSON.
func (p *IMAPPoller) SetLogger(l *slog.Logger) {
	if l != nil {
		p.logger = l
	}
}

// SetDialFunc swaps the imapClient factory. Tests inject a stub here;
// production leaves it alone (dialIMAP is the default).
func (p *IMAPPoller) SetDialFunc(f IMAPDialFunc) {
	if f != nil {
		p.dial = f
	}
}

// backoffMin / backoffMax bracket the exponential backoff window the
// poller uses after IMAP failures. The ceiling matches the spec's
// "10-minute" guidance.
const (
	backoffMin = 30 * time.Second
	backoffMax = 10 * time.Minute
)

// sustainedFailureCapHits is the number of consecutive failures at the
// backoff ceiling required to flip the channel into disabled-fault.
// With backoffMax=10m, capHits=2 means we have been failing at the
// ceiling for ~20 minutes after the initial ramp (~35 minutes of
// total continuous failure) before disabling — long enough that
// brief outages don't get a channel stuck, short enough that a
// genuinely broken channel doesn't spam logs forever.
const sustainedFailureCapHits = 2

// looksLikeAuthError returns true when err reads like an IMAP
// credential failure (bad username/password, account locked, no auth
// mechanism). These are "human must intervene" signals — retrying
// with the same creds will keep failing and risks account lockout —
// so we trip disabled-fault immediately rather than waiting for
// sustained-backoff. Network errors (i/o timeout, connection refused,
// TLS) deliberately fall through to the backoff path; transient
// outages must not strand a healthy channel.
//
// The match is substring-based against the wire text the IMAP server
// (or the dial code) returns — IMAP doesn't carry typed errors and
// every server phrases credential rejections differently. Keep this
// list narrow; false positives disable a working channel.
func looksLikeAuthError(err error) bool {
	if err == nil {
		return false
	}
	s := strings.ToLower(err.Error())
	needles := []string{
		"authenticationfailed", // RFC 5530 response code, most modern servers
		"invalid credentials",
		"invalid login",
		"login failed",
		"bad credentials",
		"wrong password",
		"no auth",
		"auth failed",
		"authentication failed",
	}
	for _, n := range needles {
		if strings.Contains(s, n) {
			return true
		}
	}
	return false
}

// Tick runs one poll attempt subject to the poller's backoff gate: while
// backing off it returns nil without dialing. On RunOnce failure it bumps
// the backoff and, after sustained ceiling failures, trips the channel
// into disabled-fault; on success it clears the backoff. Logs the failure
// itself (with channel_id) and returns the RunOnce error so callers can
// observe it — the [IMAPPool] sweep discards it to keep the poll job green
// (a transient channel error isn't a scheduler-job failure). One IMAP
// session is dialed + closed per call, so there's nothing to drain between
// ticks.
func (p *IMAPPoller) Tick(ctx context.Context) error {
	if time.Now().Before(p.nextAttemptAt) {
		return nil // still backing off
	}
	runCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	runCtx = auth.WithSystemUser(runCtx)
	err := p.RunOnce(runCtx)
	if err != nil {
		p.bumpBackoff()
		p.logger.LogAttrs(runCtx, slog.LevelError, "imap poller RunOnce",
			slog.Int64("channel_id", p.channelID),
			slog.Duration("backoff", p.backoff),
			slog.Int("cap_hits", p.capHits),
			slog.String("err", err.Error()))
		// Sustained-failure trip: once we've been failing at the backoff
		// ceiling for the threshold, treat it as "this is no longer
		// transient" and disable the channel until an admin re-enables.
		if p.capHits >= sustainedFailureCapHits {
			if mfErr := MarkChannelFault(runCtx, p.pool, p.channelID,
				fmt.Sprintf("sustained polling failure: %v", err)); mfErr != nil {
				p.logger.LogAttrs(runCtx, slog.LevelError, "imap poller mark fault",
					slog.Int64("channel_id", p.channelID),
					slog.String("err", mfErr.Error()))
			}
		}
		return err
	}
	p.backoff = 0
	p.nextAttemptAt = time.Time{}
	p.capHits = 0
	return nil
}

func (p *IMAPPoller) bumpBackoff() {
	prev := p.backoff
	if p.backoff == 0 {
		p.backoff = backoffMin
	} else {
		p.backoff *= 2
		if p.backoff > backoffMax {
			p.backoff = backoffMax
		}
	}
	// Only count consecutive cap-hits: the *first* failure that lands
	// us at the ceiling doesn't trip yet (it could still be the tail
	// of a ramp). Each subsequent failure with prev already at the
	// ceiling does.
	if prev == backoffMax && p.backoff == backoffMax {
		p.capHits++
	}
	p.nextAttemptAt = time.Now().Add(p.backoff)
}

// Backoff returns the current backoff duration. Tests assert this
// grows after repeated RunOnce failures.
func (p *IMAPPoller) Backoff() time.Duration { return p.backoff }

// BumpBackoffForTest exposes the internal backoff helper so tests
// can drive the exponential-doubling assertion without piping
// errors through a fake imapClient.
func (p *IMAPPoller) BumpBackoffForTest() { p.bumpBackoff() }

// CapHitsForTest reports the consecutive-cap-hit counter used by the
// sustained-failure auto-disable path. Tests assert this rolls in
// step with bumpBackoff once the ceiling is reached.
func (p *IMAPPoller) CapHitsForTest() int { return p.capHits }

// RunOnce executes one scan + ingest cycle synchronously. Exported so
// tests can drive the loop without waiting on the ticker. Loads the
// channel config + decrypted IMAP password from one short tx, dials
// the imapClient, fetches unseen, processes each message in a
// separate write tx, then marks the successfully-ingested UIDs as
// seen. Returns the first error encountered; the loop logs and
// applies exponential backoff.
func (p *IMAPPoller) RunOnce(ctx context.Context) error {
	// Honour the channel's tri-state status before touching the IMAP
	// server. A disabled channel doesn't log a poll row either — the
	// admin UI surfaces status separately, and writing poll rows for
	// channels that aren't actually polled would muddy the operator
	// view of liveness.
	status, _, err := ReadChannelStatus(ctx, p.pool.P, p.channelID)
	if err != nil {
		return fmt.Errorf("imap poller: read status: %w", err)
	}
	if status != ChannelStatusEnabled {
		p.logger.LogAttrs(ctx, slog.LevelDebug, "imap skip: channel not enabled",
			slog.Int64("channel_id", p.channelID),
			slog.String("status", status))
		return nil
	}

	cfg, projectID, intakeStatusID, err := p.loadChannelConfig(ctx)
	if err != nil {
		return fmt.Errorf("imap poller: load config: %w", err)
	}

	// Config snapshot (no secrets). The common "no new tasks" cause shows
	// up here: intake_status_id=0 means every non-reply message is dropped
	// (see processOne); has_password=false means dial will fail.
	p.logger.LogAttrs(ctx, slog.LevelDebug, "imap channel config",
		slog.Int64("channel_id", p.channelID),
		slog.String("host", cfg.Host),
		slog.Int("port", cfg.Port),
		slog.Bool("has_username", cfg.Username != ""),
		slog.Bool("has_password", cfg.Password != ""),
		slog.Int64("project_id", projectID),
		slog.Int64("intake_status_id", intakeStatusID))

	if p.dryRun {
		p.logger.LogAttrs(ctx, slog.LevelInfo, "imap dry-run",
			slog.Int64("channel_id", p.channelID),
			slog.String("host", cfg.Host),
			slog.Int("port", cfg.Port))
		// Still record a poll log row so operators see the dry-run
		// cadence in the comm_log stream.
		return p.recordPollOnly(ctx, projectID, 0)
	}

	cfg.Insecure = p.insecure
	client, err := p.dial(ctx, cfg)
	if err != nil {
		_ = p.recordAuthFail(ctx, projectID, err)
		// Credential-shaped failures are the "human must intervene"
		// signal: bad creds, account locked, no auth mechanism. Those
		// trip disabled-fault immediately so we stop hammering the
		// server and risking lockouts. Network / TLS / timeout
		// failures (the common transient-blip case) fall through to
		// the backoff path; sustained backoff at the ceiling will
		// trip them eventually if they persist.
		if looksLikeAuthError(err) {
			if mfErr := MarkChannelFault(ctx, p.pool, p.channelID,
				fmt.Sprintf("IMAP authentication failed: %v", err)); mfErr != nil {
				p.logger.LogAttrs(ctx, slog.LevelError, "imap poller mark fault",
					slog.Int64("channel_id", p.channelID),
					slog.String("err", mfErr.Error()))
			}
		}
		return fmt.Errorf("imap dial: %w", err)
	}
	defer func() { _ = client.Close() }()
	p.logger.LogAttrs(ctx, slog.LevelDebug, "imap connected",
		slog.Int64("channel_id", p.channelID),
		slog.String("host", cfg.Host))

	msgs, err := client.FetchUnseen(ctx)
	if err != nil {
		return fmt.Errorf("imap fetch: %w", err)
	}
	p.logger.LogAttrs(ctx, slog.LevelDebug, "imap fetched unseen",
		slog.Int64("channel_id", p.channelID),
		slog.Int("count", len(msgs)))

	var ingested []uint32
	var firstErr error
	for _, m := range msgs {
		if err := p.processOne(ctx, projectID, intakeStatusID, m); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			// Skip MarkSeen for this UID so a retry can pick it up.
			continue
		}
		ingested = append(ingested, m.UID)
	}

	if err := p.recordPollOnly(ctx, projectID, len(msgs)); err != nil && firstErr == nil {
		firstErr = err
	}
	if len(ingested) > 0 {
		if err := client.MarkSeen(ctx, ingested); err != nil && firstErr == nil {
			firstErr = fmt.Errorf("imap mark seen: %w", err)
		}
	}
	p.logger.LogAttrs(ctx, slog.LevelDebug, "imap cycle complete",
		slog.Int64("channel_id", p.channelID),
		slog.Int("fetched", len(msgs)),
		slog.Int("ingested", len(ingested)))
	return firstErr
}

// loadChannelConfig reads the channel's IMAP host/port/username +
// decrypted imap_password + intake_status_id + enclosing project id.
// One round-trip; returns IMAPConfig + project + intake or an error
// shaped for the caller to log directly.
func (p *IMAPPoller) loadChannelConfig(ctx context.Context) (IMAPConfig, int64, int64, error) {
	var cfg IMAPConfig
	var projectID int64
	var intakeID int64
	row := p.pool.P.QueryRow(ctx, `
		SELECT
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = $1 AND ad.name='imap_host'), '')      AS imap_host,
			COALESCE((SELECT (value)::text::int FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = $1 AND ad.name='imap_port' AND jsonb_typeof(value)='number'), 0) AS imap_port,
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = $1 AND ad.name='imap_username'), '')  AS imap_username,
			COALESCE(
				(SELECT pgp_sym_decrypt(cs.imap_password, current_setting('app.comm_secret_key'))
					FROM comm_secret cs WHERE cs.channel_card_id = $1 AND cs.imap_password IS NOT NULL),
				''
			) AS imap_password,
			COALESCE((SELECT (value)::text::bigint FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = $1 AND ad.name='intake_status' AND jsonb_typeof(value)='number'), 0) AS intake_status_id,
			COALESCE((SELECT parent_card_id FROM card WHERE id = $1), 0) AS project_id
	`, p.channelID)
	if err := row.Scan(&cfg.Host, &cfg.Port, &cfg.Username, &cfg.Password, &intakeID, &projectID); err != nil {
		return cfg, 0, 0, err
	}
	if cfg.Port == 0 {
		cfg.Port = 993
	}
	return cfg, projectID, intakeID, nil
}

// recordAuthFail writes a comm_log kind=imap_auth_fail row capturing
// the error message. Best-effort: a failure to log doesn't surface
// (we already returned the dial error to the caller).
func (p *IMAPPoller) recordAuthFail(ctx context.Context, projectID int64, dialErr error) error {
	detail := map[string]any{"error": dialErr.Error()}
	d, _ := json.Marshal(detail)
	_, err := p.pool.P.Exec(ctx, `
		INSERT INTO comm_log (project_id, channel_id, kind, detail)
		VALUES ($1, $2, 'imap_auth_fail', $3::jsonb)
	`, projectID, p.channelID, d)
	return err
}

// recordPollOnly writes a comm_log kind=poll row with the number of
// messages processed in this cycle. Always one row per RunOnce so
// operators can see liveness on the channel.
func (p *IMAPPoller) recordPollOnly(ctx context.Context, projectID int64, count int) error {
	detail := map[string]any{"message_count": count}
	d, _ := json.Marshal(detail)
	_, err := p.pool.P.Exec(ctx, `
		INSERT INTO comm_log (project_id, channel_id, kind, detail)
		VALUES ($1, $2, 'poll', $3::jsonb)
	`, projectID, p.channelID, d)
	if err != nil {
		return err
	}
	if p.pool != nil {
		p.pool.NoteWrite()
	}
	return nil
}

// processOne ingests one inbound message: thread-lookup, then either
// append-to-existing-comm or create-new-comm-with-task. All state
// mutations happen in one tx per message so a mid-stream failure
// doesn't half-commit.
func (p *IMAPPoller) processOne(ctx context.Context, projectID, intakeStatusID int64, m InboundMessage) error {
	threadID, source := extractThreadID(m)

	actorID := auth.ActorOrSystem(ctx)
	// Root transaction for this message. Everything below runs on tx (a
	// store.Querier); only this frame commits/rolls back. The deferred
	// Rollback is unconditional and a no-op once Commit has run.
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	snap, err := schema.Load(ctx, tx)
	if err != nil {
		return fmt.Errorf("load schema: %w", err)
	}

	var matchedCommID int64
	if threadID != "" {
		matchedCommID, err = p.findCommByThreadID(ctx, tx, threadID)
		if err != nil {
			return fmt.Errorf("thread lookup: %w", err)
		}
	}

	switch {
	case matchedCommID != 0:
		p.logger.LogAttrs(ctx, slog.LevelDebug, "imap message → reply on existing comm",
			slog.Int64("channel_id", p.channelID),
			slog.Int64("comm_id", matchedCommID),
			slog.String("thread_source", source),
			slog.String("message_id", m.MessageID),
			slog.String("subject", m.Subject))
		if err := p.appendReceivedReply(ctx, tx, snap, matchedCommID, m, actorID); err != nil {
			return p.logParseError(ctx, projectID, m, err)
		}
	case intakeStatusID != 0:
		p.logger.LogAttrs(ctx, slog.LevelDebug, "imap message → new task",
			slog.Int64("channel_id", p.channelID),
			slog.Int64("project_id", projectID),
			slog.Int64("intake_status_id", intakeStatusID),
			slog.String("from", m.From),
			slog.String("subject", m.Subject))
		if err := p.createTaskAndComm(ctx, tx, snap, projectID, intakeStatusID, m, actorID); err != nil {
			return p.logParseError(ctx, projectID, m, err)
		}
	default:
		// Discard: no thread match, no intake configured. This is the
		// usual "inbound mail isn't becoming tasks" cause — surface it at
		// WARN (not just the comm_log row below) so it's visible in logs.
		p.logger.LogAttrs(ctx, slog.LevelWarn, "imap message dropped: no thread match and channel has no intake_status configured",
			slog.Int64("channel_id", p.channelID),
			slog.Int64("project_id", projectID),
			slog.String("from", m.From),
			slog.String("subject", m.Subject),
			slog.String("thread_source", source))
		detail := map[string]any{
			"message_id":    m.MessageID,
			"from":          m.From,
			"subject":       m.Subject,
			"thread_source": source,
		}
		d, _ := json.Marshal(detail)
		if _, err := tx.Exec(ctx, `
			INSERT INTO comm_log (project_id, channel_id, kind, detail)
			VALUES ($1, $2, 'unmatched_thread', $3::jsonb)
		`, projectID, p.channelID, d); err != nil {
			return fmt.Errorf("comm_log unmatched: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	if p.pool != nil {
		p.pool.NoteWrite()
	}
	return nil
}

// logParseError writes a comm_log kind=parse_error row outside the
// failed message's tx, then returns the original error so the loop
// can surface it. The comm_log insert is best-effort: a failure here
// can't shadow the original parse error (the caller already knows
// the message is unusable), but we LOG the secondary failure
// instead of silently dropping it so an operator can spot
// "comm_log table broken" if it happens at scale.
func (p *IMAPPoller) logParseError(ctx context.Context, projectID int64, m InboundMessage, origErr error) error {
	detail := map[string]any{
		"message_id": m.MessageID,
		"subject":    m.Subject,
		"error":      origErr.Error(),
	}
	d, err := json.Marshal(detail)
	if err != nil {
		slog.Default().LogAttrs(ctx, slog.LevelWarn, "imap parse_error log marshal",
			slog.String("err", err.Error()))
		return origErr
	}
	if _, err := p.pool.P.Exec(ctx, `
		INSERT INTO comm_log (project_id, channel_id, kind, detail)
		VALUES ($1, $2, 'parse_error', $3::jsonb)
	`, projectID, p.channelID, d); err != nil {
		slog.Default().LogAttrs(ctx, slog.LevelWarn, "imap parse_error log insert",
			slog.String("err", err.Error()))
	}
	return origErr
}

// findCommByThreadID returns the comm card id whose thread_id
// attribute matches the supplied token, or 0 if none. We don't filter
// by channel_ref — the spec calls out cross-channel matches as a
// false-positive risk worth warning about, but functionally the
// match is global within the install.
func (p *IMAPPoller) findCommByThreadID(ctx context.Context, tx store.Querier, threadID string) (int64, error) {
	var id int64
	err := tx.QueryRow(ctx, `
		SELECT av.card_id
		FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		JOIN card c ON c.id = av.card_id
		WHERE ad.name = 'thread_id'
		  AND av.value = to_jsonb($1::text)
		  AND c.deleted_at IS NULL
		LIMIT 1
	`, threadID).Scan(&id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, nil
		}
		return 0, err
	}
	return id, nil
}

// appendReceivedReply inserts a reply_body card carrying the inbound
// envelope + body and appends its id to the comm's replies attribute.
// Mirrors insertReceivedReply but accepts the full inbound envelope
// (From/To) so the reply_to / reply_from rows reflect who actually
// sent the message rather than empty strings.
func (p *IMAPPoller) appendReceivedReply(ctx context.Context, tx store.Querier, snap *schema.Snapshot, commID int64, m InboundMessage, actorID int64) error {
	replyCTID, err := resolveCardType(snap, "reply_body")
	if err != nil {
		return err
	}
	var replyID int64
	if err := tx.QueryRow(ctx, `
		INSERT INTO card (card_type_id) VALUES ($1) RETURNING id
	`, replyCTID).Scan(&replyID); err != nil {
		return fmt.Errorf("insert reply_body card: %w", err)
	}
	if err := writeCardCreateActivity(ctx, tx, replyID, actorID); err != nil {
		return err
	}
	jstr := func(s string) json.RawMessage { b, _ := json.Marshal(s); return b }
	writes := []struct {
		name string
		val  json.RawMessage
	}{
		{"reply_to", jstr(m.To)},
		{"reply_from", jstr(m.From)},
		{"reply_subject", jstr(m.Subject)},
		{"reply_body_text", jstr(m.Body)},
		{"delivery_status", jstr("received")},
	}
	for _, w := range writes {
		ad, ok := snap.AttrByName[w.name]
		if !ok {
			return fmt.Errorf("appendReceivedReply: missing attribute_def %q", w.name)
		}
		if err := writeAttributeValue(ctx, tx, replyID, ad.ID, w.val, actorID); err != nil {
			return err
		}
	}
	if err := appendCardRefList(ctx, tx, commID, "replies", replyID, snap, actorID); err != nil {
		return err
	}
	// Resolve the comm's parent task once so attachment ingest can
	// dedup against existing attachments on that task (round-trip
	// recognition) without re-querying per attachment.
	var parentTaskID int64
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(parent_card_id, 0)
		FROM card WHERE id = $1
	`, commID).Scan(&parentTaskID); err != nil {
		return fmt.Errorf("appendReceivedReply: load parent task: %w", err)
	}
	if parentTaskID != 0 && len(m.Attachments) > 0 {
		if err := p.ingestInboundAttachments(ctx, tx, parentTaskID, replyID, m.Attachments, actorID); err != nil {
			// One attachment row that fails to land shouldn't lose the
			// whole reply — log loudly and keep going. The reply_body
			// is already persisted at this point.
			p.logger.LogAttrs(ctx, slog.LevelWarn, "imap attachment ingest failed",
				slog.Int64("channel_id", p.channelID),
				slog.Int64("comm_id", commID),
				slog.Int64("reply_id", replyID),
				slog.String("error", err.Error()))
		}
	}
	if parentTaskID != 0 && p.saveRawEmail && len(m.Raw) > 0 {
		// Debugging aid (KITP_COMM_SAVE_RAW_EMAIL=1): keep the verbatim
		// message so we can replay it against the body-conversion rules when
		// a description comes out wrong. Best-effort — never fail the inbound
		// over it.
		name := fmt.Sprintf("inbound-uid-%d.eml", m.UID)
		if _, err := storeAttachment(ctx, tx, parentTaskID, replyID, name, "message/rfc822", m.Raw, actorID); err != nil {
			p.logger.LogAttrs(ctx, slog.LevelWarn, "imap save raw email failed",
				slog.Int64("channel_id", p.channelID),
				slog.Int64("comm_id", commID),
				slog.Int64("reply_id", replyID),
				slog.String("error", err.Error()))
		}
	}
	if err := p.syncCommRecipientsFromInbound(ctx, tx, snap, commID, m, actorID); err != nil {
		// Log but don't fail the whole inbound — the message + reply
		// landed; participant tracking can be fixed up later by an
		// operator editing recipients manually.
		p.logger.LogAttrs(ctx, slog.LevelWarn, "imap recipient sync failed",
			slog.Int64("channel_id", p.channelID),
			slog.Int64("comm_id", commID),
			slog.String("error", err.Error()))
	}
	return nil
}

// ingestInboundAttachments persists every inbound attachment as a
// task attachment (linked to the reply via reply_body_attachment)
// while deduping against round-trips. The dedup contract: for each
// inbound part, if the parent task already has a non-deleted
// attachment whose file's sha256 matches, reuse the existing
// attachment row and skip the new file/attachment inserts. This
// catches the common case where the user attached a file from the
// task, the mail round-trips back via IMAP, and the receiving end
// shouldn't grow a duplicate copy.
//
// New attachments land via the same shape as the file.create handler:
// cas_blob (ON CONFLICT on the digest), cas_blob_data (idem), file
// row with sha256 set, single file_chunk pointing at the blob,
// attachment row on the parent task.
func (p *IMAPPoller) ingestInboundAttachments(
	ctx context.Context,
	tx store.Querier,
	parentTaskID int64,
	replyID int64,
	atts []InboundAttachment,
	actorID int64,
) error {
	for _, a := range atts {
		sum := sha256.Sum256(a.Bytes)
		digest := hex.EncodeToString(sum[:])
		mt := a.MimeType
		if mt == "" {
			mt = "application/octet-stream"
		}
		filename := a.Filename
		if filename == "" {
			filename = "attachment"
		}

		// Round-trip dedup: same digest on the same parent task ⇒
		// reuse the existing attachment row, just link it to the
		// inbound reply via reply_body_attachment.
		db := named.New()
		db.Set("card_id", parentTaskID)
		db.Set("sha", digest)
		dedupSQL, dedupArgs, err := db.Compile(`
			SELECT a.id
			FROM attachment a
			JOIN file f ON f.id = a.file_id
			WHERE a.card_id = :card_id
			  AND a.deleted_at IS NULL
			  AND f.sha256 = :sha
			LIMIT 1
		`)
		if err != nil {
			return fmt.Errorf("ingestInboundAttachments: dedup compile: %w", err)
		}
		var existingAttID int64
		err = tx.QueryRow(ctx, dedupSQL, dedupArgs...).Scan(&existingAttID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("ingestInboundAttachments: dedup lookup: %w", err)
		}
		if existingAttID != 0 {
			lb := named.New()
			lb.Set("reply_id", replyID)
			lb.Set("attachment_id", existingAttID)
			linkSQL, linkArgs, err := lb.Compile(`
				INSERT INTO reply_body_attachment (reply_body_id, attachment_id)
				VALUES (:reply_id, :attachment_id)
				ON CONFLICT DO NOTHING
			`)
			if err != nil {
				return fmt.Errorf("ingestInboundAttachments: link compile: %w", err)
			}
			if _, err := tx.Exec(ctx, linkSQL, linkArgs...); err != nil {
				return fmt.Errorf("ingestInboundAttachments: link existing: %w", err)
			}
			continue
		}

		// Novel content: store the bytes as a fresh attachment on the task,
		// linked to this reply. storeAttachment recomputes the digest, but
		// CAS bytes are reused on conflict so no duplicate blob lands.
		if _, err := storeAttachment(ctx, tx, parentTaskID, replyID, filename, mt, a.Bytes, actorID); err != nil {
			return fmt.Errorf("ingestInboundAttachments: %w", err)
		}
	}
	return nil
}

// storeAttachment persists data as a new file + attachment on parentTaskID
// and links it to replyID via reply_body_attachment, returning the new
// attachment id. It follows the same shape as the file.create handler —
// cas_blob (ON CONFLICT on the digest, so identical bytes already in CAS are
// reused), cas_blob_data (idem), a file row with sha256 set, one file_chunk
// pointing at the blob, the attachment row, then the reply link — but folds
// the whole chain into ONE data-modifying CTE statement so it's a single
// round-trip inside the caller's tx. (The standalone cas.PgBackend.Put /
// file.create paths each open their own tx or assume bytes are pre-uploaded,
// so neither composes into the poller's per-message tx.) The file_chunk →
// cas_blob FK is satisfied because non-deferrable FK checks run at end of
// statement, by which point the blob CTE has inserted the address. Callers
// that want round-trip dedup must look for an existing attachment first; this
// helper always creates a new file + attachment row.
func storeAttachment(
	ctx context.Context,
	tx store.Querier,
	parentTaskID int64,
	replyID int64,
	filename string,
	mimeType string,
	data []byte,
	actorID int64,
) (int64, error) {
	sum := sha256.Sum256(data)
	digest := hex.EncodeToString(sum[:])
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	if filename == "" {
		filename = "attachment"
	}

	b := named.New()
	b.Set("address", digest)
	b.Set("size", int64(len(data)))
	b.Set("mime", mimeType)
	b.Set("data", data)
	b.Set("filename", filename)
	b.Set("actor", actorID)
	b.Set("card_id", parentTaskID)
	b.Set("reply_id", replyID)
	sql, args, err := b.Compile(`
		WITH blob AS (
			INSERT INTO cas_blob (address, size_bytes, mime_type, storage_kind)
			VALUES (:address, :size, :mime, 'pg')
			ON CONFLICT (address) DO NOTHING
		),
		blob_data AS (
			INSERT INTO cas_blob_data (address, data)
			VALUES (:address, :data)
			ON CONFLICT (address) DO NOTHING
		),
		new_file AS (
			INSERT INTO file (filename, size_bytes, mime_type, created_by, sha256)
			VALUES (:filename, :size, :mime, :actor, :address)
			RETURNING id
		),
		new_chunk AS (
			INSERT INTO file_chunk (file_id, seq, cas_address, chunk_size)
			SELECT id, 0, :address, :size FROM new_file
		),
		new_attach AS (
			INSERT INTO attachment (card_id, file_id)
			SELECT :card_id, id FROM new_file
			RETURNING id
		)
		INSERT INTO reply_body_attachment (reply_body_id, attachment_id)
		SELECT :reply_id, id FROM new_attach
		RETURNING attachment_id
	`)
	if err != nil {
		return 0, fmt.Errorf("storeAttachment: compile: %w", err)
	}
	var newAttID int64
	if err := tx.QueryRow(ctx, sql, args...).Scan(&newAttID); err != nil {
		return 0, fmt.Errorf("storeAttachment: %w", err)
	}
	return newAttID, nil
}

// Silence the unused-import lints when the file is built without the
// new attachment path active (e.g. during a partial cherry-pick).
var _ = textproto.MIMEHeader{}

// syncCommRecipientsFromInbound parses From + To + Cc on the inbound
// message, drops the channel's own from_address (case-insensitive),
// upserts each remaining address as a person card with kind='contact'
// (existing person cards keep whatever kind they already have), and
// unions the resulting person ids into comm.comm_recipients.
//
// Union semantics — never remove participants. If someone drops off
// the thread, an operator can edit recipients via the UI.
func (p *IMAPPoller) syncCommRecipientsFromInbound(
	ctx context.Context,
	tx store.Querier,
	snap *schema.Snapshot,
	commID int64,
	m InboundMessage,
	actorID int64,
) error {
	channelFrom, err := loadChannelFromAddress(ctx, tx, p.channelID)
	if err != nil {
		return fmt.Errorf("load channel from_address: %w", err)
	}
	channelLower := strings.ToLower(strings.TrimSpace(channelFrom))

	type addr struct {
		email string
		name  string
	}
	var found []addr
	seen := make(map[string]struct{})
	addOne := func(a *mail.Address) {
		if a == nil {
			return
		}
		email := strings.TrimSpace(a.Address)
		if email == "" {
			return
		}
		key := strings.ToLower(email)
		if channelLower != "" && key == channelLower {
			return
		}
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		found = append(found, addr{email: email, name: strings.TrimSpace(a.Name)})
	}
	for _, raw := range []string{m.From, m.To, m.Cc} {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		// mail.ParseAddressList tolerates name + bare-email forms.
		// Best-effort: if parsing fails for one header we still try
		// the others rather than abort the sync.
		list, perr := mail.ParseAddressList(raw)
		if perr != nil {
			continue
		}
		for _, a := range list {
			addOne(a)
		}
	}
	if len(found) == 0 {
		return nil
	}
	ids := make([]int64, 0, len(found))
	for _, a := range found {
		id, _, uerr := upsertPersonByEmail(ctx, tx, snap, a.email, a.name, PersonKindContact, actorID)
		if uerr != nil {
			return fmt.Errorf("upsert %s: %w", a.email, uerr)
		}
		ids = append(ids, id)
	}
	if _, err := mergeCommRecipients(ctx, tx, snap, commID, ids, actorID); err != nil {
		return fmt.Errorf("merge recipients: %w", err)
	}
	return nil
}

// loadChannelFromAddress returns the comm_channel's configured
// from_address attribute, or "" when none is set. Used by the
// inbound recipient sync to exclude the channel's own envelope
// from the participant list.
func loadChannelFromAddress(ctx context.Context, tx store.Querier, channelID int64) (string, error) {
	var out string
	err := tx.QueryRow(ctx, `
		SELECT COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = $1 AND ad.name='from_address'), '')
	`, channelID).Scan(&out)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	return out, nil
}

// createTaskAndComm covers the intake path: no existing thread match,
// channel has intake_status configured, so we mint a fresh task + comm
// and treat the inbound message as the comm's first received reply.
//
// The task gets title=subject, description=body, status=intake_status.
// The comm gets a fresh thread_id, channel_ref pointing at this
// channel, and the comm flow's default_create_status_id (or open).
func (p *IMAPPoller) createTaskAndComm(ctx context.Context, tx store.Querier, snap *schema.Snapshot, projectID, intakeStatusID int64, m InboundMessage, actorID int64) error {
	taskCTID, err := resolveCardType(snap, "task")
	if err != nil {
		return err
	}
	commCTID, err := resolveCardType(snap, "comm")
	if err != nil {
		return err
	}
	commStatusAttrID, err := resolveAttr(snap, "comm_status")
	if err != nil {
		return err
	}

	commStatusID, err := commFlowDefaultStatus(ctx, tx, projectID, commStatusAttrID)
	if err != nil {
		return err
	}
	if commStatusID == 0 {
		return &reg.HandlerError{Code: "no_comm_flow",
			Message: fmt.Sprintf("imap intake: project %d has no comm flow default", projectID)}
	}

	// Insert the new task card under the project.
	var taskID int64
	if err := tx.QueryRow(ctx, `
		INSERT INTO card (card_type_id, parent_card_id) VALUES ($1, $2) RETURNING id
	`, taskCTID, projectID).Scan(&taskID); err != nil {
		return fmt.Errorf("insert task card: %w", err)
	}
	if err := writeCardCreateActivity(ctx, tx, taskID, actorID); err != nil {
		return err
	}
	jstr := func(s string) json.RawMessage { b, _ := json.Marshal(s); return b }
	jid := func(n int64) json.RawMessage { b, _ := json.Marshal(n); return b }
	subject := m.Subject
	if subject == "" {
		subject = "(no subject)"
	}
	taskAttrs := []struct {
		name string
		val  json.RawMessage
	}{
		{"title", jstr(subject)},
		{"description", jstr(p.descriptionMarkdown(m))},
		{"status", jid(intakeStatusID)},
	}
	for _, w := range taskAttrs {
		ad, ok := snap.AttrByName[w.name]
		if !ok {
			// description may be optional in some seeds; skip silently
			// rather than fail the ingest.
			if w.name == "description" {
				continue
			}
			return fmt.Errorf("createTaskAndComm: missing attribute_def %q", w.name)
		}
		if err := writeAttributeValue(ctx, tx, taskID, ad.ID, w.val, actorID); err != nil {
			return fmt.Errorf("task attr %s: %w", w.name, err)
		}
	}

	// Mint a unique thread_id for the new comm.
	threadID, err := uniqueThreadID(ctx, tx)
	if err != nil {
		return err
	}

	// Insert the comm card under the new task.
	var commID int64
	if err := tx.QueryRow(ctx, `
		INSERT INTO card (card_type_id, parent_card_id) VALUES ($1, $2) RETURNING id
	`, commCTID, taskID).Scan(&commID); err != nil {
		return fmt.Errorf("insert comm card: %w", err)
	}
	if err := writeCardCreateActivity(ctx, tx, commID, actorID); err != nil {
		return err
	}
	titleAD := snap.AttrByName["title"]
	channelRefAD := snap.AttrByName["channel_ref"]
	threadAD := snap.AttrByName["thread_id"]
	for _, w := range []struct {
		id  int64
		val json.RawMessage
	}{
		{titleAD.ID, jstr(subject)},
		{channelRefAD.ID, jid(p.channelID)},
		{threadAD.ID, jstr(threadID)},
		{commStatusAttrID, jid(commStatusID)},
	} {
		if err := writeAttributeValue(ctx, tx, commID, w.id, w.val, actorID); err != nil {
			return fmt.Errorf("comm attr: %w", err)
		}
	}

	// Append comm to task.comms.
	if err := appendCardRefList(ctx, tx, taskID, "comms", commID, snap, actorID); err != nil {
		return fmt.Errorf("append task.comms: %w", err)
	}

	// First received reply, mirroring the channel-driven inbound capture.
	return p.appendReceivedReply(ctx, tx, snap, commID, m, actorID)
}

// descriptionMarkdown builds the Markdown stored in a new task's description.
// The description renders through the web client's Markdown sink, so a raw
// plain-text body (whose single newlines collapse to spaces) reads as one
// run-on paragraph; the mailmd converters fix that. Which body part is the
// source — and in what order parts are tried — is governed by the poller's
// resolved bodyPriority (KITP_COMM_BODY_PRIORITY). The first extractor whose
// part is present and non-empty wins; if none match (e.g. priority is "html"
// only but the message is plain text), we fall back to converting whatever
// text we have so the description is never empty.
func (p *IMAPPoller) descriptionMarkdown(m InboundMessage) string {
	for _, e := range p.bodyPriority {
		md, err := e.extract(m)
		if err != nil {
			// errSkipBody (the only error these return) means "this body type
			// isn't present" — try the next in priority order.
			continue
		}
		return md
	}
	return mailmd.FromText(m.Body)
}

// errSkipBody signals that a bodyExtractor found no content of its type, so
// the priority loop should fall through to the next extractor.
var errSkipBody = errors.New("comm: no body of this type")

// bodyExtractor converts one kind of message body part into description
// Markdown. extract returns errSkipBody when the message carries no part of
// that kind (or it converts to nothing), so descriptionMarkdown can try the
// next extractor in priority order.
type bodyExtractor struct {
	name    string
	extract func(InboundMessage) (string, error)
}

// extractPlainDescription sources the description from the text/plain part.
func extractPlainDescription(m InboundMessage) (string, error) {
	if strings.TrimSpace(m.BodyPlain) == "" {
		return "", errSkipBody
	}
	return mailmd.FromText(m.BodyPlain), nil
}

// extractHTMLDescription sources the description from the text/html part.
func extractHTMLDescription(m InboundMessage) (string, error) {
	if strings.TrimSpace(m.BodyHTML) == "" {
		return "", errSkipBody
	}
	md := strings.TrimSpace(mailmd.FromHTML(m.BodyHTML))
	if md == "" {
		return "", errSkipBody
	}
	return md, nil
}

// resolveBodyPriority parses KITP_COMM_BODY_PRIORITY into an ordered list of
// extractors. Tokens are comma-separated, lowercased, de-duplicated; only
// "plain" and "html" are recognised. An empty / unrecognised setting (or one
// that yields no valid tokens) falls back to the plain-then-html default.
func resolveBodyPriority(env string) []bodyExtractor {
	avail := map[string]bodyExtractor{
		"plain": {name: "plain", extract: extractPlainDescription},
		"html":  {name: "html", extract: extractHTMLDescription},
	}
	var out []bodyExtractor
	seen := map[string]bool{}
	for _, tok := range strings.Split(env, ",") {
		tok = strings.ToLower(strings.TrimSpace(tok))
		if e, ok := avail[tok]; ok && !seen[tok] {
			out = append(out, e)
			seen[tok] = true
		}
	}
	if len(out) == 0 {
		return []bodyExtractor{avail["plain"], avail["html"]}
	}
	return out
}

// ---- threading ----

// threadIDRegex matches a 10-character base62 token. The same shape
// the SMTP sender writes into the [#<id>] subject suffix + Ref: body
// trailer; the IMAP poller reads the same encoding back.
var threadIDRegex = regexp.MustCompile(`[0-9A-Za-z]{10}`)

// subjectThreadRegex finds the literal [#<id>] suffix our outbound
// mail attaches. Anchored to the bracket pair so we don't accidentally
// match base62-like tokens that occur naturally in a subject line.
var subjectThreadRegex = regexp.MustCompile(`\[#([0-9A-Za-z]{10})\]`)

// bodyRefRegex matches the body trailer line `Ref: <id>`. The body
// scan looks at the last ~20 lines only, so this regex never has to
// worry about catastrophic backtracking on a large body.
var bodyRefRegex = regexp.MustCompile(`(?m)^Ref:\s*([0-9A-Za-z]{10})\s*$`)

// extractThreadID applies the three-tier lookup in priority order:
//
//  1. X-Kitp-Thread-Id header (most reliable; we always write it on
//     outbound, mail clients rarely strip custom headers).
//  2. Subject suffix [#<id>] (survives most reply chains).
//  3. Body trailer Ref: <id> (last-ditch when header + subject got
//     mangled — we scan only the last 20 lines).
//
// Returns the matched id + the source label so the comm_log entry
// can record which mechanism fired.
func extractThreadID(m InboundMessage) (string, string) {
	if h := strings.TrimSpace(m.ThreadIDHdr); h != "" {
		// Extract exactly 10 chars; header values can occasionally
		// have trailing junk (folding, mailer rewrites).
		if match := threadIDRegex.FindString(h); match != "" {
			return match, "header"
		}
	}
	if match := subjectThreadRegex.FindStringSubmatch(m.Subject); len(match) == 2 {
		return match[1], "subject"
	}
	if match := bodyRefRegex.FindStringSubmatch(lastNLines(m.Body, 20)); len(match) == 2 {
		return match[1], "body"
	}
	return "", "none"
}

// lastNLines returns the last n newline-terminated lines of s, joined
// with LF. Used to keep the Ref: regex's input small; mailers append
// signatures + quoted-reply chains liberally, but Ref: always sits at
// the very end of our outbound bodies.
func lastNLines(s string, n int) string {
	if s == "" || n <= 0 {
		return ""
	}
	lines := strings.Split(s, "\n")
	if len(lines) <= n {
		return s
	}
	return strings.Join(lines[len(lines)-n:], "\n")
}

// ---- MIME parsing ----

// ParseInboundMessage decodes a raw RFC822 byte buffer into our
// InboundMessage struct. Used by the production dialIMAP wrapper +
// directly callable by tests that want to exercise the parse path
// without standing up a fake imapClient.
func ParseInboundMessage(uid uint32, raw []byte) (InboundMessage, error) {
	out := InboundMessage{UID: uid, Raw: raw}
	msg, err := mail.ReadMessage(strings.NewReader(string(raw)))
	if err != nil {
		return out, fmt.Errorf("mail.ReadMessage: %w", err)
	}
	out.MessageID = strings.TrimSpace(msg.Header.Get("Message-ID"))
	out.From = strings.TrimSpace(msg.Header.Get("From"))
	out.To = strings.TrimSpace(msg.Header.Get("To"))
	out.Cc = strings.TrimSpace(msg.Header.Get("Cc"))
	out.Subject = strings.TrimSpace(msg.Header.Get("Subject"))
	out.ThreadIDHdr = strings.TrimSpace(msg.Header.Get("X-Kitp-Thread-Id"))

	// Case-sensitive for the boundary= parameter (boundaries are
	// case-sensitive per RFC 2046); case-insensitive for the type
	// prefix check.
	ctypeRaw := msg.Header.Get("Content-Type")
	ctypeLow := strings.ToLower(ctypeRaw)
	body, err := io.ReadAll(msg.Body)
	if err != nil {
		return out, fmt.Errorf("read body: %w", err)
	}

	switch {
	case strings.HasPrefix(ctypeLow, "multipart/"):
		// Walk every part: pick a text body (prefer text/plain, fall
		// back to text/html with tags stripped) and harvest every
		// attachment part. One level of nested multipart is unwound
		// here so a typical multipart/mixed { multipart/alternative
		// { text/plain, text/html }, attachment, ... } message yields
		// both the plain body and the attachment list.
		plain, htmlBody, atts := walkMultipart(body, ctypeRaw)
		out.BodyPlain = plain
		out.BodyHTML = htmlBody
		out.Body = plain
		if plain == "" && htmlBody != "" {
			// No plain arm: the reply bubble still wants readable text, so
			// fall back to the tag-stripped HTML (the historical behaviour).
			out.Body = stripHTMLTags(htmlBody)
		}
		out.Attachments = atts
	case strings.HasPrefix(ctypeLow, "text/html"):
		// Apply Content-Transfer-Encoding first (quoted-printable / base64)
		// so QP markers don't survive into the stripped output — same rule
		// walkMultipart applies per-part. No text/plain part, so BodyPlain
		// stays empty (the "plain" extractor will skip).
		decoded := decodeTransferEncoding(body, msg.Header.Get("Content-Transfer-Encoding"))
		out.BodyHTML = string(decoded)
		out.Body = stripHTMLTags(string(decoded))
	default:
		// text/plain or unknown — treat as plain text. Apply the message's
		// Content-Transfer-Encoding so a top-level `quoted-printable` body
		// (`=E2=80=AA`, soft-wrap `=\r\n`, …) renders as the original UTF-8
		// the sender typed; without this the QP markers leaked into the
		// stored body verbatim.
		decoded := decodeTransferEncoding(body, msg.Header.Get("Content-Transfer-Encoding"))
		out.Body = string(decoded)
		out.BodyPlain = out.Body
	}
	return out, nil
}

// walkMultipart parses a multipart body via stdlib `mime/multipart`
// and returns (plain text, html, attachments). text/plain is captured as
// the plain body and text/html (if any) is returned raw so the caller can
// both render a reply bubble (plain, tag-stripped) and build a richer task
// description (mailmd.FromHTML). Non-text parts (or any part with a
// `Content-Disposition: attachment` header) are appended to the
// attachments list. One level of nested multipart is unwound — most
// real-world messages stop at depth 1 (multipart/mixed wrapping a
// multipart/alternative).
func walkMultipart(body []byte, contentType string) (string, string, []InboundAttachment) {
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return string(body), "", nil
	}
	boundary, ok := params["boundary"]
	if !ok || boundary == "" {
		return string(body), "", nil
	}
	var plain, htmlFallback string
	var atts []InboundAttachment
	mr := multipart.NewReader(bytes.NewReader(body), boundary)
	for {
		p, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			// Stop early on malformed input; surface whatever we've
			// collected so the caller still gets a body (and a partial
			// attachment list) rather than nothing.
			break
		}
		partCT := p.Header.Get("Content-Type")
		partCTLow := strings.ToLower(partCT)
		raw, _ := io.ReadAll(p)
		decoded := decodeTransferEncoding(raw, p.Header.Get("Content-Transfer-Encoding"))
		disp, dispParams, _ := mime.ParseMediaType(p.Header.Get("Content-Disposition"))
		dispLow := strings.ToLower(disp)
		if strings.HasPrefix(partCTLow, "multipart/") {
			nestedPlain, nestedHTML, nestedAtts := walkMultipart(decoded, partCT)
			if plain == "" && nestedPlain != "" {
				// Prefer nested text body when we haven't found one yet.
				plain = nestedPlain
			}
			if htmlFallback == "" && nestedHTML != "" {
				htmlFallback = nestedHTML
			}
			atts = append(atts, nestedAtts...)
			continue
		}
		if dispLow == "attachment" || (dispLow == "" && !strings.HasPrefix(partCTLow, "text/")) {
			filename := dispParams["filename"]
			if filename == "" {
				// Some clients put the filename only in the
				// Content-Type's name= parameter (e.g. older Outlook).
				if _, ctParams, err := mime.ParseMediaType(partCT); err == nil {
					filename = ctParams["name"]
				}
			}
			if filename == "" {
				filename = fmt.Sprintf("attachment-%d", len(atts)+1)
			}
			mt, _, _ := mime.ParseMediaType(partCT)
			if mt == "" {
				mt = "application/octet-stream"
			}
			atts = append(atts, InboundAttachment{
				Filename: filename,
				MimeType: mt,
				Bytes:    decoded,
			})
			continue
		}
		if strings.HasPrefix(partCTLow, "text/plain") {
			if plain == "" {
				plain = string(decoded)
			}
		} else if strings.HasPrefix(partCTLow, "text/html") {
			if htmlFallback == "" {
				htmlFallback = string(decoded)
			}
		}
	}
	return strings.TrimSpace(plain), htmlFallback, atts
}

// decodeTransferEncoding undoes the Content-Transfer-Encoding wrapping
// of a part. Recognises base64 and quoted-printable; passes 7bit /
// 8bit / binary through unchanged.
func decodeTransferEncoding(raw []byte, encoding string) []byte {
	switch strings.ToLower(strings.TrimSpace(encoding)) {
	case "base64":
		decoded, err := base64.StdEncoding.DecodeString(
			strings.Map(func(r rune) rune {
				// base64 ignores whitespace per RFC but the std encoder is
				// strict — strip CRLF / spaces before decoding.
				if r == '\r' || r == '\n' || r == ' ' || r == '\t' {
					return -1
				}
				return r
			}, string(raw)))
		if err != nil {
			return raw
		}
		return decoded
	case "quoted-printable":
		b, err := io.ReadAll(quotedprintable.NewReader(bytes.NewReader(raw)))
		if err != nil {
			return raw
		}
		return b
	default:
		return raw
	}
}

// htmlTagRegex strips HTML tags. Greedy on the content between < and >.
var htmlTagRegex = regexp.MustCompile(`<[^>]+>`)

// stripHTMLTags removes every tag from an HTML body, collapses runs of
// whitespace, and unescapes a couple of common entities. Used for the plain
// reply-bubble text (rendered verbatim, not as Markdown). The richer
// approximate HTML→Markdown conversion used for the initial task description
// lives in internal/mailmd (mailmd.FromHTML); this function stays
// intentionally lossy for the plain-text surface.
func stripHTMLTags(s string) string {
	noTags := htmlTagRegex.ReplaceAllString(s, "")
	// A small subset of HTML entities; covers > 95% of inbound mail.
	r := strings.NewReplacer(
		"&nbsp;", " ",
		"&amp;", "&",
		"&lt;", "<",
		"&gt;", ">",
		"&quot;", `"`,
		"&#39;", "'",
		"&apos;", "'",
	)
	noTags = r.Replace(noTags)
	// Collapse 3+ blank lines but keep paragraph spacing.
	noTags = regexp.MustCompile(`\n{3,}`).ReplaceAllString(noTags, "\n\n")
	return strings.TrimSpace(noTags)
}

// ---- production IMAP dialer ----

// dialIMAP opens an IMAPS connection (or plain IMAP + STARTTLS),
// authenticates with LOGIN, selects INBOX (read-write so STORE \Seen
// works), and returns a realIMAPClient. The returned client owns the
// underlying socket; the caller must Close() to release it.
//
// go-imap doesn't expose a per-call context, so we surface ctx via a
// dial timeout (taken from the caller's deadline when set, else a 30s
// default). FetchUnseen / MarkSeen rely on the underlying conn's
// read/write deadlines, which the dial timeout effectively pins.
func dialIMAP(ctx context.Context, cfg IMAPConfig) (imapClient, error) {
	// SSRF guard (SEC-4 / A9): reject internal / loopback / link-local
	// dial targets before opening the socket.
	if err := guardDialHost(ctx, cfg.Host); err != nil {
		return nil, err
	}
	addr := net.JoinHostPort(cfg.Host, fmt.Sprintf("%d", cfg.Port))
	dialer := &net.Dialer{Timeout: 30 * time.Second}
	if deadline, ok := ctx.Deadline(); ok {
		dialer.Timeout = time.Until(deadline)
	}

	var c *imapclient.Client
	var err error
	switch {
	case cfg.Insecure:
		c, err = imapclient.DialWithDialer(dialer, addr)
	case cfg.Port == 143:
		c, err = imapclient.DialWithDialer(dialer, addr)
		if err == nil {
			err = c.StartTLS(&tls.Config{ServerName: cfg.Host, MinVersion: tls.VersionTLS12})
		}
	default:
		c, err = imapclient.DialWithDialerTLS(dialer, addr, &tls.Config{ServerName: cfg.Host, MinVersion: tls.VersionTLS12})
	}
	if err != nil {
		return nil, fmt.Errorf("imap dial %s: %w", addr, err)
	}
	if err := c.Login(cfg.Username, cfg.Password); err != nil {
		_ = c.Logout()
		return nil, fmt.Errorf("imap login: %w", err)
	}
	if _, err := c.Select("INBOX", false); err != nil {
		_ = c.Logout()
		return nil, fmt.Errorf("imap select INBOX: %w", err)
	}
	return &realIMAPClient{c: c}, nil
}

// realIMAPClient implements imapClient against emersion/go-imap. The
// concrete protocol surface lives here so the rest of the package
// (threading, ingest) stays library-agnostic.
type realIMAPClient struct {
	c *imapclient.Client
}

func (r *realIMAPClient) FetchUnseen(ctx context.Context) ([]InboundMessage, error) {
	criteria := imap.NewSearchCriteria()
	criteria.WithoutFlags = []string{imap.SeenFlag}
	uids, err := r.c.UidSearch(criteria)
	if err != nil {
		return nil, fmt.Errorf("imap UID SEARCH UNSEEN: %w", err)
	}
	if len(uids) == 0 {
		return nil, nil
	}
	seqset := new(imap.SeqSet)
	seqset.AddNum(uids...)

	section := &imap.BodySectionName{}
	items := []imap.FetchItem{imap.FetchUid, imap.FetchEnvelope, section.FetchItem()}

	ch := make(chan *imap.Message, 16)
	done := make(chan error, 1)
	go func() { done <- r.c.UidFetch(seqset, items, ch) }()

	var out []InboundMessage
	for msg := range ch {
		body := msg.GetBody(section)
		if body == nil {
			// No body fetched (unusual); skip rather than fail the
			// whole batch.
			continue
		}
		raw, err := io.ReadAll(body)
		if err != nil {
			return nil, fmt.Errorf("imap read body: %w", err)
		}
		parsed, err := ParseInboundMessage(msg.Uid, raw)
		if err != nil {
			// Per-message parse failure: continue ingesting the rest
			// but include the bad UID with empty fields so the caller
			// can log + skip MarkSeen for it. We pick this surface
			// because returning an error here would skip the whole
			// batch — too aggressive.
			parsed = InboundMessage{UID: msg.Uid}
		}
		out = append(out, parsed)
	}
	if err := <-done; err != nil {
		return out, fmt.Errorf("imap UID FETCH: %w", err)
	}
	return out, nil
}

func (r *realIMAPClient) MarkSeen(ctx context.Context, uids []uint32) error {
	if len(uids) == 0 {
		return nil
	}
	seqset := new(imap.SeqSet)
	seqset.AddNum(uids...)
	item := imap.FormatFlagsOp(imap.AddFlags, true)
	flags := []interface{}{imap.SeenFlag}
	return r.c.UidStore(seqset, item, flags, nil)
}

func (r *realIMAPClient) Close() error {
	if r.c == nil {
		return nil
	}
	err := r.c.Logout()
	r.c = nil
	return err
}

// ---- startup helpers ----

// IMAPPool drives inbound polling for every comm_channel from a single
// scheduler job. Each RunOnce reconciles one [IMAPPoller] per live channel
// and ticks each one; per-channel backoff lives on the poller and survives
// across sweeps. Construct with [NewIMAPPool] and call RunOnce from the
// `comm.imap_poll` job (see cmd/kitpd/main.go).
type IMAPPool struct {
	pool   *store.Pool
	logger *slog.Logger
	wp     *job.WorkerPool[int64, *IMAPPoller]
}

// NewIMAPPool builds the pool. tick is the per-poller cadence hint (the
// real cadence is the owning job's Interval); logger is threaded to each
// poller.
func NewIMAPPool(pool *store.Pool, tick time.Duration, logger *slog.Logger) *IMAPPool {
	m := &IMAPPool{pool: pool, logger: logger}
	m.wp = job.NewWorkerPool[int64, *IMAPPoller](
		func(id int64) *IMAPPoller {
			p := newIMAPPoller(pool, id, tick)
			p.SetLogger(logger)
			return p
		},
		// Discard the per-channel error: Tick already logged + backed off,
		// and one bad channel must not flip the whole poll job red.
		func(ctx context.Context, p *IMAPPoller) error { _ = p.Tick(ctx); return nil },
	)
	return m
}

// RunOnce is the `comm.imap_poll` job body: list every channel and sweep
// its poller. Returns only a channel-enumeration error (per-channel poll
// errors are handled inside Tick).
func (m *IMAPPool) RunOnce(ctx context.Context) error {
	ids, err := ListChannelIDs(ctx, m.pool)
	if err != nil {
		return fmt.Errorf("imap poll: list channels: %w", err)
	}
	m.logger.LogAttrs(ctx, slog.LevelDebug, "imap poll sweep",
		slog.Int("channels", len(ids)))
	return m.wp.Sweep(ctx, ids)
}
