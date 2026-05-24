package attachment

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/cas"
	"github.com/kitp/kitp/server/internal/store"
)

// Config wires the download HTTP route into the rest of the server. The
// upload side is two pieces now (POST /api/v1/cas/chunk + the
// attachment.create dispatcher endpoint), wired separately by
// `cas.Mount` and `attachment.Register`.
type Config struct {
	Pool    *store.Pool
	Storage *cas.Storage
}

// Mount registers the streaming download / inline view / thumbnail
// routes on the apiRouter. The upload path lives in `cas.Mount`
// (see chunk_http.go).
//
// All three are Authed: an attachment id is enough to fetch the bytes,
// so we never want an unauthenticated request to pull them. Future
// per-attachment authz (only the project's members can view) would
// layer on top inside handleStream.
//
// Three routes share the same chunk-streaming guts but differ in headers
// and (for thumb) the `file` row they target:
//
//   - GET …/download  — Content-Disposition: attachment (forces save-as)
//   - GET …/view      — Content-Disposition: inline (renders in browser)
//   - GET …/thumb     — Content-Disposition: inline + targets the
//                       attachment's thumb_file_id; 404 when no thumb
func Mount(rt *api.Router, cfg Config) {
	rt.Authed("GET /api/v1/attachment/{id}/download", func(ctx context.Context, w http.ResponseWriter, r *http.Request, _ *auth.UserCtx) error {
		return handleStream(ctx, w, r, cfg, streamModeDownload)
	})
	rt.Authed("GET /api/v1/attachment/{id}/view", func(ctx context.Context, w http.ResponseWriter, r *http.Request, _ *auth.UserCtx) error {
		return handleStream(ctx, w, r, cfg, streamModeView)
	})
	rt.Authed("GET /api/v1/attachment/{id}/thumb", func(ctx context.Context, w http.ResponseWriter, r *http.Request, _ *auth.UserCtx) error {
		return handleStream(ctx, w, r, cfg, streamModeThumb)
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
		return api.BadRequest("validation", "invalid id")
	}

	user, ok := auth.FromContext(ctx)
	if !ok || user == nil || user.ID == 0 {
		return api.ErrUnauthenticated
	}
	// Per-row authz: caller must hold `card.update` on the
	// attachment's project (same gate projectexport uses). Without
	// this, any authenticated user could enumerate attachments by
	// sequential id — see
	// issues/backend/03-high-attachment-no-row-authz.md.
	if err := requireAttachmentAccess(ctx, cfg.Pool, user.ID, id); err != nil {
		return err
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
			return api.NotFound("attachment not found")
		}
		return api.Internal(fmt.Errorf("lookup: %w", err))
	}

	chunkRows, err := cfg.Pool.P.Query(ctx, `
		SELECT cas_address, chunk_size
		FROM file_chunk
		WHERE file_id = $1
		ORDER BY seq
	`, fileID)
	if err != nil {
		return api.Internal(fmt.Errorf("lookup chunks: %w", err))
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
			return api.Internal(fmt.Errorf("scan chunks: %w", err))
		}
		chunks = append(chunks, c)
	}
	chunkRows.Close()
	if err := chunkRows.Err(); err != nil {
		return api.Internal(fmt.Errorf("chunks rows: %w", err))
	}
	if len(chunks) == 0 {
		return api.Internal(fmt.Errorf("file has no chunks"))
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

	// One round-trip for every chunk via cas.GetAll — bytes stream
	// straight to the response writer as rows arrive. Closes S8's
	// per-chunk N+1. Once a row's been written the headers are
	// committed; a mid-stream failure surfaces as a truncated body
	// + a logged warning (returning an error here would be useless
	// — the router can't rewrite a flushed response into JSON).
	addrs := make([]string, len(chunks))
	for i, c := range chunks {
		addrs[i] = c.Address
	}
	if err := cfg.Storage.GetAll(ctx, addrs, w); err != nil {
		slog.Default().LogAttrs(ctx, slog.LevelError, "attachment download stream",
			slog.Int64("id", id),
			slog.String("err", err.Error()))
	}
	return nil
}

// requireAttachmentAccess gates the three HTTP routes on the same
// scoped grant projectexport uses: caller must hold `card.update`
// on the project that owns this attachment's parent task. Walks
// attachment → task → project so a worker scoped to project A
// can't pull project B's attachment by id enumeration.
//
// Returns `api.ErrNotFound` (not `Forbidden`) when the attachment id
// doesn't resolve to a project at all — the join's missing rows mean
// either the attachment doesn't exist or its task / parent chain is
// broken. Either way, the caller gets a 404, not "exists but you
// can't have it" (which would leak existence).
//
// Returns `api.ErrForbidden` when the chain resolves but the caller
// has no scoped grant.
func requireAttachmentAccess(ctx context.Context, pool *store.Pool, userID, attachmentID int64) error {
	// One round-trip: resolve the attachment's project AND check the
	// caller's grant against it. EXISTS short-circuits on first
	// matching grant row, so an admin with a global card.update sees
	// no extra cost over the single-row lookup.
	//
	// The project resolution handles both shapes seen in production:
	//   - attachment hangs directly off a project card  → project = a.card_id
	//   - attachment hangs off a task (or other child)  → project = card.parent_card_id
	// Both cases use the same `card.update` grant on the project's
	// card_type — matches projectexport.isAuthorized so the user has
	// one consistent gate across reads of the project's bytes.
	//
	// COALESCE the project_id to 0 so the scan never sees NULL — we
	// detect "no such attachment" by zero, not by NULL.
	var (
		projectID int64
		allowed   bool
	)
	err := pool.P.QueryRow(ctx, `
		WITH attach AS (
			SELECT
				CASE
					WHEN ct.name = 'project' THEN a.card_id
					ELSE c.parent_card_id
				END AS project_id
			FROM attachment a
			JOIN card c ON c.id = a.card_id
			JOIN card_type ct ON ct.id = c.card_type_id
			WHERE a.id = $1 AND a.deleted_at IS NULL
		)
		SELECT
			COALESCE((SELECT project_id FROM attach), 0),
			EXISTS (
				SELECT 1
				FROM attach
				JOIN user_role ur ON ur.user_id = $2
				JOIN role r        ON r.id  = ur.role_id
				JOIN role_grant rg ON rg.role_id = r.id
				JOIN card_type pct ON pct.id = rg.card_type_id AND pct.name = 'project'
				JOIN process p     ON p.id  = rg.process_id   AND p.name = 'card.update'
				WHERE attach.project_id IS NOT NULL
				  AND (ur.scope_card_id IS NULL OR ur.scope_card_id = attach.project_id)
			)
	`, attachmentID, userID).Scan(&projectID, &allowed)
	if err != nil {
		return api.Internal(fmt.Errorf("authz: %w", err))
	}
	if projectID == 0 {
		return api.NotFound("attachment not found")
	}
	if !allowed {
		return api.ErrForbidden
	}
	return nil
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
