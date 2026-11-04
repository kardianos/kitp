package netx

import (
	"encoding/binary"
	"net"
	"net/http"
	"net/netip"
	"testing"
	"time"
)

func TestParseTrusted(t *testing.T) {
	def, err := ParseTrusted("")
	if err != nil || def.Configured() {
		t.Fatalf("default: %v %v", def, err)
	}
	for _, a := range []string{"10.1.2.3", "192.168.0.9", "127.0.0.1", "::1", "fd00::5"} {
		if !def.Contains(netip.MustParseAddr(a)) {
			t.Errorf("default should trust %s", a)
		}
	}
	// Carrier-grade NAT / Tailscale: clients connect from there, so it is
	// trusted only when named (review 2026-11-03 round 4).
	for _, a := range []string{"8.8.8.8", "100.64.1.1"} {
		if def.Contains(netip.MustParseAddr(a)) {
			t.Errorf("default trusts %s", a)
		}
	}
	if cgn, err := ParseTrusted("100.64.0.0/10"); err != nil || !cgn.Contains(netip.MustParseAddr("100.100.1.1")) {
		t.Errorf("100.64.0.0/10 named: %v", err)
	}
	narrow, err := ParseTrusted("10.42.0.0/16, 127.0.0.1")
	if err != nil || !narrow.Configured() {
		t.Fatalf("narrow: %v", err)
	}
	if !narrow.Contains(netip.MustParseAddr("10.42.9.9")) || narrow.Contains(netip.MustParseAddr("10.43.0.1")) || narrow.Contains(netip.MustParseAddr("192.168.1.1")) {
		t.Errorf("narrow set = %v", narrow.Ranges())
	}
	for _, bad := range []string{"8.8.8.0/24", "0.0.0.0/0", "10.0.0.0/7", "not-an-ip"} {
		if _, err := ParseTrusted(bad); err == nil {
			t.Errorf("ParseTrusted(%q) accepted; only private ranges may be trusted", bad)
		}
	}
}

func TestClientIP(t *testing.T) {
	trusted, _ := ParseTrusted("")
	req := func(peer string, xff ...string) *http.Request {
		r, _ := http.NewRequest("POST", "/", nil)
		r.RemoteAddr = peer
		for _, x := range xff {
			r.Header.Add("X-Forwarded-For", x)
		}
		return r
	}
	for _, c := range []struct {
		name string
		r    *http.Request
		want string
	}{
		{"direct", req("203.0.113.7:4000"), "203.0.113.7"},
		{"direct, a forged header", req("203.0.113.7:4000", "1.2.3.4"), "203.0.113.7"},
		{"behind a proxy", req("10.0.0.5:4000", "198.51.100.9"), "198.51.100.9"},
		{"a forged hop before the real one", req("10.0.0.5:4000", "1.2.3.4, 198.51.100.9"), "198.51.100.9"},
		{"two proxies", req("10.0.0.5:4000", "198.51.100.9, 10.0.0.9"), "198.51.100.9"},
		{"proxy, no header", req("10.0.0.5:4000"), "10.0.0.5"},
		// Hops with a port (review 2026-11-03 round 4).
		{"a hop with a port", req("10.0.0.5:4000", "198.51.100.9:52311"), "198.51.100.9"},
		{"an IPv6 hop with a port", req("10.0.0.5:4000", "[2001:db8::9]:443"), "2001:db8::9"},
		{"a bracketed IPv6 hop", req("10.0.0.5:4000", "[2001:db8::9]"), "2001:db8::9"},
		{"an unreadable hop", req("10.0.0.5:4000", "unknown"), "10.0.0.5"},
		{"a CGNAT peer, untrusted by default", req("100.64.0.5:4000", "1.2.3.4"), "100.64.0.5"},
	} {
		if got := ClientIP(c.r, trusted).String(); got != c.want {
			t.Errorf("%s: %s, want %s", c.name, got, c.want)
		}
	}
}

func TestSourceKey(t *testing.T) {
	if SourceKey(netip.MustParseAddr("2001:db8:1:2:aaaa::1")) != SourceKey(netip.MustParseAddr("2001:db8:1:2:bbbb::9")) {
		t.Error("one IPv6 /64 should be one source")
	}
	if SourceKey(netip.MustParseAddr("192.0.2.1")) == SourceKey(netip.MustParseAddr("192.0.2.2")) {
		t.Error("IPv4 addresses are separate sources")
	}
}

func TestLimiter(t *testing.T) {
	l := NewLimiter(60, 3, 2)
	now := time.Unix(1000, 0)
	l.now = func() time.Time { return now }
	for i := 0; i < 3; i++ {
		if !l.Allow("a", 1) {
			t.Fatalf("burst request %d refused", i)
		}
	}
	if l.Allow("a", 1) {
		t.Fatal("past the burst")
	}
	if got := l.Throttled(); len(got) != 1 || got[0] != "a" {
		t.Errorf("Throttled = %v", got)
	}
	now = now.Add(time.Second) // 60/min = 1 a second
	if !l.Allow("a", 1) {
		t.Error("a second later one token is back")
	}
	l.Charge("b", 10) // a miss sends b negative
	if l.Allow("b", 1) {
		t.Error("a source that missed is throttled")
	}
	l.Allow("c", 1) // a third key evicts the least recently used (a)
	if _, ok := l.keys["a"]; ok {
		t.Error("least recently used key kept past maxKeys")
	}
}

// sniffPair connects to a loopback listener, writes pre to it and returns
// what Sniff made of the server side.
func sniffPair(t *testing.T, trusted *Trusted, pre []byte) (net.Conn, string, error) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	client, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.Close() })
	server, err := ln.Accept()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { server.Close() })
	if len(pre) > 0 {
		if _, err := client.Write(pre); err != nil {
			t.Fatal(err)
		}
	}
	return Sniff(server, trusted, 100*time.Millisecond, time.Second)
}

func TestSniff(t *testing.T) {
	loopback, _ := ParseTrusted("")
	elsewhere, _ := ParseTrusted("10.0.0.0/8")
	v2 := append([]byte{}, v2Sig...)
	v2 = append(v2, 0x21, 0x11, 0, 12, 198, 51, 100, 23, 10, 0, 0, 1)
	v2 = binary.BigEndian.AppendUint16(v2, 40000)
	v2 = binary.BigEndian.AppendUint16(v2, 25)

	c, reason, err := sniffPair(t, loopback, nil)
	if err != nil || AddrOf(c.RemoteAddr()).String() != "127.0.0.1" {
		t.Errorf("a direct client: %v %q %v", c, reason, err)
	}
	c, _, err = sniffPair(t, loopback, []byte("PROXY TCP4 203.0.113.50 10.0.0.1 51000 25\r\n"))
	if err != nil || AddrOf(c.RemoteAddr()).String() != "203.0.113.50" {
		t.Errorf("v1 from a trusted proxy: %v %v", c, err)
	}
	c, _, err = sniffPair(t, loopback, v2)
	if err != nil || AddrOf(c.RemoteAddr()).String() != "198.51.100.23" {
		t.Errorf("v2 from a trusted proxy: %v %v", c, err)
	}
	if _, reason, err = sniffPair(t, elsewhere, []byte("PROXY TCP4 203.0.113.50 10.0.0.1 51000 25\r\n")); err == nil || reason != RefuseUntrustedProxy {
		t.Errorf("v1 from an untrusted peer: %q %v", reason, err)
	}
	if _, reason, err = sniffPair(t, loopback, []byte("EHLO spam.example\r\n")); err == nil || reason != RefuseEarlyTalker {
		t.Errorf("an early talker: %q %v", reason, err)
	}
	if _, reason, err = sniffPair(t, loopback, []byte("PROXY TCP4 203.0.113.50 10.0.0.1 51000 25\r\nEHLO x\r\n")); err == nil || reason != RefuseEarlyTalker {
		t.Errorf("talking right after the header: %q %v", reason, err)
	}
}
