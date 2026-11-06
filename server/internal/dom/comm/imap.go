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
// = 'received') to the matched comm's replies list. Unmatched but a
// reply to a kitp notification email (In-Reply-To / References names a
// notification Message-ID, see mailer.go) → comm_log
// kind='notification_reply' and discard, so answering a digest never
// files an intake task. Unmatched + the channel has intake_status
// configured → create a new task with the inbound subject/body and a
// fresh comm. Unmatched + no intake → comm_log kind='unmatched_thread'
// and discard.
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
//	KITP_COMM_IMAP_SET_ASIDE_FOLDER=kitp-set-aside
//	                               folder a message kitp can never file
//	                               (unreadable, too large, set aside,
//	                               unfileable) is moved to, out of INBOX,
//	                               once it is marked read; set empty to
//	                               leave such mail in INBOX
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
	"sort"
	"strings"
	"time"

	imap "github.com/emersion/go-imap"
	imapclient "github.com/emersion/go-imap/client"
	"github.com/emersion/go-imap/commands"
	"github.com/emersion/go-imap/utf7"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/job"
	"github.com/kitp/kitp/server/internal/mailmd"
	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
	"github.com/kitp/kitp/server/internal/textnorm"
)

// IMAPPoller owns one channel's poll state (backoff counters + the dial
// seam). An [IMAPPool] holds one poller per channel and drives them from
// a single scheduler job via Tick; RunOnce runs one scan+ingest cycle and
// is exported so tests can drive it synchronously.
type IMAPPoller struct {
	// filer holds what filing a message needs (pool, channel, logger,
	// body rules); POST and SMTP intake build one per message through
	// [Intake] (intake.go).
	filer
	tick     time.Duration
	dryRun   bool
	insecure bool
	// budget is how long one poll may run (imapPollBudget).
	budget time.Duration
	// setAside is the folder never-fileable mail is moved to
	// (KITP_COMM_IMAP_SET_ASIDE_FOLDER); "" leaves it in INBOX.
	setAside string

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
// and returns an InboundClient ready for ListUnseen / Fetch / MarkSeen /
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
	// ListUnseen returns the messages in INBOX without the \Seen flag,
	// oldest first and at most imapFetchBatch of them (the rest come on
	// later polls), each with its size (0 when the server gave none). The
	// ones last names (nil: none) come after all the others, before the
	// cap, so messages that keep failing don't fill a poll. It reads no
	// message: the poller fetches, files and marks one at a time, so a poll
	// holds one message, not fifty (review 2026-11-03 round 4 #1).
	ListUnseen(ctx context.Context, last func(uid uint32) bool) ([]UnseenMessage, error)
	// Fetch reads and parses one message, leaving it unseen. A message
	// that doesn't parse comes back with ParseError set.
	Fetch(ctx context.Context, uid uint32) (InboundMessage, error)
	// MarkSeen flips the \Seen flag on the supplied UIDs. The poller
	// marks what it filed and what can never be filed (unreadable,
	// unfileable, too large, set aside); a message that failed for a
	// passing reason stays unseen for the next poll.
	MarkSeen(ctx context.Context, uids []uint32) error
	// UIDValidity is the selected mailbox's UIDVALIDITY.
	UIDValidity() uint32
	// Archive moves the messages to folder (made if missing), out of
	// INBOX: where a message kitp can never file goes (setAsideFolder).
	// ErrNoMove when the server can't move a message by UID safely.
	Archive(ctx context.Context, uids []uint32, folder string) error
	// Close releases the underlying connection. Idempotent.
	Close() error
}

// UnseenMessage is one unseen message as ListUnseen names it.
type UnseenMessage struct {
	UID  uint32
	Size uint32 // RFC822.SIZE; 0 when unknown
}

// InboundMessage is the parsed shape of one inbound email. The dialer
// is responsible for converting wire bytes into this struct so the
// rest of the package never touches go-imap types — keeps the unit
// tests independent of the IMAP protocol.
type InboundMessage struct {
	UID         uint32
	MessageID   string // RFC822 Message-ID header (the dedupe key, see messageKey)
	Date        string // Date header as sent (part of the dedupe fallback key)
	From        string // address-list as a single text field
	To          string
	Cc          string // address-list; comma-joined like To
	Subject     string
	ThreadIDHdr string // X-Kitp-Thread-Id header value, if present
	// InReplyTo / References are the RFC 5322 threading headers. kitp
	// doesn't thread comms by them (see extractThreadID) but uses them to
	// recognise replies to notification email (IsNotificationReply).
	InReplyTo  string
	References string
	// NotificationHdr is the X-Kitp-Notification header, present when the
	// inbound message is (a bounce/copy of) a kitp notification email.
	NotificationHdr string
	// AutoKind is why the message was written by a machine — an
	// auto-reply, bounce, report or mailing-list post (automaticKind,
	// relay.go) — or "" when a person wrote it. Such mail is filed as
	// usual but never sent on to the rest of the thread.
	AutoKind string
	Body     string // plain-text body for the reply bubble (text/plain part, else text/html stripped to plain)
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
	// ParseError is set (IMAP) when the raw bytes couldn't be read as mail;
	// the poller logs a parse_error and marks it read instead of filing an
	// empty message.
	ParseError string
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
	setAside := DefaultSetAsideFolder
	if v, ok := os.LookupEnv("KITP_COMM_IMAP_SET_ASIDE_FOLDER"); ok {
		setAside = strings.TrimSpace(v)
	}
	p := &IMAPPoller{
		filer:    newFiler(pool, channelID, slog.Default()),
		tick:     tick,
		dryRun:   os.Getenv("KITP_COMM_IMAP_DRY_RUN") == "1",
		insecure: os.Getenv("KITP_COMM_IMAP_INSECURE") == "1",
		setAside: setAside,
		budget:   imapPollBudget,
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
	runCtx, cancel := context.WithTimeout(ctx, p.budget)
	defer cancel()
	runCtx = auth.WithSystemUser(runCtx)
	// One replica polls an account at a time: two read the same messages
	// and took each other's reads for crashes (review 2026-11-03 round 5).
	ran, err := job.Exclusive(runCtx, p.pool.P, fmt.Sprintf("kitp.imap_poll:%d", p.channelID), p.RunOnce)
	if err == nil && !ran {
		return nil // another replica is polling this account
	}
	if errors.Is(err, ErrNothingFiled) {
		// The failures are the messages': back off, but this is no step
		// toward the fault switch.
		p.backOff(false)
		p.logger.LogAttrs(runCtx, slog.LevelWarn, "imap poller: no message filed",
			slog.Int64("channel_id", p.channelID),
			slog.Duration("backoff", p.backoff))
		return err
	}
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

func (p *IMAPPoller) bumpBackoff() { p.backOff(true) }

// backOff doubles the backoff; countCap says whether a failure at the
// ceiling counts toward the fault switch.
func (p *IMAPPoller) backOff(countCap bool) {
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
	if countCap && prev == backoffMax && p.backoff == backoffMax {
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

	cfg, intake, err := p.loadChannelConfig(ctx)
	if err != nil {
		return fmt.Errorf("imap poller: load config: %w", err)
	}
	projectID := intake.projectID
	// No mailbox to poll: "Poll a mailbox (IMAP)" is off, or the account
	// sends only, or takes its mail through POST / SMTP routes. Nothing to
	// dial and nothing failed — counting it as a failed poll faulted the
	// whole account within the hour, which stops its sending and its
	// routes too (review 2026-11-06 round 8 #3).
	if strings.TrimSpace(cfg.Host) == "" {
		p.logger.LogAttrs(ctx, slog.LevelDebug, "imap skip: no mailbox to poll",
			slog.Int64("channel_id", p.channelID))
		return nil
	}

	// Config snapshot (no secrets). The common "no new tasks" cause shows
	// up here: intake_mode=ignore means every non-reply message is dropped
	// (see processOne); has_password=false means dial will fail.
	p.logger.LogAttrs(ctx, slog.LevelDebug, "imap channel config",
		slog.Int64("channel_id", p.channelID),
		slog.String("host", cfg.Host),
		slog.Int("port", cfg.Port),
		slog.Bool("has_username", cfg.Username != ""),
		slog.Bool("has_password", cfg.Password != ""),
		slog.Int64("project_id", projectID),
		slog.Int64("intake_status_id", intake.statusID),
		slog.String("intake_mode", intake.mode))

	if p.dryRun {
		p.logger.LogAttrs(ctx, slog.LevelInfo, "imap dry-run",
			slog.Int64("channel_id", p.channelID),
			slog.String("host", cfg.Host),
			slog.Int("port", cfg.Port))
		// Still record a poll log row so operators see the dry-run
		// cadence in the comm_log stream.
		return p.recordPoll(ctx, projectID, 0, 0)
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

	validity := client.UIDValidity()
	if err := p.pruneInflight(ctx, validity); err != nil {
		return err
	}
	// Messages that failed to file before are listed and tried after the
	// rest, so ones that fail on every poll, or take a poll's whole budget,
	// neither fill the poll's window nor hold back the mail behind them.
	failed, err := p.loadFileFailures(ctx, validity)
	if err != nil {
		return err
	}
	list, err := client.ListUnseen(ctx, func(uid uint32) bool { _, ok := failed[uid]; return ok })
	if err != nil {
		return fmt.Errorf("imap fetch: %w", err)
	}
	p.logger.LogAttrs(ctx, slog.LevelDebug, "imap unseen",
		slog.Int64("channel_id", p.channelID),
		slog.Int("count", len(list)))
	sort.SliceStable(list, func(i, j int) bool {
		_, fi := failed[list[i].UID]
		_, fj := failed[list[j].UID]
		return !fi && fj
	})

	// One message at a time: fetch, file, mark seen, then the next — a
	// poll holds one message's bytes, never the batch (review 2026-11-03
	// round 4 #1). A message is recorded as in flight while it is read and
	// filed; one still recorded when its poll began was being read when
	// kitpd stopped, and one that stopped kitpd twice is set aside —
	// logged and marked read, left in the mailbox — rather than end it on
	// every poll. Once the poll's budget is spent the rest wait for the
	// next poll: that isn't the account failing.
	var ingested, failures int
	var firstErr error
	filedPaths := map[string]bool{} // paths fresh mail filed down this poll
poll:
	for _, u := range list {
		if ctx.Err() != nil {
			break
		}
		ff, hadFailed := failed[u.UID]
		if ff.setAside && p.budgetLeft(ctx) < p.budget/2 {
			continue // its last try waits for a poll with time for it
		}
		leftAtStart := p.budgetLeft(ctx)
		var m InboundMessage
		tracked := false
		switch {
		case int64(u.Size) > IMAPMaxMessageBytes:
			m = InboundMessage{UID: u.UID, ParseError: fmt.Sprintf(
				"message is %d bytes, over the %d-byte limit; not fetched", u.Size, IMAPMaxMessageBytes)}
		default:
			attempts, err := p.beginInflight(ctx, validity, u.UID)
			if err != nil {
				if ctx.Err() != nil {
					break poll
				}
				return err
			}
			if attempts > imapMaxAttempts {
				m = InboundMessage{UID: u.UID, ParseError: fmt.Sprintf(
					"set aside: reading this message failed %d times (kitp stopped, or the server refused to fetch it)", attempts-1)}
				break
			}
			tracked = true
			m, err = client.Fetch(ctx, u.UID)
			if errors.Is(err, ErrFetchRefused) {
				// Its in-flight row stays: the refusal counts as a try, and
				// after imapMaxAttempts the message is set aside (above).
				p.logger.LogAttrs(ctx, slog.LevelWarn, "imap: the server refused a message; trying the next",
					slog.Int64("channel_id", p.channelID), slog.Any("uid", u.UID),
					slog.String("err", err.Error()))
				continue
			}
			if err != nil {
				p.endInflight(ctx, validity, u.UID)
				if ctx.Err() != nil {
					break poll
				}
				return fmt.Errorf("imap fetch: %w", err)
			}
			if !p.saveRawEmail {
				m.Raw = nil // only the debugging copy needs the verbatim bytes
			}
		}
		seen, aside, path, err := p.fileFetched(ctx, intake, m, int64(u.Size))
		// What's left of this message's handling outlives the poll's budget.
		bctx, cancel := bookkeepingCtx(ctx)
		switch {
		case err == nil:
		case errors.Is(ctx.Err(), context.Canceled):
			// kitpd is stopping: not the message's doing.
			if firstErr == nil {
				firstErr = err
			}
		case ctx.Err() != nil && leftAtStart < p.budget/2:
			// The poll's budget ran out on it: not the message's doing
			// either, and it goes first next poll.
		case ff.setAside:
			// It kept failing while mail down its path filed, and its last
			// try failed too: set aside.
			if err := p.setAsideUnfiled(bctx, client, projectID, validity, m, ff.failures+1, err); err != nil && firstErr == nil {
				firstErr = err
			}
			ingested++
		default:
			// A passing failure (permanent ones are set aside by
			// fileFetched): recorded against the message, not the account,
			// and the poll goes on to the next one.
			failures++
			p.noteFileFailure(bctx, projectID, validity, m, path, err)
		}
		if seen {
			if err := client.MarkSeen(bctx, []uint32{u.UID}); err != nil && firstErr == nil {
				firstErr = fmt.Errorf("imap mark seen: %w", err)
			}
			ingested++
			if !aside && path != OutcomeDuplicate {
				filedPaths[path] = true
			}
			if hadFailed {
				p.clearFileFailure(bctx, validity, u.UID)
			}
		}
		if seen && aside {
			p.archive(bctx, client, u.UID)
		}
		cancel()
		if tracked || seen {
			p.endInflight(ctx, validity, u.UID)
		}
	}

	if len(filedPaths) > 0 {
		p.noteOthersFiled(ctx, validity, filedPaths)
	}
	bctx, cancel := bookkeepingCtx(ctx)
	defer cancel()
	if err := p.recordPoll(bctx, projectID, len(list), failures); err != nil && firstErr == nil {
		firstErr = err
	}
	p.logger.LogAttrs(ctx, slog.LevelDebug, "imap cycle complete",
		slog.Int64("channel_id", p.channelID),
		slog.Int("unseen", len(list)),
		slog.Int("ingested", ingested),
		slog.Int("failed", failures))
	if firstErr == nil && failures > 0 && len(filedPaths) == 0 {
		return ErrNothingFiled
	}
	return firstErr
}

// ErrNothingFiled is a poll in which messages failed to file and none
// filed. Tick backs the account off on it, so a failure that hits all its
// mail isn't retried every minute, but it doesn't count toward the fault
// switch: the failures are recorded on the messages (file_retry), and the
// Comm log's poll row counts them.
var ErrNothingFiled = errors.New("imap: messages failed to file and none filed")

// budgetLeft is how long the poll may still run.
func (p *IMAPPoller) budgetLeft(ctx context.Context) time.Duration {
	if d, ok := ctx.Deadline(); ok {
		return time.Until(d)
	}
	return p.budget
}

// imapPollBudget is how long one poll may run (Tick).
const imapPollBudget = 2 * time.Minute

// imapMaxAttempts is how many times a poll starts reading one message
// before setting it aside: a message that stopped kitpd that often would
// stop it on every poll.
const imapMaxAttempts = 2

// DefaultSetAsideFolder is where never-fileable mail goes out of INBOX.
const DefaultSetAsideFolder = "kitp-set-aside"

// archive moves a never-fileable message out of INBOX to the set-aside
// folder, so it is out of the way as well as read (review 2026-11-03 round
// 4). A server that can't move by UID leaves it read in INBOX; a failure is
// logged and changes nothing else.
func (p *IMAPPoller) archive(ctx context.Context, client imapClient, uid uint32) {
	if p.setAside == "" {
		return
	}
	err := client.Archive(ctx, []uint32{uid}, p.setAside)
	switch {
	case err == nil:
	case errors.Is(err, ErrNoMove):
		p.logger.LogAttrs(ctx, slog.LevelDebug, "imap: server can't move mail; set-aside message stays in INBOX",
			slog.Int64("channel_id", p.channelID), slog.Any("uid", uid))
	default:
		p.logger.LogAttrs(ctx, slog.LevelWarn, "imap: moving a set-aside message failed",
			slog.Int64("channel_id", p.channelID), slog.Any("uid", uid),
			slog.String("folder", p.setAside), slog.String("error", err.Error()))
	}
}

// fileFetched files one fetched message and says whether it is done with
// — filed, or never fileable (unreadable, too large, set aside,
// unfileable) — so it is marked seen, and whether it is never fileable
// (aside), so it is moved out of INBOX. A message that failed for a
// passing reason returns false and the error, and is tried again next poll.
// path is the filing path it went down, or failed on (Filed.Outcome).
func (p *IMAPPoller) fileFetched(ctx context.Context, intake channelIntake, m InboundMessage, size int64) (seen, aside bool, path string, err error) {
	if m.ParseError != "" {
		// Not mail: log it and mark it read (it stays in the mailbox), as
		// POST and SMTP do. Filing it would make an empty thread, and every
		// empty message shares one dedupe key.
		n := int64(len(m.Raw))
		if n == 0 {
			n = size
		}
		if err := p.logInbound(ctx, p.pool.P, intake.projectID, inboundMeta{transport: TransportIMAP}, "parse_error", map[string]any{
			"error": m.ParseError, "uid": m.UID, "bytes": n,
		}); err != nil {
			return false, false, "", err
		}
		return true, true, "", nil
	}
	filed, err := p.processOne(ctx, intake, m, inboundMeta{transport: TransportIMAP})
	if err != nil {
		if permanentFilingError(err) {
			// It can never be filed (ErrUnfileable): log it and mark it read
			// like an unreadable message, rather than retry it forever and
			// trip the account's fault switch. A failure to log it is logged
			// here and doesn't hold the message back either.
			if lerr := p.logInbound(ctx, p.pool.P, intake.projectID, inboundMeta{transport: TransportIMAP}, "file_error", fileErrorDetail(m, err)); lerr != nil {
				p.logger.LogAttrs(ctx, slog.LevelWarn, "imap: logging an unfileable message failed",
					slog.Int64("channel_id", p.channelID),
					slog.Any("uid", m.UID),
					slog.String("error", lerr.Error()))
			}
			return true, true, filed.Outcome, nil
		}
		return false, false, filed.Outcome, err
	}
	return true, false, filed.Outcome, nil
}

// pruneInflight drops this channel's in-flight and file-failure records
// from another UIDVALIDITY (the mailbox was rebuilt; its UIDs name other
// messages now) and any untouched for a week (a failing message someone
// read or moved in the mailbox).
func (p *IMAPPoller) pruneInflight(ctx context.Context, validity uint32) error {
	args := map[string]any{"channel": p.channelID, "validity": int64(validity)}
	if err := namedExec(ctx, p.pool.P, `
		DELETE FROM comm_imap_inflight
		WHERE channel_id = :channel
		  AND (uid_validity <> :validity OR started_at < now() - interval '7 days')
	`, args); err != nil {
		return fmt.Errorf("imap: prune in-flight: %w", err)
	}
	if err := namedExec(ctx, p.pool.P, `
		DELETE FROM comm_imap_file_failure
		WHERE channel_id = :channel
		  AND (uid_validity <> :validity OR last_failed_at < now() - interval '7 days')
	`, args); err != nil {
		return fmt.Errorf("imap: prune file failures: %w", err)
	}
	return nil
}

// imapSetAsideFailures and fileFailureSetAsideAfter are when a message that
// keeps failing to file for a passing reason is set aside: after this many
// failures over at least this long, while fresh mail of the account filed
// down the same path (comm_imap_file_failure), and once a last try fails.
const imapSetAsideFailures = 3

var fileFailureSetAsideAfter = 24 * time.Hour

// fileFailure is a comm_imap_file_failure row as a poll reads it.
type fileFailure struct {
	failures int
	detail   map[string]any
	setAside bool
}

// loadFileFailures reads this channel's messages that failed to file, and
// which of them are due to be set aside.
func (p *IMAPPoller) loadFileFailures(ctx context.Context, validity uint32) (map[uint32]fileFailure, error) {
	b := named.New()
	b.Set("channel", p.channelID)
	b.Set("validity", int64(validity))
	b.Set("min_failures", imapSetAsideFailures)
	b.Set("after_secs", fileFailureSetAsideAfter.Seconds())
	q, args, err := b.Compile(`
		SELECT uid, failures, detail,
		       others_filed AND failures >= :min_failures
		       AND first_failed_at <= now() - make_interval(secs => :after_secs)
		FROM comm_imap_file_failure
		WHERE channel_id = :channel AND uid_validity = :validity`)
	if err != nil {
		return nil, fmt.Errorf("imap: file failures: compile: %w", err)
	}
	rows, err := p.pool.P.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("imap: file failures: %w", err)
	}
	defer rows.Close()
	out := map[uint32]fileFailure{}
	for rows.Next() {
		var uid int64
		var f fileFailure
		if err := rows.Scan(&uid, &f.failures, &f.detail, &f.setAside); err != nil {
			return nil, fmt.Errorf("imap: file failures: scan: %w", err)
		}
		out[uint32(uid)] = f
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("imap: file failures: %w", err)
	}
	return out, nil
}

// fileRetryDetail is the Comm log detail of a passing filing failure: which
// message, and why in words that don't quote its values.
func fileRetryDetail(m InboundMessage, err error) map[string]any {
	reason := "an error (the kitpd log has it)"
	var pg *pgconn.PgError
	switch {
	case errors.As(err, &pg):
		reason = "a database error (" + pg.Code + ")"
	case errors.Is(err, context.DeadlineExceeded):
		reason = "filing it took longer than the poll may"
	}
	return map[string]any{
		"error": reason, "uid": m.UID,
		"message_id": clip(m.MessageID, 300), "from": clip(m.From, 300), "subject": clip(m.Subject, 300),
	}
}

// bookkeepingCtx is for a poll's records of a message once the poll's own
// ctx may have run out (a filing that took the whole budget).
func bookkeepingCtx(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
}

// noteFileFailure records a passing filing failure against the message, with
// the path it failed on; the first one is logged in the Comm log
// (file_retry). A failure to record it is logged: the message is retried on
// the next poll either way. ctx is a bookkeepingCtx.
func (p *IMAPPoller) noteFileFailure(ctx context.Context, projectID int64, validity uint32, m InboundMessage, path string, ferr error) {
	p.logger.LogAttrs(ctx, slog.LevelWarn, "imap: filing a message failed; trying it again next poll",
		slog.Int64("channel_id", p.channelID), slog.Any("uid", m.UID), slog.String("path", path), slog.String("error", ferr.Error()))
	detail := fileRetryDetail(m, ferr)
	row, err := namedRow(ctx, p.pool.P, `
		INSERT INTO comm_imap_file_failure (channel_id, uid_validity, uid, path, detail)
		VALUES (:channel, :validity, :uid, :path, :detail)
		ON CONFLICT (channel_id, uid_validity, uid) DO UPDATE
			SET failures = comm_imap_file_failure.failures + 1, last_failed_at = now(),
			    path = EXCLUDED.path, detail = EXCLUDED.detail,
			    -- Another path is another fault: it has to be its own
			    -- again while that path files.
			    others_filed = comm_imap_file_failure.others_filed AND comm_imap_file_failure.path = EXCLUDED.path
		RETURNING failures
	`, map[string]any{"channel": p.channelID, "validity": int64(validity), "uid": int64(m.UID), "path": path, "detail": detail})
	var failures int
	if err == nil {
		err = row.Scan(&failures)
	}
	if err != nil {
		p.logger.LogAttrs(ctx, slog.LevelError, "imap: recording a filing failure failed",
			slog.Int64("channel_id", p.channelID), slog.Any("uid", m.UID), slog.String("error", err.Error()))
		return
	}
	if failures == 1 {
		if err := p.logInbound(ctx, p.pool.P, projectID, inboundMeta{transport: TransportIMAP}, "file_retry", detail); err != nil {
			p.logger.LogAttrs(ctx, slog.LevelWarn, "imap: logging a filing failure failed",
				slog.Int64("channel_id", p.channelID), slog.Any("uid", m.UID), slog.String("error", err.Error()))
		}
	}
}

// clearFileFailure forgets a message's failures once it filed or was set
// aside. Left behind, the row is pruned within a week. ctx is a
// bookkeepingCtx.
func (p *IMAPPoller) clearFileFailure(ctx context.Context, validity uint32, uid uint32) {
	if err := namedExec(ctx, p.pool.P, `
		DELETE FROM comm_imap_file_failure WHERE channel_id = :channel AND uid_validity = :validity AND uid = :uid
	`, map[string]any{"channel": p.channelID, "validity": int64(validity), "uid": int64(uid)}); err != nil {
		p.logger.LogAttrs(ctx, slog.LevelWarn, "imap: clearing a filing failure failed",
			slog.Int64("channel_id", p.channelID), slog.Any("uid", uid), slog.String("error", err.Error()))
	}
}

// noteOthersFiled marks this channel's failing messages as failing while
// fresh mail down their path files: the failure is theirs, not the
// account's, nor a fault of that path. A duplicate isn't such mail (it
// stops at the dedupe); a failure before the thread match (path "") is on
// every path.
func (p *IMAPPoller) noteOthersFiled(ctx context.Context, validity uint32, paths map[string]bool) {
	list := make([]string, 0, len(paths))
	for path := range paths {
		list = append(list, path)
	}
	bctx, cancel := bookkeepingCtx(ctx)
	defer cancel()
	if err := namedExec(bctx, p.pool.P, `
		UPDATE comm_imap_file_failure SET others_filed = true
		WHERE channel_id = :channel AND uid_validity = :validity AND NOT others_filed
		  AND (path = '' OR path = ANY(:paths::text[]))
	`, map[string]any{"channel": p.channelID, "validity": int64(validity), "paths": list}); err != nil {
		p.logger.LogAttrs(ctx, slog.LevelWarn, "imap: noting other mail filed failed",
			slog.Int64("channel_id", p.channelID), slog.String("error", err.Error()))
	}
}

// setAsideUnfiled sets aside a message that kept failing to file and failed
// its last try (ferr, its failures-th): marked read, logged as file_error,
// moved to the set-aside folder, its failure record cleared. It is marked
// read first, so a mark that fails logs nothing and the next poll tries
// again. ctx is a bookkeepingCtx.
func (p *IMAPPoller) setAsideUnfiled(ctx context.Context, client InboundClient, projectID int64, validity uint32, m InboundMessage, failures int, ferr error) error {
	if err := client.MarkSeen(ctx, []uint32{m.UID}); err != nil {
		return fmt.Errorf("imap mark seen: %w", err)
	}
	detail := fileRetryDetail(m, ferr)
	detail["error"] = fmt.Sprintf("set aside: filing it failed %d times over more than %s (last: %v)",
		failures, fileFailureSetAsideAfter, detail["error"])
	if err := p.logInbound(ctx, p.pool.P, projectID, inboundMeta{transport: TransportIMAP}, "file_error", detail); err != nil {
		p.logger.LogAttrs(ctx, slog.LevelWarn, "imap: logging a set-aside message failed",
			slog.Int64("channel_id", p.channelID), slog.Any("uid", m.UID), slog.String("error", err.Error()))
	}
	p.archive(ctx, client, m.UID)
	p.clearFileFailure(ctx, validity, m.UID)
	return nil
}

// beginInflight records that a poll is reading message uid, committed at
// once (outside any filing transaction), and returns how many polls have
// started on it without finishing, this one included.
func (p *IMAPPoller) beginInflight(ctx context.Context, validity, uid uint32) (int, error) {
	row, err := namedRow(ctx, p.pool.P, `
		INSERT INTO comm_imap_inflight (channel_id, uid_validity, uid)
		VALUES (:channel, :validity, :uid)
		ON CONFLICT (channel_id, uid_validity, uid) DO UPDATE
			SET attempts = comm_imap_inflight.attempts + 1, started_at = now()
		RETURNING attempts
	`, map[string]any{"channel": p.channelID, "validity": int64(validity), "uid": int64(uid)})
	if err != nil {
		return 0, fmt.Errorf("imap: record in-flight: %w", err)
	}
	var attempts int
	if err := row.Scan(&attempts); err != nil {
		return 0, fmt.Errorf("imap: record in-flight: %w", err)
	}
	return attempts, nil
}

// endInflight clears a message's in-flight record: it was filed, set
// aside, or failed in a way the next poll retries. A failure to clear it
// is logged: the record only costs that message one of its attempts.
func (p *IMAPPoller) endInflight(ctx context.Context, validity, uid uint32) {
	err := namedExec(context.WithoutCancel(ctx), p.pool.P, `
		DELETE FROM comm_imap_inflight
		WHERE channel_id = :channel AND uid_validity = :validity AND uid = :uid
	`, map[string]any{"channel": p.channelID, "validity": int64(validity), "uid": int64(uid)})
	if err != nil {
		p.logger.LogAttrs(ctx, slog.LevelWarn, "imap: clearing an in-flight record failed",
			slog.Int64("channel_id", p.channelID),
			slog.Any("uid", uid),
			slog.String("error", err.Error()))
	}
}

// Intake modes: what a new (unmatched) inbound message becomes. See
// docs/CONVERSATIONS.md.
const (
	IntakeTask   = "task"   // a task and a thread on it
	IntakeThread = "thread" // a thread on its own, in the project
	IntakeIgnore = "ignore" // dropped: only replies to existing threads come in
)

// ResolveIntakeMode maps a channel's stored intake_mode to the mode in
// effect. Unset (or unknown) keeps what channels did before the setting:
// a task when the channel has an intake status, else ignore.
func ResolveIntakeMode(stored string, intakeStatusID int64) string {
	switch stored {
	case IntakeTask, IntakeThread, IntakeIgnore:
		return stored
	}
	if intakeStatusID != 0 {
		return IntakeTask
	}
	return IntakeIgnore
}

// Mail account settings for what kitp does beyond filing a message
// (docs/MAIL_INTAKE_AND_CALENDARS.md): relay_replies sends an emailed reply
// on to the thread's other people; email_attachments keeps or drops the
// files on incoming mail.
const (
	RelayOn         = "on"
	RelayOff        = "off"
	AttachmentsKeep = "keep"
	AttachmentsDrop = "drop"
)

// ResolveRelay reports whether a stored relay_replies value sends replies
// on. Unset is off: accounts from before the setting keep what they did (a
// new account is created with "on", comm_channel.set).
func ResolveRelay(stored string) bool { return stored == RelayOn }

// ResolveKeepAttachments reports whether a stored email_attachments value
// keeps files. Unset keeps them, as before the setting.
func ResolveKeepAttachments(stored string) bool { return stored != AttachmentsDrop }

// channelIntake is what the poller needs to file a message: the
// channel's project, its intake status (0 = none), resolved mode, and
// whether replies are sent on and files kept.
type channelIntake struct {
	projectID int64
	statusID  int64
	mode      string
	relay     bool
	keepFiles bool
}

// loadChannelConfig reads the channel's IMAP host/port/username +
// decrypted imap_password + intake status / mode + enclosing project
// id. One round-trip; returns an error shaped for the caller to log
// directly.
func (p *IMAPPoller) loadChannelConfig(ctx context.Context) (IMAPConfig, channelIntake, error) {
	var cfg IMAPConfig
	var in channelIntake
	var storedMode string
	b := named.New()
	b.Set("channel_id", p.channelID)
	q, args, err := b.Compile(`
		SELECT
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = :channel_id AND ad.name='imap_host'), '')      AS imap_host,
			COALESCE((SELECT (value)::text::int FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = :channel_id AND ad.name='imap_port' AND jsonb_typeof(value)='number'), 0) AS imap_port,
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = :channel_id AND ad.name='imap_username'), '')  AS imap_username,
			COALESCE(
				(SELECT pgp_sym_decrypt(cs.imap_password, current_setting('app.comm_secret_key'))
					FROM comm_secret cs WHERE cs.channel_card_id = :channel_id AND cs.imap_password IS NOT NULL),
				''
			) AS imap_password,
			COALESCE((SELECT (value)::text::bigint FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = :channel_id AND ad.name='intake_status' AND jsonb_typeof(value)='number'), 0) AS intake_status_id,
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = :channel_id AND ad.name='intake_mode'), '')    AS intake_mode,
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = :channel_id AND ad.name='relay_replies'), '')  AS relay_replies,
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = :channel_id AND ad.name='email_attachments'), '') AS email_attachments,
			COALESCE((SELECT parent_card_id FROM card WHERE id = :channel_id), 0) AS project_id
	`)
	if err != nil {
		return cfg, in, fmt.Errorf("compile: %w", err)
	}
	var relay, files string
	if err := p.pool.P.QueryRow(ctx, q, args...).Scan(&cfg.Host, &cfg.Port, &cfg.Username, &cfg.Password, &in.statusID, &storedMode, &relay, &files, &in.projectID); err != nil {
		return cfg, in, err
	}
	if cfg.Port == 0 {
		cfg.Port = 993
	}
	in.mode = ResolveIntakeMode(storedMode, in.statusID)
	in.relay = ResolveRelay(relay)
	in.keepFiles = ResolveKeepAttachments(files)
	return cfg, in, nil
}

// recordAuthFail writes a comm_log kind=imap_auth_fail row capturing
// the error message. Best-effort: a failure to log doesn't surface
// (we already returned the dial error to the caller).
func (p *IMAPPoller) recordAuthFail(ctx context.Context, projectID int64, dialErr error) error {
	return LogEvent(ctx, p.pool.P, projectID, p.channelID, "imap_auth_fail", map[string]any{"error": dialErr.Error()})
}

// recordPoll writes a comm_log kind=poll row with the number of messages
// listed in this cycle and how many of them failed to file. Always one row
// per RunOnce so operators can see liveness on the channel.
func (p *IMAPPoller) recordPoll(ctx context.Context, projectID int64, count, failed int) error {
	if err := LogEvent(ctx, p.pool.P, projectID, p.channelID, "poll", map[string]any{"message_count": count, "failed": failed}); err != nil {
		return err
	}
	if p.pool != nil {
		p.pool.NoteWrite()
	}
	return nil
}

// processOne ingests one inbound message: dedupe, thread-lookup, then
// either append-to-existing-comm or, by the channel's intake mode, a new task
// and thread, a thread on its own, or a drop. All state mutations happen in
// one tx per message so a mid-stream failure doesn't half-commit — and the
// dedupe row (comm_inbound_seen) rolls back with it, so a failed message can
// be retried. Every transport (IMAP, POST, SMTP) comes through here; see
// docs/MAIL_INTAKE_AND_CALENDARS.md §3–4.
func (p *filer) processOne(ctx context.Context, intake channelIntake, m InboundMessage, meta inboundMeta) (filed Filed, err error) {
	// path is the branch the message is on; a failure names it
	// (Filed.Outcome).
	var path string
	defer func() {
		if err != nil {
			filed = Filed{Outcome: path}
		}
	}()
	// Every transport's message is made storable here too, whoever parsed
	// it (storableInbound; a no-op on what ParseInboundMessage returned).
	m.Attachments = append([]InboundAttachment(nil), m.Attachments...)
	storableInbound(&m)
	projectID := intake.projectID
	threadID, source := extractThreadID(m)

	actorID := auth.ActorOrSystem(ctx)
	// Root transaction for this message. Everything below runs on tx (a
	// store.Querier); only this frame commits/rolls back. The deferred
	// Rollback is unconditional and a no-op once Commit has run.
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return Filed{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Dedupe first: a message already filed in this project (by any
	// account, any transport) is recorded as a duplicate and dropped.
	key := messageKey(m)
	fresh, original, err := claimMessage(ctx, tx, projectID, key, p.channelID, meta.transport, m.MessageID)
	if err != nil {
		return Filed{}, fmt.Errorf("dedupe: %w", err)
	}
	if !fresh {
		p.logger.LogAttrs(ctx, slog.LevelDebug, "inbound message is a duplicate",
			slog.Int64("channel_id", p.channelID),
			slog.String("transport", meta.transport),
			slog.String("message_id", m.MessageID),
			slog.Int64("original_card_id", original))
		if err := p.logInbound(ctx, tx, projectID, meta, "duplicate", map[string]any{
			"message_id": m.MessageID, "from": m.From, "subject": m.Subject, "card_id": original,
		}); err != nil {
			return Filed{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return Filed{}, fmt.Errorf("commit: %w", err)
		}
		return Filed{Outcome: OutcomeDuplicate, CardID: original, Duplicate: true}, nil
	}

	snap, err := schema.Load(ctx, tx)
	if err != nil {
		return Filed{}, fmt.Errorf("load schema: %w", err)
	}

	var matchedCommID int64
	if threadID != "" {
		matchedCommID, err = p.findCommByThreadID(ctx, tx, threadID, projectID)
		if err != nil {
			return Filed{}, fmt.Errorf("thread lookup: %w", err)
		}
	}

	// New mail on a task-mode account while the project's Tasks area is
	// off would become a task nobody can see; file it as a thread on its
	// own instead (Conversations is on, or the account wouldn't be
	// polled), so it stays in view (review A3).
	mode := intake.mode
	if matchedCommID == 0 && mode == IntakeTask {
		off, err := tasksOff(ctx, tx, projectID)
		if err != nil {
			return Filed{}, fmt.Errorf("tasks area: %w", err)
		}
		if off {
			mode = IntakeThread
		}
	}

	switch {
	case matchedCommID != 0:
		path = OutcomeReply
		p.logger.LogAttrs(ctx, slog.LevelDebug, "inbound message → reply on existing comm",
			slog.Int64("channel_id", p.channelID),
			slog.Int64("comm_id", matchedCommID),
			slog.String("thread_source", source),
			slog.String("message_id", m.MessageID),
			slog.String("subject", m.Subject))
		// Who was on the thread before this message adds its sender and
		// To / Cc (the relay sends on only between people already there).
		before, err := threadRecipientAddresses(ctx, tx, matchedCommID)
		if err != nil {
			return Filed{}, err
		}
		replyID, err := p.appendReceivedReply(ctx, tx, snap, matchedCommID, m, intake, meta, actorID)
		if err != nil {
			return Filed{}, fmt.Errorf("file reply: %w", err)
		}
		// Sent on to the thread's other people when the account says so. A
		// new thread has nobody else on it yet, so only a reply can be.
		if err := p.relayReply(ctx, tx, snap, matchedCommID, replyID, m, intake, meta, actorID, before); err != nil {
			return Filed{}, fmt.Errorf("relay: %w", err)
		}
		filed = Filed{Outcome: OutcomeReply, CardID: matchedCommID}
	case IsNotificationReply(m):
		path = OutcomeNotificationReply
		// A reply (or auto-reply / bounce) to a notification digest. The
		// notification mailbox doesn't read replies — log and drop.
		p.logger.LogAttrs(ctx, slog.LevelInfo, "inbound message dropped: reply to a notification email",
			slog.Int64("channel_id", p.channelID),
			slog.Int64("project_id", projectID),
			slog.String("from", m.From),
			slog.String("subject", m.Subject))
		if err := p.logInbound(ctx, tx, projectID, meta, "notification_reply", map[string]any{
			"message_id":  m.MessageID,
			"from":        m.From,
			"subject":     m.Subject,
			"in_reply_to": m.InReplyTo,
		}); err != nil {
			return Filed{}, fmt.Errorf("comm_log notification_reply: %w", err)
		}
		filed = Filed{Outcome: OutcomeNotificationReply}
	case mode == IntakeTask:
		path = OutcomeTask
		p.logger.LogAttrs(ctx, slog.LevelDebug, "inbound message → new task",
			slog.Int64("channel_id", p.channelID),
			slog.Int64("project_id", projectID),
			slog.Int64("intake_status_id", intake.statusID),
			slog.String("from", m.From),
			slog.String("subject", m.Subject))
		commID, err := p.createTaskAndComm(ctx, tx, snap, intake, meta, m, actorID)
		if err != nil {
			return Filed{}, fmt.Errorf("file new task: %w", err)
		}
		filed = Filed{Outcome: OutcomeTask, CardID: commID}
	case mode == IntakeThread:
		path = OutcomeThread
		p.logger.LogAttrs(ctx, slog.LevelDebug, "inbound message → new thread",
			slog.Int64("channel_id", p.channelID),
			slog.Int64("project_id", projectID),
			slog.String("from", m.From),
			slog.String("subject", m.Subject))
		commID, err := p.createComm(ctx, tx, snap, projectID, m, intake, meta, actorID)
		if err != nil {
			return Filed{}, fmt.Errorf("file new thread: %w", err)
		}
		filed = Filed{Outcome: OutcomeThread, CardID: commID}
	default:
		path = OutcomeIgnored
		// Discard: no thread match and the channel ignores new mail. This
		// is the usual "inbound mail isn't becoming tasks" cause — surface
		// it at WARN (not just the comm_log row below) so it's visible in
		// logs.
		p.logger.LogAttrs(ctx, slog.LevelWarn, "inbound message dropped: no thread match and the channel ignores new mail",
			slog.Int64("channel_id", p.channelID),
			slog.Int64("project_id", projectID),
			slog.String("from", m.From),
			slog.String("subject", m.Subject),
			slog.String("thread_source", source))
		if err := p.logInbound(ctx, tx, projectID, meta, "unmatched_thread", map[string]any{
			"message_id":    m.MessageID,
			"from":          m.From,
			"subject":       m.Subject,
			"thread_source": source,
		}); err != nil {
			return Filed{}, fmt.Errorf("comm_log unmatched: %w", err)
		}
		filed = Filed{Outcome: OutcomeIgnored}
	}

	if filed.CardID != 0 {
		if err := recordFiledCard(ctx, tx, projectID, key, filed.CardID); err != nil {
			return Filed{}, err
		}
	}
	if err := p.logInbound(ctx, tx, projectID, meta, "received", map[string]any{
		"outcome":    filed.Outcome,
		"card_id":    filed.CardID,
		"message_id": m.MessageID,
		"from":       m.From,
		"subject":    m.Subject,
	}); err != nil {
		return Filed{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return Filed{}, fmt.Errorf("commit: %w", err)
	}
	if p.pool != nil {
		p.pool.NoteWrite()
	}
	return filed, nil
}

// findCommByThreadID returns the comm card id whose thread_id matches
// the supplied token, or 0 if none — among the threads of this mail
// account's project that anyone can see. A token from another project's
// mail (thread ids are global, and a sender can copy one) or a thread in
// an area that is switched off is no match: the message is then new mail
// for this project, visible, rather than appended where it doesn't belong
// or out of sight (review A3).
func (p *filer) findCommByThreadID(ctx context.Context, tx store.Querier, threadID string, projectID int64) (int64, error) {
	row, err := namedRow(ctx, tx, `
		SELECT av.card_id
		FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		JOIN card c ON c.id = av.card_id
		WHERE ad.name = 'thread_id'
		  AND av.value = to_jsonb(:thread::text)
		  AND c.deleted_at IS NULL
		  -- A thread on a deleted task is gone with it: mail on it starts
		  -- anew rather than filing where nobody sees it.
		  AND NOT card_under_deleted(c.id)
		  AND card_enclosing_project(c.id) = :project
		  AND NOT card_in_off_area(c.id)
		ORDER BY c.id
		LIMIT 1
	`, map[string]any{"thread": threadID, "project": projectID})
	if err != nil {
		return 0, err
	}
	var id int64
	if err := row.Scan(&id); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, nil
		}
		return 0, err
	}
	return id, nil
}

// appendReceivedReply inserts a reply_body card carrying the inbound
// envelope + body, appends its id to the comm's replies attribute and
// returns it. Mirrors insertReceivedReply but accepts the full inbound
// envelope (From/To) so the reply_to / reply_from rows reflect who actually
// sent the message rather than empty strings. The message's files are
// stored on the thread, or left off when the account drops them (in).
func (p *filer) appendReceivedReply(ctx context.Context, tx store.Querier, snap *schema.Snapshot, commID int64, m InboundMessage, in channelIntake, meta inboundMeta, actorID int64) (int64, error) {
	replyCTID, err := resolveCardType(snap, "reply_body")
	if err != nil {
		return 0, err
	}
	var replyID int64
	row, err := namedRow(ctx, tx, `INSERT INTO card (card_type_id) VALUES (:type) RETURNING id`,
		map[string]any{"type": replyCTID})
	if err != nil {
		return 0, err
	}
	if err := row.Scan(&replyID); err != nil {
		return 0, fmt.Errorf("insert reply_body card: %w", err)
	}
	if err := writeCardCreateActivity(ctx, tx, replyID, actorID); err != nil {
		return 0, err
	}
	jstr := func(s string) json.RawMessage { b, _ := json.Marshal(s); return b }
	writes := []struct {
		name string
		val  json.RawMessage
	}{
		{"reply_to", jstr(m.To)},
		{"reply_cc", jstr(m.Cc)},
		{"reply_from", jstr(displayAddress(m.From))},
		{"reply_subject", jstr(m.Subject)},
		{"reply_body_text", jstr(m.Body)},
		{"delivery_status", jstr("received")},
	}
	// Its Message-ID, for the References of kitp's replies (threading).
	if mid := normalMessageID(m.MessageID); mid != "" {
		writes = append(writes, struct {
			name string
			val  json.RawMessage
		}{"reply_message_id", jstr(mid)})
	}
	for _, w := range writes {
		ad, ok := snap.AttrByName[w.name]
		if !ok {
			return 0, fmt.Errorf("appendReceivedReply: missing attribute_def %q", w.name)
		}
		if err := writeAttributeValue(ctx, tx, replyID, ad.ID, w.val, actorID); err != nil {
			return 0, err
		}
	}
	if err := appendCardRefList(ctx, tx, commID, "replies", replyID, snap, actorID); err != nil {
		return 0, err
	}
	// A newly received message marks the thread unhandled: clear the comm's
	// `acked` flag so it surfaces in the "Needs ACK" filter until an operator
	// acknowledges it via comm.set_ack. Tolerate an older snapshot without the
	// attribute_def (skip rather than fail the whole inbound).
	if ad, ok := snap.AttrByName["acked"]; ok {
		if err := writeAttributeValue(ctx, tx, commID, ad.ID, json.RawMessage("false"), actorID); err != nil {
			return 0, fmt.Errorf("appendReceivedReply: clear acked: %w", err)
		}
	}
	// The message's files live on the thread itself, whether or not it is
	// on a task; a person can move one onto the task (comm.attachment_to_task).
	switch {
	case len(m.Attachments) == 0:
	case !in.keepFiles:
		if err := p.leaveFilesOff(ctx, tx, snap, replyID, m, in, meta, actorID); err != nil {
			return 0, err
		}
	default:
		err := withSavepoint(ctx, tx, "inbound_files", func() error {
			return p.ingestInboundAttachments(ctx, tx, commID, replyID, m.Attachments, actorID)
		})
		if err != nil {
			// A file that fails to land doesn't lose the message: its
			// savepoint is rolled back and the message is filed without
			// the files.
			p.logger.LogAttrs(ctx, slog.LevelWarn, "inbound attachment ingest failed",
				slog.Int64("channel_id", p.channelID),
				slog.Int64("comm_id", commID),
				slog.Int64("reply_id", replyID),
				slog.String("error", err.Error()))
		}
	}
	if p.saveRawEmail && len(m.Raw) > 0 {
		// Debugging aid (KITP_COMM_SAVE_RAW_EMAIL=1): keep the verbatim
		// message so we can replay it against the body-conversion rules when
		// a description comes out wrong. An operator's switch, so it keeps
		// the .eml even on an account that drops files. Best-effort — never
		// fail the inbound over it.
		name := rawEmailName(m.UID)
		err := withSavepoint(ctx, tx, "inbound_raw", func() error {
			_, err := storeAttachment(ctx, tx, commID, replyID, name, "message/rfc822", m.Raw, actorID)
			return err
		})
		if err != nil {
			p.logger.LogAttrs(ctx, slog.LevelWarn, "imap save raw email failed",
				slog.Int64("channel_id", p.channelID),
				slog.Int64("comm_id", commID),
				slog.Int64("reply_id", replyID),
				slog.String("error", err.Error()))
		}
	}
	err = withSavepoint(ctx, tx, "inbound_recipients", func() error {
		return p.syncCommRecipientsFromInbound(ctx, tx, snap, commID, m, actorID)
	})
	if err != nil {
		// Log but don't fail the whole inbound — the message + reply
		// landed; participant tracking can be fixed up later by an
		// operator editing recipients manually. The savepoint keeps a
		// failed statement from aborting the message's transaction
		// (review 2026-11-03 round 2 #2).
		p.logger.LogAttrs(ctx, slog.LevelWarn, "imap recipient sync failed",
			slog.Int64("channel_id", p.channelID),
			slog.Int64("comm_id", commID),
			slog.String("error", err.Error()))
	}
	return replyID, nil
}

// withSavepoint runs fn inside a savepoint of the message's transaction, so
// a failed statement in fn is rolled back alone instead of aborting the
// whole message. fn's error is returned after the rollback.
func withSavepoint(ctx context.Context, tx store.Querier, name string, fn func() error) error {
	if _, err := tx.Exec(ctx, "SAVEPOINT "+name); err != nil {
		return fmt.Errorf("savepoint: %w", err)
	}
	if err := fn(); err != nil {
		if _, rerr := tx.Exec(ctx, "ROLLBACK TO SAVEPOINT "+name); rerr != nil {
			return errors.Join(err, fmt.Errorf("rollback to savepoint: %w", rerr))
		}
		return err
	}
	if _, err := tx.Exec(ctx, "RELEASE SAVEPOINT "+name); err != nil {
		return fmt.Errorf("release savepoint: %w", err)
	}
	return nil
}

// leaveFilesOff files a message without its files, for an account that
// drops them: the message records how many were left off
// (attachments_left_off) and the Comm log gets an attachments_dropped row
// with their names.
func (p *filer) leaveFilesOff(ctx context.Context, tx store.Querier, snap *schema.Snapshot, replyID int64, m InboundMessage, in channelIntake, meta inboundMeta, actorID int64) error {
	ad, ok := snap.AttrByName["attachments_left_off"]
	if !ok {
		return fmt.Errorf("leaveFilesOff: missing attribute_def attachments_left_off")
	}
	n, err := json.Marshal(len(m.Attachments))
	if err != nil {
		return err
	}
	if err := writeAttributeValue(ctx, tx, replyID, ad.ID, n, actorID); err != nil {
		return fmt.Errorf("leaveFilesOff: %w", err)
	}
	names := make([]string, 0, len(m.Attachments))
	for _, a := range m.Attachments {
		names = append(names, a.Filename)
	}
	return p.logInbound(ctx, tx, in.projectID, meta, "attachments_dropped", map[string]any{
		"reply_id": replyID, "count": len(m.Attachments), "files": names,
		"message_id": m.MessageID, "from": m.From, "subject": m.Subject,
	})
}

// threadTask is the task a thread sits on, or 0 for a thread on its own.
func threadTask(ctx context.Context, tx store.Querier, commID int64) (int64, error) {
	row, err := namedRow(ctx, tx, `
		SELECT COALESCE((
			SELECT p.id FROM card c
			JOIN card p ON p.id = c.parent_card_id
			JOIN card_type pct ON pct.id = p.card_type_id AND pct.name = 'task'
			WHERE c.id = :comm_id), 0)
	`, map[string]any{"comm_id": commID})
	if err != nil {
		return 0, fmt.Errorf("thread task: %w", err)
	}
	var task int64
	if err := row.Scan(&task); err != nil {
		return 0, fmt.Errorf("thread task: %w", err)
	}
	return task, nil
}

// ingestInboundAttachments stores every file on an inbound message on the
// thread (commID), linked to the message via reply_body_attachment — once.
// A file whose bytes (sha256) kitp already holds for this thread is linked,
// not stored again: one on the thread, on its task, or linked from any of
// the thread's messages (a file moved onto a task the thread has since left).
// That covers the round trip — a file sent from the task comes back quoted
// in a reply — and the same file sent twice, or twice in one message.
//
// New files land via the same shape as the file.create handler:
// cas_blob (ON CONFLICT on the digest), cas_blob_data (idem), file
// row with sha256 set, single file_chunk pointing at the blob,
// attachment row on the thread.
func (p *filer) ingestInboundAttachments(
	ctx context.Context,
	tx store.Querier,
	commID int64,
	replyID int64,
	atts []InboundAttachment,
	actorID int64,
) error {
	taskID, err := threadTask(ctx, tx, commID)
	if err != nil {
		return fmt.Errorf("ingestInboundAttachments: %w", err)
	}
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

		existingAttID, err := findThreadFile(ctx, tx, commID, taskID, digest)
		if err != nil {
			return fmt.Errorf("ingestInboundAttachments: %w", err)
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

		// Novel content: store the bytes as a new file on the thread,
		// linked to this message. storeAttachment recomputes the digest, but
		// CAS bytes are reused on conflict so no duplicate blob lands.
		if _, err := storeAttachment(ctx, tx, commID, replyID, filename, mt, a.Bytes, actorID); err != nil {
			return fmt.Errorf("ingestInboundAttachments: %w", err)
		}
	}
	return nil
}

// findThreadFile returns a live attachment with these bytes (sha256 hex)
// that belongs with the thread — on it, on its task (taskID, 0 = none) or
// linked from one of its messages — or 0. The oldest wins.
func findThreadFile(ctx context.Context, tx store.Querier, commID, taskID int64, digest string) (int64, error) {
	row, err := namedRow(ctx, tx, `
		WITH cand AS (
			SELECT a.id FROM attachment a
			WHERE a.card_id IN (:comm_id, :task_id) AND a.deleted_at IS NULL
			UNION
			SELECT rba.attachment_id
			FROM attribute_value rep
			JOIN attribute_def rad ON rad.id = rep.attribute_def_id AND rad.name = 'replies'
			CROSS JOIN LATERAL jsonb_array_elements(
				CASE WHEN jsonb_typeof(rep.value) = 'array' THEN rep.value ELSE '[]'::jsonb END) AS e(v)
			JOIN reply_body_attachment rba ON rba.reply_body_id =
				CASE WHEN (e.v #>> '{}') ~ '^[0-9]+$' THEN (e.v #>> '{}')::bigint END
			WHERE rep.card_id = :comm_id
		)
		SELECT a.id
		FROM cand
		JOIN attachment a ON a.id = cand.id AND a.deleted_at IS NULL
		JOIN file f ON f.id = a.file_id AND f.sha256 = :sha
		ORDER BY a.id
		LIMIT 1
	`, map[string]any{"comm_id": commID, "task_id": taskID, "sha": digest})
	if err != nil {
		return 0, fmt.Errorf("find thread file: %w", err)
	}
	var id int64
	if err := row.Scan(&id); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, nil
		}
		return 0, fmt.Errorf("find thread file: %w", err)
	}
	return id, nil
}

// storeAttachment persists data as a new file + attachment on cardID (the
// thread) and links it to replyID via reply_body_attachment, returning the new
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
	cardID int64,
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
	b.Set("card_id", cardID)
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
// the thread, an operator can edit recipients via the UI; someone they
// took off isn't put back (mergeCommRecipients). At most MaxSyncPeople
// addresses of one message are taken, From first: a Cc of thousands made
// as many people and took seconds to file (review 2026-11-03 round 3).
func (p *filer) syncCommRecipientsFromInbound(
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
		if p.isRouteAddress(key) {
			return
		}
		if _, ok := seen[key]; ok {
			return
		}
		if len(found) >= MaxSyncPeople {
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
		// Plain addresses only, odd ones skipped (PeopleIn). Best-effort:
		// a header that doesn't parse adds nobody, and the others are
		// still read.
		for _, a := range PeopleIn(raw) {
			addOne(a)
		}
	}
	if len(found) == 0 {
		return nil
	}
	// A thread holds at most MaxCommRecipients people; a full one makes
	// no more people of its mail's addresses (review 2026-11-03 round 5
	// #2: two or three emails that each Cc'd 49 put a thread past 100,
	// and every staff reply on it was refused).
	cur, _, err := readAttributeValueRaw(ctx, tx, commID, "comm_recipients")
	if err != nil {
		return fmt.Errorf("read recipients: %w", err)
	}
	if len(decodeCardRefArray(cur)) >= MaxCommRecipients {
		p.logger.LogAttrs(ctx, slog.LevelInfo, "inbound mail: thread has the most recipients; nobody added",
			slog.Int64("comm_id", commID), slog.Int("max", MaxCommRecipients))
		return nil
	}
	ids := make([]int64, 0, len(found))
	sender := senderOf(m.From)
	for _, a := range found {
		id, _, uerr := upsertPersonByEmail(ctx, tx, snap, a.email, a.name, PersonKindContact,
			sender != "" && strings.EqualFold(a.email, sender), actorID)
		if uerr != nil {
			return fmt.Errorf("upsert %s: %w", a.email, uerr)
		}
		ids = append(ids, id)
	}
	_, dropped, err := mergeCommRecipients(ctx, tx, snap, commID, ids, actorID)
	if err != nil {
		return fmt.Errorf("merge recipients: %w", err)
	}
	if dropped > 0 {
		p.logger.LogAttrs(ctx, slog.LevelInfo, "inbound mail: thread reached the most recipients; some not added",
			slog.Int64("comm_id", commID), slog.Int("not_added", dropped), slog.Int("max", MaxCommRecipients))
	}
	return nil
}

// MaxCommRecipients is the most people on one thread, and the most one
// reply goes to: the cap comm.create, comm.set_recipients, reply.post and
// comm_author_join keep in SQL (review 2026-11-03 round 5 #2).
const MaxCommRecipients = 100

// MaxSyncPeople is the most addresses one received message puts on its
// thread (and makes people of).
const MaxSyncPeople = 50

// loadChannelFromAddress returns the comm_channel's configured
// from_address attribute, or "" when none is set. Used by the
// inbound recipient sync to exclude the channel's own envelope
// from the participant list.
func loadChannelFromAddress(ctx context.Context, tx store.Querier, channelID int64) (string, error) {
	var out string
	row, err := namedRow(ctx, tx, `
		SELECT COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = :channel AND ad.name='from_address'), '')
	`, map[string]any{"channel": channelID})
	if err != nil {
		return "", err
	}
	if err := row.Scan(&out); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	return out, nil
}

// createTaskAndComm covers the task intake path: no existing thread
// match, the channel files new mail as tasks, so we mint a fresh task +
// comm and treat the inbound message as the comm's first received
// reply.
//
// The task gets title=subject, description=body, status=the channel's
// intake status, or the project's task flow default when it has none.
// The comm is createComm's, under the task.
func (p *filer) createTaskAndComm(ctx context.Context, tx store.Querier, snap *schema.Snapshot, in channelIntake, meta inboundMeta, m InboundMessage, actorID int64) (int64, error) {
	projectID, intakeStatusID := in.projectID, in.statusID
	taskCTID, err := resolveCardType(snap, "task")
	if err != nil {
		return 0, err
	}
	if intakeStatusID == 0 {
		statusAttrID, err := resolveAttr(snap, "status")
		if err != nil {
			return 0, err
		}
		if intakeStatusID, err = commFlowDefaultStatus(ctx, tx, projectID, statusAttrID); err != nil {
			return 0, err
		}
		if intakeStatusID == 0 {
			return 0, &reg.HandlerError{Code: "no_task_flow",
				Message: fmt.Sprintf("imap intake: project %d has no task flow default and the channel has no intake status", projectID)}
		}
	}

	// Insert the new task card under the project.
	var taskID int64
	row, err := namedRow(ctx, tx, `INSERT INTO card (card_type_id, parent_card_id) VALUES (:type, :parent) RETURNING id`,
		map[string]any{"type": taskCTID, "parent": projectID})
	if err != nil {
		return 0, err
	}
	if err := row.Scan(&taskID); err != nil {
		return 0, fmt.Errorf("insert task card: %w", err)
	}
	if err := writeCardCreateActivity(ctx, tx, taskID, actorID); err != nil {
		return 0, err
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
			return 0, fmt.Errorf("createTaskAndComm: missing attribute_def %q", w.name)
		}
		if err := writeAttributeValue(ctx, tx, taskID, ad.ID, w.val, actorID); err != nil {
			return 0, fmt.Errorf("task attr %s: %w", w.name, err)
		}
	}

	commID, err := p.createComm(ctx, tx, snap, taskID, m, in, meta, actorID)
	if err != nil {
		return 0, err
	}

	// Append comm to task.comms.
	if err := appendCardRefList(ctx, tx, taskID, "comms", commID, snap, actorID); err != nil {
		return 0, fmt.Errorf("append task.comms: %w", err)
	}
	return commID, nil
}

// createComm files an unmatched inbound message as a new thread under
// parentID — a task (createTaskAndComm) or the project itself (intake
// mode 'thread': a thread on its own). The comm gets title=subject, a
// fresh thread_id, channel_ref pointing at this channel and the comm
// flow's default_create_status_id; the message becomes its first
// received reply.
func (p *filer) createComm(ctx context.Context, tx store.Querier, snap *schema.Snapshot, parentID int64, m InboundMessage, in channelIntake, meta inboundMeta, actorID int64) (int64, error) {
	commCTID, err := resolveCardType(snap, "comm")
	if err != nil {
		return 0, err
	}
	commStatusAttrID, err := resolveAttr(snap, "comm_status")
	if err != nil {
		return 0, err
	}
	var projectID int64
	prow, err := namedRow(ctx, tx, `SELECT COALESCE(card_enclosing_project(:parent), 0)`, map[string]any{"parent": parentID})
	if err != nil {
		return 0, err
	}
	if err := prow.Scan(&projectID); err != nil {
		return 0, fmt.Errorf("enclosing project: %w", err)
	}
	commStatusID, err := commFlowDefaultStatus(ctx, tx, projectID, commStatusAttrID)
	if err != nil {
		return 0, err
	}
	if commStatusID == 0 {
		return 0, &reg.HandlerError{Code: "no_comm_flow",
			Message: fmt.Sprintf("imap intake: project %d has no comm flow default", projectID)}
	}

	// Mint a unique thread_id for the new comm.
	threadID, err := uniqueThreadID(ctx, tx)
	if err != nil {
		return 0, err
	}
	subject := m.Subject
	if subject == "" {
		subject = "(no subject)"
	}
	jstr := func(s string) json.RawMessage { b, _ := json.Marshal(s); return b }
	jid := func(n int64) json.RawMessage { b, _ := json.Marshal(n); return b }

	var commID int64
	crow, err := namedRow(ctx, tx, `INSERT INTO card (card_type_id, parent_card_id) VALUES (:type, :parent) RETURNING id`,
		map[string]any{"type": commCTID, "parent": parentID})
	if err != nil {
		return 0, err
	}
	if err := crow.Scan(&commID); err != nil {
		return 0, fmt.Errorf("insert comm card: %w", err)
	}
	if err := writeCardCreateActivity(ctx, tx, commID, actorID); err != nil {
		return 0, err
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
			return 0, fmt.Errorf("comm attr: %w", err)
		}
	}

	// First received reply, mirroring the channel-driven inbound capture.
	if _, err := p.appendReceivedReply(ctx, tx, snap, commID, m, in, meta, actorID); err != nil {
		return 0, err
	}
	if err := confirmStarter(ctx, tx, commID, m.From); err != nil {
		return 0, err
	}
	return commID, nil
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
func (p *filer) descriptionMarkdown(m InboundMessage) string {
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
	out.Date = strings.TrimSpace(msg.Header.Get("Date"))
	out.From = strings.TrimSpace(msg.Header.Get("From"))
	out.To = strings.TrimSpace(msg.Header.Get("To"))
	out.Cc = strings.TrimSpace(msg.Header.Get("Cc"))
	out.Subject = strings.TrimSpace(decodeHeaderText(msg.Header.Get("Subject")))
	out.ThreadIDHdr = strings.TrimSpace(msg.Header.Get("X-Kitp-Thread-Id"))
	out.InReplyTo = strings.TrimSpace(msg.Header.Get("In-Reply-To"))
	out.References = strings.TrimSpace(msg.Header.Get("References"))
	out.NotificationHdr = strings.TrimSpace(msg.Header.Get(NotificationHeader))
	out.AutoKind = automaticKind(msg.Header)

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
	storableInbound(&out)
	return out, nil
}

// storableInbound makes every text field of a parsed message storable
// (textnorm.Storable: valid UTF-8, no NUL). Mail may carry a NUL or broken
// bytes anywhere, raw or inside an encoded word, and Postgres refuses NUL
// in text and jsonb alike — the message would never file, and IMAP would
// retry it until the account faults (review 2026-11-03 round 2 #2). Names
// decoded later (displayAddress, the people on a thread) are cleaned where
// they are decoded.
func storableInbound(m *InboundMessage) {
	for _, f := range []*string{
		&m.MessageID, &m.Date, &m.From, &m.To, &m.Cc, &m.Subject, &m.ThreadIDHdr,
		&m.InReplyTo, &m.References, &m.NotificationHdr, &m.Body, &m.BodyPlain, &m.BodyHTML,
	} {
		*f = textnorm.Storable(*f)
	}
	for i := range m.Attachments {
		m.Attachments[i].Filename = textnorm.Storable(m.Attachments[i].Filename)
		m.Attachments[i].MimeType = textnorm.Storable(m.Attachments[i].MimeType)
	}
}

// Limits on a multipart body's shape (review 2026-11-03 round 3 #1). Each
// level of nesting used to copy the rest of the message, and every copy
// stayed alive down the recursion: a 224 KB message of nested parts peaked
// at 600 MB. Nested parts are now read as a stream, nesting past
// maxMultipartDepth is skipped, and parsing stops after maxMultipartParts
// parts in all; real mail stays far inside both.
const (
	maxMultipartDepth = 8
	maxMultipartParts = 500
)

// multipartWalk collects a message's text bodies and attachments across the
// levels of one walkMultipart call.
type multipartWalk struct {
	plain, html string
	atts        []InboundAttachment
	parts       int // parts seen so far, every level counted
}

// walkMultipart parses a multipart body via stdlib `mime/multipart`
// and returns (plain text, html, attachments). text/plain is captured as
// the plain body and text/html (if any) is returned raw so the caller can
// both render a reply bubble (plain, tag-stripped) and build a richer task
// description (mailmd.FromHTML). Non-text parts (or any part with a
// `Content-Disposition: attachment` header) are appended to the
// attachments list. Nested multiparts (multipart/mixed wrapping a
// multipart/alternative, a forwarded message's parts) are unwound up to
// maxMultipartDepth levels; the first text bodies found win.
func walkMultipart(body []byte, contentType string) (string, string, []InboundAttachment) {
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return string(body), "", nil
	}
	if b, ok := params["boundary"]; !ok || b == "" {
		return string(body), "", nil
	}
	w := &multipartWalk{}
	w.walk(bytes.NewReader(body), params["boundary"], 0)
	return strings.TrimSpace(w.plain), w.html, w.atts
}

// walk reads one multipart level from r. A nested multipart part is walked
// straight from its part reader — never buffered — so the message is held
// once however deep it nests.
func (w *multipartWalk) walk(r io.Reader, boundary string, depth int) {
	mr := multipart.NewReader(r, boundary)
	for {
		p, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			return
		}
		if err != nil {
			// Stop early on malformed input; surface whatever we've
			// collected so the caller still gets a body (and a partial
			// attachment list) rather than nothing.
			return
		}
		w.parts++
		if w.parts > maxMultipartParts {
			return
		}
		partCT := p.Header.Get("Content-Type")
		partCTLow := strings.ToLower(partCT)
		if strings.HasPrefix(partCTLow, "multipart/") {
			if depth+1 >= maxMultipartDepth {
				continue // too deep to be real mail: skip it (NextPart drains it)
			}
			_, nestedParams, perr := mime.ParseMediaType(partCT)
			if perr != nil || nestedParams["boundary"] == "" {
				continue
			}
			// A multipart body may only be 7bit, 8bit or binary (RFC 2045
			// §6.4); one that claims an encoding is still undone, as a
			// stream over the part — reading it whole copied the rest of
			// the message at every level (review 2026-11-03 round 4 #1).
			var nested io.Reader = p
			switch strings.ToLower(strings.TrimSpace(p.Header.Get("Content-Transfer-Encoding"))) {
			case "base64":
				nested = base64.NewDecoder(base64.StdEncoding, p)
			case "quoted-printable":
				nested = quotedprintable.NewReader(p)
			}
			w.walk(nested, nestedParams["boundary"], depth+1)
			continue
		}
		// A part cut short (no closing boundary, as in truncated mail) keeps
		// what was read; the next NextPart reports the error and ends the
		// walk.
		decoded, rerr := readDecoded(p, p.Header.Get("Content-Transfer-Encoding"))
		if rerr != nil && len(decoded) == 0 {
			continue // nothing readable in this part; a broken stream ends at the next NextPart
		}
		disp, dispParams, _ := mime.ParseMediaType(p.Header.Get("Content-Disposition"))
		dispLow := strings.ToLower(disp)
		if dispLow == "attachment" || (dispLow == "" && !strings.HasPrefix(partCTLow, "text/")) {
			filename := dispParams["filename"]
			if filename == "" {
				// Some clients put the filename only in the
				// Content-Type's name= parameter (e.g. older Outlook).
				if _, ctParams, err := mime.ParseMediaType(partCT); err == nil {
					filename = ctParams["name"]
				}
			}
			// The sender chose the name: decode an RFC 2047 word, then
			// drop control and bidi runes and path separators. A raw name
			// reached outgoing MIME headers (CR/LF) and export zip paths
			// ("../"), and could disguise its type (review 2026-11-03 #11).
			if strings.Contains(filename, "=?") {
				if dec, err := headerDecoder.DecodeHeader(filename); err == nil {
					filename = dec
				}
			}
			filename = textnorm.FilenameLoose(filename)
			if filename == "" {
				filename = fmt.Sprintf("attachment-%d", len(w.atts)+1)
			}
			mt, _, _ := mime.ParseMediaType(partCT)
			if mt == "" {
				mt = "application/octet-stream"
			}
			w.atts = append(w.atts, InboundAttachment{
				Filename: filename,
				MimeType: mt,
				Bytes:    decoded,
			})
			continue
		}
		if strings.HasPrefix(partCTLow, "text/plain") {
			if w.plain == "" {
				w.plain = string(decoded)
			}
		} else if strings.HasPrefix(partCTLow, "text/html") {
			if w.html == "" {
				w.html = string(decoded)
			}
		}
	}
}

// readDecoded reads a part's content with its Content-Transfer-Encoding
// undone as it is read, so a large attachment is held once, decoded —
// not raw, then as a string, then stripped, then decoded (review
// 2026-11-03 round 4 #1). base64 skips the whitespace mail puts in it; a
// part cut short or not valid keeps what decoded before the error.
func readDecoded(r io.Reader, encoding string) ([]byte, error) {
	switch strings.ToLower(strings.TrimSpace(encoding)) {
	case "base64":
		return io.ReadAll(base64.NewDecoder(base64.StdEncoding, &dropBlanks{r: r}))
	case "quoted-printable":
		return io.ReadAll(quotedprintable.NewReader(r))
	default:
		return io.ReadAll(r)
	}
}

// dropBlanks passes its reader through without spaces and tabs (the base64
// decoder already skips CR and LF).
type dropBlanks struct{ r io.Reader }

func (d *dropBlanks) Read(p []byte) (int, error) {
	for {
		n, err := d.r.Read(p)
		k := 0
		for _, c := range p[:n] {
			if c != ' ' && c != '\t' {
				p[k] = c
				k++
			}
		}
		if k > 0 || err != nil {
			return k, err
		}
	}
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
// go-imap doesn't expose a per-call context: the dial takes its timeout
// from the caller's deadline (else 30s), every later command gets a
// deadline of its own (realIMAPClient.arm), and the connection is closed
// when ctx ends.
func dialIMAP(ctx context.Context, cfg IMAPConfig) (imapClient, error) {
	// SSRF guard (SEC-4 / A9): reject internal / loopback / link-local
	// dial targets before opening the socket.
	if err := guardDialHost(ctx, cfg.Host); err != nil {
		return nil, err
	}
	addr := net.JoinHostPort(cfg.Host, fmt.Sprintf("%d", cfg.Port))
	dialer := guardedDialer(cfg.Host, &net.Dialer{Timeout: 30 * time.Second})
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
	mbox, err := c.Select("INBOX", false)
	if err != nil {
		_ = c.Logout()
		return nil, fmt.Errorf("imap select INBOX: %w", err)
	}
	r := &realIMAPClient{c: c, validity: mbox.UidValidity}
	// go-imap has no per-call context: when the poll's context ends (the
	// job's timeout, shutdown), close the connection so a command stalled
	// on a slow or silent server returns at once instead of holding up
	// every account's poll (review 2026-11-03 round 4 #6). Each command
	// also gets a deadline of its own (arm).
	r.stop = context.AfterFunc(ctx, func() {
		if err := c.Terminate(); err != nil {
			return // the connection is going either way
		}
	})
	return r, nil
}

// realIMAPClient implements imapClient against emersion/go-imap. The
// concrete protocol surface lives here so the rest of the package
// (threading, ingest) stays library-agnostic.
type realIMAPClient struct {
	c        *imapclient.Client
	validity uint32
	stop     func() bool
	// created is the set-aside folder once this connection has made sure
	// it exists: one CREATE per poll, not one per message.
	created string
}

// imapFetchBatch is the most messages one poll looks at; the rest wait for
// the next poll. IMAPMaxMessageBytes is the largest message it fetches at
// all (the POST route's default cap).
const imapFetchBatch = 50

// IMAPMaxMessageBytes caps one message fetched over IMAP.
const IMAPMaxMessageBytes int64 = 50 << 20

// imapCommandTimeout bounds one IMAP command (a search, one message's
// body, a flag change) when the poll's context has no deadline of its own.
const imapCommandTimeout = 2 * time.Minute

// arm sets the deadline for the next command: the poll's own deadline, or
// imapCommandTimeout. go-imap applies Client.Timeout to every command; with
// none, a server that stops answering mid-response held the poll forever.
func (r *realIMAPClient) arm(ctx context.Context) {
	r.c.Timeout = imapCommandTimeout
	if d, ok := ctx.Deadline(); ok {
		if left := time.Until(d); left > 0 && left < imapCommandTimeout {
			r.c.Timeout = left
		}
	}
}

// ListUnseen returns INBOX's unseen messages, oldest first with the ones
// last names after the rest, at most imapFetchBatch of them, with each
// one's RFC822.SIZE — no bodies, so a poll holds nothing of a message until
// it is fetched to be filed.
func (r *realIMAPClient) ListUnseen(ctx context.Context, last func(uid uint32) bool) ([]UnseenMessage, error) {
	r.arm(ctx)
	criteria := imap.NewSearchCriteria()
	criteria.WithoutFlags = []string{imap.SeenFlag}
	uids, err := r.c.UidSearch(criteria)
	if err != nil {
		return nil, fmt.Errorf("imap UID SEARCH UNSEEN: %w", err)
	}
	if len(uids) == 0 {
		return nil, nil
	}
	uids = unseenWindow(uids, last)
	seqset := new(imap.SeqSet)
	seqset.AddNum(uids...)
	sizes := make(map[uint32]uint32, len(uids))
	err = r.fetch(ctx, seqset, []imap.FetchItem{imap.FetchUid, imap.FetchRFC822Size}, func(msg *imap.Message) error {
		sizes[msg.Uid] = msg.Size
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("imap UID FETCH RFC822.SIZE: %w", err)
	}
	out := make([]UnseenMessage, len(uids))
	for i, uid := range uids {
		out[i] = UnseenMessage{UID: uid, Size: sizes[uid]}
	}
	return out, nil
}

// unseenWindow orders unseen UIDs oldest first, the ones last names after
// the rest, and keeps the first imapFetchBatch.
func unseenWindow(uids []uint32, last func(uid uint32) bool) []uint32 {
	sort.Slice(uids, func(i, j int) bool {
		if last != nil {
			if li, lj := last(uids[i]), last(uids[j]); li != lj {
				return lj
			}
		}
		return uids[i] < uids[j]
	})
	if len(uids) > imapFetchBatch {
		uids = uids[:imapFetchBatch]
	}
	return uids
}

// Fetch reads one message whole and parses it. BODY.PEEK[] leaves it
// unseen: the poller marks it seen once it is filed (or can never be), so
// a message that failed for a passing reason is tried again — a plain
// BODY[] marked it seen as it was read, and such a message was lost. A
// message that doesn't parse comes back with ParseError set.
func (r *realIMAPClient) Fetch(ctx context.Context, uid uint32) (InboundMessage, error) {
	seqset := new(imap.SeqSet)
	seqset.AddNum(uid)
	section := &imap.BodySectionName{Peek: true}
	var out InboundMessage
	found := false
	err := r.fetch(ctx, seqset, []imap.FetchItem{imap.FetchUid, section.FetchItem()}, func(msg *imap.Message) error {
		body := msg.GetBody(section)
		if body == nil || msg.Uid != uid {
			return nil
		}
		raw, err := io.ReadAll(body)
		if err != nil {
			return fmt.Errorf("imap read body: %w", err)
		}
		found = true
		parsed, perr := ParseInboundMessage(uid, raw)
		if perr != nil {
			parsed = InboundMessage{UID: uid, Raw: raw, ParseError: perr.Error()}
		}
		out = parsed
		return nil
	})
	if err != nil {
		// The server refused this one message (Gmail: "Some messages could
		// not be FETCHed"; Dovecot on a corrupt one) and the connection still
		// works: the poller moves on to the next and counts the refusal, so
		// one message doesn't stop the account's mail (review 2026-11-03
		// round 5 #9). go-imap gives a NO the same error type as a dropped
		// connection, so the connection is asked.
		if ctx.Err() == nil && r.c.State() != imap.LogoutState {
			r.arm(ctx)
			if r.c.Noop() == nil {
				return InboundMessage{}, fmt.Errorf("imap UID FETCH %d: %w: %w", uid, ErrFetchRefused, err)
			}
		}
		return InboundMessage{}, fmt.Errorf("imap UID FETCH %d: %w", uid, err)
	}
	if !found {
		// Gone since the list (another client expunged it), or no body.
		return InboundMessage{UID: uid, ParseError: "the server returned no body for this message"}, nil
	}
	return out, nil
}

// fetch runs one UID FETCH and hands each message to each. The fetch runs
// on its own goroutine, where a panic would end the process rather than
// fail this poll; go-imap closes ch on the way out either way (review B9).
// ch is drained whatever each returns, so the goroutine never blocks.
func (r *realIMAPClient) fetch(ctx context.Context, seqset *imap.SeqSet, items []imap.FetchItem, each func(*imap.Message) error) error {
	r.arm(ctx)
	ch := make(chan *imap.Message, 1)
	done := make(chan error, 1)
	go func() {
		done <- job.Protect(context.Background(), nil, "imap fetch", func() error { return r.c.UidFetch(seqset, items, ch) })
	}()
	var first error
	for msg := range ch {
		if first != nil {
			continue
		}
		first = each(msg)
	}
	if err := <-done; err != nil {
		return err
	}
	return first
}

func (r *realIMAPClient) MarkSeen(ctx context.Context, uids []uint32) error {
	if len(uids) == 0 {
		return nil
	}
	r.arm(ctx)
	seqset := new(imap.SeqSet)
	seqset.AddNum(uids...)
	item := imap.FormatFlagsOp(imap.AddFlags, true)
	flags := []interface{}{imap.SeenFlag}
	return r.c.UidStore(seqset, item, flags, nil)
}

// UIDValidity is INBOX's UIDVALIDITY: a UID names the same message only
// while it is unchanged.
func (r *realIMAPClient) UIDValidity() uint32 { return r.validity }

// ErrNoMove: the server has neither MOVE nor UIDPLUS, so a message can't be
// taken out of INBOX without a plain EXPUNGE, which would also remove
// every message another client flagged \Deleted. It stays, marked read.
var ErrNoMove = errors.New("imap: the server can't move a message by UID")

// ErrFetchRefused wraps a Fetch error for one message the server refused
// while the connection carries on.
var ErrFetchRefused = errors.New("the server refused to fetch this message")

// Archive moves uids to folder with UID MOVE (RFC 6851), or, on a server
// without MOVE but with UIDPLUS, UID COPY + \Deleted + UID EXPUNGE of just
// those messages. The folder is made first; one that exists already is
// fine.
func (r *realIMAPClient) Archive(ctx context.Context, uids []uint32, folder string) error {
	if len(uids) == 0 || folder == "" {
		return nil
	}
	r.arm(ctx)
	// The server's capabilities first: one that can't move by UID gets no
	// folder it would never use (review 2026-11-03 round 5).
	canMove, err := r.c.Support("MOVE")
	if err != nil {
		return fmt.Errorf("imap capability: %w", err)
	}
	if !canMove {
		uidPlus, err := r.c.Support("UIDPLUS")
		if err != nil {
			return fmt.Errorf("imap capability: %w", err)
		}
		if !uidPlus {
			return ErrNoMove
		}
	}
	// Most often the folder exists already (ALREADYEXISTS); a failure that
	// matters shows in the move below, which reports it too. Once per
	// connection.
	var createErr error
	if r.created != folder {
		if createErr = r.c.Create(folder); createErr == nil {
			r.created = folder
		}
	}
	wrap := func(op string, err error) error {
		if createErr != nil {
			return fmt.Errorf("imap %s to %q: %w (creating it: %v)", op, folder, err, createErr)
		}
		return fmt.Errorf("imap %s to %q: %w", op, folder, err)
	}
	seqset := new(imap.SeqSet)
	seqset.AddNum(uids...)
	if canMove {
		status, err := r.c.Execute(&commands.Uid{Cmd: &moveCmd{seqSet: seqset, mailbox: folder}}, nil)
		if err == nil {
			err = status.Err()
		}
		if err != nil {
			return wrap("UID MOVE", err)
		}
		return nil
	}
	if err := r.c.UidCopy(seqset, folder); err != nil {
		return wrap("UID COPY", err)
	}
	if err := r.c.UidStore(seqset, imap.FormatFlagsOp(imap.AddFlags, true), []interface{}{imap.DeletedFlag}, nil); err != nil {
		return fmt.Errorf("imap UID STORE \\Deleted: %w", err)
	}
	status, err := r.c.Execute(&commands.Uid{Cmd: &expungeCmd{seqSet: seqset}}, nil)
	if err != nil {
		return fmt.Errorf("imap UID EXPUNGE: %w", err)
	}
	return status.Err()
}

// moveCmd is MOVE (RFC 6851), which go-imap v1 doesn't have; wrapped in
// commands.Uid it is UID MOVE.
type moveCmd struct {
	seqSet  *imap.SeqSet
	mailbox string
}

func (cmd *moveCmd) Command() *imap.Command {
	mailbox, err := utf7.Encoding.NewEncoder().String(cmd.mailbox)
	if err != nil {
		mailbox = cmd.mailbox // ASCII names encode as themselves
	}
	return &imap.Command{Name: "MOVE", Arguments: []interface{}{cmd.seqSet, mailbox}}
}

// expungeCmd is EXPUNGE with a sequence set: wrapped in commands.Uid it is
// UID EXPUNGE (RFC 4315), which removes only the messages named.
type expungeCmd struct{ seqSet *imap.SeqSet }

func (cmd *expungeCmd) Command() *imap.Command {
	return &imap.Command{Name: "EXPUNGE", Arguments: []interface{}{cmd.seqSet}}
}

func (r *realIMAPClient) Close() error {
	if r.c == nil {
		return nil
	}
	if r.stop != nil {
		r.stop()
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

// tasksOff reports whether a project's Tasks area is switched off, so a
// task written there would be hidden (area_write_blocked for a task).
func tasksOff(ctx context.Context, q store.Querier, projectID int64) (bool, error) {
	row, err := namedRow(ctx, q, `
		SELECT area_write_blocked((SELECT id FROM card_type WHERE name = 'task'), :project, :project)
	`, map[string]any{"project": projectID})
	if err != nil {
		return false, err
	}
	var off bool
	if err := row.Scan(&off); err != nil {
		return false, err
	}
	return off, nil
}

// namedRow compiles a :name query (internal/named) and runs it with
// QueryRow.
// namedExec is namedRow for a statement that returns no row.
func namedExec(ctx context.Context, q store.Querier, sql string, vals map[string]any) error {
	b := named.New()
	for k, v := range vals {
		b.Set(k, v)
	}
	compiled, args, err := b.Compile(sql)
	if err != nil {
		return fmt.Errorf("compile: %w", err)
	}
	_, err = q.Exec(ctx, compiled, args...)
	return err
}

func namedRow(ctx context.Context, q store.Querier, sql string, vals map[string]any) (pgx.Row, error) {
	b := named.New()
	for k, v := range vals {
		b.Set(k, v)
	}
	compiled, args, err := b.Compile(sql)
	if err != nil {
		return nil, fmt.Errorf("compile: %w", err)
	}
	return q.QueryRow(ctx, compiled, args...), nil
}
