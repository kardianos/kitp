package comm

// Shared filing step (docs/MAIL_INTAKE_AND_CALENDARS.md §3–4). Every way
// mail reaches kitp — IMAP polling, POST from a provider, the SMTP listener
// — ends in filer.processOne: dedupe, thread match, then reply / new task /
// new thread / ignore, in one transaction, with a Comm log row.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/store"
)

// Transports — how a message reached kitp.
const (
	TransportIMAP = "imap"
	TransportPOST = "post"
	TransportSMTP = "smtp"
)

// Outcomes — what a message became.
const (
	OutcomeReply             = "reply"              // added to an existing thread
	OutcomeTask              = "task"               // a new task and a thread on it
	OutcomeThread            = "thread"             // a new thread on its own
	OutcomeIgnored           = "ignored"            // no thread match and the account ignores new mail
	OutcomeNotificationReply = "notification_reply" // a reply to a notification digest, dropped
	OutcomeDuplicate         = "duplicate"          // already filed in this project
)

// ErrChannelPaused: the mail account isn't enabled. POST answers 503 and
// SMTP 451, so the sender retries later; nothing is filed.
var ErrChannelPaused = errors.New("comm: the mail account is paused")

// ErrUnparseable: the message couldn't be read as mail. It is logged
// (parse_error) and not retried — retrying can't help.
var ErrUnparseable = errors.New("comm: the message could not be read as mail")

// ErrUnfileable: filing the message failed in a way no retry can fix — it
// breaks a database limit or check (permanentFilingError). It is logged
// (file_error) and dropped, like an unparseable message; before, one such
// message was retried forever and its mail account switched off (review
// 2026-11-03 #7).
var ErrUnfileable = errors.New("comm: the message can't be filed")

// permanentFilingError reports whether a filing error comes from the
// message itself rather than the moment: a data exception (22xxx: a value
// out of range, bad encoding), a program limit (54xxx: an index row too
// large), or a NOT NULL / CHECK violation. Anything else — a lost
// connection, a lock timeout, a unique race — may pass on a retry.
func permanentFilingError(err error) bool {
	var pg *pgconn.PgError
	if !errors.As(err, &pg) || len(pg.Code) != 5 {
		return false
	}
	switch pg.Code[:2] {
	case "22", "54":
		return true
	}
	return pg.Code == "23502" || pg.Code == "23514"
}

// fileErrorDetail is the Comm log detail of an unfileable message: which
// message, and the database's reason code (not its text, which can quote
// the message's own values).
func fileErrorDetail(m InboundMessage, err error) map[string]any {
	code := ""
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		code = pg.Code
	}
	return map[string]any{
		"error":      "the message breaks a database limit (" + code + ")",
		"message_id": clip(m.MessageID, 300), "from": clip(m.From, 300), "subject": clip(m.Subject, 300),
	}
}

// clip cuts s to at most n bytes, at a rune boundary.
func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// Filed is what filing one message did.
type Filed struct {
	Outcome string
	// CardID is the thread (comm card) the message is on, when it is on
	// one; for a duplicate, the thread the first copy went to.
	CardID    int64
	Duplicate bool
}

// inboundMeta says how a message arrived, for the Comm log.
type inboundMeta struct {
	transport string
	routeID   int64 // card_access row for POST / SMTP; 0 for IMAP
}

// filer files messages for one mail account (comm_channel).
type filer struct {
	pool      *store.Pool
	channelID int64
	// bodyPriority is the ordered set of body extractors a new task's
	// description is sourced from (KITP_COMM_BODY_PRIORITY). The first
	// extractor whose body part exists wins; see resolveBodyPriority /
	// descriptionMarkdown.
	bodyPriority []bodyExtractor
	// saveRawEmail persists the verbatim RFC822 message as a `.eml`
	// attachment on the task when set (KITP_COMM_SAVE_RAW_EMAIL=1). Off by
	// default; a debugging aid for deriving better body-conversion rules
	// from real problem mail.
	saveRawEmail bool
	// routeDomain is KITP_SMTP_DOMAIN, lowercased: an address there is a
	// secret route (its local part is the token), never a correspondent.
	routeDomain string
	logger      *slog.Logger
}

func newFiler(pool *store.Pool, channelID int64, logger *slog.Logger) filer {
	if logger == nil {
		logger = slog.Default()
	}
	return filer{
		pool:         pool,
		channelID:    channelID,
		bodyPriority: resolveBodyPriority(os.Getenv("KITP_COMM_BODY_PRIORITY")),
		saveRawEmail: os.Getenv("KITP_COMM_SAVE_RAW_EMAIL") == "1",
		routeDomain:  strings.ToLower(strings.TrimSpace(os.Getenv("KITP_SMTP_DOMAIN"))),
		logger:       logger,
	}
}

// Intake files raw messages that were pushed to kitp (POST and SMTP).
type Intake struct {
	Pool   *store.Pool
	Logger *slog.Logger
}

// FileRaw files one raw RFC 5322 message on a mail account. routeID is the
// card_access row it arrived through. It returns ErrChannelPaused when the
// account isn't enabled, and ErrUnparseable (after logging a parse_error)
// when the bytes aren't mail; any other error is transient.
func (in *Intake) FileRaw(ctx context.Context, channelID int64, transport string, routeID int64, raw []byte) (Filed, error) {
	status, _, err := ReadChannelStatus(ctx, in.Pool.P, channelID)
	if err != nil {
		return Filed{}, fmt.Errorf("intake: read status: %w", err)
	}
	if status != ChannelStatusEnabled {
		return Filed{}, ErrChannelPaused
	}
	// Mail for a project whose Conversations area is off waits, as IMAP
	// does (it doesn't poll such accounts): filed now it would land where
	// nobody can see it (review 2026-11-03 #22).
	if off, err := ChannelInOffArea(ctx, in.Pool.P, channelID); err != nil {
		return Filed{}, fmt.Errorf("intake: area: %w", err)
	} else if off {
		return Filed{}, ErrChannelPaused
	}
	intake, err := loadIntake(ctx, in.Pool.P, channelID)
	if err != nil {
		return Filed{}, fmt.Errorf("intake: load account: %w", err)
	}
	f := newFiler(in.Pool, channelID, in.Logger)
	meta := inboundMeta{transport: transport, routeID: routeID}
	m, err := ParseInboundMessage(0, raw)
	if err == nil && strings.TrimSpace(m.From) == "" && strings.TrimSpace(m.Subject) == "" && strings.TrimSpace(m.Body) == "" {
		err = errors.New("no From, Subject or body")
	}
	if err != nil {
		if lerr := f.logInbound(ctx, in.Pool.P, intake.projectID, meta, "parse_error", map[string]any{
			"error": err.Error(), "bytes": len(raw),
		}); lerr != nil {
			return Filed{}, lerr
		}
		return Filed{}, fmt.Errorf("%w: %v", ErrUnparseable, err)
	}
	filed, err := f.processOne(ctx, intake, m, meta)
	if err != nil && permanentFilingError(err) {
		// Unfileable whether or not the Comm log row lands: a sender told
		// to try again would only send the same message forever.
		if lerr := f.logInbound(ctx, in.Pool.P, intake.projectID, meta, "file_error", fileErrorDetail(m, err)); lerr != nil {
			f.logger.LogAttrs(ctx, slog.LevelWarn, "intake: logging an unfileable message failed",
				slog.Int64("channel_id", channelID),
				slog.String("error", lerr.Error()))
		}
		return Filed{}, fmt.Errorf("%w: %v", ErrUnfileable, err)
	}
	return filed, err
}

// ChannelInOffArea reports whether a mail account sits in a switched-off
// area (card_in_off_area: its project's Conversations is off). Nothing is
// filed or sent through such an account until the area is back on.
func ChannelInOffArea(ctx context.Context, q store.Querier, channelID int64) (bool, error) {
	row, err := namedRow(ctx, q, `SELECT card_in_off_area(:channel::bigint)`, map[string]any{"channel": channelID})
	if err != nil {
		return false, err
	}
	var off bool
	if err := row.Scan(&off); err != nil {
		return false, err
	}
	return off, nil
}

// loadIntake reads a mail account's project, intake status and mode, and
// whether it sends replies on and keeps files.
func loadIntake(ctx context.Context, q store.Querier, channelID int64) (channelIntake, error) {
	var in channelIntake
	var storedMode string
	row, err := namedRow(ctx, q, `
		SELECT
			COALESCE((SELECT (value)::text::bigint FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = :channel_id AND ad.name = 'intake_status' AND jsonb_typeof(value) = 'number'), 0),
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = :channel_id AND ad.name = 'intake_mode'), ''),
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = :channel_id AND ad.name = 'relay_replies'), ''),
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = :channel_id AND ad.name = 'email_attachments'), ''),
			COALESCE((SELECT parent_card_id FROM card WHERE id = :channel_id AND deleted_at IS NULL), 0)
	`, map[string]any{"channel_id": channelID})
	if err != nil {
		return in, err
	}
	var relay, files string
	if err := row.Scan(&in.statusID, &storedMode, &relay, &files, &in.projectID); err != nil {
		return in, err
	}
	in.relay = ResolveRelay(relay)
	in.keepFiles = ResolveKeepAttachments(files)
	if in.projectID == 0 {
		return in, fmt.Errorf("mail account %d not found", channelID)
	}
	in.mode = ResolveIntakeMode(storedMode, in.statusID)
	return in, nil
}

// messageKey is the dedupe key: "mid:" + the Message-ID without its angle
// brackets (case kept), or — for mail with no Message-ID — "h:" + a SHA-256
// of From, To, Date, Subject and the body. Not the raw bytes: each route
// adds its own trace headers, so the same message differs byte for byte.
// A Message-ID longer than maxMessageKeyID is keyed "midh:" + its SHA-256:
// whole, it overflowed the primary key's index and the message could never
// be filed (review 2026-11-03 #7).
func messageKey(m InboundMessage) string {
	id := strings.TrimSpace(m.MessageID)
	id = strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(id, "<"), ">"))
	if len(id) > maxMessageKeyID {
		sum := sha256.Sum256([]byte(id))
		return "midh:" + hex.EncodeToString(sum[:])
	}
	if id != "" {
		return "mid:" + id
	}
	sum := sha256.Sum256([]byte(strings.Join([]string{m.From, m.To, m.Date, m.Subject, m.Body}, "\n")))
	return "h:" + hex.EncodeToString(sum[:])
}

// maxMessageKeyID is the longest Message-ID kept whole in a dedupe key (and
// in comm_inbound_seen.message_id); RFC 5322 lines stop at 998 octets.
const maxMessageKeyID = 900

// claimMessage records a message as seen in a project. fresh is false when
// it was already there (a duplicate); then last_seen_at is bumped — rows are
// pruned by it, so a message that keeps being re-delivered stays known —
// and original is the card the first copy became. A concurrent second copy
// waits on the first's uncommitted row and then sees the conflict.
func claimMessage(ctx context.Context, tx store.Querier, projectID int64, key string, channelID int64, transport, messageID string) (fresh bool, original int64, err error) {
	vals := map[string]any{"project": projectID, "key": key, "channel": channelID, "transport": transport, "mid": clip(messageID, maxMessageKeyID)}
	row, err := namedRow(ctx, tx, `
		INSERT INTO comm_inbound_seen (project_id, message_key, channel_id, transport, message_id)
		VALUES (:project, :key, :channel, :transport, :mid)
		ON CONFLICT (project_id, message_key) DO NOTHING
		RETURNING true`, vals)
	if err != nil {
		return false, 0, err
	}
	var inserted bool
	switch err := row.Scan(&inserted); {
	case err == nil:
		return true, 0, nil
	case !errors.Is(err, pgx.ErrNoRows):
		return false, 0, err
	}
	row, err = namedRow(ctx, tx, `
		UPDATE comm_inbound_seen SET last_seen_at = now()
		WHERE project_id = :project AND message_key = :key
		RETURNING COALESCE(card_id, 0)`, vals)
	if err != nil {
		return false, 0, err
	}
	if err := row.Scan(&original); err != nil {
		return false, 0, err
	}
	return false, original, nil
}

// recordFiledCard notes which card a message became, so a later duplicate
// can point at it.
func recordFiledCard(ctx context.Context, tx store.Querier, projectID int64, key string, cardID int64) error {
	b := named.New()
	b.Set("project", projectID)
	b.Set("key", key)
	b.Set("card", cardID)
	sql, args, err := b.Compile(`UPDATE comm_inbound_seen SET card_id = :card WHERE project_id = :project AND message_key = :key`)
	if err != nil {
		return fmt.Errorf("record filed card: compile: %w", err)
	}
	if _, err := tx.Exec(ctx, sql, args...); err != nil {
		return fmt.Errorf("record filed card: %w", err)
	}
	return nil
}

// logInbound writes a Comm log row for an inbound message, naming the
// transport and (POST / SMTP) the route it came through.
func (p *filer) logInbound(ctx context.Context, q Execer, projectID int64, meta inboundMeta, kind string, detail map[string]any) error {
	detail["transport"] = meta.transport
	if meta.routeID != 0 {
		detail["route_id"] = meta.routeID
	}
	return LogRouteEvent(ctx, q, projectID, p.channelID, meta.routeID, kind, detail)
}

// isRouteAddress reports whether an address is one of kitp's own SMTP route
// addresses (<token>@KITP_SMTP_DOMAIN). Mail that reached kitp through one
// names it in To or Cc; taken as a correspondent, staff replies and relay
// copies would be mailed to it, showing the token to everyone on the thread
// (review 2026-11-03 #22).
func (p *filer) isRouteAddress(addr string) bool {
	if p.routeDomain == "" {
		return false
	}
	at := strings.LastIndexByte(addr, '@')
	return at >= 0 && strings.EqualFold(strings.TrimSuffix(addr[at+1:], "."), p.routeDomain)
}
