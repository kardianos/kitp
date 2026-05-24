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
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

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

// runStartCallback exercises handleStart (which writes the oidc_state row
// carrying the validated redirect) then reads the stored redirect back and
// runs handleCallback with the issued state. Returns the post-login
// Location header and the redirect value persisted in the state row.
func runStartCallback(t *testing.T, startRedirect string) (location, storedRedirect string) {
	t.Helper()
	op := newCallbackFakeOP(t)
	pool := store.TestPool(t, "kitp_test_oidc_cb")

	v := NewValidator(&Config{
		Issuer:      op.issuer,
		Audience:    op.aud,
		RoleClaim:   "groups",
		DefaultRole: "worker",
		ClientID:    "kitp-web",
		RedirectURI: "http://localhost/api/v1/auth/oidc/callback",
		Scopes:      "openid profile email",
	}, pool)

	sessMgr := session.New(pool, session.Config{})
	cfg := BFFConfig{
		Validator:      v,
		Pool:           pool,
		SessionManager: sessMgr,
		InsecureCookie: true,
		StateTTL:       10 * time.Minute,
	}

	ctx := context.Background()

	// --- start ---
	startURL := "/api/v1/auth/oidc/start"
	if startRedirect != "" {
		startURL += "?redirect=" + url.QueryEscape(startRedirect)
	}
	startReq := httptest.NewRequest(http.MethodGet, startURL, nil)
	startRec := httptest.NewRecorder()
	handleStart(startRec, startReq, cfg)
	if startRec.Code != http.StatusFound {
		t.Fatalf("start status = %d, want 302", startRec.Code)
	}

	// Pull the issued state out of the OP authorize redirect.
	loc := startRec.Header().Get("Location")
	u, err := url.Parse(loc)
	if err != nil {
		t.Fatalf("parse start Location: %v", err)
	}
	state := u.Query().Get("state")
	if state == "" {
		t.Fatalf("start emitted no state; Location=%q", loc)
	}

	// Verify the redirect was stored on the state row (before the
	// callback deletes it).
	if err := pool.QueryRow(ctx,
		`SELECT redirect FROM oidc_state WHERE state = $1`, state,
	).Scan(&storedRedirect); err != nil {
		t.Fatalf("read stored redirect: %v", err)
	}

	// --- callback ---
	cbReq := httptest.NewRequest(http.MethodGet,
		"/api/v1/auth/oidc/callback?code=fake-code&state="+url.QueryEscape(state), nil)
	cbRec := httptest.NewRecorder()
	handleCallback(cbRec, cbReq, cfg)
	if cbRec.Code != http.StatusFound {
		t.Fatalf("callback status = %d (body=%q), want 302", cbRec.Code, cbRec.Body.String())
	}
	return cbRec.Header().Get("Location"), storedRedirect
}

func TestCallbackRedirectThreading(t *testing.T) {
	loc, stored := runStartCallback(t, "/x")
	if stored != "/x" {
		t.Errorf("state row redirect = %q, want /x", stored)
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
