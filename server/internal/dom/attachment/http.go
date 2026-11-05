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
	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/store"
)

// Config wires the attachment HTTP routes into the rest of the server.
// The browser upload side is two pieces (POST /api/v1/cas/chunk + the
// attachment.create dispatcher endpoint), wired separately by
// `cas.Mount` and `attachment.Register`; the signed one-shot upload
// route (see upload.go) lives here and needs the dispatcher.
type Config struct {
	Pool    *store.Pool
	Storage *cas.Storage
	// Dispatcher runs file.create + attachment.create for the signed
	// upload route, as the actor the link was minted for.
	Dispatcher *api.Server
	// MaxUploadBytes caps the whole-file body on the signed upload
	// route (ATTACHMENT_MAX_MB). Zero uses defaultUploadMaxBytes.
	MaxUploadBytes int64
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
//     attachment's thumb_file_id; 404 when no thumb
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
	// Public, signature-gated streaming route. Unlike the three Authed
	// routes above, this one carries no session/bearer credential: a
	// valid HMAC signature (minted by attachment.download_url) names the
	// account that minted the link (`u`), and that account's access is
	// checked again here (requireAttachmentAccess) before a byte goes
	// out, so a link stops working once its maker can't read the file
	// (review 2026-11-03 round 5). Bytes for all three modes flow through
	// the same streamBytes core; mode, u, exp and sig ride in the query
	// string. See link.go.
	rt.Public("GET /api/v1/attachment/{id}/dl", func(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
		return handleSignedStream(ctx, w, r, cfg)
	})
	// Public, signature-gated one-shot upload — the write-side twin of
	// /dl. A link minted by attachment.upload_url (which ran the
	// card.update-on-project gate against the requesting agent) lets an
	// MCP client attach a file with a plain `curl -T`, no session cookie
	// or bearer header. PUT is what `curl -T` sends; POST covers
	// `curl --data-binary @file`. See upload.go.
	upload := func(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
		return handleSignedUpload(ctx, w, r, cfg)
	}
	rt.Public("PUT /api/v1/attachment/upload", upload)
	rt.Public("POST /api/v1/attachment/upload", upload)
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
	// DI-3 in docs/DESIGN_INVARIANTS.md.
	if err := requireAttachmentAccess(ctx, cfg.Pool, user.ID, id); err != nil {
		return err
	}
	return streamBytes(ctx, w, cfg, id, mode)
}

// streamBytes is the credential-agnostic streaming core shared by the
// Authed routes (which call requireAttachmentAccess first) and the
// public signed /dl route (which verifies an HMAC signature first). It
// assumes the caller has already established access to `id`; it only
// resolves the file row + chunks and copies bytes to the writer.
func streamBytes(ctx context.Context, w http.ResponseWriter, cfg Config, id int64, mode streamMode) error {
	var err error
	// One round-trip to fetch the chosen file row's metadata + the
	// ordered chunk list. The same query covers all three modes — the
	// only knob is which `file` row to JOIN against (file_id vs.
	// thumb_file_id).
	var (
		filename, mime string
		fileID         int64
		totalBytes     int64
	)
	fileCol := "a.file_id"
	if mode == streamModeThumb {
		fileCol = "a.thumb_file_id"
	}
	lb := named.New()
	lb.Set("attachment", id)
	lookupSQL, lookupArgs, err := lb.Compile(`
		SELECT f.id, f.filename, f.mime_type, f.size_bytes
		FROM attachment a
		JOIN file f ON f.id = ` + fileCol + `
		WHERE a.id = :attachment AND a.deleted_at IS NULL`)
	if err != nil {
		return api.Internal(fmt.Errorf("lookup: compile: %w", err))
	}
	err = cfg.Pool.P.QueryRow(ctx, lookupSQL, lookupArgs...).Scan(&fileID, &filename, &mime, &totalBytes)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return api.NotFound("attachment not found")
		}
		return api.Internal(fmt.Errorf("lookup: %w", err))
	}

	cb := named.New()
	cb.Set("file", fileID)
	chunkSQL, chunkArgs, err := cb.Compile(`
		SELECT cas_address, chunk_size
		FROM file_chunk
		WHERE file_id = :file
		ORDER BY seq`)
	if err != nil {
		return api.Internal(fmt.Errorf("lookup chunks: compile: %w", err))
	}
	chunkRows, err := cfg.Pool.P.Query(ctx, chunkSQL, chunkArgs...)
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
	// The type is the uploader's claim. Served from kitp's own origin, an
	// HTML or script "attachment" would run with the viewer's session
	// (review B2), so only a type that can't carry script is shown inline;
	// anything else is a download of opaque bytes. nosniff stops the
	// browser guessing past that, and the sandbox keeps even an allowed
	// type from acting as a page. (A PDF isn't sandboxed: browsers won't
	// show a PDF in a sandboxed document, and their viewers don't run its
	// script on the page's origin.)
	h := w.Header()
	safe := InlineSafe(mime)
	if !safe {
		mime = "application/octet-stream"
	}
	h.Set("Content-Type", mime)
	h.Set("Content-Length", strconv.FormatInt(totalBytes, 10))
	h.Set("X-Content-Type-Options", "nosniff")
	if mime != "application/pdf" {
		h.Set("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'")
	}
	disposition := "inline"
	if mode == streamModeDownload || !safe {
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
	// The project is the attachment's card when that is a project, else
	// the project the card chains up to (card_enclosing_project: a task,
	// a page under other pages, a thread on a task). Both cases use the same `card.update` grant on the project's
	// card_type — matches projectexport.isAuthorized so the user has
	// one consistent gate across reads of the project's bytes.
	//
	// COALESCE the project_id to 0 so the scan never sees NULL — we
	// detect "no such attachment" by zero, not by NULL.
	var (
		projectID int64
		allowed   bool
	)
	b := named.New()
	b.Set("attachment", attachmentID)
	b.Set("user", userID)
	sql, args, err := b.Compile(`
		WITH attach AS (
			-- The project the attachment's card chains up to: a page under
			-- pages, a thread on a task, … not only a direct child
			-- (review B14).
			SELECT
				CASE
					WHEN ct.name = 'project' THEN a.card_id
					ELSE card_enclosing_project(a.card_id)
				END AS project_id
			FROM attachment a
			JOIN card c ON c.id = a.card_id
			JOIN card_type ct ON ct.id = c.card_type_id
			WHERE a.id = :attachment AND a.deleted_at IS NULL
			  -- An attachment of an area that is switched off doesn't
			  -- exist as far as anyone can tell (docs/AREAS.md).
			  AND NOT card_in_off_area(a.card_id)
			  -- Nor does one on someone else's private card
			  -- (docs/PERSONAL_SCREENS.md; review 2026-11-03 #23).
			  AND card_private_ok(a.card_id, :user)
			  -- Nor one on a deleted card, or under one (round 4 #16).
			  AND card_live(a.card_id)
		)
		SELECT
			COALESCE((SELECT project_id FROM attach), 0),
			EXISTS (
				SELECT 1
				FROM attach
				CROSS JOIN LATERAL user_role_effective(:user) ur
				JOIN role r        ON r.id  = ur.role_id
				JOIN role_grant rg ON rg.role_id = r.id
				JOIN card_type pct ON pct.id = rg.card_type_id AND pct.name = 'project'
				JOIN process p     ON p.id  = rg.process_id   AND p.name = 'card.update'
				WHERE attach.project_id IS NOT NULL
				  AND (ur.scope_card_id IS NULL OR ur.scope_card_id = attach.project_id)
			)
	`)
	if err != nil {
		return api.Internal(fmt.Errorf("authz: compile: %w", err))
	}
	err = pool.P.QueryRow(ctx, sql, args...).Scan(&projectID, &allowed)
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

// inlineTypes are the attachment types shown inline: pictures (not SVG,
// which can carry script), PDF, plain text, audio and video.
var inlineTypes = map[string]bool{
	"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true, "image/avif": true, "image/bmp": true,
	"application/pdf": true,
	"text/plain":      true,
	"audio/mpeg":      true, "audio/ogg": true, "audio/wav": true, "audio/webm": true,
	"video/mp4": true, "video/webm": true, "video/ogg": true,
}

// InlineSafe reports whether an attachment of this MIME type may be shown
// inline (review B2); every other type is served as a download.
func InlineSafe(mime string) bool {
	base := strings.ToLower(strings.TrimSpace(strings.SplitN(mime, ";", 2)[0]))
	return inlineTypes[base]
}
