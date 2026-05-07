package attachment

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/cas"
	"github.com/kitp/kitp/server/internal/store"
)

// Config wires the download HTTP route into the rest of the server. The
// upload side is two pieces now (POST /api/v1/cas/chunk + the
// attachment.create dispatcher endpoint), wired separately by
// `cas.RegisterHTTP` and `attachment.Register`.
type Config struct {
	Pool    *store.Pool
	Storage *cas.Storage
	Logger  *slog.Logger
}

// RegisterHTTP mounts the streaming download / inline view / thumbnail
// routes. The upload path lives in `cas.RegisterHTTP` (see chunk_http.go).
//
// Three routes share the same chunk-streaming guts but differ in headers
// and (for thumb) the `file` row they target:
//
//   - GET …/download  — Content-Disposition: attachment (forces save-as)
//   - GET …/view      — Content-Disposition: inline (renders in browser)
//   - GET …/thumb     — Content-Disposition: inline + targets the
//                       attachment's thumb_file_id; 404 when no thumb
func RegisterHTTP(mux *http.ServeMux, cfg Config) {
	mux.HandleFunc("GET /api/v1/attachment/{id}/download", func(w http.ResponseWriter, r *http.Request) {
		if err := handleStream(r.Context(), w, r, cfg, streamModeDownload); err != nil {
			writeErr(w, cfg.Logger, err)
		}
	})
	mux.HandleFunc("GET /api/v1/attachment/{id}/view", func(w http.ResponseWriter, r *http.Request) {
		if err := handleStream(r.Context(), w, r, cfg, streamModeView); err != nil {
			writeErr(w, cfg.Logger, err)
		}
	})
	mux.HandleFunc("GET /api/v1/attachment/{id}/thumb", func(w http.ResponseWriter, r *http.Request) {
		if err := handleStream(r.Context(), w, r, cfg, streamModeThumb); err != nil {
			writeErr(w, cfg.Logger, err)
		}
	})
}

type streamMode int

const (
	// streamModeDownload sends Content-Disposition: attachment so the
	// browser triggers a save-as. Bytes come from attachment.file_id.
	streamModeDownload streamMode = iota
	// streamModeView is the same bytes as download but inline so the
	// browser renders them (used by the gallery modal for both images
	// and PDFs).
	streamModeView
	// streamModeThumb pulls from attachment.thumb_file_id instead and
	// 404s if the column is NULL. Always inline.
	streamModeThumb
)

// handleStream streams the attachment bytes back to the caller chunk by
// chunk. We intentionally don't materialise the whole file in memory —
// for a 200 MB attachment with 1 MB chunks we read each chunk via the
// CAS Storage and copy it straight to the response writer, then move on.
//
// `mode` selects the source `file` row (the attachment's own bytes vs.
// its thumbnail) and the Content-Disposition the response carries.
func handleStream(ctx context.Context, w http.ResponseWriter, r *http.Request, cfg Config, mode streamMode) error {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		return httpError(http.StatusBadRequest, "invalid id")
	}

	// One round-trip to fetch the chosen file row's metadata + the
	// ordered chunk list. The same query covers all three modes — the
	// only knob is which `file` row to JOIN against (file_id vs.
	// thumb_file_id).
	var (
		filename, mime string
		fileID         int64
		totalBytes     int64
	)
	var lookupSQL string
	switch mode {
	case streamModeThumb:
		lookupSQL = `
			SELECT f.id, f.filename, f.mime_type, f.size_bytes
			FROM attachment a
			JOIN file f ON f.id = a.thumb_file_id
			WHERE a.id = $1 AND a.deleted_at IS NULL
		`
	default:
		lookupSQL = `
			SELECT f.id, f.filename, f.mime_type, f.size_bytes
			FROM attachment a
			JOIN file f ON f.id = a.file_id
			WHERE a.id = $1 AND a.deleted_at IS NULL
		`
	}
	err = cfg.Pool.P.QueryRow(ctx, lookupSQL, id).Scan(&fileID, &filename, &mime, &totalBytes)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return httpError(http.StatusNotFound, "attachment not found")
		}
		return httpError(http.StatusInternalServerError, "lookup: "+err.Error())
	}

	chunkRows, err := cfg.Pool.P.Query(ctx, `
		SELECT cas_address, chunk_size
		FROM file_chunk
		WHERE file_id = $1
		ORDER BY seq
	`, fileID)
	if err != nil {
		return httpError(http.StatusInternalServerError, "lookup chunks: "+err.Error())
	}
	type chunkRef struct {
		Address string
		Size    int64
	}
	var chunks []chunkRef
	for chunkRows.Next() {
		var c chunkRef
		if err := chunkRows.Scan(&c.Address, &c.Size); err != nil {
			chunkRows.Close()
			return httpError(http.StatusInternalServerError, "scan chunks: "+err.Error())
		}
		chunks = append(chunks, c)
	}
	chunkRows.Close()
	if err := chunkRows.Err(); err != nil {
		return httpError(http.StatusInternalServerError, "chunks rows: "+err.Error())
	}
	if len(chunks) == 0 {
		return httpError(http.StatusInternalServerError, "file has no chunks")
	}

	// Headers go on the wire before the body — once we've started
	// streaming bytes we can't change status, so any failure inside the
	// loop surfaces as a truncated response. Logged for the operator.
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Content-Length", strconv.FormatInt(totalBytes, 10))
	disposition := "inline"
	if mode == streamModeDownload {
		disposition = "attachment"
	}
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`%s; filename="%s"`, disposition, sanitizeFilename(filename)))

	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	for _, c := range chunks {
		rc, err := cfg.Storage.Get(ctx, c.Address)
		if err != nil {
			logger.LogAttrs(ctx, slog.LevelError, "attachment download chunk get",
				slog.Int64("id", id),
				slog.String("chunk", c.Address),
				slog.String("err", err.Error()))
			return nil // headers already flushed; just stop
		}
		if _, err := io.Copy(w, rc); err != nil {
			rc.Close()
			logger.LogAttrs(ctx, slog.LevelWarn, "attachment download stream",
				slog.Int64("id", id),
				slog.String("chunk", c.Address),
				slog.String("err", err.Error()))
			return nil
		}
		rc.Close()
	}
	return nil
}

// httpErr is the typed-error wire shape the route hands to writeErr.
type httpErr struct {
	status int
	msg    string
}

func (e *httpErr) Error() string { return e.msg }

func httpError(status int, msg string) error {
	return &httpErr{status: status, msg: msg}
}

func writeErr(w http.ResponseWriter, logger *slog.Logger, err error) {
	status := http.StatusInternalServerError
	msg := err.Error()
	var he *httpErr
	if errors.As(err, &he) {
		status = he.status
		msg = he.msg
	}
	if status >= 500 {
		l := logger
		if l == nil {
			l = slog.Default()
		}
		l.LogAttrs(context.Background(), slog.LevelError, "attachment http",
			slog.Int("status", status), slog.String("err", msg))
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = fmt.Fprintf(w, `{"error":%q}`, msg)
}

// sanitizeFilename strips quote and CR/LF so a malicious filename can't
// inject extra Content-Disposition fields. The browser still sees the
// printable bytes verbatim.
func sanitizeFilename(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r == '"' || r == '\r' || r == '\n' {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}
