package mailin_test

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/smtp"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/dom/comm"
	"github.com/kitp/kitp/server/internal/dom/mailin"
)

const smtpDomain = "in.example.test"

func startSMTP(t *testing.T, f *fixture, certFile, keyFile string) string {
	t.Helper()
	srv, err := mailin.NewSMTPServer(mailin.SMTPConfig{
		Addr: "127.0.0.1:0", Domain: smtpDomain, CertFile: certFile, KeyFile: keyFile,
		Pool: f.sp, Intake: &comm.Intake{Pool: f.sp}, Trusted: f.trusted, Status: f.status,
	})
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	})
	return ln.Addr().String()
}

func send(addr, from, to string, msg []byte) error {
	return smtp.SendMail(addr, nil, from, []string{to}, msg)
}

func TestSMTPReceives(t *testing.T) {
	f := setup(t, "kitp_test_mailin_smtp")
	addr := startSMTP(t, f, "", "")
	open := f.route(t, mailin.PurposeSMTP, "", nil, "")
	to := open.Token + "@" + smtpDomain

	if err := send(addr, "ada@example.com", to, mailText("<m1@example.com>", "Ada <ada@example.com>", "Over SMTP")); err != nil {
		t.Fatalf("delivery: %v", err)
	}
	if logCount(t, f, fmt.Sprint(open.ID), "received") != 1 {
		t.Error("no received row for the route")
	}
	if err := send(addr, "ada@example.com", strings.ToUpper(open.Token)+"@IN.EXAMPLE.TEST", mailText("<m1@example.com>", "Ada <ada@example.com>", "Over SMTP")); err != nil {
		t.Errorf("the same message again (upper-cased address): %v", err)
	}
	if logCount(t, f, fmt.Sprint(open.ID), "duplicate") != 1 {
		t.Error("the second copy should be a duplicate")
	}
	for _, bad := range []string{strings.Repeat("a", 40) + "@" + smtpDomain, open.Token + "@elsewhere.example"} {
		if err := send(addr, "ada@example.com", bad, mailText("<m2@example.com>", "a@b.com", "x")); err == nil || !strings.Contains(err.Error(), "550") {
			t.Errorf("to %s: %v, want 550", bad, err)
		}
	}

	env := f.route(t, mailin.PurposeSMTP, "", map[string]any{"envelope_from": []string{"example.org"}}, "")
	if err := send(addr, "bounces+SRS=x@example.org", env.Token+"@"+smtpDomain, mailText("<m3@example.com>", "c@customer.example", "fwd")); err != nil {
		t.Errorf("an allowed envelope: %v", err)
	}
	if err := send(addr, "spam@evil.example", env.Token+"@"+smtpDomain, mailText("<m4@example.com>", "c@customer.example", "fwd")); err == nil || !strings.Contains(err.Error(), "550") {
		t.Errorf("a refused envelope: %v", err)
	}
	if logCount(t, f, fmt.Sprint(env.ID), "inbound_refused") != 1 {
		t.Error("the envelope refusal isn't logged on the route")
	}

	hf := f.route(t, mailin.PurposeSMTP, "", map[string]any{"header_from": []string{"staff.example"}}, "")
	if err := send(addr, "x@y.example", hf.Token+"@"+smtpDomain, mailText("<m5@example.com>", "eve@evil.example", "x")); err == nil || !strings.Contains(err.Error(), "550") {
		t.Errorf("a refused header From (after DATA): %v", err)
	}

	tlsOnly := f.route(t, mailin.PurposeSMTP, "", map[string]any{"require_tls": true}, "")
	if err := send(addr, "a@b.example", tlsOnly.Token+"@"+smtpDomain, mailText("<m6@example.com>", "a@b.example", "x")); err == nil || !strings.Contains(err.Error(), "530") {
		t.Errorf("require_tls without STARTTLS: %v", err)
	}

	if err := comm.MarkChannelFault(context.Background(), f.sp, f.channelID, "test"); err != nil {
		t.Fatal(err)
	}
	if err := send(addr, "a@b.example", open.Token+"@"+smtpDomain, mailText("<m7@example.com>", "a@b.example", "x")); err == nil || !strings.Contains(err.Error(), "451") {
		t.Errorf("a paused account: %v, want 451", err)
	}
}

func TestSMTPSenderHostsAndProxy(t *testing.T) {
	f := setup(t, "kitp_test_mailin_smtp_hosts")
	addr := startSMTP(t, f, "", "")
	restore := mailin.SetSenderDNSForTest(
		func(_ context.Context, ip string) ([]string, error) {
			switch ip {
			case "127.0.0.1":
				return []string{"mail-x.outbound.protection.outlook.com."}, nil
			case "198.51.100.4":
				return []string{"liar.outbound.protection.outlook.com."}, nil // doesn't resolve back
			}
			return nil, fmt.Errorf("no PTR")
		},
		func(_ context.Context, host string) ([]string, error) {
			if host == "mail-x.outbound.protection.outlook.com." {
				return []string{"127.0.0.1"}, nil
			}
			return []string{"203.0.113.99"}, nil
		})
	defer restore()

	ms := f.route(t, mailin.PurposeSMTP, "", map[string]any{"sender_hosts": []string{".outbound.protection.outlook.com"}}, "")
	if err := send(addr, "a@b.example", ms.Token+"@"+smtpDomain, mailText("<h1@example.com>", "a@b.example", "x")); err != nil {
		t.Errorf("from a confirmed Microsoft host: %v", err)
	}
	google := f.route(t, mailin.PurposeSMTP, "", map[string]any{"sender_hosts": []string{".google.com"}}, "")
	if err := send(addr, "a@b.example", google.Token+"@"+smtpDomain, mailText("<h2@example.com>", "a@b.example", "x")); err == nil || !strings.Contains(err.Error(), "550") {
		t.Errorf("from a host outside the list: %v", err)
	}

	// Through a proxy (loopback is trusted): the PROXY header's address is
	// the client; its PTR name doesn't resolve back, so it isn't confirmed.
	viaProxy := func(src string) error {
		c, err := net.Dial("tcp", addr)
		if err != nil {
			return err
		}
		defer c.Close()
		fmt.Fprintf(c, "PROXY TCP4 %s 127.0.0.1 40000 25\r\n", src)
		cl, err := smtp.NewClient(c, "127.0.0.1")
		if err != nil {
			return err
		}
		defer cl.Close()
		if err := cl.Mail("a@b.example"); err != nil {
			return err
		}
		return cl.Rcpt(ms.Token + "@" + smtpDomain)
	}
	if err := viaProxy("198.51.100.4"); err == nil || !strings.Contains(err.Error(), "550") {
		t.Errorf("a proxied client whose PTR isn't confirmed: %v", err)
	}
	src := f.route(t, mailin.PurposeSMTP, "", map[string]any{"sources": []string{"198.51.100.0/24"}}, "")
	ms = src
	if err := viaProxy("198.51.100.4"); err != nil {
		t.Errorf("a proxied client inside sources: %v", err)
	}

	// Speaking before the greeting gets the connection dropped.
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprint(c, "EHLO early.example\r\n")
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	line, _ := bufio.NewReader(c).ReadString('\n')
	c.Close()
	if strings.HasPrefix(line, "220") {
		t.Errorf("an early talker was greeted: %q", line)
	}
	found := false
	for _, r := range f.status.Snapshot().RecentRefusals {
		if r.Reason == "spoke before the greeting" {
			found = true
		}
	}
	if !found {
		t.Error("the early talker isn't in the status refusals")
	}
}

func TestSMTPStartTLS(t *testing.T) {
	f := setup(t, "kitp_test_mailin_smtp_tls")
	dir := t.TempDir()
	certFile, keyFile := filepath.Join(dir, "tls.crt"), filepath.Join(dir, "tls.key")
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: smtpDomain}, DNSNames: []string{smtpDomain},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour)}
	der, _ := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	kb, _ := x509.MarshalECPrivateKey(key)
	_ = os.WriteFile(certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600)
	_ = os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kb}), 0o600)
	addr := startSMTP(t, f, certFile, keyFile)
	r := f.route(t, mailin.PurposeSMTP, "", map[string]any{"require_tls": true}, "")

	c, err := smtp.Dial(addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if ok, _ := c.Extension("STARTTLS"); !ok {
		t.Fatal("STARTTLS isn't offered")
	}
	if err := c.StartTLS(&tls.Config{InsecureSkipVerify: true}); err != nil {
		t.Fatal(err)
	}
	if err := c.Mail("a@b.example"); err != nil {
		t.Fatal(err)
	}
	if err := c.Rcpt(r.Token + "@" + smtpDomain); err != nil {
		t.Errorf("require_tls after STARTTLS: %v", err)
	}
	st := f.status.Snapshot()
	if !st.SMTP.Enabled || !st.TLS.Configured || st.TLS.Subject != smtpDomain || st.TLS.NotAfter == "" {
		t.Errorf("status = %+v / %+v", st.SMTP, st.TLS)
	}
}
