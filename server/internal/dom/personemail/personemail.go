// Package personemail is a person's email addresses (docs/EMAIL_ADDRESSES.md):
// the list (person_email.list), adding one of your own and verifying it by a
// code mailed to it (person_email.add / verify), choosing the primary
// (person_email.set_primary) and taking one off (person_email.remove); and
// which mail account sends those codes (account_mail.get / set, admin).
//
// The primary is the person card's `email` — what mail, digests and thread
// recipients use. A sign-in's trusted email joins the list on its own
// (person_email_note_signin, from the OIDC sign-in).
package personemail

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"mime"
	"mime/quotedprintable"
	"net/mail"
	"os"
	"reflect"
	"strings"
	"time"

	"github.com/kitp/kitp/server/internal/dom/comm"
	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// Address is one of a person's addresses as person_email.list shows it.
type Address struct {
	Email         string  `json:"email" mcp:"desc=the address (lower-cased)"`
	Source        string  `json:"source" mcp:"desc=where it came from: signin (a sign-in brought it) | added (the person added it) | card (the person card's email, not on the list)"`
	Verified      bool    `json:"verified" mcp:"desc=true once verified (by the sign-in, or by the code mailed to it)"`
	Primary       bool    `json:"primary" mcp:"desc=true for the primary: the address mail and digests use"`
	CodeExpiresAt *string `json:"code_expires_at,omitempty" mcp:"desc=when the code mailed to an unverified address stops working"`
}

// ListInput names whose addresses to list.
type ListInput struct {
	PersonID int64 `json:"person_id,string,omitempty" mcp:"desc=person card id; omit for your own (another person's needs a workspace admin)"`
}

// ListOutput is a person's addresses.
type ListOutput struct {
	PersonID  int64     `json:"person_id,string" mcp:"desc=the person card id"`
	Primary   string    `json:"primary" mcp:"desc=the primary address (the person card's email)"`
	CanAdd    bool      `json:"can_add" mcp:"desc=true when you may add an address (your own list, and a mail account sends account emails)"`
	Addresses []Address `json:"addresses" mcp:"desc=the addresses"`
}

// AddInput is an address the caller adds. The code mailed to it is made as
// the input is read (UnmarshalJSON) and never comes from the wire; the SQL
// sees only its hash (MarshalJSON).
type AddInput struct {
	Email string `json:"email" mcp:"required,desc=the address to add; a code is mailed to it to verify it"`
	code  string
}

// UnmarshalJSON reads the address and makes the verification code.
func (in *AddInput) UnmarshalJSON(b []byte) error {
	var w struct {
		Email string `json:"email"`
	}
	if err := json.Unmarshal(b, &w); err != nil {
		return err
	}
	code, err := newCode()
	if err != nil {
		return err
	}
	in.Email, in.code = w.Email, code
	return nil
}

// MarshalJSON is what the SQL sees: the address and the code's hash.
func (in AddInput) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		Email    string `json:"email"`
		CodeHash string `json:"code_hash"`
	}{in.Email, codeHash(in.code)})
}

// codeHash is what kitp stores of a code: HMAC-SHA256 under a key derived
// from KITP_COMM_SECRET_KEY (set in production; kitpd refuses to start
// without it), hex. A code is only about 50 bits, so a plain SHA-256 read
// from a backup or replica could be searched within its 24 hours (review
// 2026-11-06 L10).
func codeHash(code string) string {
	key := sha256.Sum256([]byte("kitp person_email code v1\x00" + store.CommSecretKey()))
	mac := hmac.New(sha256.New, key[:])
	mac.Write([]byte(code))
	return hex.EncodeToString(mac.Sum(nil))
}

// AddOutput reports the pending address.
type AddOutput struct {
	Email           string `json:"email" mcp:"desc=the address, waiting for its code"`
	SenderChannelID int64  `json:"sender_channel_id,string" mcp:"desc=the mail account the code was sent from"`
	// skipSend: the address is verified on someone else — the SQL answers
	// as for any address but sends nothing, and the caller isn't told
	// (review 2026-11-06 L2). Read from the SQL's `send`, never written.
	skipSend bool
	// personID is the caller's person, for the send log (recordCodeSend).
	personID int64
}

// UnmarshalJSON reads the SQL's answer, including `send`.
func (o *AddOutput) UnmarshalJSON(b []byte) error {
	var w struct {
		Email           string `json:"email"`
		SenderChannelID int64  `json:"sender_channel_id,string"`
		Send            *bool  `json:"send"`
		PersonCardID    int64  `json:"person_card_id,string"`
	}
	if err := json.Unmarshal(b, &w); err != nil {
		return err
	}
	o.Email, o.SenderChannelID, o.personID = w.Email, w.SenderChannelID, w.PersonCardID
	o.skipSend = w.Send != nil && !*w.Send
	return nil
}

// VerifyInput is an address and the code mailed to it.
type VerifyInput struct {
	Email string `json:"email" mcp:"required,desc=the address being verified"`
	Code  string `json:"code" mcp:"required,desc=the code mailed to it (dashes and case don't matter)"`
}

// MarshalJSON is what the SQL sees: the address and the code's hash.
func (in VerifyInput) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		Email    string `json:"email"`
		CodeHash string `json:"code_hash"`
	}{in.Email, codeHash(normalCode(in.Code))})
}

// VerifyOutput confirms a verified address.
type VerifyOutput struct {
	Email    string `json:"email" mcp:"desc=the address"`
	Verified bool   `json:"verified" mcp:"desc=true"`
}

// EmailInput names one of the caller's addresses.
type EmailInput struct {
	Email string `json:"email" mcp:"required,desc=the address"`
}

// RemoveInput names an address to take off a person's list.
type RemoveInput struct {
	PersonID int64  `json:"person_id,string,omitempty" mcp:"desc=person card id; omit for your own (another person's needs a workspace admin)"`
	Email    string `json:"email" mcp:"required,desc=the address to remove (not the primary)"`
}

// EmailOutput echoes the address acted on.
type EmailOutput struct {
	Email string `json:"email" mcp:"desc=the address"`
}

// AccountMailInput chooses the mail account that sends account emails.
type AccountMailInput struct {
	ChannelID int64 `json:"channel_id,string,omitempty" mcp:"desc=comm_channel card id; omit or 0 for none"`
}

// AccountMailOutput is that mail account, or none, and (account_mail.get)
// the mail accounts it may be.
type AccountMailOutput struct {
	ChannelID string          `json:"channel_id" mcp:"desc=comm_channel card id, or empty for none"`
	Choices   []AccountChoice `json:"choices,omitempty" mcp:"desc=account_mail.get: every live mail account with an outgoing server and a From address"`
}

// AccountChoice is a mail account that could send account emails.
type AccountChoice struct {
	ID          string `json:"id" mcp:"desc=comm_channel card id"`
	Name        string `json:"name" mcp:"desc=the mail account's name"`
	Project     string `json:"project" mcp:"desc=its project's title"`
	FromAddress string `json:"from_address" mcp:"desc=its From address"`
}

// EmptyInput takes nothing.
type EmptyInput struct{}

// codeSymbols are 31 letters and digits, none easily mistaken for another
// (no 0/O, 1/I/L): a 10-symbol code is one of 31^10 ≈ 8×10^14. A failed try
// rolls its batch back, so tries can't be counted; the code is too long to
// guess in its 24 hours instead.
const codeSymbols = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

const codeLen = 10

// newCode is a fresh verification code, shown as XXXXX-XXXXX. Bytes past
// the largest multiple of 31 are drawn again, so every symbol is as likely.
func newCode() (string, error) {
	out := make([]byte, 0, codeLen)
	var b [16]byte
	for len(out) < codeLen {
		if _, err := rand.Read(b[:]); err != nil {
			return "", fmt.Errorf("person_email: code: %w", err)
		}
		for _, v := range b {
			if v < 248 && len(out) < codeLen { // 248 = 8 × 31
				out = append(out, codeSymbols[int(v)%len(codeSymbols)])
			}
		}
	}
	return string(out[:5]) + "-" + string(out[5:]), nil
}

// normalCode is a typed code as it was made: upper case, without spaces
// and other marks, with its one dash where newCode puts it.
func normalCode(c string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(c) {
		if strings.ContainsRune(codeSymbols, r) {
			b.WriteRune(r)
		}
	}
	s := b.String()
	if len(s) != codeLen {
		return s
	}
	return s[:5] + "-" + s[5:]
}

// pool is kitp's database, for the Comm log row of a code that failed to
// go out: the request's transaction rolls back with the failure.
var pool *store.Pool

// transport sends one message by SMTP, apiTransport by an HTTP API (the
// account's send method; tests replace both).
var (
	transport    = comm.SendSMTP
	apiTransport = comm.SendAPI
)

// sendCodes mails each new code from the account-mail account. It runs in
// the request's transaction after the SQL: a failed send fails the batch,
// so no code is stored that never went out. Each send is counted for the
// limits first, on its own connection (recordCodeSend).
//
// An address verified on someone else gets no mail (skipSend), but goes
// through the same checks and is counted the same: a paused or faulted
// mailbox refused a free address and passed a taken one, which told whose
// it was (review 2026-11-06 round 8 L2). It can't fail to send, though,
// and it answers sooner — docs/EMAIL_ADDRESSES.md.
func sendCodes(ctx context.Context, tx store.Querier, ins []any, outs []any) error {
	for i := range outs {
		in, ok := ins[i].(AddInput)
		out, ok2 := outs[i].(AddOutput)
		if !ok || !ok2 {
			return fmt.Errorf("person_email.add: unexpected types %T, %T", ins[i], outs[i])
		}
		cfg, err := comm.LoadSMTPConfig(ctx, tx, out.SenderChannelID)
		if err != nil {
			return fmt.Errorf("person_email.add: mail account: %w", err)
		}
		// An admin paused it, or kitp switched it off after failures: it
		// sends nothing, codes included (review 2026-11-06 L12).
		if cfg.Status != comm.ChannelStatusEnabled {
			return &reg.HandlerError{Code: "no_sender", Message: "the mail account for account emails is switched off; ask an admin", InputIndex: i}
		}
		if !cfg.Outbound().Ready() || cfg.From == "" {
			return &reg.HandlerError{Code: "no_sender", Message: "the mail account for account emails has no way out or From address; ask an admin", InputIndex: i}
		}
		if err := recordCodeSend(ctx, tx, out.personID, out.Email); err != nil {
			return err
		}
		if out.skipSend {
			continue
		}
		msg := buildCodeMail(cfg.From, out.Email, in.code, publicURL())
		detail := map[string]any{"recipient": out.Email, "purpose": "verify_address"}
		if comm.SMTPDryRun() {
			detail["dry_run"] = true
			slog.Default().LogAttrs(ctx, slog.LevelInfo, "person_email: dry run, code not sent",
				slog.Int64("channel_id", cfg.ChannelID), slog.Int("bytes", len(msg)))
		} else {
			sendCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
			err := comm.Deliver(sendCtx, cfg.Outbound(), transport, apiTransport, envelope(cfg.From), out.Email, msg)
			cancel()
			if err != nil {
				detail["error"] = err.Error()
				if pool != nil {
					if lerr := comm.LogEvent(context.WithoutCancel(ctx), pool.P, cfg.ProjectID, cfg.ChannelID, "notify_fail", detail); lerr != nil {
						slog.Default().LogAttrs(ctx, slog.LevelWarn, "person_email: log a failed code", slog.String("error", lerr.Error()))
					}
				}
				var be *comm.SMTPBounceError
				if errors.As(err, &be) {
					return &reg.HandlerError{Code: "send_refused", Message: "the mail server refused that address", InputIndex: i}
				}
				return &reg.HandlerError{Code: "send_failed", Message: "the code couldn't be sent; try again in a moment", InputIndex: i}
			}
		}
		if err := comm.LogEvent(ctx, tx, cfg.ProjectID, cfg.ChannelID, "notify_ok", detail); err != nil {
			return fmt.Errorf("person_email.add: log: %w", err)
		}
	}
	return nil
}

// recordCodeSend logs a code send in person_email_code_sent, which the
// limits count (person_email_add_batch). It goes in on the pool's own
// connection, committed before the mail goes out: in the request's
// transaction it rolled back with a batch that failed after sending, and
// the mail went uncounted (review 2026-11-06 round 8 #5). Without the pool
// (a test that didn't Register) it goes in the request.
func recordCodeSend(ctx context.Context, tx store.Querier, person int64, email string) error {
	b := named.New()
	b.Set("person", person)
	b.Set("email", email)
	q, args, err := b.Compile(`INSERT INTO person_email_code_sent (person_card_id, email) VALUES (:person, :email)`)
	if err != nil {
		return fmt.Errorf("person_email.add: count the send: compile: %w", err)
	}
	if pool != nil {
		_, err = pool.P.Exec(context.WithoutCancel(ctx), q, args...)
	} else {
		_, err = tx.Exec(ctx, q, args...)
	}
	if err != nil {
		return fmt.Errorf("person_email.add: count the send: %w", err)
	}
	return nil
}

// publicURL is KITP_PUBLIC_URL without its trailing slash ("" when unset).
func publicURL() string {
	return strings.TrimRight(strings.TrimSpace(os.Getenv("KITP_PUBLIC_URL")), "/")
}

// envelope is a From header's bare address.
func envelope(from string) string {
	if a, err := mail.ParseAddress(from); err == nil {
		return a.Address
	}
	return from
}

// buildCodeMail is the verification email: marked as a notification (its
// Message-ID and X-Kitp-Notification), so a reply to it is dropped rather
// than filed as new mail.
func buildCodeMail(from, to, code, base string) []byte {
	domain := "kitp.invalid"
	if at := strings.LastIndexByte(envelope(from), '@'); at >= 0 && at+1 < len(envelope(from)) {
		domain = envelope(from)[at+1:]
	}
	var r [8]byte
	if _, err := rand.Read(r[:]); err != nil {
		r = [8]byte{} // crypto/rand doesn't fail on the systems kitp runs on
	}
	oneLine := strings.NewReplacer("\r", " ", "\n", " ").Replace
	var hdr bytes.Buffer
	for _, h := range [][2]string{
		{"From", oneLine(from)},
		{"To", oneLine(to)},
		{"Subject", mime.QEncoding.Encode("utf-8", "Your kitp verification code")},
		{"Date", time.Now().UTC().Format(time.RFC1123Z)},
		{"Message-ID", fmt.Sprintf("<%sverify.%x@%s>", comm.NotificationMessageIDPrefix, r, oneLine(domain))},
		{comm.NotificationHeader, "verify"},
		{"Auto-Submitted", "auto-generated"},
		{"MIME-Version", "1.0"},
		{"Content-Type", "text/plain; charset=utf-8"},
		{"Content-Transfer-Encoding", "quoted-printable"},
	} {
		hdr.WriteString(h[0] + ": " + h[1] + "\r\n")
	}
	hdr.WriteString("\r\n")
	body := "Someone — we hope you — added this address to their kitp account.\n\n" +
		"Your code: " + code + "\n\n"
	if base != "" {
		body += "Enter it on your account page: " + base + "/account\n\n"
	}
	body += "It works for 24 hours. If you didn't ask for it, ignore this email: the address isn't added until the code is entered.\n"
	var qp bytes.Buffer
	w := quotedprintable.NewWriter(&qp)
	// Writes into a bytes.Buffer can't fail; Close only flushes.
	_, _ = w.Write([]byte(strings.ReplaceAll(body, "\n", "\r\n")))
	_ = w.Close()
	return append(hdr.Bytes(), qp.Bytes()...)
}

// Register installs the person_email.* and account_mail.* handlers.
func Register(p *store.Pool) {
	pool = p
	// Ownership is checked in each function (the caller's own person, or a
	// workspace admin): no card or project anchors these.
	reg.Register(reg.Handler{
		Endpoint: "person_email", Action: "list",
		Doc:          "List a person's email addresses: yours (person_id omitted) or, for a workspace admin, anyone's. Each says where it came from (signin / added / card), whether it is verified and whether it is the primary (the address mail and digests use).",
		InputType:    reflect.TypeFor[ListInput](),
		OutputType:   reflect.TypeFor[ListOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		IsRead:       true,
		SQLFunc:      "person_email_list_batch",
	})
	reg.Register(reg.Handler{
		Endpoint: "person_email", Action: "add",
		Doc:          "Add an email address of your own. A code is mailed to it from the mail account an admin chose for account emails; enter it with person_email.verify within 24 hours. Adding it again sends a new code. Limits: 20 addresses, 5 codes an hour.",
		InputType:    reflect.TypeFor[AddInput](),
		OutputType:   reflect.TypeFor[AddOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		SQLFunc:      "person_email_add_batch",
		PostRun:      sendCodes,
		Timeout:      30 * time.Second, // an SMTP conversation per address
	})
	reg.Register(reg.Handler{
		Endpoint: "person_email", Action: "verify",
		Doc:          "Verify an address you added with the code mailed to it.",
		InputType:    reflect.TypeFor[VerifyInput](),
		OutputType:   reflect.TypeFor[VerifyOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Secret:       true, // the code
		SQLFunc:      "person_email_verify_batch",
	})
	reg.Register(reg.Handler{
		Endpoint: "person_email", Action: "set_primary",
		Doc:          "Make one of your verified addresses the primary: the address mail, digests and threads use for you.",
		InputType:    reflect.TypeFor[EmailInput](),
		OutputType:   reflect.TypeFor[EmailOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		SQLFunc:      "person_email_set_primary_batch",
	})
	reg.Register(reg.Handler{
		Endpoint: "person_email", Action: "remove",
		Doc:          "Take an address off a person's list: yours, or (workspace admin) anyone's. Never the primary; choose another primary first.",
		InputType:    reflect.TypeFor[RemoveInput](),
		OutputType:   reflect.TypeFor[EmailOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		SQLFunc:      "person_email_remove_batch",
	})
	reg.Register(reg.Handler{
		Endpoint: "account_mail", Action: "get",
		Doc:          "Admin: the mail account that sends account emails (address verification codes), or none.",
		InputType:    reflect.TypeFor[EmptyInput](),
		OutputType:   reflect.TypeFor[AccountMailOutput](),
		AllowedRoles: []string{"admin"},
		IsRead:       true,
		SQLFunc:      "account_mail_get_batch",
	})
	reg.Register(reg.Handler{
		Endpoint: "account_mail", Action: "set",
		Doc:          "Admin: choose the mail account that sends account emails (address verification codes), or none.",
		InputType:    reflect.TypeFor[AccountMailInput](),
		OutputType:   reflect.TypeFor[AccountMailOutput](),
		AllowedRoles: []string{"admin"},
		SQLFunc:      "account_mail_set_batch",
	})
}
