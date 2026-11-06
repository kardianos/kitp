package session

import "testing"

// TestDevLoginHosts (review 2026-11-06 L9): dev-login answers on
// localhost, *.localhost, loopback addresses and the configured hosts —
// not on a name a page rebinds to 127.0.0.1.
func TestDevLoginHosts(t *testing.T) {
	extra := []string{"kitp.example.test"}
	for _, c := range []struct {
		host string
		ok   bool
	}{
		{"localhost:18080", true},
		{"LOCALHOST", true},
		{"app.localhost:8080", true},
		{"127.0.0.1:18090", true},
		{"127.1.2.3", true},
		{"[::1]:18080", true},
		{"kitp.example.test:443", true},
		{"attacker.example:18080", false},
		{"localhost.attacker.example", false},
		{"192.168.1.20:18080", false},
		{"", false},
	} {
		if got := devHostOK(c.host, extra); got != c.ok {
			t.Errorf("devHostOK(%q) = %v, want %v", c.host, got, c.ok)
		}
	}
}
