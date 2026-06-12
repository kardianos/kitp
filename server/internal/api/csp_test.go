package api_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
)

func TestCSP_EnforcedHeader(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	h := api.CSP(api.CSPConfig{UpgradeInsecure: true})(inner)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))

	got := rec.Header().Get("Content-Security-Policy")
	if got == "" {
		t.Fatal("Content-Security-Policy header missing")
	}
	if other := rec.Header().Get("Content-Security-Policy-Report-Only"); other != "" {
		t.Errorf("Report-Only header set in enforced mode: %q", other)
	}

	// Spot-check the directives the SPA architecture pins.
	musts := []string{
		"default-src 'none'",
		"script-src 'self'",
		"style-src 'self'",
		"img-src 'self' blob:",
		"connect-src 'self'",
		"frame-src 'self' blob:",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'self'",
		"frame-ancestors 'none'",
		"upgrade-insecure-requests",
	}
	for _, want := range musts {
		if !strings.Contains(got, want) {
			t.Errorf("CSP missing %q\nfull header: %s", want, got)
		}
	}

	// Without UpgradeInsecure (a dev / plain-HTTP LAN deploy) the upgrade
	// directive must be absent — it would rewrite every asset fetch to
	// https:// and blank the page on a non-loopback HTTP host.
	recDev := httptest.NewRecorder()
	api.CSP(api.CSPConfig{})(inner).ServeHTTP(recDev, httptest.NewRequest("GET", "/", nil))
	if strings.Contains(recDev.Header().Get("Content-Security-Policy"), "upgrade-insecure-requests") {
		t.Error("upgrade-insecure-requests present without UpgradeInsecure")
	}

	// Negative checks: nothing 'unsafe-*' or wildcard should leak in.
	for _, banned := range []string{"'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", "*"} {
		if strings.Contains(got, banned) {
			t.Errorf("CSP unexpectedly contains %q\nfull header: %s", banned, got)
		}
	}
}

func TestCSP_ReportOnlyFlipsHeaderName(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	h := api.CSP(api.CSPConfig{ReportOnly: true, Reporter: "/csp-report"})(inner)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))

	if rec.Header().Get("Content-Security-Policy") != "" {
		t.Error("enforced header set in report-only mode")
	}
	got := rec.Header().Get("Content-Security-Policy-Report-Only")
	if got == "" {
		t.Fatal("Report-Only header missing")
	}
	if !strings.Contains(got, "report-uri /csp-report") {
		t.Errorf("report-uri directive missing from Report-Only header: %s", got)
	}
}
