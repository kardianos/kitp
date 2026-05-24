package attachment

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	_ "image/gif"  // register GIF decoder
	"image/jpeg"
	_ "image/png" // register PNG decoder
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp" // register WebP decoder

	"github.com/kitp/kitp/server/internal/cas"
)

// Server-side thumbnail generation for image attachments.
//
// Pipeline: read every chunk for the source `file` row out of CAS,
// concatenate into one buffer, decode with image.Decode, downscale with
// x/image/draw, re-encode as JPEG (quality 60), then store the thumb
// bytes in CAS + insert a new `file` row pointing at them. The new file
// id is returned to the caller (typically attachment.runCreate) so it
// can populate `attachment.thumb_file_id`.
//
// The work runs in its own short pgxpool tx (not the caller's
// dispatcher tx). Why: image decode/encode is CPU-bound and may take
// double-digit ms on a 4K photo; we don't want to hold the dispatcher
// tx open across that. Side effect: if the caller's tx later rolls
// back, the thumb `file` row becomes an orphan — the CAS reaper sweeps
// orphan file rows past the grace period, so nothing leaks.

const (
	// thumbMaxEdge caps the longer side of the thumbnail in pixels.
	// 256 keeps the strip + gallery hover sharp at 2× DPR while staying
	// well under 100 KB for most photos at quality 60.
	thumbMaxEdge = 256
	// thumbJPEGQuality favours bytes-on-the-wire over fidelity. Thumbs
	// are decorative; the modal view shows the original.
	thumbJPEGQuality = 60
	// thumbMime is what we tag the encoded JPEG row with.
	thumbMime = "image/jpeg"
)

// Kind classifies an attachment for client display. Images get a real
// thumbnail; PDFs render with the browser's native viewer in the modal
// (and a placeholder in the strip); everything else just shows up in
// the attachments list, no preview row entry.
type Kind string

const (
	KindImage Kind = "image"
	KindPDF   Kind = "pdf"
	KindOther Kind = "other"
)

// KindFromMime maps a mime type to the Kind bucket the client cares
// about. Lowercased + trimmed so a client sending `IMAGE/PNG` still
// gets classified as an image.
func KindFromMime(mime string) Kind {
	switch strings.ToLower(strings.TrimSpace(mime)) {
	case "image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp":
		return KindImage
	case "application/pdf":
		return KindPDF
	}
	return KindOther
}

// canThumb reports whether the server can build a thumb for this mime.
func canThumb(mime string) bool { return KindFromMime(mime) == KindImage }

// generateThumb decodes the source file's bytes from CAS, builds a
// downsized JPEG, stores it as a fresh `file` row, and returns the new
// file id. Runs in its own pool tx (see file-level comment).
//
// `actorID` is the user_account.id stamped onto the thumb row's
// `created_by` column — passed in rather than auth.ActorOrSystem(ctx)
// so the caller's authoritative actor flows through (the dispatcher
// pulls it from request context once and we want the same id on every
// row this request touches).
func generateThumb(
	ctx context.Context,
	pool *pgxpool.Pool,
	storage *cas.Storage,
	srcFileID int64,
	actorID int64,
) (int64, error) {
	// 1. Pull chunk addresses for the source. We need them ordered so
	//    the reassembled bytes match what `image.Decode` expects.
	addrs, err := loadChunkAddresses(ctx, pool, srcFileID)
	if err != nil {
		return 0, fmt.Errorf("thumb: load chunks: %w", err)
	}
	if len(addrs) == 0 {
		return 0, fmt.Errorf("thumb: source file %d has no chunks", srcFileID)
	}

	// 2. Concatenate every chunk into one buffer via a single
	//    cas.GetAll. image.Decode needs the whole stream in memory
	//    anyway; the size cap (~250 MB) bounds the buffer.
	var raw bytes.Buffer
	if err := storage.GetAll(ctx, addrs, &raw); err != nil {
		return 0, fmt.Errorf("thumb: cas get_all: %w", err)
	}

	src, _, err := image.Decode(&raw)
	if err != nil {
		return 0, fmt.Errorf("thumb: decode: %w", err)
	}

	dstW, dstH := fitWithin(src.Bounds().Dx(), src.Bounds().Dy(), thumbMaxEdge)
	if dstW <= 0 || dstH <= 0 {
		return 0, fmt.Errorf("thumb: zero-area source bounds %v", src.Bounds())
	}
	dst := image.NewRGBA(image.Rect(0, 0, dstW, dstH))
	// ApproxBiLinear is the fastest of the x/image/draw scalers and
	// produces visually fine thumbnails at this ratio. CatmullRom looks
	// nicer at 2× scale-down but costs ~5× as much CPU.
	draw.ApproxBiLinear.Scale(dst, dst.Bounds(), src, src.Bounds(), draw.Over, nil)

	var jpegBuf bytes.Buffer
	if err := jpeg.Encode(&jpegBuf, dst, &jpeg.Options{Quality: thumbJPEGQuality}); err != nil {
		return 0, fmt.Errorf("thumb: encode jpeg: %w", err)
	}
	data := jpegBuf.Bytes()

	// 3. CAS write. Compute the SHA-256 ourselves so we can reuse the
	//    existing dedupe path (Has → skip Put when bytes already
	//    present).
	sum := sha256.Sum256(data)
	addr := hex.EncodeToString(sum[:])

	head := storage.Head()
	if head == nil {
		return 0, fmt.Errorf("thumb: no cas backend configured")
	}
	exists, err := storage.Has(ctx, addr)
	if err != nil {
		return 0, fmt.Errorf("thumb: cas has: %w", err)
	}
	if !exists {
		if err := head.Put(ctx, addr, thumbMime, int64(len(data)), data); err != nil {
			return 0, fmt.Errorf("thumb: cas put: %w", err)
		}
	}

	// 4. Insert the `file` + `file_chunk` rows in one tx (separate from
	//    the dispatcher tx — see file-level comment).
	type chunkRow struct {
		Seq        int    `json:"seq"`
		Address    string `json:"cas_address"`
		ChunkSize  int64  `json:"chunk_size"`
	}
	chunkBuf, err := json.Marshal([]chunkRow{{Seq: 0, Address: addr, ChunkSize: int64(len(data))}})
	if err != nil {
		return 0, fmt.Errorf("thumb: marshal chunks: %w", err)
	}

	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return 0, fmt.Errorf("thumb: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var fileID int64
	err = tx.QueryRow(ctx, `
		WITH ins_file AS (
			INSERT INTO file (filename, size_bytes, mime_type, created_by)
			VALUES ($1, $2, $3, $4)
			RETURNING id
		),
		ins_chunks AS (
			INSERT INTO file_chunk (file_id, seq, cas_address, chunk_size)
			SELECT (SELECT id FROM ins_file), seq, cas_address, chunk_size
			FROM jsonb_to_recordset($5::jsonb)
			AS x(seq int, cas_address text, chunk_size bigint)
			RETURNING file_id
		)
		SELECT id FROM ins_file
	`, "thumb.jpg", int64(len(data)), thumbMime, actorID, chunkBuf).Scan(&fileID)
	if err != nil {
		return 0, fmt.Errorf("thumb: insert file: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("thumb: commit: %w", err)
	}
	return fileID, nil
}

// loadChunkAddresses returns the chunk addresses for a `file` row, in
// seq order. Read uses the pool directly so the caller can hand off
// after committing its own tx.
func loadChunkAddresses(ctx context.Context, pool *pgxpool.Pool, fileID int64) ([]string, error) {
	rows, err := pool.Query(ctx, `
		SELECT cas_address FROM file_chunk
		WHERE file_id = $1
		ORDER BY seq
	`, fileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var a string
		if err := rows.Scan(&a); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// fitWithin returns the largest (w', h') that preserves aspect ratio
// and fits inside a maxEdge × maxEdge square. Either edge can already
// be smaller — we leave the source size alone in that case so we don't
// upscale a tiny avatar.
func fitWithin(w, h, maxEdge int) (int, int) {
	if w <= 0 || h <= 0 {
		return 0, 0
	}
	if w <= maxEdge && h <= maxEdge {
		return w, h
	}
	if w >= h {
		return maxEdge, max(1, h*maxEdge/w)
	}
	return max(1, w*maxEdge/h), maxEdge
}
