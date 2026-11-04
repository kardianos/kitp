package mailin_test

// Regression tests for the mail-intake findings of the 2026-11-03 review
// (area D).

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"mime/multipart"
	"net"
	"net/textproto"
	"strings"
	"testing"
	"time"

	"github.com/emersion/go-msgauth/dkim"

	"github.com/kitp/kitp/server/internal/dom/comm"
	"github.com/kitp/kitp/server/internal/dom/mailin"
)

// TestAddressAllowedOneAddress (#21): a From naming several addresses, or
// one that doesn't parse, is never on an allow list.
func TestAddressAllowedOneAddress(t *testing.T) {
	list := []string{"staff.example"}
	for _, c := range []struct {
		addr string
		want bool
	}{
		{"Ada <ada@staff.example>", true},
		{"ada@staff.example", true},
		{"Eve <eve@evil.example>, x@staff.example", false},
		{"eve@evil.example (@staff.example", false},
		{"", false},
		{"Eve <eve@evil.example>", false},
	} {
		if got := mailin.AddressAllowed(list, c.addr); got != c.want {
			t.Errorf("AddressAllowed(%q) = %v, want %v", c.addr, got, c.want)
		}
	}
}

// TestDKIMFromAlignment (#9): with a From allow list and DKIM required, a
// second From put in front of a genuinely signed message is refused, and so
// is a signed message whose From isn't in the signing domain.
func TestDKIMFromAlignment(t *testing.T) {
	f := setup(t, "kitp_test_review_dkim_align")
	h := f.handler(0)
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	restore := mailin.SetLookupTXTForTest(func(domain string) ([]string, error) {
		switch domain {
		case "k1._domainkey.staff.example", "k1._domainkey.relay.example":
			return []string{"v=DKIM1; k=ed25519; p=" + base64.StdEncoding.EncodeToString(pub)}, nil
		}
		return nil, fmt.Errorf("no record for %s", domain)
	})
	defer restore()
	sign := func(domain string, msg []byte) []byte {
		var out bytes.Buffer
		if err := dkim.Sign(&out, bytes.NewReader(msg), &dkim.SignOptions{Domain: domain, Selector: "k1", Signer: priv}); err != nil {
			t.Fatal(err)
		}
		return out.Bytes()
	}
	r := f.route(t, mailin.PurposePOST, mailin.ProviderRaw, map[string]any{
		"header_from": []string{"staff.example"},
		"dkim":        map[string]any{"mode": "require"},
	}, "")
	path := mailin.InboundPathPrefix + r.Token
	genuine := sign("staff.example", mailText("<orig@staff.example>", "Bob <bob@staff.example>", "Re: your ticket"))

	if rr := post(h, path, "message/rfc822", genuine, "203.0.113.5:1"); rr.Code != 200 {
		t.Fatalf("a genuine signed message: %d %s", rr.Code, rr.Body.String())
	}
	tampered := append([]byte("From: CEO <ceo@staff.example>\r\nSubject: Wire the money\r\nMessage-ID: <new@x>\r\n"), genuine...)
	if rr := post(h, path, "message/rfc822", tampered, "203.0.113.5:1"); rr.Code == 200 {
		t.Fatalf("a second From in front of a signed message was filed: %s", rr.Body.String())
	}
	// Signed by another domain the DKIM rule would accept (no domains
	// listed), From an allowed address: not aligned.
	other := sign("relay.example", mailText("<o@relay.example>", "Bob <bob@staff.example>", "relayed"))
	if rr := post(h, path, "message/rfc822", other, "203.0.113.5:1"); rr.Code == 200 {
		t.Fatalf("a message signed by relay.example claiming a staff.example From was filed: %s", rr.Body.String())
	}
	// A route that names its signer (the organisation's own forwarder)
	// trusts it to vouch for the From: no alignment needed.
	listed := f.route(t, mailin.PurposePOST, mailin.ProviderRaw, map[string]any{
		"header_from": []string{"staff.example"},
		"dkim":        map[string]any{"mode": "require", "domains": []string{"relay.example"}},
	}, "")
	if rr := post(h, mailin.InboundPathPrefix+listed.Token, "message/rfc822", other, "203.0.113.5:1"); rr.Code != 200 {
		t.Fatalf("a message from the listed signer: %d %s", rr.Code, rr.Body.String())
	}
}

// TestSMTPRcptMisses (#18): a connection that keeps naming unknown
// recipients is cut off, valid recipient or not.
func TestSMTPRcptMisses(t *testing.T) {
	f := setup(t, "kitp_test_review_rcpt_miss")
	addr := startSMTP(t, f, "", "")
	good := f.route(t, mailin.PurposeSMTP, "", nil, "")
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(20 * time.Second))
	tp := textproto.NewConn(c)
	if _, _, err := tp.ReadResponse(220); err != nil {
		t.Fatal(err)
	}
	cmd := func(s string) (int, error) {
		id, err := tp.Cmd("%s", s)
		if err != nil {
			return 0, err
		}
		tp.StartResponse(id)
		defer tp.EndResponse(id)
		code, _, err := tp.ReadResponse(0)
		if code != 0 {
			return code, nil
		}
		return code, err
	}
	if _, err := cmd("EHLO guesser.example"); err != nil {
		t.Fatal(err)
	}
	if _, err := cmd("MAIL FROM:<a@guesser.example>"); err != nil {
		t.Fatal(err)
	}
	var codes []int
	for i := range 20 {
		code, err := cmd(fmt.Sprintf("RCPT TO:<guess%d@%s>", i, smtpDomain))
		if err != nil {
			break // closed
		}
		codes = append(codes, code)
		if code == 421 {
			break
		}
	}
	if len(codes) == 0 || codes[len(codes)-1] != 421 || len(codes) > 10 {
		t.Fatalf("RCPT replies %v: want 550s and then 421 within 10 tries", codes)
	}
	if code, err := cmd("RCPT TO:<" + good.Token + "@" + smtpDomain + ">"); err == nil && code == 250 {
		t.Fatal("a valid recipient was accepted on the cut-off connection")
	}
	// The connection is then closed (round 2 #16), not left open until
	// the read timeout.
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := tp.ReadLine(); err == nil {
		t.Error("the server sent more after 421")
	} else if ne, ok := err.(net.Error); ok && ne.Timeout() {
		t.Error("the connection is still open 5 s after 421")
	}
}

// TestMailgunRetryAfter503 (#22): a Mailgun request answered "try again"
// can be retried; a request that was filed still can't be replayed.
func TestMailgunRetryAfter503(t *testing.T) {
	f := setup(t, "kitp_test_review_mg_retry")
	h := f.handler(0)
	const key = "key-test-signing"
	mg := f.route(t, mailin.PurposePOST, mailin.ProviderMailgun, nil, key)
	ts := fmt.Sprint(time.Now().Unix())
	tokBytes := make([]byte, 25)
	if _, err := rand.Read(tokBytes); err != nil {
		t.Fatal(err)
	}
	tok := hex.EncodeToString(tokBytes)
	m := hmac.New(sha256.New, []byte(key))
	m.Write([]byte(ts + tok))
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for k, v := range map[string]string{"timestamp": ts, "token": tok, "signature": hex.EncodeToString(m.Sum(nil)),
		"body-mime": string(mailText("<mg-retry@e.com>", "a@b.com", "Mailgun"))} {
		if err := mw.WriteField(k, v); err != nil {
			t.Fatal(err)
		}
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	path := mailin.InboundPathPrefix + mg.Token + "/mime"
	ctx := context.Background()
	if err := comm.MarkChannelFault(ctx, f.sp, f.channelID, "test"); err != nil {
		t.Fatal(err)
	}
	if rr := post(h, path, mw.FormDataContentType(), buf.Bytes(), ""); rr.Code != 503 {
		t.Fatalf("while paused: %d %s, want 503", rr.Code, rr.Body.String())
	}
	if err := comm.MarkChannelEnabled(ctx, f.sp, f.channelID); err != nil {
		t.Fatal(err)
	}
	if rr := post(h, path, mw.FormDataContentType(), buf.Bytes(), ""); rr.Code != 200 {
		t.Fatalf("the provider's retry: %d %s, want 200", rr.Code, strings.TrimSpace(rr.Body.String()))
	}
	if rr := post(h, path, mw.FormDataContentType(), buf.Bytes(), ""); rr.Code != 406 {
		t.Fatalf("a replay of a filed request: %d, want 406", rr.Code)
	}
}

// TestIntakeHardCases (#7, #11, #22): a huge Message-ID files (once); a
// sender's file name loses its line breaks and path; a route address in To
// doesn't join the thread; mail waits while Conversations is off; and
// iso_timestamp_ok answers false, not an error, past ±15:59.
func TestIntakeHardCases(t *testing.T) {
	t.Setenv("KITP_SMTP_DOMAIN", "in.example.test")
	f := setup(t, "kitp_test_review_intake_hard")
	h := f.handler(0)
	r := f.route(t, mailin.PurposePOST, mailin.ProviderRaw, nil, "")
	path := mailin.InboundPathPrefix + r.Token
	ctx := context.Background()

	long := make([]byte, 3400)
	for i := range long {
		long[i] = 'a' + byte(i%26)
	}
	mid := "<" + string(long) + "@evil.example>"
	if rr := post(h, path, "message/rfc822", mailText(mid, "Eve <eve@evil.example>", "long id"), "203.0.113.5:1"); rr.Code != 200 || statusOf(t, rr) == "duplicate" {
		t.Fatalf("a 3.4 KB Message-ID: %d %s", rr.Code, rr.Body.String())
	}
	if rr := post(h, path, "message/rfc822", mailText(mid, "Eve <eve@evil.example>", "long id"), "203.0.113.5:1"); statusOf(t, rr) != "duplicate" {
		t.Errorf("the same long Message-ID again: %s, want duplicate", rr.Body.String())
	}

	msg := "From: Ada <ada@example.com>\r\nTo: support@example.com, " + r.Token + "@in.example.test\r\n" +
		"Subject: files\r\nMessage-ID: <files@example.com>\r\nMIME-Version: 1.0\r\n" +
		"Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nhi\r\n" +
		"--b\r\nContent-Type: application/pdf\r\n" +
		"Content-Disposition: attachment; filename*=utf-8''..%2F..%2Fx.pdf%0D%0AContent-Type%3A%20text%2Fhtml\r\n" +
		"Content-Transfer-Encoding: base64\r\n\r\naGVsbG8=\r\n--b--\r\n"
	if rr := post(h, path, "message/rfc822", []byte(msg), "203.0.113.5:1"); rr.Code != 200 {
		t.Fatalf("mail with a file: %d %s", rr.Code, rr.Body.String())
	}
	var name string
	if err := f.sp.P.QueryRow(ctx, `SELECT filename FROM file ORDER BY id DESC LIMIT 1`).Scan(&name); err != nil {
		t.Fatal(err)
	}
	if strings.ContainsAny(name, "\r\n/\\") {
		t.Errorf("stored file name %q keeps a line break or path", name)
	}
	var routeOnThread int
	if err := f.sp.P.QueryRow(ctx, `
		SELECT count(*) FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE ad.name = 'email' AND av.value #>> '{}' ILIKE '%@in.example.test'`).Scan(&routeOnThread); err != nil {
		t.Fatal(err)
	}
	if routeOnThread != 0 {
		t.Errorf("the route address became a person (%d)", routeOnThread)
	}

	if _, err := f.sp.P.Exec(ctx, `INSERT INTO project_area (project_id, area_key, state) VALUES ($1, 'conversations', 'off')`, f.projectID); err != nil {
		t.Fatal(err)
	}
	if rr := post(h, path, "message/rfc822", mailText("<while-off@example.com>", "Ada <ada@example.com>", "while off"), "203.0.113.5:1"); rr.Code != 503 {
		t.Errorf("mail while Conversations is off: %d, want 503 (try later)", rr.Code)
	}

	for _, c := range []struct {
		in string
		ok bool
	}{{"2026-11-03T10:00:00+15:59", true}, {"2026-11-03T10:00:00+16:00", false}, {"2026-11-03T10:00:00-23:30", false}} {
		var ok bool
		if err := f.sp.P.QueryRow(ctx, `SELECT iso_timestamp_ok($1)`, c.in).Scan(&ok); err != nil {
			t.Errorf("iso_timestamp_ok(%q) raised: %v", c.in, err)
		} else if ok != c.ok {
			t.Errorf("iso_timestamp_ok(%q) = %v, want %v", c.in, ok, c.ok)
		}
	}
}
