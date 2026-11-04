package mailin

import (
	"context"
	"net/netip"
	"reflect"
	"sync"
	"time"

	"github.com/kitp/kitp/server/internal/netx"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// Status is what the Mail intake page shows. It lives in memory only:
// connection-level refusals have no project (so they can't go in the Comm
// log) and rate limits are never stored, so both reset when kitp restarts.
type Status struct {
	mu       sync.Mutex
	refusals []Refusal // ring, newest last
	next     int
	full     bool

	// Set once at startup.
	SMTP      SMTPStatus
	Trusted   *netx.Trusted
	limiters  []*netx.Limiter
	certState func() CertStatus
}

// Refusal is one connection or request kitp turned away before it could be
// tied to a mail account.
type Refusal struct {
	At        string `json:"at" mcp:"desc=RFC 3339"`
	Transport string `json:"transport" mcp:"desc=smtp or post"`
	Source    string `json:"source" mcp:"desc=client address"`
	Reason    string `json:"reason" mcp:"desc=why"`
}

// SMTPStatus is the listener's settings (from the environment).
type SMTPStatus struct {
	Enabled  bool     `json:"enabled" mcp:"desc=whether KITP_SMTP_ADDR is set"`
	Addr     string   `json:"addr" mcp:"desc=KITP_SMTP_ADDR"`
	Domain   string   `json:"domain" mcp:"desc=KITP_SMTP_DOMAIN: route addresses are <token>@<domain>"`
	Hostname string   `json:"hostname" mcp:"desc=KITP_SMTP_HOSTNAME: the greeting name"`
	MaxBytes int64    `json:"max_bytes" mcp:"desc=KITP_SMTP_MAX_BYTES"`
	Allow    []string `json:"allow" mcp:"desc=KITP_SMTP_ALLOW: install-wide source allowlist (empty = any)"`
}

// CertStatus describes the STARTTLS certificate.
type CertStatus struct {
	Configured bool   `json:"configured" mcp:"desc=KITP_SMTP_TLS_CERT / _KEY set"`
	Subject    string `json:"subject" mcp:"desc=the certificate's names"`
	NotAfter   string `json:"not_after" mcp:"desc=RFC 3339 expiry"`
	Error      string `json:"error" mcp:"desc=why it couldn't be loaded; empty when fine"`
}

const refusalRing = 200

// NewStatus makes an empty status.
func NewStatus(trusted *netx.Trusted) *Status {
	return &Status{refusals: make([]Refusal, refusalRing), Trusted: trusted}
}

// Refuse records a refusal.
func (s *Status) Refuse(transport string, source netip.Addr, reason string) {
	if s == nil {
		return
	}
	src := ""
	if source.IsValid() {
		src = source.String()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refusals[s.next] = Refusal{At: time.Now().UTC().Format(time.RFC3339), Transport: transport, Source: src, Reason: reason}
	s.next = (s.next + 1) % refusalRing
	if s.next == 0 {
		s.full = true
	}
}

func (s *Status) watch(l *netx.Limiter) {
	if s != nil && l != nil {
		s.mu.Lock()
		s.limiters = append(s.limiters, l)
		s.mu.Unlock()
	}
}

// StatusInput is empty.
type StatusInput struct{}

// StatusOutput is the Mail intake page.
type StatusOutput struct {
	SMTP           SMTPStatus `json:"smtp" mcp:"desc=the SMTP listener's settings"`
	TLS            CertStatus `json:"tls" mcp:"desc=the STARTTLS certificate"`
	TrustedProxies []string   `json:"trusted_proxies" mcp:"desc=proxies whose PROXY header / X-Forwarded-For is believed"`
	TrustedDefault bool       `json:"trusted_default" mcp:"desc=true when KITP_TRUSTED_PROXIES is unset (any private or loopback peer)"`
	Limits         Limits     `json:"limits" mcp:"desc=the rate limits in effect"`
	Throttled      []string   `json:"throttled" mcp:"desc=sources currently rate limited"`
	RecentRefusals []Refusal  `json:"recent_refusals" mcp:"desc=the last connection-level refusals, newest first (memory only)"`
}

// Limits are the in-memory rate limits (constants).
type Limits struct {
	PerSourcePerMinute   int `json:"per_source_per_minute"`
	PerSourceBurst       int `json:"per_source_burst"`
	MessagesPerMinute    int `json:"messages_per_minute"`
	PerRoutePerMinute    int `json:"per_route_per_minute"`
	MissCost             int `json:"miss_cost"`
	MissesPerSession     int `json:"misses_per_session"`
	ConnectionsPerSource int `json:"connections_per_source"`
	ConnectionsTotal     int `json:"connections_total"`
}

// The limits (docs/MAIL_INTAKE_AND_CALENDARS.md §7): generous — they stop
// floods and guessing, not mail.
var limits = Limits{
	PerSourcePerMinute:   120,
	PerSourceBurst:       240,
	MessagesPerMinute:    240,
	PerRoutePerMinute:    600,
	MissCost:             10,
	MissesPerSession:     5,
	ConnectionsPerSource: 64,
	ConnectionsTotal:     1000,
}

// Snapshot is the current status.
func (s *Status) Snapshot() StatusOutput {
	out := StatusOutput{Limits: limits, Throttled: []string{}, RecentRefusals: []Refusal{}}
	if s == nil {
		return out
	}
	out.SMTP = s.SMTP
	if out.SMTP.Allow == nil {
		out.SMTP.Allow = []string{}
	}
	if s.certState != nil {
		out.TLS = s.certState()
	}
	out.TrustedProxies = s.Trusted.Ranges()
	out.TrustedDefault = !s.Trusted.Configured()
	s.mu.Lock()
	ls := append([]*netx.Limiter(nil), s.limiters...)
	n := s.next
	if s.full {
		n = refusalRing
	}
	for i := 0; i < n; i++ {
		j := (s.next - 1 - i + refusalRing) % refusalRing
		out.RecentRefusals = append(out.RecentRefusals, s.refusals[j])
	}
	s.mu.Unlock()
	seen := map[string]bool{}
	for _, l := range ls {
		for _, k := range l.Throttled() {
			if !seen[k] {
				seen[k] = true
				out.Throttled = append(out.Throttled, k)
			}
		}
	}
	return out
}

func registerStatus(s *Status) {
	reg.Register(reg.Handler{
		Endpoint:     "mail_intake",
		Action:       "status",
		Doc:          "Admin: the mail intake listener's state — SMTP settings and certificate, trusted proxies, rate limits, sources currently throttled and the last connection-level refusals (kept in memory; reset on restart).",
		InputType:    reflect.TypeFor[StatusInput](),
		OutputType:   reflect.TypeFor[StatusOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		IsRead:       true,
		// No database: everything here is in memory.
		Run: func(_ context.Context, _ store.Querier, ins []any) ([]any, error) {
			outs := make([]any, len(ins))
			for i := range ins {
				outs[i] = s.Snapshot()
			}
			return outs, nil
		},
	})
}
