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
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/kitp/kitp/server/internal/named"
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

// SMTPConfig is one comm_channel's outbound settings, password decrypted.
type SMTPConfig struct {
	ChannelID   int64
	ProjectID   int64
	ChannelName string
	Status      string
	Host        string
	Port        int
	Username    string
	Password    string
	From        string
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
			            FROM comm_secret cs WHERE cs.channel_card_id = ch.id AND cs.smtp_password IS NOT NULL), '')
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
	); err != nil {
		return SMTPConfig{}, fmt.Errorf("comm.LoadSMTPConfig %d: %w", channelID, err)
	}
	if !ValidChannelStatus(c.Status) {
		c.Status = ChannelStatusEnabled
	}
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
	d, err := json.Marshal(detail)
	if err != nil {
		return fmt.Errorf("comm.LogEvent: marshal detail: %w", err)
	}
	b := named.New()
	b.Set("project_id", projectID)
	b.Set("channel_id", nullableID(channelID))
	b.Set("kind", kind)
	b.Set("detail", string(d))
	sql, args, err := b.Compile(`
		INSERT INTO comm_log (project_id, channel_id, kind, detail)
		VALUES (:project_id, :channel_id, :kind, CAST(:detail AS jsonb))
	`)
	if err != nil {
		return fmt.Errorf("comm.LogEvent: compile: %w", err)
	}
	if _, err := q.Exec(ctx, sql, args...); err != nil {
		return fmt.Errorf("comm.LogEvent: insert: %w", err)
	}
	return nil
}

func nullableID(id int64) any {
	if id == 0 {
		return nil
	}
	return id
}
