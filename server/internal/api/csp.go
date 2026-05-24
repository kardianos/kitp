// File api/csp.go: Content-Security-Policy middleware.
//
// Applied at the top-level mux so every response — SPA HTML, static
// asset, /api/* JSON, /healthz — carries the same policy. The CSP is
// strict: `default-src 'none'` forces every other directive to be
// explicit, no `'unsafe-inline'` / `'unsafe-eval'`, no wildcard
// origins, no nonces (we have nothing to nonce). Every external fetch
// the SPA makes targets `'self'`; the two `blob:` allowances exist
// because the attachment view (PDF iframe) and thumb (img) load CAS
// bytes through a Blob URL the SPA creates itself.
//
// The policy is intentionally NOT route-conditional. Even on JSON
// /api/ responses we set it — defence-in-depth so a future
// content-type confusion (a JSON endpoint mistakenly returning HTML)
// doesn't open a hole.
//
// Toggle to soft-launch:
//   KITP_CSP_REPORT_ONLY=1
// switches the header name to `Content-Security-Policy-Report-Only`.
// The browser logs violations without enforcing. Use during the
// initial rollout to catch surprises in the wild.

package api

import (
	"net/http"
	"strings"
)

// CSPConfig drives the CSP middleware. ReportOnly flips between
// enforced and soft-launch mode. Reporter is the optional report-uri
// (a URL the browser POSTs JSON violation reports to); leave empty
// to omit the directive.
type CSPConfig struct {
	ReportOnly bool
	Reporter   string
}

// CSP returns an http middleware that sets the Content-Security-
// Policy header on every response.
func CSP(cfg CSPConfig) func(http.Handler) http.Handler {
	header := "Content-Security-Policy"
	if cfg.ReportOnly {
		header = "Content-Security-Policy-Report-Only"
	}
	value := buildCSP(cfg.Reporter)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set(header, value)
			next.ServeHTTP(w, r)
		})
	}
}

// buildCSP composes the policy from a small set of directives.
// Kept readable on purpose — every directive has a one-line comment
// for the next person reading it.
//
// Constraints baked into this policy:
//
//   - SPA loads scripts and styles only from the kitp origin (the
//     Vite-built bundle). No CDNs, no inline scripts (theme bootstrap
//     was extracted to /theme-boot.js for exactly this reason), no
//     inline styles (the four floating-ui anchors were converted to
//     `.kf-float-anchor` classes; the one dynamic style attribute on
//     `<Avatar>` was converted to a Svelte `style:` directive).
//
//   - `connect-src 'self'` covers every XHR / fetch the SPA makes.
//     The OIDC redirect is a top-level navigation, controlled by
//     `form-action` / browser nav, not by `connect-src`.
//
//   - `blob:` is allowed on `img-src` (attachment thumbs) and
//     `frame-src` (PDF inline view). The blobs are constructed by the
//     SPA itself from bytes the server returned over /api/v1/attachment;
//     a malicious blob URL can only be created by code already
//     executing in the SPA's origin.
//
//   - `frame-ancestors 'none'` refuses to be embedded in any other
//     site's iframe (modern equivalent of `X-Frame-Options: DENY`).
//
//   - `upgrade-insecure-requests` rewrites accidental http:// asset
//     refs to https:// in production.
func buildCSP(reporter string) string {
	directives := []string{
		"default-src 'none'",
		"script-src 'self'",
		"style-src 'self'",
		"img-src 'self' blob:",
		"connect-src 'self'",
		"frame-src 'self' blob:",
		"font-src 'self'",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'self'",
		"frame-ancestors 'none'",
		"upgrade-insecure-requests",
	}
	if reporter != "" {
		directives = append(directives, "report-uri "+reporter)
	}
	return strings.Join(directives, "; ")
}
