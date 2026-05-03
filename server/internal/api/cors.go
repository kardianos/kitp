// File cors.go: simple permissive CORS middleware for the dev/e2e loop.
//
// In dev (`ENV=dev`) we default to enabled so a Flutter web app served from
// http://localhost:8090 can hit the kitpd API on http://localhost:8080
// without requiring `chrome --disable-web-security`. In production it is
// disabled by default and must be explicitly enabled with `CORS=on` —
// otherwise we'd be advertising `Access-Control-Allow-Origin: *` to the
// public internet, which is a foot-gun.
//
// The middleware:
//   1. Responds to preflight (OPTIONS) requests with 204 and the CORS
//      headers. The request never reaches the handler chain.
//   2. Adds the same `Access-Control-Allow-Origin` and friends to every
//      regular response.
//
// Headers exposed:
//   Access-Control-Allow-Origin:  *
//   Access-Control-Allow-Methods: POST, OPTIONS
//   Access-Control-Allow-Headers: Content-Type, Idempotency-Key, X-Request-Id
//
// The wildcard is fine here: every endpoint is unauthenticated in dev
// (System User) and v1 acceptance covers Phase 20 (OIDC) for the locked-
// down case.
package api

import (
	"net/http"
	"os"
	"strings"
)

// CORSEnabled returns true when the CORS middleware should be installed.
// Logic:
//   - If `CORS` is set, that value wins (`on|true|1` enables; everything
//     else disables).
//   - Otherwise default by env: dev ⇒ enabled; production ⇒ disabled.
func CORSEnabled(env string) bool {
	if v := strings.TrimSpace(os.Getenv("CORS")); v != "" {
		switch strings.ToLower(v) {
		case "on", "true", "1", "yes":
			return true
		default:
			return false
		}
	}
	return strings.ToLower(strings.TrimSpace(env)) == "dev"
}

// CORSMiddleware returns a middleware that:
//   - responds to OPTIONS preflights with 204 + the CORS headers, and
//   - decorates every other response with the same headers.
func CORSMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeCORSHeaders(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// writeCORSHeaders centralises the header set so the preflight reply and
// the wrapped POST response stay in sync.
func writeCORSHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	h.Set("Access-Control-Allow-Headers", "Content-Type, Idempotency-Key, X-Request-Id")
	// Browsers will cache the preflight response for this many seconds.
	h.Set("Access-Control-Max-Age", "600")
}
