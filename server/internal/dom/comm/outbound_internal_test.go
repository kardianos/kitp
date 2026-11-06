package comm

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// testMessage is a message as the reply sender builds it: a non-ASCII
// subject, threading headers, an X- header and a file.
func testMessage() []byte {
	th := mimeThread{
		messageID:  "<reply-1@example.com>",
		inReplyTo:  "<first@customer.example>",
		references: []string{"<first@customer.example>", "<second@example.com>"},
	}
	return buildMIMEThreaded(th, `"Support" <support@example.com>`, "ada@customer.example", "Café réponse", "Hello Ada.",
		"Support", "AbCdEfGhIj", "", "", 42,
		[]mimeAttachment{{Filename: "notes.txt", MimeType: "text/plain", Bytes: []byte("the notes")}},
		mimeHeader{"Auto-Submitted", "auto-replied"})
}

func TestOutboundReady(t *testing.T) {
	for _, c := range []struct {
		o    Outbound
		want bool
	}{
		{Outbound{Method: SendMethodSMTP, Host: "smtp.example.com"}, true},
		{Outbound{Method: SendMethodSMTP}, false},
		{Outbound{Method: SendMethodMailgun, Domain: "mg.example.com", Secret: "k"}, true},
		{Outbound{Method: SendMethodMailgun, Domain: "mg.example.com"}, false},
		{Outbound{Method: SendMethodPostmark, Secret: "t"}, true},
		{Outbound{Method: SendMethodWebhook, URL: "https://x.example/", Secret: "s"}, true},
		{Outbound{Method: SendMethodWebhook, Secret: "s"}, false},
		{Outbound{Method: SendMethodNone, Host: "smtp.example.com"}, false},
	} {
		if got := c.o.Ready(); got != c.want {
			t.Errorf("%+v Ready = %v, want %v", c.o, got, c.want)
		}
	}
	if ResolveSendMethod("") != SendMethodSMTP || ResolveSendMethod("bogus") != SendMethodSMTP || ResolveSendMethod("postmark") != SendMethodPostmark {
		t.Error("ResolveSendMethod: unset or unknown is smtp")
	}
}

// TestMailgunGetsTheMessageWhole: messages.mime with the recipients and the
// MIME bytes as they are (so threading headers survive), basic auth api:key;
// a 400 bounces, a 500 is tried again.
func TestMailgunGetsTheMessageWhole(t *testing.T) {
	resetAllowlist(t, "127.0.0.1")
	msg := testMessage()
	status := http.StatusOK
	var gotTo []string
	var gotMsg []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v3/mg.example.com/messages.mime" {
			t.Errorf("path %s", r.URL.Path)
		}
		if u, p, ok := r.BasicAuth(); !ok || u != "api" || p != "key-1" {
			t.Errorf("basic auth %q %q %v", u, p, ok)
		}
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Errorf("form: %v", err)
			return
		}
		gotTo = r.MultipartForm.Value["to"]
		f, _, err := r.FormFile("message")
		if err != nil {
			t.Errorf("message part: %v", err)
			return
		}
		gotMsg, _ = io.ReadAll(f)
		w.WriteHeader(status)
		_, _ = io.WriteString(w, `{"message":"Queued"}`) // a test server; the client reads it
	}))
	defer srv.Close()
	prev := mailgunBase["eu"]
	mailgunBase["eu"] = srv.URL
	t.Cleanup(func() { mailgunBase["eu"] = prev })

	o := Outbound{Method: SendMethodMailgun, Domain: "mg.example.com", Region: "eu", Secret: "key-1"}
	if err := SendAPI(context.Background(), o, "support@example.com", "ada@customer.example, bob@customer.example", msg); err != nil {
		t.Fatalf("send: %v", err)
	}
	if strings.Join(gotTo, ",") != "ada@customer.example,bob@customer.example" {
		t.Errorf("to = %v", gotTo)
	}
	if string(gotMsg) != string(msg) {
		t.Error("the message wasn't sent as it was built")
	}
	status = http.StatusBadRequest
	var be *SMTPBounceError
	if err := SendAPI(context.Background(), o, "support@example.com", "ada@customer.example", msg); !errors.As(err, &be) {
		t.Errorf("a 400: %v, want a bounce", err)
	}
	status = http.StatusInternalServerError
	if err := SendAPI(context.Background(), o, "support@example.com", "ada@customer.example", msg); err == nil || errors.As(err, &be) {
		t.Errorf("a 500: %v, want an error to try again", err)
	}
}

// TestPostmarkReadsTheMessageBack: the message's From, decoded Subject,
// text, file and every other header — the threading ones above all —
// become Postmark's fields.
func TestPostmarkReadsTheMessageBack(t *testing.T) {
	pm, err := postmarkFromMIME(testMessage(), "ada@customer.example", "outbound")
	if err != nil {
		t.Fatal(err)
	}
	if pm.From != `"Support" <support@example.com>` || pm.To != "ada@customer.example" || pm.MessageStream != "outbound" {
		t.Errorf("from %q to %q stream %q", pm.From, pm.To, pm.MessageStream)
	}
	if !strings.HasPrefix(pm.Subject, "Café réponse") {
		t.Errorf("subject %q", pm.Subject)
	}
	if !strings.Contains(pm.TextBody, "Hello Ada.") || !strings.Contains(pm.TextBody, "Ref: AbCdEfGhIj") {
		t.Errorf("text body %q", pm.TextBody)
	}
	headers := map[string]string{}
	for _, h := range pm.Headers {
		headers[h.Name] = h.Value
	}
	for name, want := range map[string]string{
		"Message-Id":       "<reply-1@example.com>",
		"In-Reply-To":      "<first@customer.example>",
		"X-Kitp-Thread-Id": "AbCdEfGhIj",
		"Auto-Submitted":   "auto-replied",
	} {
		if got := headers[name]; got != want {
			t.Errorf("header %s = %q, want %q (headers %v)", name, got, want, headers)
		}
	}
	if !strings.Contains(headers["References"], "<second@example.com>") {
		t.Errorf("References = %q", headers["References"])
	}
	for _, skipped := range []string{"From", "To", "Subject", "Date", "Content-Type", "Mime-Version"} {
		if _, ok := headers[skipped]; ok {
			t.Errorf("header %s passed through; Postmark sets it", skipped)
		}
	}
	if len(pm.Attachments) != 1 || pm.Attachments[0].Name != "notes.txt" {
		t.Fatalf("attachments %+v", pm.Attachments)
	}
	if b, _ := base64.StdEncoding.DecodeString(pm.Attachments[0].Content); string(b) != "the notes" {
		t.Errorf("attachment content %q", b)
	}
}

// TestPostmarkAnswers: the token in its header; 422 with ErrorCode 406 (an
// inactive recipient) bounces, other codes are tried again.
func TestPostmarkAnswers(t *testing.T) {
	resetAllowlist(t, "127.0.0.1")
	var answer struct {
		status int
		body   string
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Postmark-Server-Token") != "tok" {
			t.Errorf("token header %q", r.Header.Get("X-Postmark-Server-Token"))
		}
		var pm postmarkMessage
		if err := json.NewDecoder(r.Body).Decode(&pm); err != nil {
			t.Errorf("body: %v", err)
		}
		w.WriteHeader(answer.status)
		_, _ = io.WriteString(w, answer.body) // a test server
	}))
	defer srv.Close()
	prev := postmarkURL
	postmarkURL = srv.URL
	t.Cleanup(func() { postmarkURL = prev })
	o := Outbound{Method: SendMethodPostmark, Secret: "tok"}
	send := func() error {
		return SendAPI(context.Background(), o, "support@example.com", "ada@customer.example", testMessage())
	}
	answer.status, answer.body = 200, `{"ErrorCode":0}`
	if err := send(); err != nil {
		t.Fatalf("send: %v", err)
	}
	var be *SMTPBounceError
	answer.status, answer.body = 422, `{"ErrorCode":406,"Message":"inactive recipient"}`
	if err := send(); !errors.As(err, &be) {
		t.Errorf("406: %v, want a bounce", err)
	}
	answer.status, answer.body = 422, `{"ErrorCode":400,"Message":"sender signature not found"}`
	if err := send(); err == nil || errors.As(err, &be) {
		t.Errorf("400: %v, want an error to try again", err)
	}
}

// TestWebhookSignsTheRawMessage: the raw message, the envelope in headers,
// a signature over both a receiver can check; a 4xx bounces, a 5xx and a
// redirect (not followed) are tried again.
func TestWebhookSignsTheRawMessage(t *testing.T) {
	resetAllowlist(t, "127.0.0.1")
	msg := testMessage()
	status := http.StatusAccepted
	followed := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/elsewhere" {
			followed = true
			return
		}
		body, _ := io.ReadAll(r.Body)
		ct, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if ct != "message/rfc822" || string(body) != string(msg) {
			t.Errorf("content type %q, body intact %v", ct, string(body) == string(msg))
		}
		ts, from, to := r.Header.Get("X-Kitp-Timestamp"), r.Header.Get("X-Kitp-Envelope-From"), r.Header.Get("X-Kitp-Envelope-To")
		if from != "support@example.com" || to != "ada@customer.example" {
			t.Errorf("envelope %q → %q", from, to)
		}
		if got, want := r.Header.Get("X-Kitp-Signature"), WebhookSignature("s3cret", ts, from, to, body); got != want {
			t.Errorf("signature %q, want %q", got, want)
		}
		if status == http.StatusFound {
			http.Redirect(w, r, "/elsewhere", http.StatusFound)
			return
		}
		w.WriteHeader(status)
	}))
	defer srv.Close()
	o := Outbound{Method: SendMethodWebhook, URL: srv.URL + "/send", Secret: "s3cret"}
	send := func() error {
		return SendAPI(context.Background(), o, "support@example.com", "ada@customer.example", msg)
	}
	if err := send(); err != nil {
		t.Fatalf("send: %v", err)
	}
	var be *SMTPBounceError
	status = http.StatusUnprocessableEntity
	if err := send(); !errors.As(err, &be) {
		t.Errorf("422: %v, want a bounce", err)
	}
	status = http.StatusServiceUnavailable
	if err := send(); err == nil || errors.As(err, &be) {
		t.Errorf("503: %v, want an error to try again", err)
	}
	status = http.StatusFound
	if err := send(); err == nil || followed {
		t.Errorf("a redirect: err %v, followed %v; want refused and not followed", err, followed)
	}
}

// TestAPICallsGoThroughTheDialGuard: an endpoint on a loopback or private
// address isn't reached (the SSRF guard on every API connection).
func TestAPICallsGoThroughTheDialGuard(t *testing.T) {
	resetAllowlist(t, "")
	reached := false
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached = true }))
	defer srv.Close()
	err := SendAPI(context.Background(), Outbound{Method: SendMethodWebhook, URL: srv.URL, Secret: "s"}, "a@example.com", "b@example.com", []byte("x"))
	if err == nil || reached || !strings.Contains(err.Error(), "blocked address") {
		t.Errorf("webhook to %s: err %v, reached %v; want the guard's refusal", srv.URL, err, reached)
	}
}

// TestPostmarkTakesANestedMessage: an alternative text + HTML message inside
// a mixed one reads both bodies, and the file.
func TestPostmarkTakesANestedMessage(t *testing.T) {
	var b strings.Builder
	b.WriteString("From: a@example.com\r\nTo: b@example.com\r\nSubject: =?utf-8?q?Hi_=C3=A9?=\r\nMIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: multipart/mixed; boundary=OUT\r\n\r\n--OUT\r\nContent-Type: multipart/alternative; boundary=IN\r\n\r\n")
	b.WriteString("--IN\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nplain =C3=A9\r\n")
	b.WriteString("--IN\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>html</p>\r\n--IN--\r\n")
	b.WriteString("--OUT\r\nContent-Type: application/pdf; name=\"r.pdf\"\r\nContent-Disposition: attachment; filename=\"r.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\n")
	b.WriteString(base64.StdEncoding.EncodeToString([]byte("%PDF")) + "\r\n--OUT--\r\n")
	pm, err := postmarkFromMIME([]byte(b.String()), "b@example.com", "")
	if err != nil {
		t.Fatal(err)
	}
	if pm.Subject != "Hi é" || !strings.HasPrefix(pm.TextBody, "plain é") || !strings.Contains(pm.HtmlBody, "<p>html</p>") {
		t.Errorf("subject %q text %q html %q", pm.Subject, pm.TextBody, pm.HtmlBody)
	}
	if len(pm.Attachments) != 1 || pm.Attachments[0].ContentType != "application/pdf" {
		t.Errorf("attachments %+v", pm.Attachments)
	}
}
