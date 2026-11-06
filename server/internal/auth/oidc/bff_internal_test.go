package oidc

// Internal tests (package oidc, not oidc_test) so they can reach the
// unexported safeLocalRedirect / redirectLogin / handleStart /
// handleCallback. The open-redirect guard is security-sensitive, so it
// gets a thorough table test; the start→callback path proves the
// validated redirect threads through the oidc_state row.

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth/session"
	"github.com/kitp/kitp/server/internal/store"
)

func TestSafeLocalRedirect(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"empty falls back to root", "", "/"},
		{"plain local path with query accepted", "/legit/path?x=1", "/legit/path?x=1"},
		{"bare slash accepted", "/", "/"},
		{"deep link accepted", "/project/42/screen/inbox", "/project/42/screen/inbox"},
		{"scheme-relative rejected", "//evil.com", "/"},
		{"scheme-relative with path rejected", "//evil.com/path", "/"},
		{"backslash scheme-relative rejected", "/\\evil.com", "/"},
		{"absolute https rejected", "https://evil", "/"},
		{"absolute https with path rejected", "https://evil.com/x", "/"},
		{"javascript scheme rejected", "javascript:alert(1)", "/"},
		{"relative (no leading slash) rejected", "evil.com", "/"},
		{"relative dotpath rejected", "../escape", "/"},
		{"CR injection rejected", "/x\rSet-Cookie: y", "/"},
		{"LF injection rejected", "/x\nLocation: //evil", "/"},
		{"data uri rejected", "data:text/html,evil", "/"},
		{"protocol with userinfo rejected", "https://user@evil.com", "/"},
		{"dot segment then backslash rejected", "/./\\evil.com", "/"},
		{"backslash later in the path rejected", "/a/..\\evil.com", "/"},
		{"tab between slashes rejected", "/\t/evil.com", "/"},
		{"dot-dot then backslash rejected", "/a/../\\evil.com", "/"},
		{"dot segments that stay local accepted", "/a/./b/../c", "/a/./b/../c"},
		{"encoded backslash stays local", "/%5Cevil.com", "/%5Cevil.com"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := safeLocalRedirect(c.raw); got != c.want {
				t.Errorf("safeLocalRedirect(%q) = %q, want %q", c.raw, got, c.want)
			}
		})
	}
}

func TestRedirectLoginRendersErrorPage(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/oidc/callback", nil)
	// reason carries markup-ish text to prove HTML escaping.
	redirectLogin(rec, req, "state expired <script>")

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/html; charset=utf-8" {
		t.Errorf("content-type = %q", ct)
	}
	body := rec.Body.String()
	// Reason present, but escaped (no raw <script>).
	if !strings.Contains(body, "state expired &lt;script&gt;") {
		t.Errorf("escaped reason missing from body: %q", body)
	}
	if strings.Contains(body, "<script>") {
		t.Errorf("reason was not HTML-escaped: %q", body)
	}
	// Retry link to the start endpoint, and no /login bounce.
	if !strings.Contains(body, `href="/api/v1/auth/oidc/start"`) {
		t.Errorf("retry link missing from body: %q", body)
	}
	if strings.Contains(body, "/login") {
		t.Errorf("error page must not reference the SPA /login route: %q", body)
	}
}

// callbackFakeOP serves discovery (authorization + token endpoints),
// JWKS, and a token endpoint that returns a freshly-signed id_token.
type callbackFakeOP struct {
	server *httptest.Server
	priv   *rsa.PrivateKey
	kid    string
	issuer string
	aud    string
	sub    string
	// nonce, when set, goes in the id_token (a real OP echoes the one the
	// authorize request carried).
	nonce string
	// sid, when set, is the IdP session the id_token names.
	sid string
}

func newCallbackFakeOP(t *testing.T) *callbackFakeOP {
	t.Helper()
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	op := &callbackFakeOP{priv: priv, kid: "cb-key-1", aud: "kitp-web", sub: "cb-user"}
	mux := http.NewServeMux()
	op.server = httptest.NewServer(mux)
	op.issuer = op.server.URL
	t.Cleanup(op.server.Close)

	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"issuer":                 op.issuer,
			"jwks_uri":               op.server.URL + "/jwks",
			"authorization_endpoint": op.server.URL + "/authorize",
			"token_endpoint":         op.server.URL + "/token",
		})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, _ *http.Request) {
		n := base64.RawURLEncoding.EncodeToString(priv.N.Bytes())
		e := base64.RawURLEncoding.EncodeToString(big.NewInt(int64(priv.E)).Bytes())
		_ = json.NewEncoder(w).Encode(map[string]any{
			"keys": []map[string]any{
				{"kid": op.kid, "kty": "RSA", "alg": "RS256", "n": n, "e": e},
			},
		})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, _ *http.Request) {
		claims := jwt.MapClaims{
			"iss":  op.issuer,
			"aud":  op.aud,
			"sub":  op.sub,
			"name": "Callback User",
			"exp":  time.Now().Add(time.Hour).Unix(),
			"nbf":  time.Now().Add(-time.Minute).Unix(),
			"iat":  time.Now().Unix(),
		}
		if op.nonce != "" {
			claims["nonce"] = op.nonce
		}
		if op.sid != "" {
			claims["sid"] = op.sid
		}
		tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
		tok.Header["kid"] = op.kid
		signed, err := tok.SignedString(priv)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"id_token": signed})
	})
	return op
}

// signIn is one started sign-in: the fake OP, the BFF config, the start
// response, and the state / nonce it sent to the OP.
type signIn struct {
	op           *callbackFakeOP
	cfg          BFFConfig
	pool         *pgxpool.Pool
	start        *httptest.ResponseRecorder
	state, nonce string
}

// startSignIn runs handleStart (which seals the validated redirect into the
// state cookie it sets).
func startSignIn(t *testing.T, schema, startRedirect string) *signIn {
	t.Helper()
	op := newCallbackFakeOP(t)
	pool := store.TestPool(t, schema)
	v := NewValidator(&Config{
		Issuer:      op.issuer,
		Audience:    op.aud,
		RoleClaim:   "groups",
		DefaultRole: "worker",
		ClientID:    "kitp-web",
		RedirectURI: "http://localhost/api/v1/auth/oidc/callback",
		Scopes:      "openid profile email",
	}, pool)
	cfg := BFFConfig{
		Validator:      v,
		Pool:           pool,
		SessionManager: session.New(pool, session.Config{}),
		InsecureCookie: true,
		StateTTL:       10 * time.Minute,
	}
	startURL := "/api/v1/auth/oidc/start"
	if startRedirect != "" {
		startURL += "?redirect=" + url.QueryEscape(startRedirect)
	}
	rec := httptest.NewRecorder()
	handleStart(rec, httptest.NewRequest(http.MethodGet, startURL, nil), cfg)
	if rec.Code != http.StatusFound {
		t.Fatalf("start status = %d, want 302", rec.Code)
	}
	loc := rec.Header().Get("Location")
	u, err := url.Parse(loc)
	if err != nil {
		t.Fatalf("parse start Location: %v", err)
	}
	si := &signIn{op: op, cfg: cfg, pool: pool, start: rec,
		state: u.Query().Get("state"), nonce: u.Query().Get("nonce")}
	if si.state == "" || si.nonce == "" {
		t.Fatalf("start sent no state or nonce; Location=%q", loc)
	}
	op.nonce = si.nonce
	return si
}

// callback runs handleCallback for this sign-in; withCookie says whether
// the request carries the cookies start set (the same browser).
func (si *signIn) callback(withCookie bool) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/auth/oidc/callback?code=fake-code&state="+url.QueryEscape(si.state), nil)
	if withCookie {
		for _, c := range si.start.Result().Cookies() {
			req.AddCookie(c)
		}
	}
	rec := httptest.NewRecorder()
	handleCallback(rec, req, si.cfg)
	return rec
}

// runStartCallback signs in end to end and returns the post-login
// Location header and the redirect value sealed in the state cookie.
func runStartCallback(t *testing.T, startRedirect string) (location, storedRedirect string) {
	t.Helper()
	si := startSignIn(t, "kitp_test_oidc_cb", startRedirect)
	st, err := openState(si.cfg, si.state, si.start.Result().Cookies()[0].Value, time.Now())
	if err != nil {
		t.Fatalf("open the state cookie: %v", err)
	}
	storedRedirect = st.Redirect
	rec := si.callback(true)
	if rec.Code != http.StatusFound {
		t.Fatalf("callback status = %d (body=%q), want 302", rec.Code, rec.Body.String())
	}
	return rec.Header().Get("Location"), storedRedirect
}

// TestCallbackNeedsTheStartingBrowser (review B8): a callback URL from a
// sign-in this browser didn't start — an attacker's own, handed to a
// victim to sign them in as the attacker — is refused, and doesn't use up
// the real sign-in.
func TestCallbackNeedsTheStartingBrowser(t *testing.T) {
	si := startSignIn(t, "kitp_test_oidc_csrf", "/")
	cookies := si.start.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteLaxMode || cookies[0].Path != "/api/v1/auth/oidc/callback" {
		t.Fatalf("state cookie = %+v", cookies)
	}
	if rec := si.callback(false); rec.Code != http.StatusUnauthorized {
		t.Fatalf("callback without the start cookie: %d, want 401", rec.Code)
	}
	if rec := si.callback(true); rec.Code != http.StatusFound {
		t.Fatalf("the starting browser, after the refused attempt: %d %q", rec.Code, rec.Body.String())
	}
}

// TestCallbackChecksNonce (review B8): an id_token that wasn't issued for
// this sign-in (another nonce, or none) is refused.
func TestCallbackChecksNonce(t *testing.T) {
	for _, nonce := range []string{"someone-elses", ""} {
		si := startSignIn(t, "kitp_test_oidc_nonce", "/")
		si.op.nonce = nonce
		if rec := si.callback(true); rec.Code != http.StatusUnauthorized {
			t.Errorf("an id_token with nonce %q: %d, want 401", nonce, rec.Code)
		}
	}
}

func TestCallbackRedirectThreading(t *testing.T) {
	loc, stored := runStartCallback(t, "/x")
	if stored != "/x" {
		t.Errorf("sealed redirect = %q, want /x", stored)
	}
	if loc != "/x" {
		t.Errorf("callback Location = %q, want /x", loc)
	}
}

func TestCallbackRedirectNeutralizesMalicious(t *testing.T) {
	// A malicious redirect is neutralized at handleStart already (stored
	// as "/"), and the callback re-validates defensively.
	loc, stored := runStartCallback(t, "//evil.com/phish")
	if stored != "/" {
		t.Errorf("malicious redirect stored as %q, want / (neutralized at start)", stored)
	}
	if loc != "/" {
		t.Errorf("callback Location = %q, want / (neutralized)", loc)
	}
}

func TestCallbackRedirectDefaultsToRoot(t *testing.T) {
	// No redirect supplied → stored "/" (column default via start) →
	// callback lands on "/".
	loc, stored := runStartCallback(t, "")
	if stored != "/" {
		t.Errorf("absent redirect stored as %q, want /", stored)
	}
	if loc != "/" {
		t.Errorf("callback Location = %q, want /", loc)
	}
}

// TestStartWritesNoRowAndTheCookieIsSealed (review 2026-11-06 #3): a start
// writes nothing to the database — so there is no overall budget for
// anyone to spend — and the callback takes only a cookie kitp sealed for
// that state, unexpired.
func TestStartWritesNoRowAndTheCookieIsSealed(t *testing.T) {
	si := startSignIn(t, "kitp_test_oidc_sealed", "/x")
	var rows int
	if err := si.pool.QueryRow(context.Background(), `SELECT count(*) FROM oidc_state`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Errorf("a start wrote %d oidc_state rows", rows)
	}
	c := si.start.Result().Cookies()[0]
	if strings.Contains(c.Value, si.state) || strings.Contains(c.Value, "/x") {
		t.Errorf("the state cookie isn't sealed: %q", c.Value)
	}
	if _, err := openState(si.cfg, si.state, c.Value, time.Now()); err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := openState(si.cfg, "another-state", c.Value, time.Now()); err == nil {
		t.Error("the cookie opened for another sign-in's state")
	}
	raw := []byte(c.Value)
	raw[len(raw)-3] ^= 1
	if _, err := openState(si.cfg, si.state, string(raw), time.Now()); err == nil {
		t.Error("a tampered cookie opened")
	}
	other := si.cfg
	other.StateKey = []byte("another kitpd's key")
	if _, err := openState(other, si.state, c.Value, time.Now()); err == nil {
		t.Error("the cookie opened under another key")
	}
	if _, err := openState(si.cfg, si.state, c.Value, time.Now().Add(11*time.Minute)); !errors.Is(err, errStateExpired) {
		t.Errorf("past its life: %v, want errStateExpired", err)
	}
	if got := safeLocalRedirect("/" + strings.Repeat("a", maxRedirectLen)); got != "/" {
		t.Errorf("an over-long redirect kept: %d bytes", len(got))
	}
}

// TestStartsHaveNoOverallBudget (review 2026-11-06 #3): many addresses
// starting at once don't use up anyone else's start.
func TestStartsHaveNoOverallBudget(t *testing.T) {
	g := newStartGate(nil)
	for i := 0; i < 3000; i++ {
		r := httptest.NewRequest(http.MethodGet, "/api/v1/auth/oidc/start", nil)
		r.RemoteAddr = fmt.Sprintf("[2001:db8:%x::1]:4000", i)
		if !g.allow(r) {
			t.Fatalf("start from address %d refused", i)
		}
	}
	r := httptest.NewRequest(http.MethodGet, "/api/v1/auth/oidc/start", nil)
	r.RemoteAddr = "198.51.100.21:4000"
	if !g.allow(r) {
		t.Error("a new address was refused after many others started")
	}
}
