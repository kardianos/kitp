package cas

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/kitp/kitp/server/internal/store"
)

// HTTPConfig wires the chunk-upload route into the rest of the server.
// Each "chunk" is one fragment of a logical file (~1 MB on the wire).
// The route hashes server-side, stores via the configured Storage head,
// and returns the address so the client can collect addresses + commit
// a manifest in one follow-up call.
type HTTPConfig struct {
	Pool     *store.Pool
	Storage  *Storage
	MaxBytes int64        // per-chunk cap; rejects 413 when exceeded
	Logger   *slog.Logger // optional
}

// RegisterHTTP mounts POST /api/v1/cas/chunk on `mux`. The body is the
// raw chunk bytes (Content-Type: application/octet-stream is the
// canonical client choice; anything else is treated as the chunk's MIME).
//
// Why raw body instead of multipart: multipart wraps the bytes in a
// boundary envelope (~200 B + per-part headers). For chunks sized at
// `MaxBytes` exactly, the envelope pushed the whole request over the
// cap, producing a 413 on otherwise-valid chunks. Raw bytes have zero
// overhead and the route stays this simple.
func RegisterHTTP(mux *http.ServeMux, cfg HTTPConfig) {
	if cfg.MaxBytes <= 0 {
		cfg.MaxBytes = 8 * 1024 * 1024 // a generous per-chunk cap; client picks ~1 MB
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	mux.HandleFunc("POST /api/v1/cas/chunk", func(w http.ResponseWriter, r *http.Request) {
		if err := handleChunkUpload(r.Context(), w, r, cfg); err != nil {
			writeChunkErr(w, logger, err)
		}
	})
}

func handleChunkUpload(
	ctx context.Context,
	w http.ResponseWriter,
	r *http.Request,
	cfg HTTPConfig,
) error {
	mime := r.Header.Get("Content-Type")
	if mime == "" {
		mime = "application/octet-stream"
	}
	// MaxBytesReader caps the body before any read — exceeding it
	// surfaces as http.MaxBytesError on the next Read.
	r.Body = http.MaxBytesReader(w, r.Body, cfg.MaxBytes)
	hasher := NewHashingReader(r.Body)
	buf, err := io.ReadAll(hasher)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) ||
			strings.Contains(err.Error(), "request body too large") {
			return chunkErr(http.StatusRequestEntityTooLarge,
				fmt.Sprintf("chunk exceeds %d-byte limit", cfg.MaxBytes))
		}
		return chunkErr(http.StatusBadRequest, "read chunk: "+err.Error())
	}
	address := hasher.Address()
	size := int64(len(buf))
	head := cfg.Storage.Head()
	if head == nil {
		return chunkErr(http.StatusInternalServerError, "no CAS backend configured")
	}
	// Idempotent: skip the write if a backend already has the bytes.
	exists, err := cfg.Storage.Has(ctx, address)
	if err != nil {
		return chunkErr(http.StatusInternalServerError, "cas has: "+err.Error())
	}
	if !exists {
		if err := head.Put(ctx, address, mime, size, buf); err != nil {
			return chunkErr(http.StatusInternalServerError, "cas put: "+err.Error())
		}
	}
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"address":%q,"size_bytes":%d}`, address, size)
	return nil
}

// Mirror the typed-error pattern used by attachment/http.go without
// taking a dependency on it.
type chunkHTTPErr struct {
	status int
	msg    string
}

func (e *chunkHTTPErr) Error() string { return e.msg }

func chunkErr(status int, msg string) error {
	return &chunkHTTPErr{status: status, msg: msg}
}

func writeChunkErr(w http.ResponseWriter, logger *slog.Logger, err error) {
	status := http.StatusInternalServerError
	msg := err.Error()
	var he *chunkHTTPErr
	if errors.As(err, &he) {
		status = he.status
		msg = he.msg
	}
	if status >= 500 {
		logger.LogAttrs(context.Background(), slog.LevelError, "cas chunk http",
			slog.Int("status", status), slog.String("err", msg))
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = fmt.Fprintf(w, `{"error":%q}`, msg)
}
