// Package activitysink: deliver.go ships one Digest to the unit's output.
//
//   - msgraph_teams: one channel message (Digest.HTML) via the poster.
//   - email: one plain-text message (Digest.Text, quoted-printable) to the
//     subscriber, From the sink's comm_channel address, through that
//     channel's SMTP login + the comm transport, audited in comm_log
//     (notify_ok / notify_bounce / notify_fail). The message is marked —
//     Message-ID `<kitp-notify.…@domain>`, X-Kitp-Notification,
//     Auto-Submitted: auto-generated — so the IMAP poller drops replies to
//     it instead of filing intake tasks.
package activitysink

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"mime"
	"mime/quotedprintable"
	"net/mail"
	"strconv"
	"strings"
	"time"

	"github.com/kitp/kitp/server/internal/dom/comm"
)

// deliver routes a digest to the unit's output.
func (p *Pumper) deliver(ctx context.Context, cfg unitConfig, d Digest) error {
	switch cfg.sinkKind {
	case SinkKindEmail:
		return p.deliverEmail(ctx, cfg, d)
	case SinkKindMSGraphTeams:
		return p.deliverTeams(ctx, cfg, d)
	}
	return &errPermanent{reason: fmt.Sprintf("unsupported sink_kind %q", cfg.sinkKind)}
}

func (p *Pumper) deliverTeams(ctx context.Context, cfg unitConfig, d Digest) error {
	msg := d.HTML()
	if p.dryRun {
		p.logger.LogAttrs(ctx, slog.LevelInfo, "activity_sink dry-run",
			slog.Int64("sink_id", p.sinkID),
			slog.Int("events", d.EventCount),
			slog.String("body", msg))
		return nil
	}
	return p.poster(ctx, cfg.msgraph, msg)
}

func (p *Pumper) deliverEmail(ctx context.Context, cfg unitConfig, d Digest) error {
	if cfg.subscriberEmail == "" {
		return &errPermanent{reason: "subscriber has no email address"}
	}
	// Only an address kitp sends to (comm.PlainAddress), as for every
	// other message kitp sends (review 2026-11-03 round 3 #9, round 4 #19).
	if !comm.PlainAddress(strings.TrimSpace(cfg.subscriberEmail)) {
		return &errPermanent{reason: "the subscriber's email address isn't one kitp sends to"}
	}
	// A mail account in a switched-off area (Conversations off) sends
	// nothing, notifications included; the digest waits for it to come
	// back (a temporary error, retried) (review 2026-11-03 #30).
	if off, err := comm.ChannelInOffArea(ctx, p.pool.P, cfg.channelID); err != nil {
		return fmt.Errorf("comm channel area: %w", err)
	} else if off {
		return fmt.Errorf("comm channel %d is in a switched-off area; waiting", cfg.channelID)
	}
	smtpCfg, err := comm.LoadSMTPConfig(ctx, p.pool.P, cfg.channelID)
	if err != nil {
		return fmt.Errorf("load comm channel: %w", err)
	}
	if smtpCfg.From == "" {
		return fmt.Errorf("comm channel %d has no from_address", cfg.channelID)
	}
	msg := buildNotificationMIME(smtpCfg.From, cfg.subscriberEmail, d.Subject(), d.Text(), p.unitID, p.now())

	var sendErr error
	if p.dryRun || comm.SMTPDryRun() {
		p.logger.LogAttrs(ctx, slog.LevelInfo, "activity_sink email dry-run",
			slog.Int64("unit_id", p.unitID),
			slog.String("to", cfg.subscriberEmail),
			slog.Int("events", d.EventCount),
			slog.Int("message_bytes", len(msg)),
			slog.String("subject", d.Subject()),
			slog.String("body", d.Text()))
	} else {
		if !smtpCfg.Outbound().Ready() {
			return fmt.Errorf("comm channel %d has no way out (Sending isn't set up)", cfg.channelID)
		}
		sendErr = comm.Deliver(ctx, smtpCfg.Outbound(), p.mailer, p.apiMailer, smtpCfg.From, cfg.subscriberEmail, msg)
	}

	kind := "notify_ok"
	detail := map[string]any{
		"subscription_id": strconv.FormatInt(p.unitID, 10),
		"recipient":       cfg.subscriberEmail,
		"events":          d.EventCount,
	}
	var bounce *comm.SMTPBounceError
	switch {
	case sendErr == nil:
	case errors.As(sendErr, &bounce):
		kind = "notify_bounce"
		detail["error"] = bounce.Msg
		detail["smtp_code"] = bounce.Code
	default:
		kind = "notify_fail"
		detail["error"] = sendErr.Error()
	}
	if err := comm.LogEvent(ctx, p.pool.P, p.projectID, cfg.channelID, kind, detail); err != nil {
		// The audit row is best-effort: the delivery outcome (and its
		// pointer bookkeeping) must not hinge on it. Log and continue.
		p.logger.LogAttrs(ctx, slog.LevelWarn, "activity_sink comm_log write failed",
			slog.Int64("unit_id", p.unitID),
			slog.String("err", err.Error()))
	}
	if bounce != nil {
		// The reason is shown to the subscriber (their subscription's
		// fault reason): kitp's words and the reply code; the server's own
		// reply is in the Comm log row above (review 2026-11-03 round 3).
		return &errPermanent{reason: fmt.Sprintf("the mail server refused the email (%d); an admin can see its reply in the Comm log", bounce.Code)}
	}
	return sendErr
}

// buildNotificationMIME assembles the RFC 5322 notification message.
// Header values derived from user content (task titles in the subject)
// are flattened to one line and RFC 2047-encoded so they can't inject
// headers; the body is quoted-printable UTF-8.
func buildNotificationMIME(from, to, subject, body string, unitID int64, now time.Time) []byte {
	var hdr bytes.Buffer
	writeHeader := func(k, v string) {
		hdr.WriteString(k)
		hdr.WriteString(": ")
		hdr.WriteString(v)
		hdr.WriteString("\r\n")
	}
	writeHeader("From", headerSafe(from))
	writeHeader("To", headerSafe(to))
	writeHeader("Subject", mime.QEncoding.Encode("utf-8", headerSafe(subject)))
	writeHeader("Date", now.UTC().Format(time.RFC1123Z))
	writeHeader("Message-ID", notificationMessageID(from, unitID))
	writeHeader(comm.NotificationHeader, strconv.FormatInt(unitID, 10))
	writeHeader("Auto-Submitted", "auto-generated")
	writeHeader("MIME-Version", "1.0")
	writeHeader("Content-Type", "text/plain; charset=utf-8")
	writeHeader("Content-Transfer-Encoding", "quoted-printable")
	hdr.WriteString("\r\n")

	var qp bytes.Buffer
	w := quotedprintable.NewWriter(&qp)
	// Writes into a bytes.Buffer can't fail; Close only flushes.
	_, _ = w.Write([]byte(strings.ReplaceAll(strings.ReplaceAll(body, "\r\n", "\n"), "\n", "\r\n")))
	_ = w.Close()
	return append(hdr.Bytes(), qp.Bytes()...)
}

// notificationMessageID returns `<kitp-notify.<unit>.<random>@<domain>>`,
// the domain taken from the From address (RFC 5322 recommends the
// sender's domain). The prefix is what comm.IsNotificationReply looks for
// in a reply's In-Reply-To / References.
func notificationMessageID(from string, unitID int64) string {
	domain := "kitp.invalid"
	if a, err := mail.ParseAddress(from); err == nil {
		if at := strings.LastIndexByte(a.Address, '@'); at >= 0 && at+1 < len(a.Address) {
			domain = a.Address[at+1:]
		}
	}
	var r [8]byte
	if _, err := rand.Read(r[:]); err != nil {
		// crypto/rand never fails on supported platforms; fall back to the
		// clock so the id stays unique-enough rather than aborting a send.
		return fmt.Sprintf("<%s%d.%d@%s>", comm.NotificationMessageIDPrefix, unitID, time.Now().UnixNano(), domain)
	}
	return fmt.Sprintf("<%s%d.%s@%s>", comm.NotificationMessageIDPrefix, unitID, hex.EncodeToString(r[:]), domain)
}

// headerSafe flattens CR / LF (header injection) to spaces.
func headerSafe(s string) string {
	return strings.NewReplacer("\r", " ", "\n", " ").Replace(s)
}
