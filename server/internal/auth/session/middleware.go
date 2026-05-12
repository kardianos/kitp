package session

import (
	"net/http"

	"github.com/kitp/kitp/server/internal/auth"
)

// Middleware reads the kitp_session cookie on every request; when the
// session is valid it stamps the resolved user onto the context.
// Otherwise it falls through unchanged — the request still reaches
// downstream handlers, which are responsible for deciding whether
// they require an authenticated actor (use AuthRequired for that).
//
// This split keeps the public auth surface (dev-login, oidc/start,
// oidc/callback, logout) reachable without a cookie, while keeping
// every other /api/* route a 401 by default via AuthRequired.
func Middleware(mgr *Manager) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id := Read(r)
			if id == "" {
				next.ServeHTTP(w, r)
				return
			}
			u, err := mgr.Lookup(r.Context(), id)
			if err != nil {
				// Bad / expired cookie — proactively clear it so the
				// browser stops sending the dead value on every
				// request. Use the same insecure-cookie flag the
				// /logout path would use; the in-memory Manager
				// doesn't carry it, so we err on the safe side
				// (Secure on). InsecureCookie clients will get a
				// Secure-attribute mismatch on this specific evict
				// cookie; that's harmless — the browser still drops
				// the original cookie path/name match.
				Clear(w, false)
				next.ServeHTTP(w, r)
				return
			}
			ctx := auth.WithUser(r.Context(), &auth.UserCtx{
				ID:          u.ID,
				DisplayName: u.DisplayName,
			})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// AuthRequired returns 401 when no user is attached to the request
// context. Wrap it around every handler that expects an authenticated
// actor — the dispatcher batch route is the obvious one.
func AuthRequired(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := auth.FromContext(r.Context()); !ok {
			writeJSONErr(w, http.StatusUnauthorized, "unauthenticated")
			return
		}
		h.ServeHTTP(w, r)
	})
}

// GateConfig configures GateAPI.
type GateConfig struct {
	// Prefix is the path prefix that requires authentication. Typical
	// value: "/api/".
	Prefix string
	// Exempt lists path prefixes inside Prefix that should NOT be
	// gated. Use this for the login / logout / OIDC redirect
	// endpoints — they need to be reachable without a session cookie.
	Exempt []string
}

// GateAPI returns a middleware that 401s any request whose path
// starts with cfg.Prefix unless it matches one of cfg.Exempt or has a
// user already attached. Static assets / healthz / GET / pass through
// unchanged (they don't share Prefix).
func GateAPI(cfg GateConfig) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !startsWith(r.URL.Path, cfg.Prefix) {
				next.ServeHTTP(w, r)
				return
			}
			for _, ex := range cfg.Exempt {
				if startsWith(r.URL.Path, ex) {
					next.ServeHTTP(w, r)
					return
				}
			}
			if _, ok := auth.FromContext(r.Context()); !ok {
				writeJSONErr(w, http.StatusUnauthorized, "unauthenticated")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func startsWith(s, prefix string) bool {
	return len(s) >= len(prefix) && s[:len(prefix)] == prefix
}
