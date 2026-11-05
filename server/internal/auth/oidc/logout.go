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

	"github.com/kitp/kitp/server/internal/auth/session"
	"github.com/kitp/kitp/server/internal/netx"
)

// backchannelLogoutEvent is the events member a logout token carries.
const backchannelLogoutEvent = "http://schemas.openid.net/event/backchannel-logout"

// logoutTokenMaxAge is how old (by iat) a logout token may be: an IdP sends
// it as the sign-out happens. Its jti is kept a little longer, so a replay
// within the window ends nothing either.
const logoutTokenMaxAge = 10 * time.Minute

// logoutsPerMinute / logoutsBurst bound both logout routes together: they
// take no credential but the token or sid, and an IdP signing many people
// out at once sends one request each.
const (
	logoutsPerMinute = 600
	logoutsBurst     = 1200
)

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
func handleBackchannelLogout(w http.ResponseWriter, r *http.Request, cfg BFFConfig, gate *netx.Limiter) {
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
	if !gate.Allow("*", 1) {
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
// of the sid it names, and the one its cookie carries if the browser sent
// it, and answers with an empty page the IdP may frame.
func handleFrontchannelLogout(w http.ResponseWriter, r *http.Request, cfg BFFConfig, gate *netx.Limiter) {
	w.Header().Set("Cache-Control", "no-cache, no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Del("Content-Security-Policy-Report-Only")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors "+cfg.Validator.logoutFrameAncestors(r.Context()))
	if !gate.Allow("*", 1) {
		w.Header().Set("Retry-After", "60")
		http.Error(w, "too many logout requests", http.StatusTooManyRequests)
		return
	}
	q := r.URL.Query()
	sid, iss := q.Get("sid"), q.Get("iss")
	if iss != "" && iss != cfg.Validator.cfg.Issuer {
		http.Error(w, "unknown issuer", http.StatusBadRequest)
		return
	}
	if len(sid) > 512 {
		http.Error(w, "sid too long", http.StatusBadRequest)
		return
	}
	var ended int64
	if sid != "" {
		_, n, err := cfg.SessionManager.RevokeOIDC(r.Context(), "", sid, "", time.Time{})
		if err != nil {
			slog.Default().LogAttrs(r.Context(), slog.LevelError, "oidc: front-channel logout", slog.String("error", err.Error()))
			http.Error(w, "logout failed", http.StatusInternalServerError)
			return
		}
		ended += n
	}
	if id := session.Read(r); id != "" {
		if err := cfg.SessionManager.Revoke(r.Context(), id); err != nil {
			slog.Default().LogAttrs(r.Context(), slog.LevelError, "oidc: front-channel logout (cookie)", slog.String("error", err.Error()))
			http.Error(w, "logout failed", http.StatusInternalServerError)
			return
		}
		session.Clear(w, cfg.InsecureCookie)
		ended++
	}
	slog.Default().LogAttrs(r.Context(), slog.LevelInfo, "oidc: front-channel logout",
		slog.Bool("sid", sid != ""), slog.Int64("sessions_ended", ended))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte("<!doctype html><title>Signed out</title>")) // a constant; nothing to do if the frame is gone
}

// logoutFrameAncestors is the CSP frame-ancestors source list for the
// front-channel page: the IdP's issuer and end-session origins (its sign-out
// page frames ours), or 'none' when neither parses.
func (v *Validator) logoutFrameAncestors(ctx context.Context) string {
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
	if err := v.ensureDiscovery(ctx); err == nil {
		v.mu.RLock()
		add(v.disco.EndSessionEndpoint)
		v.mu.RUnlock()
	}
	if len(out) == 0 {
		return "'none'"
	}
	return strings.Join(out, " ")
}
