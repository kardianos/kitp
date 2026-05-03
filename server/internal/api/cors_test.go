package api_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
)

// TestCORSPreflight confirms that an OPTIONS request returns 204 with
// the canonical CORS headers, and that the wrapped handler is NOT
// invoked for the preflight.
func TestCORSPreflight(t *testing.T) {
	called := false
	wrapped := api.CORSMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	}))

	req := httptest.NewRequest(http.MethodOptions, "/api/v1/batch", nil)
	req.Header.Set("Origin", "http://localhost:8090")
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "Content-Type")
	rec := httptest.NewRecorder()
	wrapped.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("preflight status: got %d want 204", rec.Code)
	}
	if called {
		t.Errorf("inner handler should not be called on preflight")
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Access-Control-Allow-Origin: got %q want %q", got, "*")
	}
	wantMethods := "POST, OPTIONS"
	if got := rec.Header().Get("Access-Control-Allow-Methods"); got != wantMethods {
		t.Errorf("Access-Control-Allow-Methods: got %q want %q", got, wantMethods)
	}
	gotHeaders := rec.Header().Get("Access-Control-Allow-Headers")
	for _, h := range []string{"Content-Type", "Idempotency-Key", "X-Request-Id"} {
		if !strings.Contains(gotHeaders, h) {
			t.Errorf("Access-Control-Allow-Headers missing %q (got %q)", h, gotHeaders)
		}
	}
}

// TestCORSPostPassesThrough confirms that POST requests reach the inner
// handler and carry the CORS headers in the response.
func TestCORSPostPassesThrough(t *testing.T) {
	called := false
	wrapped := api.CORSMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/batch", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	wrapped.ServeHTTP(rec, req)

	if !called {
		t.Errorf("inner handler should be called for POST")
	}
	if rec.Code != http.StatusOK {
		t.Errorf("POST status: got %d want 200", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Access-Control-Allow-Origin: got %q want %q", got, "*")
	}
	if rec.Body.String() != "ok" {
		t.Errorf("body: got %q want %q", rec.Body.String(), "ok")
	}
}

// TestCORSEnabled walks the CORS env switch matrix.
func TestCORSEnabled(t *testing.T) {
	tests := []struct {
		name    string
		envVar  string
		appEnv  string
		want    bool
	}{
		{"dev default", "", "dev", true},
		{"prod default", "", "production", false},
		{"explicit on prod", "on", "production", true},
		{"explicit off dev", "off", "dev", false},
		{"true prod", "true", "production", true},
		{"1 prod", "1", "production", true},
		{"empty prod", "", "production", false},
		{"unknown defaults off", "maybe", "dev", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("CORS", tc.envVar)
			if got := api.CORSEnabled(tc.appEnv); got != tc.want {
				t.Errorf("CORSEnabled(env=%q, CORS=%q): got %v want %v",
					tc.appEnv, tc.envVar, got, tc.want)
			}
		})
	}
}
