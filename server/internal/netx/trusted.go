// Package netx holds the network plumbing for mail intake and calendar
// feeds (docs/MAIL_INTAKE_AND_CALENDARS.md §6–7): which proxies to believe
// about a client's address (X-Forwarded-For for HTTP, a PROXY protocol
// header for SMTP), the client address itself, PROXY header sniffing, and
// in-memory rate limits.
package netx

import (
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// privateNets is where a proxy in front of kitp lives in practice — a pod
// network, a Docker network, a LAN, loopback. By default only a peer in
// these is believed about the client's address; KITP_TRUSTED_PROXIES can
// narrow it, never widen it.
var privateNets = []netip.Prefix{
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("::1/128"),
	netip.MustParsePrefix("fc00::/7"),
}

// IsPrivate reports whether an address is in a private or loopback range.
func IsPrivate(a netip.Addr) bool {
	a = a.Unmap()
	for _, p := range privateNets {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// Trusted is the set of peers whose word about the client's address is
// believed.
type Trusted struct {
	nets       []netip.Prefix
	configured bool
}

// ParseTrusted reads KITP_TRUSTED_PROXIES: CIDRs (or bare addresses)
// separated by commas or spaces. Empty means "any private or loopback
// peer". Every entry must lie inside a private range — the setting can
// only narrow the default — so a public entry is an error.
func ParseTrusted(s string) (*Trusted, error) {
	fields := strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ' ' || r == '\t' || r == '\n' })
	if len(fields) == 0 {
		return &Trusted{nets: privateNets}, nil
	}
	t := &Trusted{configured: true}
	for _, f := range fields {
		p, err := netip.ParsePrefix(f)
		if err != nil {
			a, aerr := netip.ParseAddr(f)
			if aerr != nil {
				return nil, fmt.Errorf("KITP_TRUSTED_PROXIES: %q is not a CIDR or an address", f)
			}
			p = netip.PrefixFrom(a.Unmap(), a.Unmap().BitLen())
		}
		p = p.Masked()
		inside := false
		for _, q := range privateNets {
			if q.Bits() <= p.Bits() && q.Contains(p.Addr()) {
				inside = true
				break
			}
		}
		if !inside {
			return nil, fmt.Errorf("KITP_TRUSTED_PROXIES: %s is not a private range; only proxies on a private network can be trusted", p)
		}
		t.nets = append(t.nets, p)
	}
	return t, nil
}

// Contains reports whether a peer is trusted.
func (t *Trusted) Contains(a netip.Addr) bool {
	if t == nil || !a.IsValid() {
		return false
	}
	a = a.Unmap()
	for _, p := range t.nets {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// Configured reports whether KITP_TRUSTED_PROXIES was set (else the
// private-range default is in effect).
func (t *Trusted) Configured() bool { return t != nil && t.configured }

// Ranges lists the trusted ranges, for the Mail intake page.
func (t *Trusted) Ranges() []string {
	if t == nil {
		return nil
	}
	out := make([]string, len(t.nets))
	for i, p := range t.nets {
		out[i] = p.String()
	}
	return out
}

// AddrOf returns the IP of a net.Addr (TCP or UDP), or the zero Addr.
func AddrOf(a net.Addr) netip.Addr {
	if a == nil {
		return netip.Addr{}
	}
	if ap, err := netip.ParseAddrPort(a.String()); err == nil {
		return ap.Addr().Unmap()
	}
	if ip, err := netip.ParseAddr(a.String()); err == nil {
		return ip.Unmap()
	}
	return netip.Addr{}
}

// ClientIP is the address an HTTP request came from: the TCP peer, unless
// the peer is a trusted proxy — then X-Forwarded-For is read from the
// right, skipping trusted hops, and the first untrusted address is the
// client. (A client can put anything in the header; only the hops a
// trusted proxy appended are believed.)
func ClientIP(r *http.Request, t *Trusted) netip.Addr {
	peer := netip.Addr{}
	if ap, err := netip.ParseAddrPort(r.RemoteAddr); err == nil {
		peer = ap.Addr().Unmap()
	} else if ip, err := netip.ParseAddr(r.RemoteAddr); err == nil {
		peer = ip.Unmap()
	}
	if !t.Contains(peer) {
		return peer
	}
	hops := strings.Split(strings.Join(r.Header.Values("X-Forwarded-For"), ","), ",")
	last := peer
	for i := len(hops) - 1; i >= 0; i-- {
		h := strings.TrimSpace(hops[i])
		if h == "" {
			continue
		}
		a, err := netip.ParseAddr(h)
		if err != nil {
			return last
		}
		a = a.Unmap()
		if !t.Contains(a) {
			return a
		}
		last = a
	}
	return last
}

// SourceKey groups an address for rate limits: an IPv4 address on its own,
// an IPv6 address by its /64 (one host can rotate through a whole /64).
func SourceKey(a netip.Addr) string {
	a = a.Unmap()
	if a.Is6() {
		p, err := a.Prefix(64)
		if err == nil {
			return p.String()
		}
	}
	return a.String()
}

// InPrefixes reports whether an address is in any of the CIDRs (already
// validated; a bad entry never matches).
func InPrefixes(a netip.Addr, cidrs []string) bool {
	a = a.Unmap()
	for _, c := range cidrs {
		if p, err := netip.ParsePrefix(c); err == nil && p.Contains(a) {
			return true
		}
	}
	return false
}
