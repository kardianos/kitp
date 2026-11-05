package oidc

// Front- and back-channel logout (logout.go).

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/kitp/kitp/server/internal/auth/session"
)

// signedInWithSID signs in through the fake IdP with IdP session sid and
// returns the sign-in and the kitp session cookie value.
func signedInWithSID(t *testing.T, schema, sid string) (*signIn, string) {
	t.Helper()
	si := startSignIn(t, schema, "/")
	si.op.sid = sid
	rec := si.callback(true)
	if rec.Code != http.StatusFound {
		t.Fatalf("callback: %d %s", rec.Code, rec.Body.String())
	}
	for _, c := range rec.Result().Cookies() {
		if c.Name == session.CookieName {
			return si, c.Value
		}
	}
	t.Fatal("no session cookie")
	return nil, ""
}

// live reports whether a kitp session still works.
func live(t *testing.T, si *signIn, cookie string) bool {
	t.Helper()
	_, err := si.cfg.SessionManager.Lookup(context.Background(), cookie)
	return err == nil
}

// logoutToken signs a back-channel logout token as the fake IdP; edit
// changes its claims or header first.
func (op *callbackFakeOP) logoutToken(t *testing.T, edit func(jwt.MapClaims, map[string]any)) string {
	t.Helper()
	claims := jwt.MapClaims{
		"iss": op.issuer, "aud": op.aud, "iat": time.Now().Unix(), "jti": "jti-" + time.Now().Format(time.RFC3339Nano),
		"events": map[string]any{backchannelLogoutEvent: map[string]any{}},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	tok.Header["kid"] = op.kid
	tok.Header["typ"] = "logout+jwt"
	if edit != nil {
		edit(claims, tok.Header)
	}
	signed, err := tok.SignedString(op.priv)
	if err != nil {
		t.Fatal(err)
	}
	return signed
}

func postLogout(si *signIn, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/oidc/backchannel-logout",
		strings.NewReader(url.Values{"logout_token": {token}}.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	handleBackchannelLogout(rec, req, si.cfg, newLogoutGate(backchannelPerAddressPerMinute, backchannelPerAddressBurst, nil))
	return rec
}

// TestBackchannelLogout: a logout token naming the IdP session ends the
// kitp sessions it started and no other; a replay ends nothing; one naming
// only the subject ends all of theirs; a token that isn't a valid logout
// token is refused.
func TestBackchannelLogout(t *testing.T) {
	si, cookie := signedInWithSID(t, "kitp_test_oidc_backchannel", "idp-session-1")
	ctx := context.Background()
	var uid int64
	if err := si.pool.QueryRow(ctx, `SELECT user_id FROM session WHERE oidc_sid = 'idp-session-1'`).Scan(&uid); err != nil {
		t.Fatalf("the session's IdP sid wasn't recorded: %v", err)
	}
	other, err := si.cfg.SessionManager.CreateOIDC(ctx, uid, si.op.sub, "idp-session-2")
	if err != nil {
		t.Fatal(err)
	}

	for _, c := range []struct {
		name string
		edit func(jwt.MapClaims, map[string]any)
	}{
		{"an ID token (nonce)", func(c jwt.MapClaims, _ map[string]any) { c["sid"] = "idp-session-1"; c["nonce"] = "n" }},
		{"no logout event", func(c jwt.MapClaims, _ map[string]any) { c["sid"] = "idp-session-1"; delete(c, "events") }},
		{"another client's", func(c jwt.MapClaims, _ map[string]any) { c["sid"] = "idp-session-1"; c["aud"] = "someone-else" }},
		{"too old", func(c jwt.MapClaims, _ map[string]any) {
			c["sid"] = "idp-session-1"
			c["iat"] = time.Now().Add(-20 * time.Minute).Unix()
		}},
		{"no jti", func(c jwt.MapClaims, _ map[string]any) { c["sid"] = "idp-session-1"; delete(c, "jti") }},
		{"neither sub nor sid", nil},
		{"an access token", func(c jwt.MapClaims, h map[string]any) { c["sid"] = "idp-session-1"; h["typ"] = "at+jwt" }},
	} {
		if rec := postLogout(si, si.op.logoutToken(t, c.edit)); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: %d, want 400", c.name, rec.Code)
		}
	}
	if !live(t, si, cookie) {
		t.Fatal("a refused token ended the session")
	}

	tok := si.op.logoutToken(t, func(c jwt.MapClaims, _ map[string]any) { c["sid"] = "idp-session-1"; c["sub"] = si.op.sub })
	if rec := postLogout(si, tok); rec.Code != http.StatusOK || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("logout: %d %q", rec.Code, rec.Header().Get("Cache-Control"))
	}
	if live(t, si, cookie) || !live(t, si, other) {
		t.Fatalf("after the sid logout: first live=%v, other live=%v; want only the other", live(t, si, cookie), live(t, si, other))
	}
	if rec := postLogout(si, tok); rec.Code != http.StatusOK || !live(t, si, other) {
		t.Errorf("a replay: %d, other live=%v; want 200 and nothing ended", rec.Code, live(t, si, other))
	}
	bySub := si.op.logoutToken(t, func(c jwt.MapClaims, _ map[string]any) { c["sub"] = si.op.sub; c["jti"] = "by-sub" })
	if rec := postLogout(si, bySub); rec.Code != http.StatusOK || live(t, si, other) {
		t.Errorf("a sub-only logout: %d, other live=%v; want every session of the subject ended", rec.Code, live(t, si, other))
	}
}

// TestFrontchannelLogout: the IdP's iframe naming the sid ends the session
// (iss or not), may be framed by the IdP, and a foreign iss is refused.
func TestFrontchannelLogout(t *testing.T) {
	si, cookie := signedInWithSID(t, "kitp_test_oidc_frontchannel", "fc-session")
	gate := newLogoutGate(frontchannelPerAddressPerMinute, frontchannelPerAddressBurst, nil)
	get := func(q url.Values) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/oidc/frontchannel-logout?"+q.Encode(), nil)
		// The browser's cookie, as a cross-site link to this page sends it:
		// it must end nothing (review 2026-11-05 round 6 #6).
		req.AddCookie(&http.Cookie{Name: session.CookieName, Value: cookie})
		handleFrontchannelLogout(rec, req, si.cfg, gate)
		return rec
	}
	if rec := get(url.Values{"sid": {"fc-session"}, "iss": {"https://elsewhere.example"}}); rec.Code != http.StatusBadRequest || !live(t, si, cookie) {
		t.Fatalf("a foreign iss: %d, live=%v; want 400 and the session kept", rec.Code, live(t, si, cookie))
	}
	if rec := get(url.Values{}); rec.Code != http.StatusBadRequest || !live(t, si, cookie) {
		t.Fatalf("no sid, only the cookie: %d, live=%v; want 400 and the session kept", rec.Code, live(t, si, cookie))
	}
	if rec := get(url.Values{"sid": {"another-session"}}); rec.Code != http.StatusOK || !live(t, si, cookie) {
		t.Fatalf("another sid with this cookie: %d, live=%v; want the session kept", rec.Code, live(t, si, cookie))
	}
	rec := get(url.Values{"sid": {"fc-session"}})
	if rec.Code != http.StatusOK || live(t, si, cookie) {
		t.Fatalf("front-channel logout (sid only, as Entra ID may send): %d, live=%v", rec.Code, live(t, si, cookie))
	}
	if csp := rec.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "frame-ancestors "+si.op.issuer) {
		t.Errorf("CSP %q doesn't let the IdP frame the page", csp)
	}
	if !strings.Contains(rec.Header().Get("Cache-Control"), "no-store") {
		t.Errorf("Cache-Control %q", rec.Header().Get("Cache-Control"))
	}
}

// TestLogoutGateIsPerAddress (review 2026-11-05 round 6 #7): one address
// spending its logout budget leaves others theirs.
func TestLogoutGateIsPerAddress(t *testing.T) {
	gate := newLogoutGate(frontchannelPerAddressPerMinute, frontchannelPerAddressBurst, nil)
	from := func(addr string) *http.Request {
		r := httptest.NewRequest(http.MethodGet, "/api/v1/auth/oidc/frontchannel-logout", nil)
		r.RemoteAddr = addr
		return r
	}
	for i := 0; i < frontchannelPerAddressBurst; i++ {
		if !gate.allow(from("198.51.100.7:4000")) {
			t.Fatalf("request %d refused within the burst", i+1)
		}
	}
	if gate.allow(from("198.51.100.7:4001")) {
		t.Error("past the burst: still allowed")
	}
	if !gate.allow(from("203.0.113.9:4000")) {
		t.Error("another address refused")
	}
}
