// File auth/oidc/middleware.go: HTTP middleware that resolves the bearer
// token to a user and stamps the `auth.UserCtx` on the request context, so
// the downstream dispatcher and handlers see the authenticated actor.
//
// On a missing or invalid token we return 401 with a small JSON body. The
// dispatcher would otherwise treat the request as the System User, which is
// exactly what we don't want when AUTH_MODE=oidc.
package oidc

import (
	"net/http"
	"strings"

	"github.com/kitp/kitp/server/internal/auth"
)

// Middleware returns an http middleware that validates the
// `Authorization: Bearer ...` header and injects an auth.UserCtx into the
// request context. v must be non-nil.
//
// The gate fires only on `/api/v1/*` routes. Static assets (Flutter
// bundle, /healthz, /auth/callback, /login) bypass auth so the unsigned-in
// browser can paint the login screen and complete the OP redirect dance
// without a circular 401.
func Middleware(v *Validator) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// CORS preflight skips this entirely (handled higher up).
			if r.Method == http.MethodOptions {
				next.ServeHTTP(w, r)
				return
			}
			// Only API calls are gated; the SPA + healthz are public.
			if !strings.HasPrefix(r.URL.Path, "/api/") {
				next.ServeHTTP(w, r)
				return
			}
			ah := r.Header.Get("Authorization")
			if ah == "" || !strings.HasPrefix(ah, "Bearer ") {
				writeUnauth(w, "missing_bearer")
				return
			}
			tok := strings.TrimPrefix(ah, "Bearer ")
			id, name, err := v.Resolve(r.Context(), tok)
			if err != nil {
				writeUnauth(w, err.Error())
				return
			}
			ctx := auth.WithUser(r.Context(), &auth.UserCtx{ID: id, DisplayName: name})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func writeUnauth(w http.ResponseWriter, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	_, _ = w.Write([]byte(`{"error":{"code":"unauthorized","message":` + jsonString(msg) + `}}` + "\n"))
}

// jsonString JSON-encodes a single string value (with quotes). Defined here
// to avoid pulling encoding/json in the hot path.
func jsonString(s string) string {
	b := make([]byte, 0, len(s)+2)
	b = append(b, '"')
	for _, r := range s {
		switch r {
		case '"', '\\':
			b = append(b, '\\', byte(r))
		case '\n':
			b = append(b, '\\', 'n')
		case '\r':
			b = append(b, '\\', 'r')
		case '\t':
			b = append(b, '\\', 't')
		default:
			if r < 0x20 {
				continue
			}
			b = append(b, []byte(string(r))...)
		}
	}
	b = append(b, '"')
	return string(b)
}
