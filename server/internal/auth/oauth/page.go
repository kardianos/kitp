// page.go: the consent and notice pages. Server-rendered on purpose: the
// page is reached mid-redirect from another site, must work before the
// SPA could load, and needs nothing but a form. The app's CSP applies
// (no inline style or script), so the stylesheet is its own route.
package oauth

import (
	"bytes"
	"context"
	_ "embed"
	"fmt"
	"html/template"
	"log/slog"
	"net/http"

	"github.com/kitp/kitp/server/internal/api"
)

//go:embed assets/page.html
var pageHTML string

//go:embed assets/consent.css
var consentCSS []byte

var pageTmpl = template.Must(template.New("page").Parse(pageHTML))

// pageData fills assets/page.html: either Consent, or a notice (Message,
// Detail, an optional link, an optional "Ask an administrator" form).
type pageData struct {
	Title    string
	Consent  *consentData
	Message  string
	Detail   string
	LinkHref string
	LinkText string
	Request  *requestData
}

// requestData is the "Ask an administrator" form on the untrusted-client
// page.
type requestData struct {
	Action string
	Token  string
	Hidden []hiddenField
}

type consentData struct {
	ClientName   string
	RedirectHost string
	Loopback     bool
	Person       string
	Agents       []agentChoice
	Hidden       []hiddenField
	Token        string
	Action       string
}

type hiddenField struct {
	Name, Value string
}

// renderPage writes a page. Rendered into a buffer first so a template
// failure is a clean 500, not half a page.
func renderPage(w http.ResponseWriter, status int, d pageData) error {
	var buf bytes.Buffer
	if err := pageTmpl.Execute(&buf, d); err != nil {
		return api.Internal(fmt.Errorf("oauth: render page: %w", err))
	}
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("X-Frame-Options", "DENY")
	w.WriteHeader(status)
	if _, err := w.Write(buf.Bytes()); err != nil {
		// The browser went away; the status is already sent.
		slog.Default().Debug("oauth: write page", "err", err)
	}
	return nil
}

func serveStyles(_ context.Context, w http.ResponseWriter, _ *http.Request) error {
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(consentCSS); err != nil {
		slog.Default().Debug("oauth: write styles", "err", err)
	}
	return nil
}
