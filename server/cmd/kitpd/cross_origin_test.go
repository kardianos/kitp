package main

import (
	"net/http/httptest"
	"testing"

	"github.com/kitp/kitp/server/internal/auth"
)

// TestCrossOriginCheckFollowsAuthMode (review 2026-11-03 round 4): the
// cross-origin check is off only with AUTH_MODE=off; the dev CORS switch
// (on by default with ENV unset) no longer turns it off.
func TestCrossOriginCheckFollowsAuthMode(t *testing.T) {
	t.Setenv("CORS", "on")
	t.Setenv("KITP_PUBLIC_URL", "")
	t.Setenv("KITP_TRUSTED_ORIGINS", "http://localhost:8090")

	off, err := newCrossOriginProtection("dev", auth.ModeOff)
	if err != nil || off != nil {
		t.Fatalf("AUTH_MODE=off: check %v, err %v; want none", off, err)
	}
	c, err := newCrossOriginProtection("dev", auth.ModeOIDC)
	if err != nil {
		t.Fatal(err)
	}
	if c == nil {
		t.Fatal("CORS on with real logins: no cross-origin check")
	}
	post := func(origin string) error {
		r := httptest.NewRequest("POST", "http://kitp.example.com/api/v1/batch", nil)
		r.Header.Set("Origin", origin)
		r.Header.Set("Sec-Fetch-Site", "cross-site")
		return c.Check(r)
	}
	if err := post("https://evil.example"); err == nil {
		t.Error("a cross-site POST went through")
	}
	if err := post("http://localhost:8090"); err != nil {
		t.Errorf("a trusted origin was refused: %v", err)
	}
}
