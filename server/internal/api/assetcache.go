package api

// Static-asset compression cache.
//
// The SPA bundle (app.js / css / json / svg / source maps) is served straight
// off the filesystem by http.FileServer. Those files never change between
// builds, so compressing them on every request wastes CPU. This cache
// memoises the gzip / deflate rendition of each asset in memory, keyed by
// {path, encoding}, and re-validates against the source file's mod-time + size
// so a redeploy or dev hot-reload transparently rebuilds the entry.
//
// Concurrency: a single RWMutex guards the map. The (expensive) compression
// runs OUTSIDE the lock — the lock only brackets the map read / write — so
// concurrent first-hits on different assets don't serialise. A racing
// double-compress of the SAME asset is harmless (both produce identical bytes;
// the last writer wins).

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"fmt"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/andybalholm/brotli"
)

// preferredEncodings lists the response Content-Encodings the cache can
// produce, in server-preference order (best ratio first). Negotiation picks
// the first entry the client accepts; a client that accepts none gets the
// asset uncompressed via the plain FileServer path. brotli (the only non-stdlib
// dep) leads since it beats gzip-9 by ~15-20% on JS/CSS and modern browsers
// prefer it; gzip/deflate remain the universal fallbacks.
var preferredEncodings = []string{"br", "gzip", "deflate"}

// minCompressSize skips compressing tiny files where the encoding framing
// overhead (and the lost conditional-GET / Range support) isn't worth it.
const minCompressSize = 512

// assetCacheKey identifies one compressed rendition of a static asset.
type assetCacheKey struct {
	path     string // absolute filesystem path under webDir
	encoding string // one of preferredEncodings
}

// cachedAsset is a compressed rendition plus the source-file stamp it was built
// from; a mismatch on the stamp invalidates the entry (file changed on disk).
type cachedAsset struct {
	body    []byte
	modUnix int64
	size    int64
}

// assetCache memoises compressed renditions of static files in memory.
type assetCache struct {
	mu      sync.RWMutex
	entries map[assetCacheKey]cachedAsset
}

func newAssetCache() *assetCache {
	return &assetCache{entries: make(map[assetCacheKey]cachedAsset)}
}

// get returns the cached body for key when present AND still matching the
// source file's current mod-time + size.
func (c *assetCache) get(key assetCacheKey, modUnix, size int64) ([]byte, bool) {
	c.mu.RLock()
	e, ok := c.entries[key]
	c.mu.RUnlock()
	if !ok || e.modUnix != modUnix || e.size != size {
		return nil, false
	}
	return e.body, true
}

func (c *assetCache) put(key assetCacheKey, body []byte, modUnix, size int64) {
	c.mu.Lock()
	c.entries[key] = cachedAsset{body: body, modUnix: modUnix, size: size}
	c.mu.Unlock()
}

// build reads + compresses the file at `full` with `enc`, stores the rendition,
// and returns it. ok is false (nothing cached) when the file can't be read or
// the compressed form isn't smaller than the source — the caller then serves
// identity. The caller is responsible for having validated enc + content-type.
func (c *assetCache) build(full, enc string, modUnix, size int64) (body []byte, ok bool) {
	raw, err := os.ReadFile(full)
	if err != nil {
		return nil, false
	}
	body, err = compressBytes(enc, raw)
	if err != nil || len(body) >= len(raw) {
		return nil, false // compression failed or didn't shrink it
	}
	c.put(assetCacheKey{path: full, encoding: enc}, body, modUnix, size)
	return body, true
}

// warm walks webDir and pre-compresses every servable asset into the cache for
// each preferred encoding, so the FIRST real request for the big bundle
// (app.js / styles.css) serves cached bytes instead of paying brotli-11 inline.
// Source maps (*.map) are skipped: they're large and only fetched with devtools
// open, so they tolerate the one-off on-demand cost — warming them would burn
// startup CPU compressing megabytes almost nobody downloads. Best-effort:
// unreadable / non-compressible / non-shrinking files are skipped. Returns the
// number of cached renditions built.
//
// Safe to run in a background goroutine: the cache is mutex-guarded, and a
// racing on-demand compress of the same asset just overwrites identical bytes.
func (c *assetCache) warm(webDir string) int {
	built := 0
	_ = filepath.WalkDir(webDir, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil || d.IsDir() {
			return nil // skip unreadable entries; keep walking the rest
		}
		built += c.warmFile(path)
		return nil
	})
	return built
}

// warmFile pre-compresses one file into every preferred encoding, returning the
// count of renditions built (0 when the file isn't a warmable asset).
func (c *assetCache) warmFile(full string) int {
	ext := strings.ToLower(filepath.Ext(full))
	if ext == ".map" {
		return 0 // source maps: latency-tolerant + large — warm on demand only
	}
	ct := assetContentType(ext)
	if ct == "" || !isCompressibleType(ct) {
		return 0
	}
	st, err := os.Stat(full)
	if err != nil || st.IsDir() || st.Size() < minCompressSize {
		return 0
	}
	modUnix := st.ModTime().UnixNano()
	size := st.Size()
	built := 0
	for _, enc := range preferredEncodings {
		if _, ok := c.build(full, enc, modUnix, size); ok {
			built++
		}
	}
	return built
}

// serveCompressed writes a cached gzip/deflate rendition of the file at `full`
// when the client accepts one and the file is worth compressing. It returns
// true when it has fully written the response; false (having written NOTHING)
// to let the caller fall back to the plain http.FileServer path — for identity
// clients, HEAD requests, unknown/incompressible content types, tiny files, or
// any stat/read/compress error (FileServer then handles Range + conditional
// GET, which the compressed path intentionally doesn't).
func serveCompressed(w http.ResponseWriter, r *http.Request, cache *assetCache, full string) bool {
	if r.Method != http.MethodGet {
		return false // HEAD etc.: no body to compress
	}
	enc := negotiateEncoding(r.Header.Get("Accept-Encoding"))
	if enc == "" {
		return false
	}
	ext := strings.ToLower(filepath.Ext(full))
	ct := assetContentType(ext)
	if ct == "" || !isCompressibleType(ct) {
		return false
	}
	st, err := os.Stat(full)
	if err != nil || st.IsDir() || st.Size() < minCompressSize {
		return false
	}
	modUnix := st.ModTime().UnixNano()
	size := st.Size()

	// ETag identifies this exact compressed rendition by {size, mod-time,
	// encoding}. Encoding is IN the tag because the br / gzip / deflate
	// renditions are distinct representations — Vary: Accept-Encoding (set by
	// the caller) keeps shared caches from crossing them, and a distinct tag
	// keeps a gzip client from being 304'd against a br entry. A client that
	// already holds a matching rendition echoes it in If-None-Match; we then
	// answer 304 without reading, compressing, or transmitting the body. That's
	// the single biggest repeat-load win on a slow uplink: the fixed-name root
	// bundle (app.js / styles.css) otherwise re-downloads in full on every
	// navigation because this path — bypassing http.FileServer — emitted no
	// validator at all. A stale validator (file changed → new mod-time/size →
	// new tag) simply won't match and falls through to a fresh 200.
	etag := fmt.Sprintf(`"%x-%x-%s"`, size, modUnix, enc)
	if inm := r.Header.Get("If-None-Match"); inm != "" && etagMatch(inm, etag) {
		// 304 carries only the validator + caching metadata, never a body or
		// the Content-Type/Encoding/Length representation headers (mirrors
		// net/http's writeNotModified). Vary was already set by the caller.
		h := w.Header()
		h.Set("ETag", etag)
		if h.Get("Cache-Control") == "" {
			h.Set("Cache-Control", "no-cache")
		}
		w.WriteHeader(http.StatusNotModified)
		return true
	}

	body, ok := cache.get(assetCacheKey{path: full, encoding: enc}, modUnix, size)
	if !ok {
		// Cache miss (cold, or the warm walk skipped it / it changed). Compress
		// + cache inline; build returns ok=false to fall back to identity when
		// the file is unreadable or doesn't actually shrink. Nothing has been
		// written to the header map yet, so the FileServer fallback stays clean.
		body, ok = cache.build(full, enc, modUnix, size)
		if !ok {
			return false
		}
	}

	h := w.Header()
	h.Set("Content-Type", ct)
	h.Set("Content-Encoding", enc)
	h.Set("ETag", etag)
	// Store-but-revalidate: the browser keeps the bytes and confirms them with a
	// cheap conditional GET (the ETag above → 304). Skip when the caller already
	// pinned a stronger policy — the content-hashed bundle under /assets/ is
	// immutable and never needs to revalidate at all.
	if h.Get("Cache-Control") == "" {
		h.Set("Cache-Control", "no-cache")
	}
	h.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body) // a write error on a closed client conn is not actionable
	return true
}

// etagMatch reports whether an If-None-Match header value admits `etag`. It
// handles the "*" wildcard and a comma-separated list, and compares weakly
// (strips any "W/" prefix on either side) per RFC 7232 §2.3.2 — our tags are
// strong, but an intermediary cache may weaken them on revalidation.
func etagMatch(inm, etag string) bool {
	inm = strings.TrimSpace(inm)
	if inm == "*" {
		return true
	}
	want := strings.TrimPrefix(etag, "W/")
	for _, part := range strings.Split(inm, ",") {
		if strings.TrimPrefix(strings.TrimSpace(part), "W/") == want {
			return true
		}
	}
	return false
}

// negotiateEncoding picks the best supported Content-Encoding the client
// accepts from its Accept-Encoding header, or "" for identity.
func negotiateEncoding(accept string) string {
	if accept == "" {
		return ""
	}
	for _, enc := range preferredEncodings {
		if clientAccepts(accept, enc) {
			return enc
		}
	}
	return ""
}

// clientAccepts reports whether the Accept-Encoding header admits `enc` (either
// named explicitly or via the `*` wildcard) with a non-zero q-value.
func clientAccepts(accept, enc string) bool {
	for _, part := range strings.Split(accept, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		name := part
		q := 1.0
		if i := strings.IndexByte(part, ';'); i >= 0 {
			name = strings.TrimSpace(part[:i])
			for _, p := range strings.Split(part[i+1:], ";") {
				p = strings.TrimSpace(p)
				if v, ok := strings.CutPrefix(p, "q="); ok {
					if f, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil {
						q = f
					}
				}
			}
		}
		if (name == enc || name == "*") && q > 0 {
			return true
		}
	}
	return false
}

// compressBytes returns `data` compressed with the named encoding at best ratio.
func compressBytes(encoding string, data []byte) ([]byte, error) {
	var buf bytes.Buffer
	switch encoding {
	case "br":
		bw := brotli.NewWriterLevel(&buf, brotli.BestCompression)
		if _, err := bw.Write(data); err != nil {
			_ = bw.Close()
			return nil, err
		}
		if err := bw.Close(); err != nil {
			return nil, err
		}
	case "gzip":
		zw, err := gzip.NewWriterLevel(&buf, gzip.BestCompression)
		if err != nil {
			return nil, err
		}
		if _, err := zw.Write(data); err != nil {
			_ = zw.Close()
			return nil, err
		}
		if err := zw.Close(); err != nil {
			return nil, err
		}
	case "deflate":
		fw, err := flate.NewWriter(&buf, flate.BestCompression)
		if err != nil {
			return nil, err
		}
		if _, err := fw.Write(data); err != nil {
			_ = fw.Close()
			return nil, err
		}
		if err := fw.Close(); err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("assetcache: unsupported encoding %q", encoding)
	}
	return buf.Bytes(), nil
}

// assetContentType resolves the Content-Type for an asset by extension, with a
// couple of fallbacks the stdlib mime table misses (.map, .wasm). Returns "" when
// unknown — the caller then declines to compress and lets FileServer sniff.
func assetContentType(ext string) string {
	if ct := mime.TypeByExtension(ext); ct != "" {
		return ct
	}
	switch ext {
	case ".map":
		return "application/json"
	case ".wasm":
		return "application/wasm"
	}
	return ""
}

// isCompressibleType reports whether a Content-Type is worth compressing
// (text + the common structured-text application types). Binary media (images,
// fonts, video) are already compressed and would only waste CPU.
func isCompressibleType(ct string) bool {
	if i := strings.IndexByte(ct, ';'); i >= 0 {
		ct = ct[:i] // drop any "; charset=…"
	}
	ct = strings.TrimSpace(ct)
	if strings.HasPrefix(ct, "text/") {
		return true
	}
	switch ct {
	case "application/json",
		"application/javascript",
		"application/manifest+json",
		"application/wasm",
		"application/xml",
		"image/svg+xml":
		return true
	}
	return false
}
