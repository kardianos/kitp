package api_test

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
)

// writeWebDir creates a temp webDir with an index.html document and a
// real static asset, returning the directory path.
func writeWebDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>SPA DOCUMENT</html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "app.js"), []byte("console.log('asset');"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

// authedResolver returns a resolver that always reports an authenticated
// user; unauthedResolver always reports "no credential".
func authedResolver() api.Resolver {
	return func(*http.Request) (*auth.UserCtx, error) {
		return &auth.UserCtx{ID: 7, DisplayName: "Gated User"}, nil
	}
}
func unauthedResolver() api.Resolver {
	return func(*http.Request) (*auth.UserCtx, error) { return nil, nil }
}

func mountedSPA(t *testing.T, cfg api.SPAGateConfig) *http.ServeMux {
	t.Helper()
	srv := api.NewServer(nil)
	mux := http.NewServeMux()
	srv.MountSPAGated(mux, writeWebDir(t), cfg)
	return mux
}

func TestSPAGate_UnauthenticatedDocumentRedirects(t *testing.T) {
	mux := mountedSPA(t, api.SPAGateConfig{
		SessionResolver: unauthedResolver(),
		Enabled:         true,
		LoginStartPath:  "/api/v1/auth/oidc/start",
	})

	// The SPA-fallback path with a query string: the gate must 302 to the
	// start endpoint carrying the original local path (incl. query) as an
	// escaped redirect.
	req := httptest.NewRequest(http.MethodGet, "/project/42?tab=inbox", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusFound {
		t.Fatalf("status = %d, want 302", rec.Code)
	}
	loc := rec.Header().Get("Location")
	want := "/api/v1/auth/oidc/start?redirect=" + url.QueryEscape("/project/42?tab=inbox")
	if loc != want {
		t.Errorf("Location = %q, want %q", loc, want)
	}
}

func TestSPAGate_RootDocumentRedirectsWhenUnauthenticated(t *testing.T) {
	mux := mountedSPA(t, api.SPAGateConfig{
		SessionResolver: unauthedResolver(),
		Enabled:         true,
		LoginStartPath:  "/api/v1/auth/oidc/start",
	})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusFound {
		t.Fatalf("status = %d, want 302", rec.Code)
	}
	if loc := rec.Header().Get("Location"); loc != "/api/v1/auth/oidc/start?redirect="+url.QueryEscape("/") {
		t.Errorf("Location = %q", loc)
	}
}

func TestSPAGate_DirectIndexHTMLRedirectsWhenUnauthenticated(t *testing.T) {
	mux := mountedSPA(t, api.SPAGateConfig{
		SessionResolver: unauthedResolver(),
		Enabled:         true,
		LoginStartPath:  "/api/v1/auth/oidc/start",
	})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/index.html", nil))
	if rec.Code != http.StatusFound {
		t.Fatalf("direct index.html status = %d, want 302", rec.Code)
	}
}

func TestSPAGate_AuthenticatedServesDocument(t *testing.T) {
	mux := mountedSPA(t, api.SPAGateConfig{
		SessionResolver: authedResolver(),
		Enabled:         true,
		LoginStartPath:  "/api/v1/auth/oidc/start",
	})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/project/42", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if body := rec.Body.String(); body != "<html>SPA DOCUMENT</html>" {
		t.Errorf("body = %q, want the index document", body)
	}
}

func TestSPAGate_AssetServedWhenUnauthenticated(t *testing.T) {
	// A real static asset must be served even with the gate on and no
	// session — only the document is gated.
	mux := mountedSPA(t, api.SPAGateConfig{
		SessionResolver: unauthedResolver(),
		Enabled:         true,
		LoginStartPath:  "/api/v1/auth/oidc/start",
	})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/app.js", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("asset status = %d, want 200", rec.Code)
	}
	if rec.Body.String() != "console.log('asset');" {
		t.Errorf("asset body = %q", rec.Body.String())
	}
}

// A content-hashed bundle under /assets/ (build.mjs emits assets/<name>-<hash>.js)
// must be served with BOTH the year-long immutable Cache-Control (the /assets/
// rule) AND an ETag (the compressed path), and answer a matching conditional
// GET with a 304. Regression guard for the assetcache × /assets/ interaction:
// immutable must survive serveCompressed, and the ETag must be added.
func TestSPAGate_HashedBundleImmutableAndConditional(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>doc</html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	assetsDir := filepath.Join(dir, "assets")
	if err := os.MkdirAll(assetsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Above minCompressSize and highly compressible so serveCompressed engages.
	big := strings.Repeat("export const x = 1; // padding padding padding\n", 200)
	if err := os.WriteFile(filepath.Join(assetsDir, "app-DEADBEEF.js"), []byte(big), 0o644); err != nil {
		t.Fatal(err)
	}

	srv := api.NewServer(nil)
	mux := http.NewServeMux()
	srv.MountSPAGated(mux, dir, api.SPAGateConfig{
		SessionResolver: unauthedResolver(),
		Enabled:         true,
		LoginStartPath:  "/api/v1/auth/oidc/start",
	})

	const immutable = "public, max-age=31536000, immutable"

	req := httptest.NewRequest(http.MethodGet, "/assets/app-DEADBEEF.js", nil)
	req.Header.Set("Accept-Encoding", "br")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != immutable {
		t.Fatalf("Cache-Control = %q, want %q (must survive serveCompressed)", cc, immutable)
	}
	if enc := rec.Header().Get("Content-Encoding"); enc != "br" {
		t.Fatalf("Content-Encoding = %q, want br", enc)
	}
	etag := rec.Header().Get("ETag")
	if etag == "" {
		t.Fatal("hashed bundle served without an ETag")
	}

	// Conditional GET echoing the ETag → 304, immutable preserved, empty body.
	req2 := httptest.NewRequest(http.MethodGet, "/assets/app-DEADBEEF.js", nil)
	req2.Header.Set("Accept-Encoding", "br")
	req2.Header.Set("If-None-Match", etag)
	rec2 := httptest.NewRecorder()
	mux.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusNotModified {
		t.Fatalf("conditional status = %d, want 304", rec2.Code)
	}
	if rec2.Body.Len() != 0 {
		t.Fatalf("304 wrote %d body bytes, want 0", rec2.Body.Len())
	}
	if cc := rec2.Header().Get("Cache-Control"); cc != immutable {
		t.Fatalf("304 Cache-Control = %q, want %q preserved", cc, immutable)
	}
}

func TestSPAGate_DisabledServesDocument(t *testing.T) {
	// Gate off: the document is served regardless of session (dev /
	// AUTH_MODE=off). A nil resolver must not be consulted.
	mux := mountedSPA(t, api.SPAGateConfig{Enabled: false})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/project/42", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (gate disabled)", rec.Code)
	}
	if rec.Body.String() != "<html>SPA DOCUMENT</html>" {
		t.Errorf("body = %q", rec.Body.String())
	}
}

func TestSPAGate_MountSPADelegatesUngated(t *testing.T) {
	// MountSPA (legacy) must serve the document with no session check.
	srv := api.NewServer(nil)
	mux := http.NewServeMux()
	srv.MountSPA(mux, writeWebDir(t))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/anything", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}

func TestSPAGate_HealthzPublic(t *testing.T) {
	mux := mountedSPA(t, api.SPAGateConfig{
		SessionResolver: unauthedResolver(),
		Enabled:         true,
		LoginStartPath:  "/api/v1/auth/oidc/start",
	})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("/healthz status = %d, want 200 (public)", rec.Code)
	}
}

func TestSPAGate_NonGETStillRejected(t *testing.T) {
	mux := mountedSPA(t, api.SPAGateConfig{
		SessionResolver: authedResolver(),
		Enabled:         true,
		LoginStartPath:  "/api/v1/auth/oidc/start",
	})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/project/42", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d, want 405", rec.Code)
	}
}

func TestSPAGate_RejectedCredentialCountsUnauthenticated(t *testing.T) {
	// Resolver returning a non-nil error (bad/expired cookie) must gate
	// the document just like "no credential".
	mux := mountedSPA(t, api.SPAGateConfig{
		SessionResolver: func(*http.Request) (*auth.UserCtx, error) {
			return nil, http.ErrNoCookie
		},
		Enabled:        true,
		LoginStartPath: "/api/v1/auth/oidc/start",
	})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x", nil))
	if rec.Code != http.StatusFound {
		t.Fatalf("status = %d, want 302 (rejected credential gated)", rec.Code)
	}
}
