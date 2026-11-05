package oidc

// Front- and back-channel logout: the IdP telling kitp that a sign-in
// ended there, so the kitp sessions it started end too. RP-initiated logout
// (kitp's Sign out also signing out of the IdP) is EndSessionURL.
//
//   - Front-channel (OpenID Connect Front-Channel Logout 1.0): the IdP's
//     sign-out page loads GET /api/v1/auth/oidc/frontchannel-logout in a
//     hidden iframe, with sid (and iss). Browsers partition an iframe's
//     cookies now, so the sid — recorded on the session at sign-in — is
//     what names the session; the cookie, when it does come, ends that one
//     too. Entra ID supports this one (the app registration's Front-channel
//     logout URL) and may leave iss out.
//   - Back-channel (OpenID Connect Back-Channel Logout 1.0): the IdP POSTs
//     a signed logout_token to /api/v1/auth/oidc/backchannel-logout, server
//     to server. Keycloak, Okta and Auth0 support it; Entra ID doesn't.
//
// Neither revokes API tokens: logging out ends sessions. Revoking the login
// in kitp ends both.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/kitp/kitp/server/internal/netx"
)

// backchannelLogoutEvent is the events member a logout token carries.
const backchannelLogoutEvent = "http://schemas.openid.net/event/backchannel-logout"

// logoutTokenMaxAge is how old (by iat) a logout token may be: an IdP sends
// it as the sign-out happens. Its jti is kept a little longer, so a replay
// within the window ends nothing either.
const logoutTokenMaxAge = 10 * time.Minute

// The logout routes take no credential but the token or sid, so each is
// limited per client address, apart: someone sending junk from their
// addresses can't starve the IdP's (review 2026-11-05 round 6 #7). The
// back-channel's from the IdP's servers, which sign many people out at
// once, one request each; the front-channel's from a person's browser, one
// per sign-out.
const (
	backchannelPerAddressPerMinute  = 600
	backchannelPerAddressBurst      = 1200
	frontchannelPerAddressPerMinute = 60
	frontchannelPerAddressBurst     = 120
)

// logoutGate is one logout route's per-address limit.
type logoutGate struct {
	limiter *netx.Limiter
	trusted *netx.Trusted
}

func newLogoutGate(perMinute, burst int, trusted *netx.Trusted) *logoutGate {
	return &logoutGate{limiter: netx.NewLimiter(perMinute, burst, 10000), trusted: trusted}
}

// allow takes one request from the caller's address.
func (g *logoutGate) allow(r *http.Request) bool {
	return g.limiter.Allow(netx.SourceKey(netx.ClientIP(r, g.trusted)), 1)
}

// logoutToken is a verified back-channel logout token's claims kitp uses.
type logoutToken struct {
	sub, sid, jti string
	iat           time.Time
}

// parseLogoutToken verifies a back-channel logout token (Back-Channel
// Logout 1.0 §2.6): signed by the IdP (RSA, its JWKS), from its issuer, to
// this client, at most logoutTokenMaxAge old, with a jti, the logout event,
// a sub or sid, and no nonce (so an ID token can't pass for one).
func (v *Validator) parseLogoutToken(ctx context.Context, raw string) (logoutToken, error) {
	keyFn := func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
			return nil, fmt.Errorf("oidc: unexpected signing alg %v", t.Method.Alg())
		}
		kid, _ := t.Header["kid"].(string)
		return v.lookupKey(ctx, kid)
	}
	aud := v.cfg.ClientID
	if aud == "" {
		aud = v.cfg.Audience
	}
	opts := []jwt.ParserOption{jwt.WithIssuer(v.cfg.Issuer), jwt.WithIssuedAt(), jwt.WithLeeway(time.Minute)}
	if aud != "" {
		opts = append(opts, jwt.WithAudience(aud))
	}
	tok, err := jwt.NewParser(opts...).Parse(raw, keyFn)
	if err != nil {
		return logoutToken{}, fmt.Errorf("oidc: logout token: %w", err)
	}
	if typ, _ := tok.Header["typ"].(string); typ != "" {
		switch strings.ToLower(typ) {
		case "logout+jwt", "application/logout+jwt", "jwt":
		default:
			return logoutToken{}, fmt.Errorf("oidc: logout token: typ %q", typ)
		}
	}
	c, ok := tok.Claims.(jwt.MapClaims)
	if !ok {
		return logoutToken{}, errors.New("oidc: logout token: claims not a map")
	}
	iat, err := c.GetIssuedAt()
	if err != nil || iat == nil {
		return logoutToken{}, errors.New("oidc: logout token: no iat")
	}
	if time.Since(iat.Time) > logoutTokenMaxAge {
		return logoutToken{}, fmt.Errorf("oidc: logout token: issued %v ago", time.Since(iat.Time).Round(time.Second))
	}
	if _, has := c["nonce"]; has {
		return logoutToken{}, errors.New("oidc: logout token: carries a nonce")
	}
	events, _ := c["events"].(map[string]any)
	if _, ok := events[backchannelLogoutEvent].(map[string]any); !ok {
		return logoutToken{}, errors.New("oidc: logout token: no back-channel logout event")
	}
	lt := logoutToken{iat: iat.Time}
	lt.jti, _ = c["jti"].(string)
	lt.sub, _ = c["sub"].(string)
	lt.sid, _ = c["sid"].(string)
	if lt.jti == "" {
		return logoutToken{}, errors.New("oidc: logout token: no jti")
	}
	if lt.sub == "" && lt.sid == "" {
		return logoutToken{}, errors.New("oidc: logout token: neither sub nor sid")
	}
	return lt, nil
}

// handleBackchannelLogout takes a back-channel logout: 200 once the
// sessions it names have ended (or a replay, which ends nothing), 400 with
// error=invalid_request otherwise (§2.8).
func handleBackchannelLogout(w http.ResponseWriter, r *http.Request, cfg BFFConfig, gate *logoutGate) {
	w.Header().Set("Cache-Control", "no-store")
	refuse := func(status int, why error) {
		slog.Default().LogAttrs(r.Context(), slog.LevelWarn, "oidc: back-channel logout refused", slog.String("error", why.Error()))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		body := struct {
			Error string `json:"error"`
		}{"invalid_request"}
		if err := json.NewEncoder(w).Encode(body); err != nil {
			return // the IdP has gone; it retries a logout it got no answer to
		}
	}
	if !gate.allow(r) {
		w.Header().Set("Retry-After", "60")
		refuse(http.StatusTooManyRequests, errors.New("too many logout requests"))
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := r.ParseForm(); err != nil {
		refuse(http.StatusBadRequest, fmt.Errorf("form: %w", err))
		return
	}
	lt, err := cfg.Validator.parseLogoutToken(r.Context(), r.PostForm.Get("logout_token"))
	if err != nil {
		refuse(http.StatusBadRequest, err)
		return
	}
	fresh, ended, err := cfg.SessionManager.RevokeOIDC(r.Context(), lt.sub, lt.sid, lt.jti, lt.iat.Add(logoutTokenMaxAge+5*time.Minute))
	if err != nil {
		refuse(http.StatusBadRequest, err)
		return
	}
	slog.Default().LogAttrs(r.Context(), slog.LevelInfo, "oidc: back-channel logout",
		slog.Bool("replay", !fresh), slog.Int64("sessions_ended", ended))
	w.WriteHeader(http.StatusOK)
}

// handleFrontchannelLogout takes a front-channel logout: ends the sessions
// of the IdP session (sid) it names, and answers with an empty page the IdP
// may frame. A request without a sid ends nothing. The session cookie isn't
// read: the IdP frames this page from its own site, where the browser
// doesn't send it, and any site could send a person here with it (a
// cross-site sign-out; review 2026-11-05 round 6 #6).
func handleFrontchannelLogout(w http.ResponseWriter, r *http.Request, cfg BFFConfig, gate *logoutGate) {
	w.Header().Set("Cache-Control", "no-cache, no-store")
	w.Header().Set("Pragma", "no-cache")
	if !gate.allow(r) {
		w.Header().Set("Retry-After", "60")
		http.Error(w, "too many logout requests", http.StatusTooManyRequests)
		return
	}
	w.Header().Del("Content-Security-Policy-Report-Only")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors "+cfg.Validator.logoutFrameAncestors())
	q := r.URL.Query()
	sid, iss := q.Get("sid"), q.Get("iss")
	if iss != "" && iss != cfg.Validator.cfg.Issuer {
		http.Error(w, "unknown issuer", http.StatusBadRequest)
		return
	}
	if sid == "" {
		// The IdP sends sid only if asked (frontchannel_logout_session_required;
		// Entra ID: the sid optional claim), and kitp matches sessions on it.
		slog.Default().LogAttrs(r.Context(), slog.LevelWarn, "oidc: front-channel logout without a sid ended nothing")
		http.Error(w, "sid required", http.StatusBadRequest)
		return
	}
	if len(sid) > 512 {
		http.Error(w, "sid too long", http.StatusBadRequest)
		return
	}
	_, ended, err := cfg.SessionManager.RevokeOIDC(r.Context(), "", sid, "", time.Time{})
	if err != nil {
		slog.Default().LogAttrs(r.Context(), slog.LevelError, "oidc: front-channel logout", slog.String("error", err.Error()))
		http.Error(w, "logout failed", http.StatusInternalServerError)
		return
	}
	slog.Default().LogAttrs(r.Context(), slog.LevelInfo, "oidc: front-channel logout",
		slog.Int64("sessions_ended", ended))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte("<!doctype html><title>Signed out</title>")) // a constant; nothing to do if the frame is gone
}

// logoutFrameAncestors is the CSP frame-ancestors source list for the
// front-channel page: the IdP's issuer and end-session origins (its sign-out
// page frames ours), or 'none' when neither parses. It reads discovery only
// if loaded: an unauthenticated request doesn't make kitp fetch it.
func (v *Validator) logoutFrameAncestors() string {
	seen := map[string]bool{}
	var out []string
	add := func(raw string) {
		u, err := url.Parse(raw)
		if err != nil || u.Scheme == "" || u.Host == "" {
			return
		}
		o := u.Scheme + "://" + u.Host
		if !seen[o] {
			seen[o] = true
			out = append(out, o)
		}
	}
	add(v.cfg.Issuer)
	v.mu.RLock()
	if v.disco != nil {
		add(v.disco.EndSessionEndpoint)
	}
	v.mu.RUnlock()
	if len(out) == 0 {
		return "'none'"
	}
	return strings.Join(out, " ")
}
