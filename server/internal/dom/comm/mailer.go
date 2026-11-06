// mailer.go: the comm_channel outbound-mail surface other packages reuse.
//
// The SMTP sender (smtp.go) ships reply_body cards threaded onto comms.
// Activity notifications (dom/activitysink, email sinks) are NOT comm
// threads, but they go out through the same project mailbox: the same
// SMTP login, From address, TLS + SSRF-guarded transport, dry-run switch
// and comm_log audit trail. This file exposes exactly that much.
//
// Notification mail is marked so replies to it can be recognised on the
// way back in: its Message-ID carries [NotificationMessageIDPrefix] and it
// sets the [NotificationHeader] header. The IMAP poller drops (and logs)
// inbound mail whose In-Reply-To / References point at such a Message-ID,
// so "reply to the digest" never becomes an intake task.
package comm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/textnorm"
)

// NotificationMessageIDPrefix starts the local part of every notification
// email's Message-ID (`<kitp-notify.…@domain>`).
const NotificationMessageIDPrefix = "kitp-notify."

// NotificationHeader is set on every notification email; its value is the
// delivering subscription / sink card id.
const NotificationHeader = "X-Kitp-Notification"

// notificationRefRegex finds a notification Message-ID inside an
// In-Reply-To / References header value.
var notificationRefRegex = regexp.MustCompile(`<` + regexp.QuoteMeta(NotificationMessageIDPrefix) + `[^>@\s]*@[^>\s]*>`)

// IsNotificationReply reports whether an inbound message answers (or
// bounces back) a kitp notification email.
func IsNotificationReply(m InboundMessage) bool {
	if strings.TrimSpace(m.NotificationHdr) != "" {
		return true
	}
	return notificationRefRegex.MatchString(m.InReplyTo) || notificationRefRegex.MatchString(m.References)
}

// SMTPConfig is one comm_channel's outbound settings, secrets decrypted:
// its send method (docs/MAIL_INTAKE_AND_CALENDARS.md, "Sending") and what
// that needs — the SMTP server, or an HTTP API's settings and secret.
type SMTPConfig struct {
	ChannelID   int64
	ProjectID   int64
	ChannelName string
	Status      string
	Method      string // ResolveSendMethod'd
	Host        string
	Port        int
	Username    string
	Password    string
	From        string
	Domain      string
	Region      string
	Stream      string
	URL         string
	Secret      string
}

// Outbound is c's way out.
func (c SMTPConfig) Outbound() Outbound {
	return Outbound{
		Method: c.Method, Host: c.Host, Port: c.Port, Username: c.Username, Password: c.Password,
		Domain: c.Domain, Region: c.Region, Stream: c.Stream, URL: c.URL, Secret: c.Secret,
	}
}

// ErrNoWayOut: the mail account has no send method set up (Sending), so
// nothing can go out through it.
var ErrNoWayOut = errors.New("comm: the mail account has no way out (its Sending isn't set up)")

// Deliver sends msg — envelope from, recipients (a comma list), the whole
// MIME message — through o: its SMTP server with smtp, or its HTTP API
// with api (the callers' transports, which tests replace). ErrNoWayOut when
// o can't send.
func Deliver(ctx context.Context, o Outbound, smtp SMTPTransport, api APITransport, from, to string, msg []byte) error {
	if !o.Ready() {
		return ErrNoWayOut
	}
	if o.IsAPI() {
		return api(ctx, o, from, to, msg)
	}
	return smtp(ctx, o.Host, o.Port, o.Username, o.Password, from, to, msg)
}

// LoadSMTPConfig reads a live comm_channel's SMTP settings in one query
// (the password via pgp_sym_decrypt with the app.comm_secret_key GUC).
func LoadSMTPConfig(ctx context.Context, q PoolQuerier, channelID int64) (SMTPConfig, error) {
	b := named.New()
	b.Set("channel_id", channelID)
	sql, args, err := b.Compile(`
		SELECT
			ch.id,
			COALESCE(ch.parent_card_id, 0),
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = ch.id AND ad.name='title'), ''),
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = ch.id AND ad.name='channel_status'), ''),
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = ch.id AND ad.name='smtp_host'), ''),
			COALESCE((SELECT (value)::text::int FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = ch.id AND ad.name='smtp_port' AND jsonb_typeof(value)='number'), 0),
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = ch.id AND ad.name='smtp_username'), ''),
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = ch.id AND ad.name='from_address'), ''),
			COALESCE((SELECT pgp_sym_decrypt(cs.smtp_password, current_setting('app.comm_secret_key'))
			            FROM comm_secret cs WHERE cs.channel_card_id = ch.id AND cs.smtp_password IS NOT NULL), ''),
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = ch.id AND ad.name='send_method'), ''),
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = ch.id AND ad.name='send_domain'), ''),
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = ch.id AND ad.name='send_region'), ''),
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = ch.id AND ad.name='send_stream'), ''),
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = ch.id AND ad.name='send_url'), ''),
			COALESCE((SELECT pgp_sym_decrypt(cs.send_secret, current_setting('app.comm_secret_key'))
			            FROM comm_secret cs WHERE cs.channel_card_id = ch.id AND cs.send_secret IS NOT NULL), '')
		FROM card ch
		JOIN card_type ct ON ct.id = ch.card_type_id AND ct.name = 'comm_channel'
		WHERE ch.id = :channel_id AND ch.deleted_at IS NULL
	`)
	if err != nil {
		return SMTPConfig{}, fmt.Errorf("comm.LoadSMTPConfig: compile: %w", err)
	}
	var c SMTPConfig
	if err := q.QueryRow(ctx, sql, args...).Scan(
		&c.ChannelID, &c.ProjectID, &c.ChannelName, &c.Status,
		&c.Host, &c.Port, &c.Username, &c.From, &c.Password,
		&c.Method, &c.Domain, &c.Region, &c.Stream, &c.URL, &c.Secret,
	); err != nil {
		return SMTPConfig{}, fmt.Errorf("comm.LoadSMTPConfig %d: %w", channelID, err)
	}
	if !ValidChannelStatus(c.Status) {
		c.Status = ChannelStatusEnabled
	}
	c.Method = ResolveSendMethod(c.Method)
	return c, nil
}

// SendSMTP is the production SMTP transport the reply sender uses: SSRF
// guard on the host, implicit TLS on 465 / STARTTLS otherwise, PLAIN auth.
// A permanent 5xx comes back as *SMTPBounceError.
func SendSMTP(ctx context.Context, host string, port int, username, password, from, to string, msg []byte) error {
	return sendSMTP(ctx, host, port, username, password, from, to, msg)
}

// SMTPDryRun reports whether KITP_COMM_SMTP_DRY_RUN=1 — outbound mail is
// logged instead of sent.
func SMTPDryRun() bool {
	return os.Getenv("KITP_COMM_SMTP_DRY_RUN") == "1"
}

// Execer is the slice of pgxpool.Pool / pgx.Tx LogEvent needs.
type Execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// LogEvent appends one comm_log row for a channel (channelID 0 = none).
func LogEvent(ctx context.Context, q Execer, projectID, channelID int64, kind string, detail any) error {
	return LogRouteEvent(ctx, q, projectID, channelID, 0, kind, detail)
}

// LogRouteEvent appends one comm_log row naming the inbound route
// (card_access row) it concerns as well (routeID 0 = none), so the Comm log
// can be filtered to one route.
func LogRouteEvent(ctx context.Context, q Execer, projectID, channelID, routeID int64, kind string, detail any) error {
	d, err := json.Marshal(storableDetail(detail))
	if err != nil {
		return fmt.Errorf("comm.LogEvent: marshal detail: %w", err)
	}
	b := named.New()
	b.Set("project_id", projectID)
	b.Set("channel_id", nullableID(channelID))
	b.Set("route_id", nullableID(routeID))
	b.Set("kind", kind)
	b.Set("detail", string(d))
	sql, args, err := b.Compile(`
		INSERT INTO comm_log (project_id, channel_id, route_id, kind, detail)
		VALUES (:project_id, :channel_id, :route_id, :kind, CAST(:detail AS jsonb))
	`)
	if err != nil {
		return fmt.Errorf("comm.LogEvent: compile: %w", err)
	}
	if _, err := q.Exec(ctx, sql, args...); err != nil {
		return fmt.Errorf("comm.LogEvent: insert: %w", err)
	}
	return nil
}

// storableDetail returns a Comm log detail whose strings jsonb accepts: a
// detail quotes the message it is about (its subject, sender, a parse
// error), and a NUL there would fail the row that says why the message
// wasn't filed (review 2026-11-03 round 2 #2).
func storableDetail(v any) any {
	switch t := v.(type) {
	case string:
		return textnorm.Storable(t)
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, x := range t {
			out[textnorm.Storable(k)] = storableDetail(x)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, x := range t {
			out[i] = storableDetail(x)
		}
		return out
	case []string:
		out := make([]string, len(t))
		for i, x := range t {
			out[i] = textnorm.Storable(x)
		}
		return out
	}
	return v
}

func nullableID(id int64) any {
	if id == 0 {
		return nil
	}
	return id
}
