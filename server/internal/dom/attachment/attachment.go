// Package attachment exposes per-card file attachments. The actual file
// content lives in the generic `file` table (filename + size + mime +
// chunk list); this domain just associates a `file` with a `card`.
//
// Two JSON dispatcher endpoints:
//   - attachment.list  — list active attachments for a card
//   - attachment.delete — soft-delete one attachment (the file + chunks
//     linger until the CAS reaper sweeps them)
//   - attachment.create — link an existing file to a card. The client
//     calls file.create first (with the chunk list)
//     and feeds the resulting id here.
//
// Plus one HTTP route outside the dispatcher: GET
// /api/v1/attachment/{id}/download streams the chunks back in order.
package attachment

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"reflect"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/cas"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/schema"
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
	CardID int64 `json:"card_id,string" mcp:"required,desc=card to list attachments for"`
}

// Row is one attachment record. SizeBytes / MimeType / Filename come
// from the joined file row. ThumbFileID is non-zero when the server has
// generated (or recognised) a thumbnail; the client fetches it via
// GET /api/v1/attachment/{id}/thumb.
type Row struct {
	ID          int64  `json:"id,string" mcp:"desc=attachment row id"`
	CardID      int64  `json:"card_id,string" mcp:"desc=card the attachment belongs to"`
	FileID      int64  `json:"file_id,string" mcp:"desc=file row id"`
	Filename    string `json:"filename" mcp:"desc=display filename (from the file row)"`
	MimeType    string `json:"mime_type" mcp:"desc=MIME type (from the file row)"`
	SizeBytes   int64  `json:"size_bytes" mcp:"desc=total size across all chunks"`
	CreatedAt   string `json:"created_at" mcp:"desc=ISO8601 timestamp of the attachment row"`
	ThumbFileID int64  `json:"thumb_file_id,string" mcp:"desc=thumbnail file id (0 when no thumb)"`
	Kind        string `json:"kind" mcp:"desc=display bucket: image|pdf|other"`
}

// ListOutput wraps the rows.
type ListOutput struct {
	Rows []Row `json:"rows" mcp:"desc=attachments for the card, newest first"`
}

// DeleteInput soft-deletes one attachment row.
type DeleteInput struct {
	ID int64 `json:"id,string" mcp:"required,desc=attachment id to delete"`
}

// DeleteOutput acks the soft-delete.
type DeleteOutput struct {
	OK bool `json:"ok" mcp:"desc=true on successful soft-delete"`
}

// CreateInput links an existing `file` row to a card.
type CreateInput struct {
	CardID int64 `json:"card_id,string" mcp:"required,desc=card to attach to"`
	FileID int64 `json:"file_id,string" mcp:"required,desc=existing file row id (created via file.create)"`
}

// CreateOutput returns the freshly-created attachment.
type CreateOutput struct {
	ID          int64  `json:"id,string"`
	CardID      int64  `json:"card_id,string"`
	FileID      int64  `json:"file_id,string"`
	Filename    string `json:"filename"`
	MimeType    string `json:"mime_type"`
	SizeBytes   int64  `json:"size_bytes"`
	ThumbFileID int64  `json:"thumb_file_id,string"`
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
		// Unified handler — body lives in
		// db/schema/functions/attachment_list_batch.sql.
		SQLFunc: "attachment_list_batch",
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
		ProcessName:  "card.update",
		CardTypeID:   cardTypeFromDeleteInput(p),
		// Input carries only the attachment id, not a card_id, so the
		// per-row scope pass needs an explicit resolver to dereference
		// attachment → card (then walk that card → project). Without it a
		// project-scoped manager would be denied (BE-H3 / A2).
		ScopeCardID: scopeCardFromDeleteInput(p),
		// Unified handler — body lives in
		// db/schema/functions/attachment_delete_batch.sql. See
		// docs/UNIFIED_HANDLER_PLAN.md Phase 2.
		SQLFunc: "attachment_delete_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "attachment",
		Action:       "create",
		Doc:          "Link an existing file (created via file.create) to a card. Inserts the attachment row + an attachment_create activity in one tx.",
		InputType:    reflect.TypeFor[CreateInput](),
		OutputType:   reflect.TypeFor[CreateOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "card.update",
		CardTypeID:   cardTypeFromCreateInput,
		// Unified handler — body lives in
		// db/schema/functions/attachment_create_batch.sql. The SQL
		// function writes the attachment + activity rows with
		// thumb_file_id=NULL; PostRun decodes any image bytes Go-side,
		// inserts a thumbnail `file` row, and UPDATEs the attachment
		// row to point at it — all within the same request tx.
		// See docs/UNIFIED_HANDLER_PLAN.md "Go-side post-write side
		// effects (PostRun hook needed)".
		SQLFunc: "attachment_create_batch",
		PostRun: doThumbnails(p),
	})
}

// cardTypeFromCreateInput resolves the attaching card's card_type so the
// dispatcher can scope-check the actor's `card.update` grant against
// that card's project. attachment.create takes a card_id in input.
func cardTypeFromCreateInput(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	return schema.CardTypeIDByCardID(ctx, pool, raw.(CreateInput).CardID)
}

// cardTypeFromDeleteInput resolves the card_type of the attachment's
// owning card. Delete input only carries the attachment id, so we
// join through attachment → card to find the card_type. Returns 0
// (skip authz) if the attachment doesn't resolve — the handler will
// surface a not-found error from runDelete.
func cardTypeFromDeleteInput(p *store.Pool) func(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	return func(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
		id := raw.(DeleteInput).ID
		var cardTypeID int64
		err := pool.QueryRow(ctx, `
			SELECT c.card_type_id
			FROM attachment a
			JOIN card c ON c.id = a.card_id
			WHERE a.id = $1
		`, id).Scan(&cardTypeID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return 0, nil
			}
			return 0, fmt.Errorf("attachment.delete: card_type lookup: %w", err)
		}
		return cardTypeID, nil
	}
}

// scopeCardFromDeleteInput dereferences the attachment to its owning
// card so the per-row scope pass can walk that card → project. Used as
// reg.Handler.ScopeCardID for attachment.delete (BE-H3 / A2). Returns
// (0, nil) on a missing attachment — the handler surfaces the proper
// not-found error.
func scopeCardFromDeleteInput(_ *store.Pool) func(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	return func(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
		id := raw.(DeleteInput).ID
		var cardID int64
		err := pool.QueryRow(ctx, `SELECT card_id FROM attachment WHERE id = $1`, id).Scan(&cardID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return 0, nil
			}
			return 0, fmt.Errorf("attachment.delete: card_id lookup: %w", err)
		}
		return cardID, nil
	}
}

// attachment.list is migrated to
// db/schema/functions/attachment_list_batch.sql per Phase 5 of
// docs/UNIFIED_HANDLER_PLAN.md. The Go-side runList is gone; the SQL
// function returns rows shaped to ListOutput / Row, including the
// 'kind' display bucket (KindFromMime stays Go-side for the HTTP
// download route + tests).

// doThumbnails is the PostRun hook for attachment.create. It runs
// after the SQL function (attachment_create_batch) has written the
// attachment + activity rows with thumb_file_id=NULL, in the same
// request tx. For each output we generated, if the source MIME is a
// supported image, we decode + downscale + JPEG-encode the bytes
// Go-side, insert a new `file` row for the thumb, then UPDATE the
// attachment row's thumb_file_id to point at it. The output struct
// is mutated in place so the dispatcher's wire response carries the
// freshly-minted thumb id.
//
// Side-effect / orphan-risk note (see UNIFIED_HANDLER_PLAN.md):
// `generateThumb` opens its OWN pgxpool tx for the thumb's
// `file` + `file_chunk` rows so the CPU-heavy decode doesn't widen
// the dispatcher's tx. If the outer request tx commits, the thumb
// is referenced by the attachment row and isn't reaper-eligible. If
// the outer tx rolls back, both the attachment INSERT and the
// thumb UPDATE are undone — but the thumb's `file` row is already
// committed via the separate pool tx, becoming a reaper-eligible
// orphan. Same risk profile as the pre-migration code.
//
// Best-effort: a generation failure logs + leaves thumb_file_id=0,
// rather than aborting the batch. The attachment row stays valid.
// Storage absence (tests) is treated the same as a non-image MIME —
// we just leave thumb_file_id=0.
func doThumbnails(p *store.Pool) func(ctx context.Context, tx store.Querier, ins []any, outs []any) error {
	return func(ctx context.Context, tx store.Querier, ins []any, outs []any) error {
		// Test mode (or before SetThumbDeps fires from main): nothing
		// to do. The legacy runCreate behaved the same way.
		if p == nil || thumbDeps.storage == nil {
			return nil
		}
		actorID := auth.ActorOrSystem(ctx)
		for i := range outs {
			out, ok := outs[i].(CreateOutput)
			if !ok {
				continue
			}
			if !canThumb(out.MimeType) {
				continue
			}
			thumbID, terr := generateThumb(ctx, p.P, thumbDeps.storage, out.FileID, actorID)
			if terr != nil {
				if thumbDeps.logger != nil {
					thumbDeps.logger.LogAttrs(ctx, slog.LevelWarn,
						"attachment thumb generation failed",
						slog.Int64("file_id", out.FileID),
						slog.String("mime", out.MimeType),
						slog.String("err", terr.Error()))
				}
				continue
			}
			if _, err := tx.Exec(ctx,
				`UPDATE attachment SET thumb_file_id = $1 WHERE id = $2`,
				thumbID, out.ID,
			); err != nil {
				return fmt.Errorf("attachment.create: post_run set thumb_file_id: %w", err)
			}
			out.ThumbFileID = thumbID
			outs[i] = out
		}
		return nil
	}
}
