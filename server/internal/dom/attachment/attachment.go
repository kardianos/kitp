// Package attachment exposes per-card file attachments. The actual file
// content lives in the generic `file` table (filename + size + mime +
// chunk list); this domain just associates a `file` with a `card`.
//
// Two JSON dispatcher endpoints:
//   - attachment.list  — list active attachments for a card
//   - attachment.delete — soft-delete one attachment (the file + chunks
//                         linger until the CAS reaper sweeps them)
//   - attachment.create — link an existing file to a card. The client
//                         calls file.create first (with the chunk list)
//                         and feeds the resulting id here.
//
// Plus one HTTP route outside the dispatcher: GET
// /api/v1/attachment/{id}/download streams the chunks back in order.
package attachment

import (
	"context"
	"fmt"
	"log/slog"
	"reflect"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/cas"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// thumbDeps carries the optional plumbing the create handler needs to
// build a thumbnail server-side. Wired by SetThumbDeps in main.go after
// the CAS storage is constructed; if either field is nil, attachment.create
// silently skips thumb generation (so unit tests that don't care about
// images don't have to thread a Storage through).
var thumbDeps struct {
	storage *cas.Storage
	logger  *slog.Logger
}

// SetThumbDeps installs the CAS storage + logger used for server-side
// thumbnail generation. Call once from main.go after `cas.New(...)`.
// Safe to call with a nil storage to disable thumbs (used in tests).
func SetThumbDeps(storage *cas.Storage, logger *slog.Logger) {
	thumbDeps.storage = storage
	thumbDeps.logger = logger
}

// ListInput requests attachments for one card.
type ListInput struct {
	CardID int64 `json:"card_id" mcp:"required,desc=card to list attachments for"`
}

// Row is one attachment record. SizeBytes / MimeType / Filename come
// from the joined file row. ThumbFileID is non-zero when the server has
// generated (or recognised) a thumbnail; the client fetches it via
// GET /api/v1/attachment/{id}/thumb.
type Row struct {
	ID          int64  `json:"id" mcp:"desc=attachment row id"`
	CardID      int64  `json:"card_id" mcp:"desc=card the attachment belongs to"`
	FileID      int64  `json:"file_id" mcp:"desc=file row id"`
	Filename    string `json:"filename" mcp:"desc=display filename (from the file row)"`
	MimeType    string `json:"mime_type" mcp:"desc=MIME type (from the file row)"`
	SizeBytes   int64  `json:"size_bytes" mcp:"desc=total size across all chunks"`
	CreatedAt   string `json:"created_at" mcp:"desc=ISO8601 timestamp of the attachment row"`
	ThumbFileID int64  `json:"thumb_file_id" mcp:"desc=thumbnail file id (0 when no thumb)"`
	Kind        string `json:"kind" mcp:"desc=display bucket: image|pdf|other"`
}

// ListOutput wraps the rows.
type ListOutput struct {
	Rows []Row `json:"rows" mcp:"desc=attachments for the card, newest first"`
}

// DeleteInput soft-deletes one attachment row.
type DeleteInput struct {
	ID int64 `json:"id" mcp:"required,desc=attachment id to delete"`
}

// DeleteOutput acks the soft-delete.
type DeleteOutput struct {
	OK bool `json:"ok" mcp:"desc=true on successful soft-delete"`
}

// CreateInput links an existing `file` row to a card.
type CreateInput struct {
	CardID int64 `json:"card_id" mcp:"required,desc=card to attach to"`
	FileID int64 `json:"file_id" mcp:"required,desc=existing file row id (created via file.create)"`
}

// CreateOutput returns the freshly-created attachment.
type CreateOutput struct {
	ID          int64  `json:"id"`
	CardID      int64  `json:"card_id"`
	FileID      int64  `json:"file_id"`
	Filename    string `json:"filename"`
	MimeType    string `json:"mime_type"`
	SizeBytes   int64  `json:"size_bytes"`
	ThumbFileID int64  `json:"thumb_file_id"`
	Kind        string `json:"kind"`
}

// Register installs the JSON endpoints.
func Register(p *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "attachment",
		Action:       "list",
		Doc:          "List active attachments for a card, newest first.",
		InputType:    reflect.TypeFor[ListInput](),
		OutputType:   reflect.TypeFor[ListOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Run:          runList(p),
	})
	reg.Register(reg.Handler{
		Endpoint:   "attachment",
		Action:     "delete",
		Doc:        "Soft-delete an attachment. The file + chunks linger until the CAS reaper sweeps them.",
		InputType:  reflect.TypeFor[DeleteInput](),
		OutputType: reflect.TypeFor[DeleteOutput](),
		// Worker / manager / admin can attach + delete. The handler may
		// further restrict by ownership (e.g. only the uploader can
		// delete) — see reg.Unauthorized for the canonical error code.
		AllowedRoles: []string{"worker", "manager", "admin"},
		Run:          runDelete(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "attachment",
		Action:       "create",
		Doc:          "Link an existing file (created via file.create) to a card. Inserts the attachment row + an attachment_create activity in one tx.",
		InputType:    reflect.TypeFor[CreateInput](),
		OutputType:   reflect.TypeFor[CreateOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		Run:          runCreate(p),
	})
}

func runList(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(ListInput)
			if in.CardID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "attachment.list: card_id is required"}
			}
			rows, err := tx.Query(ctx, `
				SELECT a.id, a.card_id, a.file_id,
				       f.filename, f.mime_type, f.size_bytes,
				       a.created_at,
				       COALESCE(a.thumb_file_id, 0)
				FROM attachment a
				JOIN file f ON f.id = a.file_id
				WHERE a.card_id = $1 AND a.deleted_at IS NULL
				ORDER BY a.id DESC
			`, in.CardID)
			if err != nil {
				return nil, fmt.Errorf("attachment.list: %w", err)
			}
			var out []Row
			for rows.Next() {
				var r Row
				var createdAt time.Time
				if err := rows.Scan(&r.ID, &r.CardID, &r.FileID,
					&r.Filename, &r.MimeType, &r.SizeBytes, &createdAt,
					&r.ThumbFileID); err != nil {
					rows.Close()
					return nil, fmt.Errorf("attachment.list: scan: %w", err)
				}
				r.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
				r.Kind = string(KindFromMime(r.MimeType))
				out = append(out, r)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return nil, err
			}
			if p != nil {
				p.NoteRead()
			}
			outs[i] = ListOutput{Rows: out}
		}
		return outs, nil
	}
}

func runDelete(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		actorID := auth.ActorOrSystem(ctx)
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(DeleteInput)
			if in.ID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "attachment.delete: id is required"}
			}
			var deletedID int64
			err := tx.QueryRow(ctx, `
				WITH upd AS (
					UPDATE attachment a
					SET deleted_at = now()
					FROM file f
					WHERE a.id = $1 AND a.deleted_at IS NULL AND f.id = a.file_id
					RETURNING a.id, a.card_id, a.file_id, f.filename
				),
				ins_act AS (
					INSERT INTO activity (card_id, kind, value_old, actor_id)
					SELECT card_id, 'attachment_delete',
					       jsonb_build_object(
					           'attachment_id', id,
					           'file_id', file_id,
					           'filename', filename
					       ),
					       $2
					FROM upd
					RETURNING id
				)
				SELECT id FROM upd
			`, in.ID, actorID).Scan(&deletedID)
			if err != nil {
				if err == pgx.ErrNoRows {
					return nil, &reg.HandlerError{InputIndex: i, Code: "not_found",
						Message: "attachment.delete: attachment not found or already deleted"}
				}
				return nil, fmt.Errorf("attachment.delete: %w", err)
			}
			outs[i] = DeleteOutput{OK: true}
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}

func runCreate(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		actorID := auth.ActorOrSystem(ctx)
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(CreateInput)
			if in.CardID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "attachment.create: card_id is required"}
			}
			if in.FileID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "attachment.create: file_id is required"}
			}

			// 1. Pull the source file's metadata up front. We need the
			// mime to decide whether to attempt a thumbnail, and the
			// filename / size for the activity payload + response.
			var (
				filename  string
				mimeType  string
				sizeBytes int64
			)
			err := tx.QueryRow(ctx,
				`SELECT filename, mime_type, size_bytes FROM file WHERE id = $1`,
				in.FileID,
			).Scan(&filename, &mimeType, &sizeBytes)
			if err != nil {
				if err == pgx.ErrNoRows {
					return nil, &reg.HandlerError{InputIndex: i, Code: "not_found",
						Message: fmt.Sprintf("attachment.create: file %d not found", in.FileID)}
				}
				return nil, fmt.Errorf("attachment.create: file lookup: %w", err)
			}

			// 2. Best-effort thumbnail generation. Runs in its own tx
			// (via the pool, not our dispatcher tx) so a CPU-heavy
			// decode doesn't extend the dispatcher's lock window. If
			// the storage isn't wired (tests) or the source isn't an
			// image, skip; if generation errors, log and continue —
			// the attachment still commits, just without a thumb.
			var thumbFileID int64
			if canThumb(mimeType) && p != nil && thumbDeps.storage != nil {
				if id, terr := generateThumb(ctx, p.P, thumbDeps.storage, in.FileID, actorID); terr == nil {
					thumbFileID = id
				} else if thumbDeps.logger != nil {
					thumbDeps.logger.LogAttrs(ctx, slog.LevelWarn,
						"attachment thumb generation failed",
						slog.Int64("file_id", in.FileID),
						slog.String("mime", mimeType),
						slog.String("err", terr.Error()))
				}
			}

			// 3. Insert the attachment row + matching activity in one
			// CTE. thumb_file_id is NULL when we couldn't (or didn't)
			// build a thumb — the column is nullable.
			var thumbArg any
			if thumbFileID != 0 {
				thumbArg = thumbFileID
			}
			var id int64
			err = tx.QueryRow(ctx, `
				WITH ins_attach AS (
					INSERT INTO attachment (card_id, file_id, thumb_file_id)
					VALUES ($1, $2, $3)
					RETURNING id, card_id, file_id
				),
				ins_act AS (
					INSERT INTO activity (card_id, kind, value_new, actor_id)
					SELECT a.card_id, 'attachment_create',
					       jsonb_build_object(
					           'attachment_id', a.id,
					           'file_id', a.file_id,
					           'filename', $4::text
					       ),
					       $5
					FROM ins_attach a
					RETURNING id
				)
				SELECT id FROM ins_attach
			`, in.CardID, in.FileID, thumbArg, filename, actorID).Scan(&id)
			if err != nil {
				return nil, fmt.Errorf("attachment.create: %w", err)
			}
			outs[i] = CreateOutput{
				ID:          id,
				CardID:      in.CardID,
				FileID:      in.FileID,
				Filename:    filename,
				MimeType:    mimeType,
				SizeBytes:   sizeBytes,
				ThumbFileID: thumbFileID,
				Kind:        string(KindFromMime(mimeType)),
			}
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}
