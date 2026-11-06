// dialguard.go: SSRF guard for admin-configured comm transports
// (SEC-4 / A9).
//
// SMTP / IMAP host + port are operator configuration stored on the
// comm_channel card. An admin (or an attacker who reaches the channel-
// config surface) can point them at an internal address — the cloud
// metadata endpoint (169.254.169.254), a loopback admin port, or an
// RFC1918 service — and turn the mailer into a request forwarder. We
// can't fully prevent that with a static check (DNS rebinding, IPv6
// tricks), but we make the easy cases fail: every dial target is
// resolved and rejected when it lands on a private / loopback /
// link-local / unspecified address, unless the host is explicitly
// allowlisted.
//
// Enforcement points: guardDialHost is called immediately before the
// SMTP and IMAP dials (dial-time is the authoritative check — it sees
// the resolved IP, defeating a hostname that resolved differently at
// config-write time). The allowlist is read from
// KITP_COMM_HOST_ALLOWLIST (comma-separated host names / literal IPs);
// operators who legitimately run an internal relay add it there.
package comm

import (
	"context"
	"fmt"
	"net"
	"os"
	"strings"
	"syscall"
)

// loadAllowlist parses KITP_COMM_HOST_ALLOWLIST into a lookup set on
// each call. Entries are matched case-insensitively against the dial
// host (and against each resolved IP's string form), so both
// "relay.internal" and "10.0.0.5" work. Re-parsing the (short) env var
// per dial is negligible — dials are rare and bounded by the comm
// worker's interval — and avoids a cached set going stale if the
// operator updates the allowlist without a restart.
func loadAllowlist() map[string]struct{} {
	set := map[string]struct{}{}
	for _, e := range strings.Split(os.Getenv("KITP_COMM_HOST_ALLOWLIST"), ",") {
		if e = strings.TrimSpace(strings.ToLower(e)); e != "" {
			set[e] = struct{}{}
		}
	}
	return set
}

// ipResolver is swappable in tests so the denylist can be exercised
// without real DNS. Production uses net.DefaultResolver.
var ipResolver = func(ctx context.Context, host string) ([]net.IP, error) {
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	ips := make([]net.IP, 0, len(addrs))
	for _, a := range addrs {
		ips = append(ips, a.IP)
	}
	return ips, nil
}

// isBlockedIP reports whether an IP is in a range we refuse to dial:
// loopback, RFC1918 / ULA private, link-local (incl. 169.254.0.0/16 and
// IPv6 fe80::/10), unspecified (0.0.0.0 / ::), or interface-local
// multicast. These cover the cloud metadata endpoint and internal
// services an SSRF would target.
// Beyond those, the shared and special ranges in blockedNets (carrier-grade
// NAT and Tailscale's 100.64/10 with 100.100.100.200, benchmarking
// 198.18/15, "this network" 0/8, reserved 240/4, IETF 192.0.0/24, and
// IPv4-compatible ::/96 such as ::a9fe:a9fe), and a NAT64 address
// (64:ff9b::/96) is judged by the IPv4 address it carries (review
// 2026-11-06 L3).
func isBlockedIP(ip net.IP) bool {
	if nat64.Contains(ip) && ip.To4() == nil {
		return isBlockedIP(net.IP(ip[12:16]).To16())
	}
	if ip.IsLoopback() ||
		ip.IsPrivate() ||
		ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() ||
		ip.IsUnspecified() ||
		ip.IsInterfaceLocalMulticast() {
		return true
	}
	for _, n := range blockedNets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

var (
	blockedNets = mustCIDRs("0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "198.18.0.0/15", "240.0.0.0/4", "::/96")
	nat64       = mustCIDRs("64:ff9b::/96")[0]
)

func mustCIDRs(cidrs ...string) []*net.IPNet {
	out := make([]*net.IPNet, 0, len(cidrs))
	for _, c := range cidrs {
		_, n, err := net.ParseCIDR(c)
		if err != nil {
			panic(fmt.Sprintf("dialguard: %s: %v", c, err)) // a constant above
		}
		out = append(out, n)
	}
	return out
}

// guardedDialer gives d a Control that checks the address the socket
// actually connects to, after resolution: guardDialHost resolves the name
// once and the dial resolves it again, so a name that answers with a
// public address first and an internal one next (DNS rebinding) got
// through (review 2026-11-06 L3). An allowlisted host, or a connected IP on
// the allowlist, passes.
func guardedDialer(host string, d *net.Dialer) *net.Dialer {
	allow := loadAllowlist()
	h := strings.ToLower(strings.TrimSpace(host))
	if _, ok := allow[h]; ok {
		return d
	}
	d.Control = func(_, address string, _ syscall.RawConn) error {
		ipStr, _, err := net.SplitHostPort(address)
		if err != nil {
			return fmt.Errorf("comm: dial address %q: %w", address, err)
		}
		ip := net.ParseIP(ipStr)
		if ip == nil {
			return fmt.Errorf("comm: dial address %q is not an IP", address)
		}
		if _, ok := allow[ip.String()]; ok {
			return nil
		}
		if isBlockedIP(ip) {
			return fmt.Errorf("comm: refusing to dial %q — connects to blocked address %s (SSRF guard; allowlist via KITP_COMM_HOST_ALLOWLIST)", host, ip)
		}
		return nil
	}
	return d
}

// guardDialHost resolves host and returns an error if any resolved
// address is in a blocked range, unless host (or a resolved literal IP)
// is in the operator allowlist. A bare IP literal is checked directly
// (no DNS). Called just before each SMTP / IMAP dial (SEC-4 / A9).
func guardDialHost(ctx context.Context, host string) error {
	h := strings.ToLower(strings.TrimSpace(host))
	if h == "" {
		return fmt.Errorf("comm: empty dial host")
	}
	allow := loadAllowlist()
	if _, ok := allow[h]; ok {
		return nil
	}

	// Literal IP: check directly without DNS.
	if ip := net.ParseIP(h); ip != nil {
		if _, ok := allow[ip.String()]; ok {
			return nil
		}
		if isBlockedIP(ip) {
			return fmt.Errorf("comm: refusing to dial blocked address %s (SSRF guard; allowlist via KITP_COMM_HOST_ALLOWLIST)", h)
		}
		return nil
	}

	ips, err := ipResolver(ctx, h)
	if err != nil {
		return fmt.Errorf("comm: resolve dial host %q: %w", host, err)
	}
	if len(ips) == 0 {
		return fmt.Errorf("comm: dial host %q resolved to no addresses", host)
	}
	for _, ip := range ips {
		if _, ok := allow[ip.String()]; ok {
			continue
		}
		if isBlockedIP(ip) {
			return fmt.Errorf("comm: refusing to dial %q — resolves to blocked address %s (SSRF guard; allowlist via KITP_COMM_HOST_ALLOWLIST)", host, ip)
		}
	}
	return nil
}
