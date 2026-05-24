// File auth/oidc/bff.go: server-side OIDC redirect dance for the BFF
// session model.
//
// Two endpoints are exposed:
//
//   GET /api/v1/auth/oidc/start
//       1. Validate the caller's `redirect` deep link (safeLocalRedirect).
//       2. Generate a PKCE pair + opaque state.
//       3. Stash (state -> verifier, redirect) in the oidc_state table
//          with a 10-minute expiry.
//       4. 302 to the OP's authorization endpoint with PKCE +
//          state + scope.
//
//   GET /api/v1/auth/oidc/callback
//       1. Look up the verifier + redirect by state (delete the row on read).
//       2. POST the code + verifier to the OP's token endpoint.
//       3. Validate the returned id_token via Validator.Resolve
//          (which also upserts the user + applies role mappings).
//       4. Create a kitp session and set the cookie.
//       5. 302 to the validated redirect (default '/').
//
// On failure both endpoints render a minimal server-side HTML error page
// (status 401) with a retry link. They deliberately do NOT bounce to the
// SPA's /login route: with the SPA-document gate enabled that route would
// 302 straight back here and loop. See redirectLogin.

package oidc

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth/session"
)

// BFFConfig wires the redirect handlers.
type BFFConfig struct {
	Validator      *Validator
	Pool           *pgxpool.Pool
	SessionManager *session.Manager
	InsecureCookie bool
	StateTTL       time.Duration // default 10 minutes
}

// Validate returns an error when [cfg] is missing required fields.
// Split out from Mount so main.go can fail fast at startup while
// auth-audit tooling (which doesn't connect to an OP) can mount the
// routes for inventory without standing up a real Validator.
func (cfg *BFFConfig) Validate() error {
	if cfg.Validator == nil {
		return fmt.Errorf("oidc/bff: Validator required")
	}
	if cfg.Pool == nil {
		return fmt.Errorf("oidc/bff: Pool required")
	}
	if cfg.SessionManager == nil {
		return fmt.Errorf("oidc/bff: SessionManager required")
	}
	if cfg.Validator.cfg.ClientID == "" {
		return fmt.Errorf("oidc/bff: OIDC_CLIENT_ID is empty")
	}
	if cfg.Validator.cfg.RedirectURI == "" {
		return fmt.Errorf("oidc/bff: OIDC_REDIRECT_URI is empty")
	}
	return nil
}

// Mount registers the two OIDC redirect endpoints on the apiRouter as
// Public routes (the OIDC dance is the path TO authentication; the
// browser is mid-redirect and has no cookie yet). Mount is pure
// registration — call cfg.Validate() before Mount in production
// startup so missing config trips before the listener opens.
func Mount(rt *api.Router, cfg BFFConfig) {
	if cfg.StateTTL <= 0 {
		cfg.StateTTL = 10 * time.Minute
	}
	// Both handlers always write a response (either a 302 to the OP /
	// back to /login, or a 302 to / after session creation), so they
	// return nil unconditionally — the router's error translator
	// would only kick in for an unexpected panic/bug. We surface
	// failures via redirectLogin instead, matching the existing
	// browser-driven contract.
	rt.Public("GET /api/v1/auth/oidc/start", func(_ context.Context, w http.ResponseWriter, r *http.Request) error {
		handleStart(w, r, cfg)
		return nil
	})
	rt.Public("GET /api/v1/auth/oidc/callback", func(_ context.Context, w http.ResponseWriter, r *http.Request) error {
		handleCallback(w, r, cfg)
		return nil
	})
}

func handleStart(w http.ResponseWriter, r *http.Request, cfg BFFConfig) {
	authURL, err := cfg.Validator.AuthorizationEndpoint(r.Context())
	if err != nil {
		logRedirect(r, "oidc.start: discovery", err)
		redirectLogin(w, r, "could not start sign-in")
		return
	}
	state, err := randomURLString(24)
	if err != nil {
		logRedirect(r, "oidc.start: rng_state", err)
		redirectLogin(w, r, "could not start sign-in")
		return
	}
	verifier, err := randomURLString(48)
	if err != nil {
		logRedirect(r, "oidc.start: rng_verifier", err)
		redirectLogin(w, r, "could not start sign-in")
		return
	}
	challenge := s256Challenge(verifier)

	// Validate the caller-supplied deep link before it ever touches the
	// DB or the eventual post-login redirect. safeLocalRedirect collapses
	// anything that isn't a safe same-origin path down to "/", so an
	// open-redirect can't be smuggled through the state row.
	redirect := safeLocalRedirect(r.URL.Query().Get("redirect"))

	_, err = cfg.Pool.Exec(r.Context(), `
		INSERT INTO oidc_state (state, verifier, redirect, expires_at)
		VALUES ($1, $2, $3, now() + $4 * INTERVAL '1 second')
	`, state, verifier, redirect, int(cfg.StateTTL.Seconds()))
	if err != nil {
		logRedirect(r, "oidc.start: state_insert", err)
		redirectLogin(w, r, "could not start sign-in")
		return
	}

	q := url.Values{}
	q.Set("response_type", "code")
	q.Set("client_id", cfg.Validator.cfg.ClientID)
	q.Set("redirect_uri", cfg.Validator.cfg.RedirectURI)
	q.Set("scope", cfg.Validator.cfg.Scopes)
	q.Set("state", state)
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	dest := authURL + "?" + q.Encode()
	http.Redirect(w, r, dest, http.StatusFound)
}

func handleCallback(w http.ResponseWriter, r *http.Request, cfg BFFConfig) {
	q := r.URL.Query()
	if e := q.Get("error"); e != "" {
		desc := q.Get("error_description")
		msg := e
		if desc != "" {
			msg = e + ": " + desc
		}
		redirectLogin(w, r, msg)
		return
	}
	code := q.Get("code")
	state := q.Get("state")
	if code == "" || state == "" {
		redirectLogin(w, r, "missing code or state")
		return
	}

	var verifier, redirect string
	row := cfg.Pool.QueryRow(r.Context(), `
		DELETE FROM oidc_state WHERE state = $1 AND expires_at > now()
		RETURNING verifier, redirect
	`, state)
	if err := row.Scan(&verifier, &redirect); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			redirectLogin(w, r, "state expired")
			return
		}
		logRedirect(r, "oidc.callback: state_lookup", err)
		redirectLogin(w, r, "could not complete sign-in")
		return
	}

	tokenURL, err := cfg.Validator.TokenEndpoint(r.Context())
	if err != nil {
		logRedirect(r, "oidc.callback: discovery", err)
		redirectLogin(w, r, "could not complete sign-in")
		return
	}
	idToken, err := exchangeCode(r.Context(), tokenURL, exchangeParams{
		ClientID:     cfg.Validator.cfg.ClientID,
		ClientSecret: cfg.Validator.cfg.ClientSecret,
		RedirectURI:  cfg.Validator.cfg.RedirectURI,
		Code:         code,
		Verifier:     verifier,
	})
	if err != nil {
		logRedirect(r, "oidc.callback: token_exchange", err)
		redirectLogin(w, r, "could not complete sign-in")
		return
	}

	// Reuse Validator.Resolve to verify the id_token + upsert user.
	userID, _, err := cfg.Validator.Resolve(r.Context(), idToken)
	if err != nil {
		logRedirect(r, "oidc.callback: token_validate", err)
		redirectLogin(w, r, "could not complete sign-in")
		return
	}

	sub, _ := peekSub(idToken)
	sid, err := cfg.SessionManager.Create(r.Context(), userID, sub)
	if err != nil {
		logRedirect(r, "oidc.callback: session_create", err)
		redirectLogin(w, r, "could not complete sign-in")
		return
	}
	session.Set(w, sid, session.CookieOptions{
		MaxAge:         cfg.SessionManager.Config().AbsoluteCap,
		InsecureCookie: cfg.InsecureCookie,
	})
	// Re-validate the stored redirect defensively before sending the
	// browser there: the column is only ever written through
	// safeLocalRedirect in handleStart, but re-running the guard here
	// means a future write path can't open a redirect hole, and an empty
	// column falls back to "/".
	http.Redirect(w, r, safeLocalRedirect(redirect), http.StatusFound)
}

// safeLocalRedirect returns raw only when it is a safe, same-origin
// local path; otherwise it returns "/". This is the open-redirect guard
// for the post-login destination. A path is accepted only when ALL hold:
//
//   - it starts with a single "/" (so it's rooted, not relative);
//   - it does NOT start with "//" or "/\" (scheme-relative // and the
//     backslash variant browsers normalise to // both escape the origin);
//   - it contains no CR or LF (header/redirect splitting);
//   - it parses via net/url to a URL with an empty Scheme AND empty Host
//     (rejects "https://evil", "javascript:...", and userinfo/host tricks
//     that survive the prefix checks).
//
// Anything else — including the empty string — collapses to "/".
func safeLocalRedirect(raw string) string {
	if raw == "" {
		return "/"
	}
	if raw[0] != '/' {
		return "/"
	}
	// "//evil.com" is scheme-relative; "/\evil.com" is the backslash
	// form browsers fold to "//". Reject both before url.Parse, which
	// would otherwise read "//evil.com" as host=evil.com.
	if strings.HasPrefix(raw, "//") || strings.HasPrefix(raw, "/\\") {
		return "/"
	}
	if strings.ContainsAny(raw, "\r\n") {
		return "/"
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "/"
	}
	if u.Scheme != "" || u.Host != "" {
		return "/"
	}
	return raw
}

type exchangeParams struct {
	ClientID     string
	ClientSecret string
	RedirectURI  string
	Code         string
	Verifier     string
}

// exchangeCode POSTs the standard authorization_code grant to the OP
// and returns the id_token (or error). We only need the id_token —
// the access_token / refresh_token are deliberately discarded since
// the BFF model never hands them to the client and we don't need
// them for downstream calls (Resolve hits the OP's JWKS directly).
func exchangeCode(ctx context.Context, tokenURL string, p exchangeParams) (string, error) {
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("client_id", p.ClientID)
	form.Set("code", p.Code)
	form.Set("redirect_uri", p.RedirectURI)
	form.Set("code_verifier", p.Verifier)
	if p.ClientSecret != "" {
		form.Set("client_secret", p.ClientSecret)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return "", fmt.Errorf("token endpoint %d: %s", resp.StatusCode, string(body))
	}
	var out struct {
		IDToken string `json:"id_token"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", fmt.Errorf("token endpoint json: %w", err)
	}
	if out.IDToken == "" {
		return "", fmt.Errorf("token endpoint omitted id_token")
	}
	return out.IDToken, nil
}

// peekSub decodes the JWT payload without verifying signature, just to
// pull `sub` for the session row's oidc_sub column. We've already
// verified the same token via Validator.Resolve at the call site, so
// this is purely informational extraction.
func peekSub(idToken string) (string, error) {
	parts := strings.Split(idToken, ".")
	if len(parts) < 2 {
		return "", fmt.Errorf("malformed jwt")
	}
	body, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		// Some OPs include padding; tolerate via StdEncoding too.
		body, err = base64.StdEncoding.DecodeString(parts[1])
		if err != nil {
			return "", err
		}
	}
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		return "", err
	}
	s, _ := m["sub"].(string)
	return s, nil
}

// redirectLogin renders a minimal, self-contained server-side error page
// (no SPA, no external assets) when the OIDC dance fails. It MUST NOT
// bounce to the SPA's /login route: with the SPA-document gate enabled
// that route 302s straight back to the SSO start endpoint, so a failed
// sign-in would loop forever. Instead we show the reason and a single
// "Try sign-in again" link back to the start endpoint.
//
// Status is 401 (the visitor is unauthenticated and the attempt failed).
// reason is HTML-escaped — it can carry OP-supplied error text, so it
// must never be interpolated raw.
func redirectLogin(w http.ResponseWriter, _ *http.Request, reason string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusUnauthorized)
	const tmpl = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Sign-in failed</title></head>
<body>
<h1>Sign-in failed</h1>
<p>%s</p>
<p><a href="/api/v1/auth/oidc/start">Try sign-in again</a></p>
</body>
</html>
`
	fmt.Fprintf(w, tmpl, html.EscapeString(reason))
}

// logRedirect records the verbose underlying error to slog while the
// caller emits a generic message to the redirect query string. Keeps
// schema names, constraint names, and other DB-derived info off the
// wire to unauthenticated visitors (S7).
func logRedirect(r *http.Request, where string, err error) {
	slog.Default().LogAttrs(r.Context(), slog.LevelError, "oidc redirect",
		slog.String("where", where),
		slog.String("err", err.Error()))
}

// randomURLString returns a base64url-encoded random string of the
// requested raw-byte length (without padding).
func randomURLString(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func s256Challenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}
