// test_send.go: comm_channel.test_send — check a mail account's way out by
// mailing the admin a short test message through it
// (docs/MAIL_INTAKE_AND_CALENDARS.md, "Sending").
package comm

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"mime"
	"net/mail"
	"strings"
	"time"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// ChannelTestSendInput names the mail account to try.
type ChannelTestSendInput struct {
	ChannelID int64 `json:"channel_id,string" mcp:"required,desc=comm_channel card id"`
}

// ChannelTestSendOutput says where the test message went.
type ChannelTestSendOutput struct {
	ChannelID int64  `json:"channel_id,string" mcp:"desc=the mail account"`
	To        string `json:"to" mcp:"desc=the address the test message went to (yours)"`
}

// Test-send transports (tests replace them).
var (
	testSendSMTP SMTPTransport = sendSMTP
	testSendAPI  APITransport  = SendAPI
)

// sendTestMessages is comm_channel.test_send's PostRun: for each account
// the SQL passed, build a short message — marked as a notification, so a
// reply to it is dropped, not filed — and send it the account's way. The
// result goes in the account's Comm log (send_test); a failure fails the
// call with a fixed message (the log has the provider's answer).
func sendTestMessages(ctx context.Context, tx store.Querier, ins []any, outs []any) error {
	for i := range outs {
		out, ok := outs[i].(ChannelTestSendOutput)
		if !ok {
			return fmt.Errorf("comm_channel.test_send: unexpected output %T", outs[i])
		}
		cfg, err := LoadSMTPConfig(ctx, tx, out.ChannelID)
		if err != nil {
			return fmt.Errorf("comm_channel.test_send: mail account: %w", err)
		}
		from := (&mail.Address{Name: cfg.ChannelName, Address: plainFrom(cfg.From)}).String()
		msg := buildTestMessage(from, out.To, cfg.Method)
		detail := map[string]any{"recipient": out.To, "method": cfg.Method}
		var sendErr error
		if SMTPDryRun() {
			detail["dry_run"] = true
			slog.Default().LogAttrs(ctx, slog.LevelInfo, "comm_channel.test_send: dry run, not sent",
				slog.Int64("channel_id", cfg.ChannelID), slog.Int("bytes", len(msg)))
		} else {
			sendCtx, cancel := context.WithTimeout(ctx, 75*time.Second)
			sendErr = Deliver(sendCtx, cfg.Outbound(), testSendSMTP, testSendAPI, plainFrom(cfg.From), out.To, msg)
			cancel()
		}
		var partial *SMTPPartialError
		if sendErr != nil && !errors.As(sendErr, &partial) {
			detail["error"] = sendErr.Error()
			detail["ok"] = false
			// The request's transaction rolls back with the failure: the
			// row goes in on its own.
			if authzPool != nil {
				if lerr := LogEvent(context.WithoutCancel(ctx), authzPool.P, cfg.ProjectID, cfg.ChannelID, "send_test", detail); lerr != nil {
					slog.Default().LogAttrs(ctx, slog.LevelWarn, "comm_channel.test_send: log a failed test", slog.String("error", lerr.Error()))
				}
			}
			return &reg.HandlerError{Code: "send_failed", Message: "the test message couldn't be sent; the mail account's Comm log (send_test) has the reason", InputIndex: i}
		}
		detail["ok"] = true
		if err := LogEvent(ctx, tx, cfg.ProjectID, cfg.ChannelID, "send_test", detail); err != nil {
			return fmt.Errorf("comm_channel.test_send: log: %w", err)
		}
	}
	return nil
}

// plainFrom is a From setting's bare address.
func plainFrom(from string) string {
	if a, err := mail.ParseAddress(strings.TrimSpace(from)); err == nil {
		return a.Address
	}
	return strings.TrimSpace(from)
}

// buildTestMessage is the test message: plain text, a notification's
// Message-ID and header (a reply to it is dropped).
func buildTestMessage(from, to, method string) []byte {
	domain := "kitp.invalid"
	if at := strings.LastIndexByte(plainFrom(from), '@'); at >= 0 && at+1 < len(plainFrom(from)) {
		domain = plainFrom(from)[at+1:]
	}
	var r [8]byte
	if _, err := rand.Read(r[:]); err != nil {
		r = [8]byte{} // crypto/rand doesn't fail on the systems kitp runs on
	}
	var b bytes.Buffer
	for _, h := range [][2]string{
		{"From", oneLine(from)},
		{"To", oneLine(to)},
		{"Subject", mime.QEncoding.Encode("utf-8", "kitp test message")},
		{"Date", time.Now().UTC().Format(time.RFC1123Z)},
		{"Message-ID", fmt.Sprintf("<%stest.%x@%s>", NotificationMessageIDPrefix, r, oneLine(domain))},
		{NotificationHeader, "test"},
		{"Auto-Submitted", "auto-generated"},
		{"MIME-Version", "1.0"},
		{"Content-Type", "text/plain; charset=utf-8"},
	} {
		b.WriteString(h[0] + ": " + h[1] + "\r\n")
	}
	b.WriteString("\r\n")
	b.WriteString("This is a test message from kitp: the mail account sends (" + method + ").\r\n\r\n" +
		"Replies, notifications and account emails go out this way. A reply to this message isn't filed.\r\n")
	return b.Bytes()
}
