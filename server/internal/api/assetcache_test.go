package api

import (
	"compress/flate"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/andybalholm/brotli"
)

func TestNegotiateEncoding(t *testing.T) {
	cases := []struct {
		accept string
		want   string
	}{
		{"", ""},
		{"gzip", "gzip"},
		{"deflate", "deflate"},
		{"br", "br"},
		{"gzip, deflate", "gzip"},        // server preference: gzip before deflate
		{"deflate, gzip", "gzip"},        // header order doesn't override preference
		{"gzip, br", "br"},               // br wins regardless of header order
		{"br;q=0, gzip", "gzip"},         // br explicitly refused → next preference
		{"gzip;q=0, deflate", "deflate"}, // gzip explicitly refused
		{"*", "br"},                      // wildcard admits the top preference
		{"identity", ""},
	}
	for _, c := range cases {
		if got := negotiateEncoding(c.accept); got != c.want {
			t.Errorf("negotiateEncoding(%q) = %q, want %q", c.accept, got, c.want)
		}
	}
}

func TestIsCompressibleType(t *testing.T) {
	yes := []string{"text/html; charset=utf-8", "application/javascript", "image/svg+xml", "application/json"}
	no := []string{"image/png", "font/woff2", "video/mp4", "application/octet-stream"}
	for _, ct := range yes {
		if !isCompressibleType(ct) {
			t.Errorf("isCompressibleType(%q) = false, want true", ct)
		}
	}
	for _, ct := range no {
		if isCompressibleType(ct) {
			t.Errorf("isCompressibleType(%q) = true, want false", ct)
		}
	}
}

// writeAsset writes a sizeable, highly-compressible JS file and returns its path.
func writeAsset(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	full := filepath.Join(dir, "app.js")
	body := strings.Repeat("export const x = 1; // padding padding padding\n", 200)
	if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return full
}

func TestServeCompressedGzip(t *testing.T) {
	full := writeAsset(t)
	raw, _ := os.ReadFile(full)
	cache := newAssetCache()

	r := httptest.NewRequest(http.MethodGet, "/app.js", nil)
	r.Header.Set("Accept-Encoding", "gzip")
	w := httptest.NewRecorder()

	if !serveCompressed(w, r, cache, full) {
		t.Fatal("serveCompressed returned false, want true (gzip should apply)")
	}
	res := w.Result()
	if got := res.Header.Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/javascript") && !strings.HasPrefix(ct, "application/javascript") {
		t.Fatalf("unexpected Content-Type %q", ct)
	}
	zr, err := gzip.NewReader(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(zr)
	if string(got) != string(raw) {
		t.Fatal("decompressed body does not match source")
	}
	if len(w.Body.Bytes()) >= len(raw) {
		t.Fatalf("compressed body (%d) not smaller than raw (%d)", len(w.Body.Bytes()), len(raw))
	}
}

func TestServeCompressedBrotli(t *testing.T) {
	full := writeAsset(t)
	raw, _ := os.ReadFile(full)
	cache := newAssetCache()

	r := httptest.NewRequest(http.MethodGet, "/app.js", nil)
	r.Header.Set("Accept-Encoding", "br")
	w := httptest.NewRecorder()

	if !serveCompressed(w, r, cache, full) {
		t.Fatal("serveCompressed returned false, want true (brotli should apply)")
	}
	if got := w.Result().Header.Get("Content-Encoding"); got != "br" {
		t.Fatalf("Content-Encoding = %q, want br", got)
	}
	got, _ := io.ReadAll(brotli.NewReader(w.Result().Body))
	if string(got) != string(raw) {
		t.Fatal("brotli-decompressed body does not match source")
	}
	if w.Body.Len() >= len(raw) {
		t.Fatalf("brotli body (%d) not smaller than raw (%d)", w.Body.Len(), len(raw))
	}
}

func TestServeCompressedDeflate(t *testing.T) {
	full := writeAsset(t)
	raw, _ := os.ReadFile(full)
	cache := newAssetCache()

	r := httptest.NewRequest(http.MethodGet, "/app.js", nil)
	r.Header.Set("Accept-Encoding", "deflate")
	w := httptest.NewRecorder()

	if !serveCompressed(w, r, cache, full) {
		t.Fatal("serveCompressed returned false, want true")
	}
	if got := w.Result().Header.Get("Content-Encoding"); got != "deflate" {
		t.Fatalf("Content-Encoding = %q, want deflate", got)
	}
	fr := flate.NewReader(w.Result().Body)
	got, _ := io.ReadAll(fr)
	if string(got) != string(raw) {
		t.Fatal("inflated body does not match source")
	}
}

func TestServeCompressedIdentityFallthrough(t *testing.T) {
	full := writeAsset(t)
	cache := newAssetCache()

	// No Accept-Encoding → identity → must return false and write nothing.
	r := httptest.NewRequest(http.MethodGet, "/app.js", nil)
	w := httptest.NewRecorder()
	if serveCompressed(w, r, cache, full) {
		t.Fatal("serveCompressed returned true for identity client, want false")
	}
	if w.Body.Len() != 0 || len(w.Result().Header) != 0 {
		t.Fatal("serveCompressed wrote a response on the fallthrough path")
	}
}

func TestServeCompressedSkipsTinyAndBinary(t *testing.T) {
	dir := t.TempDir()
	cache := newAssetCache()

	tiny := filepath.Join(dir, "tiny.js")
	_ = os.WriteFile(tiny, []byte("x=1"), 0o644)
	bin := filepath.Join(dir, "logo.png")
	_ = os.WriteFile(bin, make([]byte, 4096), 0o644)

	for _, full := range []string{tiny, bin} {
		r := httptest.NewRequest(http.MethodGet, "/x", nil)
		r.Header.Set("Accept-Encoding", "gzip")
		w := httptest.NewRecorder()
		if serveCompressed(w, r, cache, full) {
			t.Errorf("serveCompressed(%s) = true, want false (skip)", filepath.Base(full))
		}
	}
}

func TestAssetCacheWarm(t *testing.T) {
	dir := t.TempDir()
	js := strings.Repeat("export const x = 1; // padding padding padding\n", 200)
	if err := os.WriteFile(filepath.Join(dir, "app.js"), []byte(js), 0o644); err != nil {
		t.Fatal(err)
	}
	css := strings.Repeat(".a{color:red} /* padding padding padding padding */\n", 200)
	if err := os.WriteFile(filepath.Join(dir, "styles.css"), []byte(css), 0o644); err != nil {
		t.Fatal(err)
	}
	// A big source map (should be SKIPPED) and a tiny file (below threshold).
	if err := os.WriteFile(filepath.Join(dir, "app.js.map"), []byte(strings.Repeat("m", 5000)), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "tiny.js"), []byte("x=1"), 0o644); err != nil {
		t.Fatal(err)
	}

	cache := newAssetCache()
	n := cache.warm(dir)

	// 2 warmable files × 3 encodings (br, gzip, deflate) = 6 renditions.
	if n != 6 {
		t.Fatalf("warm built %d renditions, want 6 (app.js + styles.css × 3 encodings)", n)
	}
	if len(cache.entries) != 6 {
		t.Fatalf("cache holds %d entries, want 6", len(cache.entries))
	}
	// The source map must not have been warmed.
	for k := range cache.entries {
		if strings.HasSuffix(k.path, ".map") {
			t.Fatalf("source map was warmed: %v", k)
		}
	}

	// A warmed asset serves straight from cache (no compression on the request
	// path): point build at a guaranteed-stale stamp and confirm get() still hits.
	full := filepath.Join(dir, "app.js")
	st, _ := os.Stat(full)
	if _, ok := cache.get(assetCacheKey{path: full, encoding: "br"}, st.ModTime().UnixNano(), st.Size()); !ok {
		t.Fatal("warmed app.js (br) not present in cache")
	}
}

func TestAssetCacheReuseAndInvalidation(t *testing.T) {
	full := writeAsset(t)
	cache := newAssetCache()

	serve := func() []byte {
		r := httptest.NewRequest(http.MethodGet, "/app.js", nil)
		r.Header.Set("Accept-Encoding", "gzip")
		w := httptest.NewRecorder()
		if !serveCompressed(w, r, cache, full) {
			t.Fatal("serveCompressed returned false")
		}
		return w.Body.Bytes()
	}

	first := serve()
	if len(cache.entries) != 1 {
		t.Fatalf("cache holds %d entries after first serve, want 1", len(cache.entries))
	}
	second := serve()
	if string(first) != string(second) {
		t.Fatal("cached rendition differs from first serve")
	}

	// Rewrite the file with different (still compressible) content; the stamp
	// changes so the entry must be rebuilt rather than served stale.
	bigger := strings.Repeat("export const y = 2; // different different\n", 300)
	if err := os.WriteFile(full, []byte(bigger), 0o644); err != nil {
		t.Fatal(err)
	}
	third := serve()
	zr, err := gzip.NewReader(strings.NewReader(string(third)))
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(zr)
	if string(got) != bigger {
		t.Fatal("after file change, served stale cached bytes")
	}
}
