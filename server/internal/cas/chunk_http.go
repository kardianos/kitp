package cas

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

// HTTPConfig wires the chunk-upload route into the rest of the server.
// Each "chunk" is one fragment of a logical file (~1 MB on the wire).
// The route hashes server-side, stores via the configured Storage head,
// and returns the address so the client can collect addresses + commit
// a manifest in one follow-up call.
//
// Logging for 5xx errors is owned by the apiRouter; this config no
// longer carries a Logger field.
type HTTPConfig struct {
	Pool     *store.Pool
	Storage  *Storage
	MaxBytes int64 // per-chunk cap; rejects 413 when exceeded
}

// Mount registers POST /api/v1/cas/chunk on the apiRouter as an Authed
// route. The body is the raw chunk bytes (Content-Type:
// application/octet-stream is the canonical client choice; anything
// else is treated as the chunk's MIME).
//
// Why raw body instead of multipart: multipart wraps the bytes in a
// boundary envelope (~200 B + per-part headers). For chunks sized at
// `MaxBytes` exactly, the envelope pushed the whole request over the
// cap, producing a 413 on otherwise-valid chunks. Raw bytes have zero
// overhead and the route stays this simple.
func Mount(rt *api.Router, cfg HTTPConfig) {
	if cfg.MaxBytes <= 0 {
		cfg.MaxBytes = 8 * 1024 * 1024 // a generous per-chunk cap; client picks ~1 MB
	}
	rt.Authed("POST /api/v1/cas/chunk", func(ctx context.Context, w http.ResponseWriter, r *http.Request, _ *auth.UserCtx) error {
		return handleChunkUpload(ctx, w, r, cfg)
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
			return &api.HTTPError{
				Status:  http.StatusRequestEntityTooLarge,
				Code:    "request_too_large",
				Message: fmt.Sprintf("chunk exceeds %d-byte limit", cfg.MaxBytes),
			}
		}
		// Don't leak the underlying io/MaxBytesReader/etc. message;
		// log the cause and return a generic message to the client.
		return api.Internal(fmt.Errorf("read_chunk: %w", err))
	}
	address := hasher.Address()
	size := int64(len(buf))
	head := cfg.Storage.Head()
	if head == nil {
		return api.Internal(fmt.Errorf("no CAS backend configured"))
	}
	// Idempotent: skip the write if a backend already has the bytes.
	exists, err := cfg.Storage.Has(ctx, address)
	if err != nil {
		return api.Internal(fmt.Errorf("cas has: %w", err))
	}
	if !exists {
		if err := head.Put(ctx, address, mime, size, buf); err != nil {
			return api.Internal(fmt.Errorf("cas put: %w", err))
		}
	}
	// Inline anonymous struct + json.Encoder so quoting / escaping is
	// correct by construction. Avoid hand-built `{"key":value}` —
	// the bytes-typed `address` field would break the moment a future
	// backend produced an address that needs escaping.
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(struct {
		Address   string `json:"address"`
		SizeBytes int64  `json:"size_bytes"`
	}{
		Address:   address,
		SizeBytes: size,
	}); err != nil {
		// Headers already flushed via Set+implicit-200; nothing useful
		// we can do besides logging. Returning err would let writeErr
		// try to write a second status.
		return nil
	}
	return nil
}
