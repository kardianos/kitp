package session

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/kitp/kitp/server/internal/store"
)

// seedUser inserts a bare user_account and returns its id.
func seedUser(t *testing.T, ctx context.Context, m *Manager, name string) int64 {
	t.Helper()
	var id int64
	if err := m.pool.QueryRow(ctx,
		`INSERT INTO user_account (display_name) VALUES ($1) RETURNING id`, name,
	).Scan(&id); err != nil {
		t.Fatalf("seed user %q: %v", name, err)
	}
	return id
}

// TestRevokeAllForUser confirms the "log out everywhere" half of the unified
// logout: every live session a user holds is revoked in one call, while a
// different user's session is untouched.
func TestRevokeAllForUser(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_revoke_all")
	ctx := context.Background()
	m := New(pool, Config{})

	uid := seedUser(t, ctx, m, "multi-device")
	other := seedUser(t, ctx, m, "bystander")

	// Two sessions for uid (two devices), one for the bystander.
	s1, err := m.Create(ctx, uid, "")
	if err != nil {
		t.Fatalf("create s1: %v", err)
	}
	s2, err := m.Create(ctx, uid, "")
	if err != nil {
		t.Fatalf("create s2: %v", err)
	}
	sOther, err := m.Create(ctx, other, "")
	if err != nil {
		t.Fatalf("create sOther: %v", err)
	}

	if err := m.RevokeAllForUser(ctx, uid); err != nil {
		t.Fatalf("revoke all: %v", err)
	}

	if _, err := m.Lookup(ctx, s1); err == nil {
		t.Error("s1 still valid after RevokeAllForUser")
	}
	if _, err := m.Lookup(ctx, s2); err == nil {
		t.Error("s2 still valid after RevokeAllForUser")
	}
	if _, err := m.Lookup(ctx, sOther); err != nil {
		t.Errorf("bystander session revoked by another user's logout: %v", err)
	}

	// Idempotent: a user with no live sessions is a no-op, and userID 0 is
	// a guarded no-op.
	if err := m.RevokeAllForUser(ctx, uid); err != nil {
		t.Errorf("second revoke-all errored: %v", err)
	}
	if err := m.RevokeAllForUser(ctx, 0); err != nil {
		t.Errorf("revoke-all for userID 0: %v", err)
	}
}

// TestHandleLogoutUnified covers the logout handler: it revokes ALL of the
// caller's sessions and, when an EndSession hook is wired (OIDC mode), returns
// the OP's RP-initiated logout URL for the client to follow.
func TestHandleLogoutUnified(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_logout_unified")
	ctx := context.Background()
	m := New(pool, Config{})
	uid := seedUser(t, ctx, m, "logger-outer")

	// Two live sessions; we log out using one cookie and expect BOTH gone.
	cookieSID, err := m.Create(ctx, uid, "")
	if err != nil {
		t.Fatalf("create cookie session: %v", err)
	}
	otherSID, err := m.Create(ctx, uid, "")
	if err != nil {
		t.Fatalf("create other session: %v", err)
	}

	const endSessionURL = "https://op.example.invalid/logout?client_id=kitp&post_logout_redirect_uri=https%3A%2F%2Fapp%2F"
	cfg := HTTPConfig{
		Manager:        m,
		InsecureCookie: true,
		EndSession: func(context.Context) (string, bool, error) {
			return endSessionURL, true, nil
		},
	}

	req := httptest.NewRequest("POST", "/api/v1/auth/logout", nil)
	req.AddCookie(&http.Cookie{Name: CookieName, Value: cookieSID})
	rec := httptest.NewRecorder()
	if err := handleLogout(ctx, rec, req, cfg); err != nil {
		t.Fatalf("handleLogout: %v", err)
	}

	// Unified: every session for the user is revoked, not just the cookie's.
	if _, err := m.Lookup(ctx, cookieSID); err == nil {
		t.Error("cookie session still valid after logout")
	}
	if _, err := m.Lookup(ctx, otherSID); err == nil {
		t.Error("other-device session survived logout (not unified)")
	}

	// The cookie is cleared (Max-Age=0 / expired) on the response.
	if sc := rec.Result().Header.Get("Set-Cookie"); sc == "" {
		t.Error("no Set-Cookie clearing the session cookie")
	}

	// OIDC SLO: the body carries the OP end-session URL for the client.
	var body struct {
		OK       bool   `json:"ok"`
		Redirect string `json:"redirect"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if !body.OK {
		t.Error("ok=false")
	}
	if body.Redirect != endSessionURL {
		t.Errorf("redirect = %q, want %q", body.Redirect, endSessionURL)
	}
}

// TestHandleLogoutLocalOnly covers the dev-login / no-OIDC path: no EndSession
// hook means no redirect (the client falls back to the app root).
func TestHandleLogoutLocalOnly(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_logout_local")
	ctx := context.Background()
	m := New(pool, Config{})
	uid := seedUser(t, ctx, m, "dev-user")
	sid, err := m.Create(ctx, uid, "")
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	cfg := HTTPConfig{Manager: m, InsecureCookie: true} // EndSession nil
	req := httptest.NewRequest("POST", "/api/v1/auth/logout", nil)
	req.AddCookie(&http.Cookie{Name: CookieName, Value: sid})
	rec := httptest.NewRecorder()
	if err := handleLogout(ctx, rec, req, cfg); err != nil {
		t.Fatalf("handleLogout: %v", err)
	}

	if _, err := m.Lookup(ctx, sid); err == nil {
		t.Error("session still valid after local logout")
	}
	var body struct {
		OK       bool   `json:"ok"`
		Redirect string `json:"redirect"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if !body.OK || body.Redirect != "" {
		t.Errorf("got {ok:%v redirect:%q}, want {ok:true redirect:\"\"}", body.OK, body.Redirect)
	}
}
