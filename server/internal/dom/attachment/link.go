package attachment

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/store"
)

// linkTTL is how long a freshly-minted download link stays valid. Links
// are a capability — short-lived by design so a leaked URL (shell
// history, logs) stops working quickly. The agent re-mints on demand.
const linkTTL = 5 * time.Minute

// linkSkew bounds how far in the future a presented `exp` may sit
// before we reject it outright, independent of the signature. The
// signature already covers `exp`, so forging a far-future link needs
// the secret; this is defense-in-depth that caps the blast radius if
// the secret ever leaks.
const linkSkew = time.Minute

// linkDeps carries the plumbing attachment.download_url needs to build
// and verify signed links: the install's external base URL (so the URL
// is absolute and curl-able) and the HMAC signing secret. Wired by
// SetLinkDeps from main.go. When secret is empty, minting fails with a
// clear internal error rather than emitting an unverifiable link.
var linkDeps struct {
	publicURL string
	secret    []byte
}

// SetLinkDeps installs the external base URL (KITP_PUBLIC_URL) and the
// HMAC secret (KITP_LINK_SECRET, or an ephemeral per-boot key) used to
// sign + verify attachment download links. Call once from main.go.
// publicURL may be empty — links then carry a site-relative path and
// the caller prefixes its own host.
func SetLinkDeps(publicURL string, secret []byte) {
	linkDeps.publicURL = strings.TrimRight(strings.TrimSpace(publicURL), "/")
	linkDeps.secret = secret
}

// DownloadURLInput requests a signed link for one attachment.
type DownloadURLInput struct {
	ID   int64  `json:"id,string" mcp:"required,desc=attachment id to mint a download link for"`
	Mode string `json:"mode" mcp:"desc=download (save-as) | view (inline) | thumb (thumbnail); default download,enum=download|view|thumb"`
}

// DownloadURLOutput carries the signed link plus the file metadata the
// SQL function resolved. url + expires_at are filled by the PostRun
// hook (signDownloadURLs); the rest come straight from the SQL body.
type DownloadURLOutput struct {
	ID        int64  `json:"id,string" mcp:"desc=attachment id"`
	Mode      string `json:"mode" mcp:"desc=resolved mode: download|view|thumb"`
	URL       string `json:"url" mcp:"desc=time-limited signed URL; GET it with no auth header (e.g. curl -o file) to stream the bytes"`
	Filename  string `json:"filename" mcp:"desc=display filename"`
	MimeType  string `json:"mime_type" mcp:"desc=MIME type"`
	SizeBytes int64  `json:"size_bytes" mcp:"desc=total size in bytes"`
	ExpiresAt string `json:"expires_at" mcp:"desc=ISO8601 UTC instant the link stops working"`
}

// signLinkPayload is the HMAC-SHA256 of the canonical "id|mode|exp"
// message, base64url-encoded (no padding). exp is unix seconds.
func signLinkPayload(id int64, mode string, exp int64) string {
	mac := hmac.New(sha256.New, linkDeps.secret)
	fmt.Fprintf(mac, "%d|%s|%d", id, mode, exp)
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// verifyDownloadURL checks a presented (id, mode, exp, sig) tuple
// against `now` (unix seconds). Returns an api 403 on an expired link,
// a far-future exp, or a signature mismatch — never leaking which.
func verifyDownloadURL(id int64, mode string, exp int64, sig string, now int64) error {
	if len(linkDeps.secret) == 0 {
		return api.Internal(fmt.Errorf("attachment.download_url: link secret not configured"))
	}
	if exp < now {
		return api.Forbidden("download link expired")
	}
	if exp > now+int64((linkTTL+linkSkew).Seconds()) {
		return api.Forbidden("download link not valid")
	}
	want := signLinkPayload(id, mode, exp)
	// Constant-time compare on the raw MACs. hmac.Equal handles the
	// length check; decode failures fall through to a non-equal compare.
	got, _ := base64.RawURLEncoding.DecodeString(sig)
	wantRaw, _ := base64.RawURLEncoding.DecodeString(want)
	if !hmac.Equal(got, wantRaw) {
		return api.Forbidden("download link not valid")
	}
	return nil
}

// buildDownloadURL assembles the absolute (or site-relative when no
// publicURL is configured) signed link for an attachment + mode + exp.
func buildDownloadURL(id int64, mode string, exp int64) string {
	q := url.Values{}
	q.Set("mode", mode)
	q.Set("exp", strconv.FormatInt(exp, 10))
	q.Set("sig", signLinkPayload(id, mode, exp))
	path := "/api/v1/attachment/" + strconv.FormatInt(id, 10) + "/dl?" + q.Encode()
	return linkDeps.publicURL + path
}

// signDownloadURLs is the PostRun hook for attachment.download_url. The
// SQL function has already validated each input and resolved the file
// metadata into DownloadURLOutput (minus url + expires_at); here we
// stamp a fresh expiry, HMAC-sign the (id, mode, exp) tuple, and fill
// in the link. Runs inside the request tx but touches no DB — a failure
// (unconfigured secret) aborts the batch with a logged internal error.
func signDownloadURLs(_ context.Context, _ store.Querier, _ []any, outs []any) error {
	if len(linkDeps.secret) == 0 {
		return fmt.Errorf("link secret not configured (set KITP_LINK_SECRET)")
	}
	exp := time.Now().Add(linkTTL)
	expUnix := exp.Unix()
	for i := range outs {
		out, ok := outs[i].(DownloadURLOutput)
		if !ok {
			continue
		}
		out.URL = buildDownloadURL(out.ID, out.Mode, expUnix)
		out.ExpiresAt = exp.UTC().Format(time.RFC3339)
		outs[i] = out
	}
	return nil
}

// handleSignedStream is the public counterpart to the Authed streaming
// routes: it trusts a valid signature as the access grant (the grant
// was checked once, against the minting agent, by the dispatcher's
// scope pass on attachment.download_url) and streams the bytes. No
// session or bearer credential is required — that's the whole point of
// a capability link the agent can hand to curl.
func handleSignedStream(ctx context.Context, w http.ResponseWriter, r *http.Request, cfg Config) error {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		return api.BadRequest("validation", "invalid id")
	}
	q := r.URL.Query()
	mode := q.Get("mode")
	if mode == "" {
		mode = "download"
	}
	sm, ok := parseStreamMode(mode)
	if !ok {
		return api.BadRequest("validation", "invalid mode")
	}
	exp, err := strconv.ParseInt(q.Get("exp"), 10, 64)
	if err != nil {
		return api.BadRequest("validation", "invalid exp")
	}
	if err := verifyDownloadURL(id, mode, exp, q.Get("sig"), time.Now().Unix()); err != nil {
		return err
	}
	return streamBytes(ctx, w, cfg, id, sm)
}

// parseStreamMode maps the wire mode string to a streamMode. The set
// matches attachment_download_url_batch's validation.
func parseStreamMode(mode string) (streamMode, bool) {
	switch mode {
	case "download":
		return streamModeDownload, true
	case "view":
		return streamModeView, true
	case "thumb":
		return streamModeThumb, true
	default:
		return 0, false
	}
}
