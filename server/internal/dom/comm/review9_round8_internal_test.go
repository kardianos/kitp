package comm

// Round 8 of the 2026-11-06 review (no database): a webhook's answers
// (L6), Postmark's fields (L9), an unknown send method, the local-use
// NAT64 prefix.

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/mail"
	"strings"
	"testing"
)

// TestAWebhookBouncesOnlyWhatItRefuses (L6): 400 and 422 refuse the
// message for good; 401, 403 and 404 (a bad signature, a rotated secret, a
// wrong path) and 408 / 429 / 5xx are tried again.
func TestAWebhookBouncesOnlyWhatItRefuses(t *testing.T) {
	resetAllowlist(t, "127.0.0.1")
	for status, bounce := range map[int]bool{
		400: true, 422: true,
		401: false, 403: false, 404: false, 408: false, 429: false, 500: false, 503: false,
	} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(status)
		}))
		err := SendAPI(context.Background(), Outbound{Method: SendMethodWebhook, URL: srv.URL, Secret: "s"},
			"a@example.com", "b@example.com", []byte("x"))
		srv.Close()
		var be *SMTPBounceError
		if err == nil || errors.As(err, &be) != bounce {
			t.Errorf("webhook %d: err %v, bounce %v; want an error, bounce %v", status, err, errors.As(err, &be), bounce)
		}
	}
}

// TestPostmarkGetsOneLineFields (L9): a name or subject that decodes to
// a CR or LF reaches Postmark on one line.
func TestPostmarkGetsOneLineFields(t *testing.T) {
	from := (&mail.Address{Name: "Ada\r\nBcc: victim@evil.example via Support", Address: "support@example.com"}).String()
	msg := buildMIMEThreaded(mimeThread{messageID: "<m@example.com>"}, from, "bob@example.com",
		"Re: x\r\nBcc: victim@evil.example", "body", "", "AbCdEfGhIj", "", "", 0, nil)
	pm, err := postmarkFromMIME(msg, "bob@example.com", "")
	if err != nil {
		t.Fatal(err)
	}
	if strings.ContainsAny(pm.From, "\r\n") || strings.ContainsAny(pm.Subject, "\r\n") {
		t.Errorf("Postmark From %q, Subject %q: a line break got through", pm.From, pm.Subject)
	}
	if got := relaySenderName("Ada\r\nLovelace", "Support", "support@example.com"); got != "Ada Lovelace via Support" {
		t.Errorf("relaySenderName = %q", got)
	}
}

// TestAnUnknownSendMethodSendsNothing: what channel_can_send says — a
// method comm_channel.set wouldn't take has no way out.
func TestAnUnknownSendMethodSendsNothing(t *testing.T) {
	for in, want := range map[string]string{
		"": SendMethodSMTP, "smtp": SendMethodSMTP, " mailgun ": SendMethodMailgun,
		"postmark": SendMethodPostmark, "webhook": SendMethodWebhook, "none": SendMethodNone,
		"carrier-pigeon": SendMethodNone,
	} {
		if got := ResolveSendMethod(in); got != want {
			t.Errorf("ResolveSendMethod(%q) = %q, want %q", in, got, want)
		}
	}
	if (Outbound{Method: SendMethodSMTP, Host: "  "}).Ready() {
		t.Error("an SMTP server of spaces is ready")
	}
}

// TestTheLocalUseNAT64PrefixIsRefused: 64:ff9b:1::/48 carries its IPv4
// address where the operator chooses.
func TestTheLocalUseNAT64PrefixIsRefused(t *testing.T) {
	for _, s := range []string{"64:ff9b:1::7f00:1", "64:ff9b:1:a9fe:a9fe::"} {
		if !isBlockedIP(net.ParseIP(s)) {
			t.Errorf("%s isn't refused", s)
		}
	}
	if isBlockedIP(net.ParseIP("64:ff9b::808:808")) {
		t.Error("NAT64 of a public address (8.8.8.8) is refused")
	}
}
