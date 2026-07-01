package api

// Per-request response compression for the dynamic JSON API.
//
// The static-asset cache (assetcache.go) pre-compresses immutable bundle files
// ONCE at the highest ratio and memoises them. API responses are different:
// they're computed per request and can be large (a project's batch read is
// hundreds of KB of JSON). On a constrained uplink that transfer dominates the
// request, so it's worth compressing inline — but at a MODERATE level, since
// the CPU is paid on every request rather than amortised across cache hits.
// JSON over the wire still shrinks ~6-8x at these levels.

import (
	"compress/flate"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"

	"github.com/andybalholm/brotli"
)

// Per-request compression levels: fast enough to run inline on every response,
// still a large win on JSON. (The static cache uses BestCompression instead —
// it compresses each file once.)
const (
	brotliRequestLevel  = 4 // ~gzip-6 ratio, far faster than brotli-11
	gzipRequestLevel    = 5
	deflateRequestLevel = 5
)

// writeJSONCompressed streams v as JSON to the client, negotiating a
// content-encoding (brotli > gzip > deflate) from the request's Accept-Encoding
// and encoding the JSON directly through the compressor into the ResponseWriter
// (no intermediate full-size buffer). Falls back to identity when the client
// accepts no supported encoding. Use for large dynamic responses (the batch
// read); tiny responses don't benefit and can stay on writeJSON.
func writeJSONCompressed(w http.ResponseWriter, r *http.Request, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	// Idempotency-keyed requests are mutations: the idempotency layer captures
	// the response bytes, JSON-parses them to decide cacheability, and replays
	// them verbatim. A compressed buffer breaks that parse + replay, so keep
	// these identity (their responses are small — compression buys nothing).
	enc := negotiateEncoding(r.Header.Get("Accept-Encoding"))
	if r.Header.Get("Idempotency-Key") != "" {
		enc = ""
	}
	if enc == "" {
		w.WriteHeader(status)
		encodeJSON(w, v)
		return
	}
	w.Header().Set("Content-Encoding", enc)
	w.Header().Add("Vary", "Accept-Encoding")
	w.WriteHeader(status)

	var cw io.WriteCloser
	switch enc {
	case "br":
		cw = brotli.NewWriterLevel(w, brotliRequestLevel)
	case "gzip":
		cw, _ = gzip.NewWriterLevel(w, gzipRequestLevel)
	case "deflate":
		cw, _ = flate.NewWriter(w, deflateRequestLevel)
	default:
		encodeJSON(w, v) // unreachable: negotiateEncoding only returns the three above
		return
	}
	encodeJSON(cw, v)
	_ = cw.Close()
}

// encodeJSON writes v as JSON with HTML escaping off (matching writeJSON), so
// the compressed and identity paths produce byte-identical JSON.
func encodeJSON(w io.Writer, v any) {
	e := json.NewEncoder(w)
	e.SetEscapeHTML(false)
	_ = e.Encode(v)
}
