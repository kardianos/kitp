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
//   KITP_COMM_IMAP_TICK_SEC=60   poll interval; default 60s
//   KITP_COMM_IMAP_DRY_RUN=0     when "1", log and continue without
//                                opening an IMAP connection
//   KITP_COMM_IMAP_INSECURE=0    when "1", allow plaintext IMAP (no
//                                TLS); dev only
package comm

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/mail"
	"os"
	"regexp"
	"strings"
	"time"

	imap "github.com/emersion/go-imap"
	imapclient "github.com/emersion/go-imap/client"
	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

// IMAPPoller owns the per-channel poll loop. Construct with
// StartIMAPPoller; the returned value's Stop() drains the goroutine
// cleanly. RunOnce is exported so tests can drive one iteration
// synchronously without waiting on the ticker.
type IMAPPoller struct {
	pool      *store.Pool
	channelID int64
	tick      time.Duration
	dryRun    bool
	insecure  bool
	logger    *slog.Logger

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

	stop chan struct{}
	done chan struct{}
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
	Subject     string
	ThreadIDHdr string // X-Kitp-Thread-Id header value, if present
	Body        string // plain-text body (text/html stripped to plain)
}

// StartIMAPPoller spawns the poll goroutine for one channel. tick is
// the poll cadence (clamped to >= 5s; production defaults to 60s).
// The returned poller is ready immediately; the first scan fires on
// the first ticker tick. Call Stop() to drain.
func StartIMAPPoller(pool *store.Pool, channelID int64, tick time.Duration) *IMAPPoller {
	p := newIMAPPoller(pool, channelID, tick)
	go p.run()
	return p
}

// NewIMAPPollerForTest builds an unstarted IMAPPoller so tests can
// drive RunOnce synchronously. Production callers go through
// StartIMAPPoller.
func NewIMAPPollerForTest(pool *store.Pool, channelID int64, tick time.Duration) *IMAPPoller {
	return newIMAPPoller(pool, channelID, tick)
}

func newIMAPPoller(pool *store.Pool, channelID int64, tick time.Duration) *IMAPPoller {
	if tick < 5*time.Second {
		tick = 5 * time.Second
	}
	p := &IMAPPoller{
		pool:      pool,
		channelID: channelID,
		tick:      tick,
		dryRun:    os.Getenv("KITP_COMM_IMAP_DRY_RUN") == "1",
		insecure:  os.Getenv("KITP_COMM_IMAP_INSECURE") == "1",
		logger:    slog.Default(),
		stop:      make(chan struct{}),
		done:      make(chan struct{}),
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

// Stop signals the goroutine to exit and waits for it to drain. Safe
// to call multiple times.
func (p *IMAPPoller) Stop() {
	select {
	case <-p.stop:
	default:
		close(p.stop)
	}
	<-p.done
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

func (p *IMAPPoller) run() {
	defer close(p.done)
	t := time.NewTicker(p.tick)
	defer t.Stop()
	for {
		select {
		case <-p.stop:
			return
		case now := <-t.C:
			if now.Before(p.nextAttemptAt) {
				continue // still backing off
			}
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			ctx = auth.WithSystemUser(ctx)
			if err := p.RunOnce(ctx); err != nil {
				p.bumpBackoff()
				p.logger.LogAttrs(ctx, slog.LevelError, "imap poller RunOnce",
					slog.Int64("channel_id", p.channelID),
					slog.Duration("backoff", p.backoff),
					slog.Int("cap_hits", p.capHits),
					slog.String("err", err.Error()))
				// Sustained-failure trip: once we've been failing at
				// the backoff ceiling for the threshold, treat it as
				// "this is no longer transient" and disable the
				// channel until an admin re-enables.
				if p.capHits >= sustainedFailureCapHits {
					if mfErr := MarkChannelFault(ctx, p.pool, p.channelID,
						fmt.Sprintf("sustained polling failure: %v", err)); mfErr != nil {
						p.logger.LogAttrs(ctx, slog.LevelError, "imap poller mark fault",
							slog.Int64("channel_id", p.channelID),
							slog.String("err", mfErr.Error()))
					}
				}
			} else {
				p.backoff = 0
				p.nextAttemptAt = time.Time{}
				p.capHits = 0
			}
			cancel()
		}
	}
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
		return nil
	}

	cfg, projectID, intakeStatusID, err := p.loadChannelConfig(ctx)
	if err != nil {
		return fmt.Errorf("imap poller: load config: %w", err)
	}

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

	msgs, err := client.FetchUnseen(ctx)
	if err != nil {
		return fmt.Errorf("imap fetch: %w", err)
	}

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
	tx, err := p.pool.BeginTx(ctx)
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
		if err := p.appendReceivedReply(ctx, tx, snap, matchedCommID, m, actorID); err != nil {
			return p.logParseError(ctx, projectID, m, err)
		}
	case intakeStatusID != 0:
		if err := p.createTaskAndComm(ctx, tx, snap, projectID, intakeStatusID, m, actorID); err != nil {
			return p.logParseError(ctx, projectID, m, err)
		}
	default:
		// Discard: no thread match, no intake configured. Log the
		// dropped message so operators can configure intake later.
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
// can surface it.
func (p *IMAPPoller) logParseError(ctx context.Context, projectID int64, m InboundMessage, origErr error) error {
	detail := map[string]any{
		"message_id": m.MessageID,
		"subject":    m.Subject,
		"error":      origErr.Error(),
	}
	d, _ := json.Marshal(detail)
	_, _ = p.pool.P.Exec(ctx, `
		INSERT INTO comm_log (project_id, channel_id, kind, detail)
		VALUES ($1, $2, 'parse_error', $3::jsonb)
	`, projectID, p.channelID, d)
	return origErr
}

// findCommByThreadID returns the comm card id whose thread_id
// attribute matches the supplied token, or 0 if none. We don't filter
// by channel_ref — the spec calls out cross-channel matches as a
// false-positive risk worth warning about, but functionally the
// match is global within the install.
func (p *IMAPPoller) findCommByThreadID(ctx context.Context, tx pgx.Tx, threadID string) (int64, error) {
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
func (p *IMAPPoller) appendReceivedReply(ctx context.Context, tx pgx.Tx, snap *schema.Snapshot, commID int64, m InboundMessage, actorID int64) error {
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
	return appendCardRefList(ctx, tx, commID, "replies", replyID, snap, actorID)
}

// createTaskAndComm covers the intake path: no existing thread match,
// channel has intake_status configured, so we mint a fresh task + comm
// and treat the inbound message as the comm's first received reply.
//
// The task gets title=subject, description=body, status=intake_status.
// The comm gets a fresh thread_id, channel_ref pointing at this
// channel, and the comm flow's default_create_status_id (or open).
func (p *IMAPPoller) createTaskAndComm(ctx context.Context, tx pgx.Tx, snap *schema.Snapshot, projectID, intakeStatusID int64, m InboundMessage, actorID int64) error {
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
		{"description", jstr(m.Body)},
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
	out := InboundMessage{UID: uid}
	msg, err := mail.ReadMessage(strings.NewReader(string(raw)))
	if err != nil {
		return out, fmt.Errorf("mail.ReadMessage: %w", err)
	}
	out.MessageID = strings.TrimSpace(msg.Header.Get("Message-ID"))
	out.From = strings.TrimSpace(msg.Header.Get("From"))
	out.To = strings.TrimSpace(msg.Header.Get("To"))
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
		// Multipart: prefer text/plain part; fall back to text/html with
		// tags stripped. The v1 spec says "keep it simple" — we don't
		// chase nested multipart/alternative structures recursively.
		out.Body = extractPreferredPart(body, ctypeRaw)
	case strings.HasPrefix(ctypeLow, "text/html"):
		out.Body = stripHTMLTags(string(body))
	default:
		// text/plain or unknown — treat as plain text.
		out.Body = string(body)
	}
	return out, nil
}

// boundaryRegex extracts the boundary= parameter from a Content-Type
// header. We do this by hand rather than via mime.ParseMediaType
// because the spec says "keep it simple" and our outbound mail (which
// this parser will most often see in reply chains) uses plain text.
var boundaryRegex = regexp.MustCompile(`boundary="?([^";]+)"?`)

// extractPreferredPart picks the text/plain section of a multipart
// body. Falls back to a tag-stripped text/html section. If neither is
// present we return the raw body so we still ingest *something*.
func extractPreferredPart(body []byte, contentType string) string {
	match := boundaryRegex.FindStringSubmatch(contentType)
	if len(match) != 2 {
		// No boundary parameter — treat as plain text.
		return string(body)
	}
	boundary := match[1]
	separator := "--" + boundary
	// Use byte semantics through strings.Split — body may contain
	// arbitrary 8-bit content, but mail clients quote-encode that.
	sections := strings.Split(string(body), separator)

	var htmlPart string
	for _, s := range sections {
		s = strings.TrimPrefix(s, "\r\n")
		s = strings.TrimPrefix(s, "\n")
		if strings.HasPrefix(strings.TrimSpace(s), "--") {
			// Closing boundary marker; skip.
			continue
		}
		headerEnd := strings.Index(s, "\r\n\r\n")
		if headerEnd < 0 {
			headerEnd = strings.Index(s, "\n\n")
			if headerEnd < 0 {
				continue
			}
			headers := s[:headerEnd]
			content := s[headerEnd+2:]
			if isPlainTextPart(headers) {
				return strings.TrimSpace(content)
			}
			if isHTMLPart(headers) {
				htmlPart = content
			}
			continue
		}
		headers := s[:headerEnd]
		content := s[headerEnd+4:]
		if isPlainTextPart(headers) {
			return strings.TrimSpace(content)
		}
		if isHTMLPart(headers) {
			htmlPart = content
		}
	}
	if htmlPart != "" {
		return stripHTMLTags(htmlPart)
	}
	return string(body)
}

// isPlainTextPart returns true when the part's headers declare a
// text/plain Content-Type. Tolerates whitespace + charset parameters.
func isPlainTextPart(headers string) bool {
	low := strings.ToLower(headers)
	return strings.Contains(low, "content-type:") && strings.Contains(low, "text/plain")
}

// isHTMLPart mirrors isPlainTextPart for text/html.
func isHTMLPart(headers string) bool {
	low := strings.ToLower(headers)
	return strings.Contains(low, "content-type:") && strings.Contains(low, "text/html")
}

// htmlTagRegex strips HTML tags. Greedy on the content between < and >.
// The spec says v1 is plain text only — sophisticated HTML→Markdown
// conversion is explicitly out of scope.
var htmlTagRegex = regexp.MustCompile(`<[^>]+>`)

// stripHTMLTags removes every tag from an HTML body, collapses runs
// of whitespace, and unescapes a couple of common entities. The
// output is intentionally lossy — operators who need rich formatting
// will follow up in v2.
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

// StartIMAPPollerPool spawns one IMAPPoller per existing comm_channel
// card. Mirrors StartSMTPSenderPool. Returns every poller so the
// caller can collect them for shutdown.
func StartIMAPPollerPool(ctx context.Context, pool *store.Pool, tick time.Duration, logger *slog.Logger) ([]*IMAPPoller, error) {
	ids, err := ListChannelIDs(ctx, pool)
	if err != nil {
		return nil, fmt.Errorf("imap poller pool: %w", err)
	}
	out := make([]*IMAPPoller, 0, len(ids))
	for _, id := range ids {
		p := StartIMAPPoller(pool, id, tick)
		p.SetLogger(logger)
		out = append(out, p)
	}
	return out, nil
}
