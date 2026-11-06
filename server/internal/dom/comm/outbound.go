// outbound.go: a mail account's way out (docs/MAIL_INTAKE_AND_CALENDARS.md,
// "Sending"). A mail account receives one or more ways (IMAP polling, POST
// routes, the SMTP listener) and sends exactly one: an SMTP server, or an
// HTTP API — Mailgun or Postmark (the providers POST intake reads), or the
// account's own endpoint, which gets the raw message signed (the
// counterpart of a raw POST route: a Cloudflare Worker, a Lambda, a script).
//
// Every sender builds the whole MIME message as before; SMTP, Mailgun
// (messages.mime) and the webhook carry those bytes as they are, so
// kitp's Message-ID, In-Reply-To and References — what threading reads —
// go out unchanged. Postmark takes JSON: the message is read back into its
// fields, the threading headers into Headers.
package comm

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net"
	"net/http"
	"net/mail"
	"net/textproto"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Send methods (comm_channel.send_method).
const (
	SendMethodSMTP     = "smtp"
	SendMethodMailgun  = "mailgun"
	SendMethodPostmark = "postmark"
	SendMethodWebhook  = "webhook"
	SendMethodNone     = "none"
)

// ResolveSendMethod reads a stored send_method: an account from before the
// setting has none, which is SMTP (what it always used).
func ResolveSendMethod(v string) string {
	switch v = strings.TrimSpace(v); v {
	case "", SendMethodSMTP:
		return SendMethodSMTP
	case SendMethodMailgun, SendMethodPostmark, SendMethodWebhook:
		return v
	}
	// 'none', or a value comm_channel.set wouldn't take (written by hand):
	// no way out, as channel_can_send says (review 2026-11-06 round 8,
	// worth a look).
	return SendMethodNone
}

// Outbound is how a mail account sends, its secrets decrypted.
type Outbound struct {
	Method string
	// SMTP.
	Host     string
	Port     int
	Username string
	Password string
	// Mailgun: the sending domain and the API's region ("us" | "eu").
	Domain string
	Region string
	// Postmark: the message stream (empty: "outbound").
	Stream string
	// Webhook: the endpoint.
	URL string
	// Mailgun's API key, Postmark's server token, or the webhook's signing
	// secret (comm_secret.send_secret).
	Secret string
}

// Ready reports whether o has what its method needs to send.
func (o Outbound) Ready() bool {
	switch o.Method {
	case SendMethodSMTP:
		return strings.TrimSpace(o.Host) != ""
	case SendMethodMailgun:
		return strings.TrimSpace(o.Domain) != "" && o.Secret != ""
	case SendMethodPostmark:
		return o.Secret != ""
	case SendMethodWebhook:
		return strings.TrimSpace(o.URL) != "" && o.Secret != ""
	}
	return false
}

// IsAPI reports whether o sends through an HTTP API (SendAPI) rather than
// an SMTP server (the SMTP transports).
func (o Outbound) IsAPI() bool {
	switch o.Method {
	case SendMethodMailgun, SendMethodPostmark, SendMethodWebhook:
		return true
	}
	return false
}

// APITransport sends a whole message — envelope from, recipients (a comma
// list), the MIME bytes — through an HTTP API. Tests replace it; the
// errors are those of SMTPTransport: *SMTPBounceError when the provider
// refused it for good, anything else to try again.
type APITransport func(ctx context.Context, o Outbound, from, to string, msg []byte) error

// SendAPI is the production APITransport.
func SendAPI(ctx context.Context, o Outbound, from, to string, msg []byte) error {
	switch o.Method {
	case SendMethodMailgun:
		return sendMailgun(ctx, o, to, msg)
	case SendMethodPostmark:
		return sendPostmark(ctx, o, to, msg)
	case SendMethodWebhook:
		return sendWebhook(ctx, o, from, to, msg)
	}
	return fmt.Errorf("comm: send method %q isn't an HTTP API", o.Method)
}

// Where the providers' APIs are (tests point them at a local server).
var (
	mailgunBase = map[string]string{"us": "https://api.mailgun.net", "eu": "https://api.eu.mailgun.net"}
	postmarkURL = "https://api.postmarkapp.com/email"
)

// apiClient carries every API call: the dial guard on each connection (the
// address it connects to, like SMTP and IMAP), no redirects (a redirect
// could point anywhere), and a bound on the whole call.
var apiClient = &http.Client{
	Timeout: 60 * time.Second,
	Transport: &http.Transport{
		DialContext:           guardedDial,
		TLSHandshakeTimeout:   15 * time.Second,
		ResponseHeaderTimeout: 45 * time.Second,
		MaxIdleConns:          10,
		IdleConnTimeout:       90 * time.Second,
		ForceAttemptHTTP2:     true,
	},
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// guardedDial is net.Dialer.DialContext behind the SSRF guard (guardDialHost,
// then guardedDialer's check of the connected address).
func guardedDial(ctx context.Context, network, addr string) (net.Conn, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	if err := guardDialHost(ctx, host); err != nil {
		return nil, err
	}
	return guardedDialer(host, &net.Dialer{Timeout: 15 * time.Second}).DialContext(ctx, network, addr)
}

// apiAnswer turns a provider's HTTP answer into the send result: 2xx is
// sent; bounce says whether this refusal is for good (the message or a
// recipient), which bounces the message — anything else is tried again.
// The text kept is the provider's, clipped; never a secret.
func apiAnswer(provider string, resp *http.Response, bounce func(status int, body []byte) bool) error {
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
	if err != nil {
		return fmt.Errorf("%s: read the answer: %w", provider, err)
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	msg := strings.TrimSpace(string(body))
	if len(msg) > 300 {
		msg = msg[:300] + "…"
	}
	if bounce(resp.StatusCode, body) {
		return &SMTPBounceError{Code: resp.StatusCode, Msg: provider + ": " + msg}
	}
	return fmt.Errorf("%s: HTTP %d: %s", provider, resp.StatusCode, msg)
}

// sendMailgun posts the message whole to Mailgun's messages.mime, which
// sends it as it is to the given recipients.
func sendMailgun(ctx context.Context, o Outbound, to string, msg []byte) error {
	base, ok := mailgunBase[o.Region]
	if !ok {
		base = mailgunBase["us"]
	}
	rcpts, err := parseRecipients(to)
	if err != nil {
		return &SMTPBounceError{Code: 400, Msg: "mailgun: " + err.Error()}
	}
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	for _, r := range rcpts {
		if err := w.WriteField("to", r); err != nil {
			return fmt.Errorf("mailgun: form: %w", err)
		}
	}
	part, err := w.CreateFormFile("message", "message.mime")
	if err != nil {
		return fmt.Errorf("mailgun: form: %w", err)
	}
	if _, err := part.Write(msg); err != nil {
		return fmt.Errorf("mailgun: form: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("mailgun: form: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/v3/"+o.Domain+"/messages.mime", &body)
	if err != nil {
		return fmt.Errorf("mailgun: %w", err)
	}
	req.Header.Set("Content-Type", w.FormDataContentType())
	req.SetBasicAuth("api", o.Secret)
	resp, err := apiClient.Do(req)
	if err != nil {
		return fmt.Errorf("mailgun: %w", err)
	}
	defer resp.Body.Close()
	// 400 is Mailgun refusing this message (an address, the content);
	// 401 / 403 / 404 are the account's settings (key, domain), and 429
	// / 5xx pass — those are tried again.
	return apiAnswer("mailgun", resp, func(status int, _ []byte) bool { return status == http.StatusBadRequest })
}

// postmarkMessage is Postmark's /email body.
type postmarkMessage struct {
	From          string               `json:"From"`
	To            string               `json:"To"`
	Cc            string               `json:"Cc,omitempty"`
	ReplyTo       string               `json:"ReplyTo,omitempty"`
	Subject       string               `json:"Subject"`
	TextBody      string               `json:"TextBody,omitempty"`
	HtmlBody      string               `json:"HtmlBody,omitempty"`
	Headers       []postmarkHeader     `json:"Headers,omitempty"`
	Attachments   []postmarkAttachment `json:"Attachments,omitempty"`
	MessageStream string               `json:"MessageStream,omitempty"`
}

type postmarkHeader struct {
	Name  string `json:"Name"`
	Value string `json:"Value"`
}

type postmarkAttachment struct {
	Name        string `json:"Name"`
	Content     string `json:"Content"`
	ContentType string `json:"ContentType"`
}

// sendPostmark sends the message through Postmark's /email.
func sendPostmark(ctx context.Context, o Outbound, to string, msg []byte) error {
	pm, err := postmarkFromMIME(msg, to, o.Stream)
	if err != nil {
		return fmt.Errorf("postmark: %w", err)
	}
	body, err := json.Marshal(pm)
	if err != nil {
		return fmt.Errorf("postmark: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, postmarkURL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("postmark: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Postmark-Server-Token", o.Secret)
	resp, err := apiClient.Do(req)
	if err != nil {
		return fmt.Errorf("postmark: %w", err)
	}
	defer resp.Body.Close()
	// 422 with ErrorCode 300 (an invalid message) or 406 (an inactive
	// recipient) is this message refused; other codes are the account's
	// settings (token, sender signature), tried again.
	return apiAnswer("postmark", resp, func(status int, b []byte) bool {
		if status != http.StatusUnprocessableEntity {
			return false
		}
		var e struct {
			ErrorCode int `json:"ErrorCode"`
		}
		if json.Unmarshal(b, &e) != nil {
			return false
		}
		return e.ErrorCode == 300 || e.ErrorCode == 406
	})
}

// postmarkSkip are the headers Postmark sets itself or takes as fields.
var postmarkSkip = map[string]bool{
	"From": true, "To": true, "Cc": true, "Bcc": true, "Reply-To": true, "Subject": true,
	"Date": true, "Mime-Version": true, "Content-Type": true, "Content-Transfer-Encoding": true,
}

// postmarkFromMIME reads a message kitp built back into Postmark's fields:
// From, Subject (decoded), the text and HTML bodies, the files, and every
// other header — Message-ID, In-Reply-To, References, Auto-Submitted, the
// X- headers — as Headers. to is the recipient list.
func postmarkFromMIME(msg []byte, to, stream string) (postmarkMessage, error) {
	m, err := mail.ReadMessage(bytes.NewReader(msg))
	if err != nil {
		return postmarkMessage{}, fmt.Errorf("read the message: %w", err)
	}
	dec := new(mime.WordDecoder)
	out := postmarkMessage{To: to, MessageStream: stream}
	if a, err := mail.ParseAddress(m.Header.Get("From")); err == nil {
		out.From = postmarkAddress(a)
	} else {
		return postmarkMessage{}, fmt.Errorf("from: %w", err)
	}
	if rt := m.Header.Get("Reply-To"); rt != "" {
		if a, err := mail.ParseAddress(rt); err == nil {
			out.ReplyTo = postmarkAddress(a)
		}
	}
	if s, err := dec.DecodeHeader(m.Header.Get("Subject")); err == nil {
		out.Subject = plainLine(s)
	} else {
		out.Subject = plainLine(m.Header.Get("Subject"))
	}
	keys := make([]string, 0, len(m.Header))
	for k := range m.Header {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if postmarkSkip[textproto.CanonicalMIMEHeaderKey(k)] {
			continue
		}
		for _, v := range m.Header[k] {
			out.Headers = append(out.Headers, postmarkHeader{Name: k, Value: v})
		}
	}
	if err := postmarkBody(&out, textproto.MIMEHeader(m.Header), m.Body, 0); err != nil {
		return postmarkMessage{}, err
	}
	return out, nil
}

// postmarkAddress is a, its name raw UTF-8 and quoted (Postmark's form),
// on one line.
func postmarkAddress(a *mail.Address) string {
	name := plainLine(a.Name)
	if name == "" {
		return a.Address
	}
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(name) + `" <` + a.Address + ">"
}

// plainLine is s with its control characters (CR and LF among them) made
// spaces: a decoded RFC 2047 name or subject can carry them, and Postmark
// takes these fields raw — a relay copy's name came from an outsider's
// From (review 2026-11-06 round 8 L9).
func plainLine(s string) string {
	return strings.TrimSpace(strings.Join(strings.FieldsFunc(s, func(r rune) bool {
		return r < 0x20 || r == 0x7f
	}), " "))
}

// postmarkBody walks a part: text/plain and text/html (not attachments)
// become the bodies, the rest files. depth caps nested multiparts.
func postmarkBody(out *postmarkMessage, h textproto.MIMEHeader, r io.Reader, depth int) error {
	if depth > 8 {
		return errors.New("message nests too deep")
	}
	ct, params, err := mime.ParseMediaType(h.Get("Content-Type"))
	if err != nil {
		ct, params = "text/plain", map[string]string{}
	}
	if strings.HasPrefix(ct, "multipart/") {
		mr := multipart.NewReader(r, params["boundary"])
		for {
			p, err := mr.NextRawPart()
			if errors.Is(err, io.EOF) {
				return nil
			}
			if err != nil {
				return fmt.Errorf("read a part: %w", err)
			}
			if err := postmarkBody(out, p.Header, p, depth+1); err != nil {
				return err
			}
		}
	}
	data, err := io.ReadAll(decodeTransfer(h.Get("Content-Transfer-Encoding"), r))
	if err != nil {
		return fmt.Errorf("read a part: %w", err)
	}
	// A missing or odd Content-Disposition is an inline part: disp stays
	// "" and the part is read as a body when its type is text.
	disp, dparams, err := mime.ParseMediaType(h.Get("Content-Disposition"))
	if err != nil {
		disp, dparams = "", map[string]string{}
	}
	switch {
	case disp != "attachment" && ct == "text/plain" && out.TextBody == "":
		out.TextBody = string(data)
	case disp != "attachment" && ct == "text/html" && out.HtmlBody == "":
		out.HtmlBody = string(data)
	default:
		name := dparams["filename"]
		if name == "" {
			name = params["name"]
		}
		if d, err := new(mime.WordDecoder).DecodeHeader(name); err == nil {
			name = d
		}
		name = plainLine(name)
		if name == "" {
			name = "attachment"
		}
		out.Attachments = append(out.Attachments, postmarkAttachment{
			Name: name, Content: base64.StdEncoding.EncodeToString(data), ContentType: ct,
		})
	}
	return nil
}

// decodeTransfer undoes a part's Content-Transfer-Encoding (base64,
// quoted-printable; 7bit / 8bit / binary as they are).
func decodeTransfer(cte string, r io.Reader) io.Reader {
	switch strings.ToLower(strings.TrimSpace(cte)) {
	case "base64":
		return base64.NewDecoder(base64.StdEncoding, r)
	case "quoted-printable":
		return quotedprintable.NewReader(r)
	}
	return r
}

// WebhookSignature is the X-Kitp-Signature a webhook send carries:
// "v1=" + hex(HMAC-SHA256(secret, timestamp "\n" envelope-from "\n"
// envelope-to "\n" body)). A receiver recomputes it with the secret and
// refuses a timestamp more than a few minutes old.
func WebhookSignature(secret, timestamp, from, to string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp + "\n" + from + "\n" + to + "\n"))
	mac.Write(body)
	return "v1=" + hex.EncodeToString(mac.Sum(nil))
}

// sendWebhook posts the raw message to the account's own endpoint, signed:
// it is the endpoint's to send (a Cloudflare Worker, a Lambda, a script).
func sendWebhook(ctx context.Context, o Outbound, from, to string, msg []byte) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, o.URL, bytes.NewReader(msg))
	if err != nil {
		return fmt.Errorf("webhook: %w", err)
	}
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	req.Header.Set("Content-Type", "message/rfc822")
	req.Header.Set("X-Kitp-Timestamp", ts)
	req.Header.Set("X-Kitp-Envelope-From", from)
	req.Header.Set("X-Kitp-Envelope-To", to)
	req.Header.Set("X-Kitp-Signature", WebhookSignature(o.Secret, ts, from, to, msg))
	resp, err := apiClient.Do(req)
	if err != nil {
		return fmt.Errorf("webhook: %w", err)
	}
	defer resp.Body.Close()
	// 400 and 422 are the endpoint refusing this message, for good. Any
	// other answer — 401 or 403 (a bad signature: a rotated secret, a
	// clock out by minutes), 404, 408, 429, a 5xx, a redirect — is tried
	// again, as Mailgun's are: bouncing on those marked every reply
	// bounced while the endpoint was misconfigured (review 2026-11-06
	// round 8 L6).
	return apiAnswer("webhook", resp, func(status int, _ []byte) bool {
		return status == http.StatusBadRequest || status == http.StatusUnprocessableEntity
	})
}
