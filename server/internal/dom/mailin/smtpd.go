package mailin

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/emersion/go-smtp"

	"github.com/kitp/kitp/server/internal/dom/comm"
	"github.com/kitp/kitp/server/internal/netx"
	"github.com/kitp/kitp/server/internal/store"
)

// DefaultSMTPMaxBytes caps a message (KITP_SMTP_MAX_BYTES).
const DefaultSMTPMaxBytes = 40 << 20

// SMTPConfig configures the receive-only SMTP listener
// (docs/MAIL_INTAKE_AND_CALENDARS.md §7). It is off unless Addr is set.
type SMTPConfig struct {
	Addr     string   // KITP_SMTP_ADDR, e.g. ":2525"
	Domain   string   // KITP_SMTP_DOMAIN: route addresses are <token>@Domain
	Hostname string   // KITP_SMTP_HOSTNAME: greeting name (default Domain)
	CertFile string   // KITP_SMTP_TLS_CERT (PEM)
	KeyFile  string   // KITP_SMTP_TLS_KEY (PEM)
	MaxBytes int64    // KITP_SMTP_MAX_BYTES
	Allow    []string // KITP_SMTP_ALLOW: install-wide source CIDRs (empty = any)

	Pool    *store.Pool
	Intake  *comm.Intake
	Trusted *netx.Trusted
	Status  *Status
	Logger  *slog.Logger
}

// SMTPServer is the listener. It only receives: mail for an address that
// isn't a route is refused at RCPT, so kitp never relays or bounces.
type SMTPServer struct {
	cfg     SMTPConfig
	srv     *smtp.Server
	certs   *certReloader
	sources *netx.Limiter // connections + misses per source
	msgs    *netx.Limiter // messages per source
	routes  *netx.Limiter // messages per route

	mu     sync.Mutex
	active map[string]int
	total  int
	ln     *netx.SniffListener
}

// NewSMTPServer checks the settings and loads the certificate.
func NewSMTPServer(cfg SMTPConfig) (*SMTPServer, error) {
	cfg.Domain = strings.ToLower(strings.TrimSpace(cfg.Domain))
	if !validDomain(cfg.Domain) {
		return nil, fmt.Errorf("KITP_SMTP_DOMAIN %q: set it to the domain route addresses use (e.g. in.example.com)", cfg.Domain)
	}
	if cfg.Hostname == "" {
		cfg.Hostname = cfg.Domain
	}
	if cfg.MaxBytes <= 0 {
		cfg.MaxBytes = DefaultSMTPMaxBytes
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	allow, err := normCIDRs(cfg.Allow)
	if err != nil {
		return nil, fmt.Errorf("KITP_SMTP_ALLOW: %w", err)
	}
	cfg.Allow = allow
	s := &SMTPServer{
		cfg:     cfg,
		sources: netx.NewLimiter(limits.PerSourcePerMinute, limits.PerSourceBurst, 100_000),
		msgs:    netx.NewLimiter(limits.MessagesPerMinute, limits.MessagesPerMinute, 100_000),
		routes:  netx.NewLimiter(limits.PerRoutePerMinute, limits.PerRoutePerMinute, 100_000),
		active:  map[string]int{},
	}
	if (cfg.CertFile == "") != (cfg.KeyFile == "") {
		return nil, errors.New("set both KITP_SMTP_TLS_CERT and KITP_SMTP_TLS_KEY, or neither")
	}
	if cfg.CertFile != "" {
		s.certs = &certReloader{certFile: cfg.CertFile, keyFile: cfg.KeyFile}
		if _, err := s.certs.get(nil); err != nil {
			return nil, fmt.Errorf("KITP_SMTP_TLS_CERT / _KEY: %w", err)
		}
	}
	srv := smtp.NewServer(&backend{s: s})
	srv.Domain = cfg.Hostname
	srv.MaxRecipients = 20
	srv.MaxMessageBytes = cfg.MaxBytes
	srv.ReadTimeout = 2 * time.Minute
	srv.WriteTimeout = 2 * time.Minute
	srv.ErrorLog = slogAdapter{cfg.Logger}
	if s.certs != nil {
		srv.TLSConfig = &tls.Config{GetCertificate: s.certs.get, MinVersion: tls.VersionTLS12}
	}
	s.srv = srv

	if st := cfg.Status; st != nil {
		st.SMTP = SMTPStatus{Enabled: true, Addr: cfg.Addr, Domain: cfg.Domain, Hostname: cfg.Hostname, MaxBytes: cfg.MaxBytes, Allow: cfg.Allow}
		st.certState = s.certState
		st.watch(s.sources)
		st.watch(s.msgs)
	}
	return s, nil
}

// Serve accepts on l (sniffing each connection for a PROXY header) until
// Close.
func (s *SMTPServer) Serve(l net.Listener) error {
	sl := netx.NewSniffListener(l, s.cfg.Trusted)
	sl.Logger = s.cfg.Logger
	sl.OnRefuse = func(a netip.Addr, reason string) { s.cfg.Status.Refuse(comm.TransportSMTP, a, reason) }
	sl.Admit = s.admit
	s.mu.Lock()
	s.ln = sl
	s.mu.Unlock()
	err := s.srv.Serve(sl)
	if errors.Is(err, smtp.ErrServerClosed) || errors.Is(err, net.ErrClosed) {
		return nil
	}
	return err
}

// ListenAndServe listens on cfg.Addr.
func (s *SMTPServer) ListenAndServe() error {
	l, err := net.Listen("tcp", s.cfg.Addr)
	if err != nil {
		return err
	}
	return s.Serve(l)
}

// Shutdown stops the listener and waits for sessions to end.
func (s *SMTPServer) Shutdown(ctx context.Context) error {
	return s.srv.Shutdown(ctx)
}

// admit runs on each connection with its real address: the install
// allowlist, then per-source connection limits.
func (s *SMTPServer) admit(client netip.Addr) (string, func()) {
	if len(s.cfg.Allow) > 0 && !netx.InPrefixes(client, s.cfg.Allow) {
		s.cfg.Status.Refuse(comm.TransportSMTP, client, "not on KITP_SMTP_ALLOW")
		return "554 5.7.1 Not accepted from your address", nil
	}
	key := netx.SourceKey(client)
	if !s.sources.Allow(key, 1) {
		s.cfg.Status.Refuse(comm.TransportSMTP, client, "rate limited")
		return "421 4.7.0 Too many connections, try again later", nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active[key] >= limits.ConnectionsPerSource || s.total >= limits.ConnectionsTotal {
		s.cfg.Status.Refuse(comm.TransportSMTP, client, "too many open connections")
		return "421 4.7.0 Too many connections, try again later", nil
	}
	s.active[key]++
	s.total++
	return "", func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.active[key]--
		s.total--
		if s.active[key] <= 0 {
			delete(s.active, key)
		}
	}
}

type backend struct{ s *SMTPServer }

func (b *backend) NewSession(c *smtp.Conn) (smtp.Session, error) {
	return &session{s: b.s, conn: c, client: netx.AddrOf(c.Conn().RemoteAddr())}, nil
}

type session struct {
	s      *SMTPServer
	conn   *smtp.Conn
	client netip.Addr
	from   string
	routes []route
	// hosts is the peer's forward-confirmed reverse DNS names, looked up
	// once per session when a route asks for sender_hosts.
	hosts    []string
	hostsSet bool
}

func smtpErr(code int, enh smtp.EnhancedCode, msg string) *smtp.SMTPError {
	return &smtp.SMTPError{Code: code, EnhancedCode: enh, Message: msg}
}

func (ss *session) Reset() {
	ss.from = ""
	ss.routes = nil
}

func (ss *session) Logout() error { return nil }

func (ss *session) Mail(from string, _ *smtp.MailOptions) error {
	ss.from = from
	ss.routes = nil
	return nil
}

func (ss *session) miss(reason string) {
	ss.s.sources.Charge(netx.SourceKey(ss.client), float64(limits.MissCost))
	ss.s.cfg.Status.Refuse(comm.TransportSMTP, ss.client, reason)
}

func (ss *session) Rcpt(to string, _ *smtp.RcptOptions) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	at := strings.LastIndexByte(to, '@')
	if at <= 0 || !strings.EqualFold(to[at+1:], ss.s.cfg.Domain) {
		ss.miss("recipient outside " + ss.s.cfg.Domain)
		return smtpErr(550, smtp.EnhancedCode{5, 1, 1}, "No such address here (this server does not relay)")
	}
	rt, ok, err := lookupRoute(ctx, ss.s.cfg.Pool, strings.ToLower(to[:at]), PurposeSMTP)
	if err != nil {
		ss.s.cfg.Logger.Error("smtp: route lookup", "err", err)
		return smtpErr(451, smtp.EnhancedCode{4, 3, 0}, "Temporary failure, try again later")
	}
	if !ok {
		ss.miss("unknown address")
		return smtpErr(550, smtp.EnhancedCode{5, 1, 1}, "No such address here")
	}
	for _, have := range ss.routes {
		if have.ID == rt.ID {
			return nil
		}
	}
	refuse := func(code int, enh smtp.EnhancedCode, check, reason, msg string) error {
		ss.s.sources.Charge(netx.SourceKey(ss.client), float64(limits.MissCost))
		if err := rt.refuse(ctx, ss.s.cfg.Pool, comm.TransportSMTP, check, reason, ss.client); err != nil {
			ss.s.cfg.Logger.Warn("smtp: log refusal", "route_id", rt.ID, "err", err)
		}
		return smtpErr(code, enh, msg)
	}
	p := rt.Policy
	if len(p.Sources) > 0 && !netx.InPrefixes(ss.client, p.Sources) {
		return refuse(550, smtp.EnhancedCode{5, 7, 1}, "sources", ss.client.String()+" is not an allowed source", "Not accepted from your address")
	}
	if p.RequireTLS {
		if _, isTLS := ss.conn.TLSConnectionState(); !isTLS {
			return refuse(530, smtp.EnhancedCode{5, 7, 0}, "require_tls", "the sender didn't use STARTTLS", "Must issue a STARTTLS command first")
		}
	}
	if len(p.SenderHosts) > 0 {
		hosts := ss.senderHosts(ctx)
		allowed := false
		for _, h := range hosts {
			if HostAllowed(p.SenderHosts, h) {
				allowed = true
				break
			}
		}
		if !allowed {
			names := "no forward-confirmed name"
			if len(hosts) > 0 {
				names = strings.Join(hosts, ", ")
			}
			return refuse(550, smtp.EnhancedCode{5, 7, 1}, "sender_hosts", ss.client.String()+" ("+names+") is not an allowed sender host", "Not accepted from your host")
		}
	}
	if len(p.EnvelopeFrom) > 0 && !AddressAllowed(p.EnvelopeFrom, ss.from) {
		return refuse(550, smtp.EnhancedCode{5, 7, 1}, "envelope_from", "MAIL FROM "+quoteOrNone(ss.from)+" is not on the allow list", "Sender not accepted")
	}
	status, _, err := comm.ReadChannelStatus(ctx, ss.s.cfg.Pool.P, rt.ChannelID)
	if err != nil {
		ss.s.cfg.Logger.Error("smtp: channel status", "route_id", rt.ID, "err", err)
		return smtpErr(451, smtp.EnhancedCode{4, 3, 0}, "Temporary failure, try again later")
	}
	if status != comm.ChannelStatusEnabled {
		return smtpErr(451, smtp.EnhancedCode{4, 7, 0}, "Mail account paused, try again later")
	}
	if !ss.s.routes.Allow(strconv.FormatInt(rt.ID, 10), 1) {
		return smtpErr(450, smtp.EnhancedCode{4, 7, 0}, "Too many messages for this address, try again later")
	}
	ss.routes = append(ss.routes, rt)
	return nil
}

func (ss *session) Data(r io.Reader) error {
	raw, err := io.ReadAll(r)
	if err != nil {
		if errors.Is(err, smtp.ErrDataTooLarge) {
			return smtp.ErrDataTooLarge
		}
		return smtpErr(451, smtp.EnhancedCode{4, 3, 0}, "Could not read the message, try again later")
	}
	if !ss.s.msgs.Allow(netx.SourceKey(ss.client), 1) {
		ss.s.cfg.Status.Refuse(comm.TransportSMTP, ss.client, "rate limited (messages)")
		return smtpErr(450, smtp.EnhancedCode{4, 7, 0}, "Too many messages, try again later")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	filed, transient := 0, false
	var refusedMsg string
	for _, rt := range ss.routes {
		check, why, after := checkMessage(rt.Policy, raw)
		if check != "" {
			if err := rt.refuse(ctx, ss.s.cfg.Pool, comm.TransportSMTP, check, why, ss.client); err != nil {
				ss.s.cfg.Logger.Warn("smtp: log refusal", "route_id", rt.ID, "err", err)
			}
			refusedMsg = check + ": " + why
			continue
		}
		f, err := ss.s.cfg.Intake.FileRaw(ctx, rt.ChannelID, comm.TransportSMTP, rt.ID, raw)
		switch {
		case errors.Is(err, comm.ErrUnparseable):
			filed++ // logged as parse_error; retrying won't help
		case err != nil:
			ss.s.cfg.Logger.Error("smtp: file", "route_id", rt.ID, "err", err)
			if nerr := rt.noteError(ctx, ss.s.cfg.Pool, "filing failed; the sender will retry"); nerr != nil {
				ss.s.cfg.Logger.Warn("smtp: note error", "route_id", rt.ID, "err", nerr)
			}
			transient = true
			continue
		default:
			filed++
			for _, row := range after {
				row.detail["card_id"] = f.CardID
				if err := rt.logEvent(ctx, ss.s.cfg.Pool, comm.TransportSMTP, row.kind, row.detail); err != nil {
					ss.s.cfg.Logger.Warn("smtp: log", "route_id", rt.ID, "kind", row.kind, "err", err)
				}
			}
		}
		if err := rt.touch(ctx, ss.s.cfg.Pool, ss.client); err != nil {
			ss.s.cfg.Logger.Warn("smtp: touch route", "route_id", rt.ID, "err", err)
		}
	}
	switch {
	case transient:
		// The sender retries every recipient; dedupe makes the copies
		// already filed harmless.
		return smtpErr(451, smtp.EnhancedCode{4, 3, 0}, "Temporary failure, try again later")
	case filed == 0 && refusedMsg != "":
		return smtpErr(550, smtp.EnhancedCode{5, 7, 1}, "Message not accepted: "+refusedMsg)
	}
	return nil
}

// senderHosts returns the peer's reverse DNS names that resolve back to it.
func (ss *session) senderHosts(ctx context.Context) []string {
	if ss.hostsSet {
		return ss.hosts
	}
	ss.hostsSet = true
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	names, err := lookupAddr(ctx, ss.client.String())
	if err != nil {
		return nil
	}
	for _, n := range names {
		ips, err := lookupHost(ctx, n)
		if err != nil {
			continue
		}
		for _, ip := range ips {
			if a, err := netip.ParseAddr(ip); err == nil && a.Unmap() == ss.client {
				ss.hosts = append(ss.hosts, strings.ToLower(strings.TrimSuffix(n, ".")))
				break
			}
		}
	}
	return ss.hosts
}

// DNS lookups for sender_hosts; tests swap them.
var (
	lookupAddr = net.DefaultResolver.LookupAddr
	lookupHost = net.DefaultResolver.LookupHost
)

// certReloader serves the STARTTLS certificate, re-reading the files when
// they change (cert-manager renews them in place) and keeping the last good
// one if a read fails.
type certReloader struct {
	certFile, keyFile string
	mu                sync.Mutex
	cert              *tls.Certificate
	mod               time.Time
	err               error
}

func (c *certReloader) get(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	ci, err1 := os.Stat(c.certFile)
	ki, err2 := os.Stat(c.keyFile)
	if err1 == nil && err2 == nil {
		mod := ci.ModTime()
		if ki.ModTime().After(mod) {
			mod = ki.ModTime()
		}
		if c.cert == nil || mod.After(c.mod) {
			cert, err := tls.LoadX509KeyPair(c.certFile, c.keyFile)
			if err == nil {
				c.cert, c.mod, c.err = &cert, mod, nil
			} else {
				c.err = err
			}
		}
	} else {
		c.err = errors.Join(err1, err2)
	}
	if c.cert == nil {
		return nil, c.err
	}
	return c.cert, nil
}

func (s *SMTPServer) certState() CertStatus {
	if s.certs == nil {
		return CertStatus{}
	}
	st := CertStatus{Configured: true}
	cert, err := s.certs.get(nil)
	if err != nil {
		st.Error = err.Error()
		return st
	}
	s.certs.mu.Lock()
	if s.certs.err != nil {
		st.Error = s.certs.err.Error()
	}
	s.certs.mu.Unlock()
	if len(cert.Certificate) > 0 {
		if x, err := x509.ParseCertificate(cert.Certificate[0]); err == nil {
			names := x.DNSNames
			if len(names) == 0 && x.Subject.CommonName != "" {
				names = []string{x.Subject.CommonName}
			}
			st.Subject = strings.Join(names, ", ")
			st.NotAfter = x.NotAfter.UTC().Format(time.RFC3339)
		}
	}
	return st
}

// slogAdapter sends go-smtp's error log to slog.
type slogAdapter struct{ l *slog.Logger }

func (a slogAdapter) Printf(format string, v ...any) { a.l.Warn("smtp: " + fmt.Sprintf(format, v...)) }
func (a slogAdapter) Println(v ...any)               { a.l.Warn("smtp: " + fmt.Sprint(v...)) }
