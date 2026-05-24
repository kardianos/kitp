package api_test

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
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
