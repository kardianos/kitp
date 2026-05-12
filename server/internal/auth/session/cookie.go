package session

import (
	"net/http"
	"time"
)

// CookieName is the wire name for the BFF session cookie.
const CookieName = "kitp_session"

// CookieOptions controls how Set / Clear stamp the kitp_session
// cookie. Secure defaults to true (the only safe default for a
// session cookie); InsecureCookie disables it for local HTTP dev.
type CookieOptions struct {
	// MaxAge is the cookie's Max-Age. Match the session manager's
	// AbsoluteCap so the browser drops the cookie naturally when the
	// session can no longer be revived server-side anyway.
	MaxAge time.Duration
	// InsecureCookie omits the Secure attribute. ONLY enable for
	// http://localhost dev — Chrome / Firefox refuse to send Secure
	// cookies over http, which would otherwise lock the user out.
	InsecureCookie bool
}

// Set writes the kitp_session cookie with the supplied id.
// HttpOnly + SameSite=Strict + Path=/. Secure unless InsecureCookie.
func Set(w http.ResponseWriter, id string, opts CookieOptions) {
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    id,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   !opts.InsecureCookie,
		MaxAge:   int(opts.MaxAge.Seconds()),
	})
}

// Clear emits a Max-Age=0 cookie to evict the session id from the
// browser. Logout calls this after Revoking the server-side row.
func Clear(w http.ResponseWriter, insecure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   !insecure,
		MaxAge:   -1,
	})
}

// Read returns the session id from the request, or "" if absent.
func Read(r *http.Request) string {
	c, err := r.Cookie(CookieName)
	if err != nil {
		return ""
	}
	return c.Value
}
