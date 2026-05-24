// dialguard_test.go: SEC-4 / A9 — the SMTP/IMAP dial guard must reject
// internal / loopback / link-local targets (the cloud metadata endpoint,
// RFC1918 services) unless explicitly allowlisted.
package comm

import (
	"context"
	"net"
	"strings"
	"testing"
)

func TestGuardDialHost_LiteralIPs(t *testing.T) {
	// Reset the once-loaded allowlist between subtests via the env-driven
	// path; each subtest sets KITP_COMM_HOST_ALLOWLIST as needed and we
	// re-derive by clearing the cached set.
	cases := []struct {
		host    string
		blocked bool
	}{
		{"127.0.0.1", true},        // loopback
		{"169.254.169.254", true},  // cloud metadata (link-local)
		{"10.1.2.3", true},         // RFC1918
		{"192.168.0.5", true},      // RFC1918
		{"172.16.9.9", true},       // RFC1918
		{"0.0.0.0", true},          // unspecified
		{"::1", true},              // IPv6 loopback
		{"fe80::1", true},          // IPv6 link-local
		{"fd00::1", true},          // IPv6 ULA (private)
		{"8.8.8.8", false},         // public
		{"93.184.216.34", false},   // public (example.com)
	}
	for _, tc := range cases {
		resetAllowlist(t, "")
		err := guardDialHost(context.Background(), tc.host)
		if tc.blocked && err == nil {
			t.Errorf("%s: expected blocked, got allowed", tc.host)
		}
		if !tc.blocked && err != nil {
			t.Errorf("%s: expected allowed, got %v", tc.host, err)
		}
	}
}

func TestGuardDialHost_Allowlist(t *testing.T) {
	resetAllowlist(t, "127.0.0.1, relay.internal")
	if err := guardDialHost(context.Background(), "127.0.0.1"); err != nil {
		t.Errorf("allowlisted literal IP should pass: %v", err)
	}
	// A blocked IP NOT on the allowlist still fails.
	resetAllowlist(t, "127.0.0.1")
	if err := guardDialHost(context.Background(), "10.0.0.1"); err == nil {
		t.Error("non-allowlisted RFC1918 should still be blocked")
	}
}

func TestGuardDialHost_ResolvedName(t *testing.T) {
	// Stub DNS so the host resolves to an internal IP without real
	// lookups. The guard must reject based on the resolved address.
	orig := ipResolver
	t.Cleanup(func() { ipResolver = orig })
	ipResolver = func(_ context.Context, host string) ([]net.IP, error) {
		if host == "evil.example.com" {
			return []net.IP{net.ParseIP("169.254.169.254")}, nil
		}
		return []net.IP{net.ParseIP("8.8.8.8")}, nil
	}

	resetAllowlist(t, "")
	if err := guardDialHost(context.Background(), "evil.example.com"); err == nil {
		t.Error("host resolving to metadata endpoint must be blocked")
	} else if !strings.Contains(err.Error(), "169.254.169.254") {
		t.Errorf("error should name the resolved blocked IP: %v", err)
	}
	if err := guardDialHost(context.Background(), "good.example.com"); err != nil {
		t.Errorf("host resolving to a public IP should pass: %v", err)
	}

	// Allowlisting the hostname bypasses the resolved-IP check.
	resetAllowlist(t, "evil.example.com")
	if err := guardDialHost(context.Background(), "evil.example.com"); err != nil {
		t.Errorf("allowlisted hostname should pass even if it resolves internal: %v", err)
	}
}

// resetAllowlist sets KITP_COMM_HOST_ALLOWLIST for the next
// guardDialHost call (loadAllowlist re-parses the env on every call, so
// no cache to invalidate).
func resetAllowlist(t *testing.T, value string) {
	t.Helper()
	t.Setenv("KITP_COMM_HOST_ALLOWLIST", value)
}
