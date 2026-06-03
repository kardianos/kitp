// Direct PL/pgSQL test for attachment_download_url_batch. Mirrors
// attachment_create_batch_test.go: it exercises the SQL function shape
// directly (validation, mode resolution, not-found surface) without the
// dispatcher or the Go-side PostRun (signDownloadURLs) that appends the
// signed url + expires_at — that hook is covered by link_test.go.
package attachment_test

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

func callAttachmentDownloadURLBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []createResultRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM attachment_download_url_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var out []createResultRow
	for rows.Next() {
		var r createResultRow
		var resJSON []byte
		if err := rows.Scan(&r.Idx, &r.OK, &r.Code, &r.Message, &resJSON); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if len(resJSON) > 0 {
			r.Result = json.RawMessage(append([]byte(nil), resJSON...))
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows.Err: %v", err)
	}
	return out
}

// seedAttachmentRow inserts an attachment row for (cardID, fileID),
// optionally with a thumb_file_id, and returns the attachment id. The
// download-url tests need explicit control over the thumb column, which
// the shared seedAttachment helper doesn't expose.
func seedAttachmentRow(t *testing.T, pool *pgxpool.Pool, cardID, fileID int64, thumbFileID *int64) int64 {
	t.Helper()
	var attID int64
	if err := pool.QueryRow(context.Background(), `
		INSERT INTO attachment (card_id, file_id, thumb_file_id)
		VALUES ($1, $2, $3)
		RETURNING id
	`, cardID, fileID, thumbFileID).Scan(&attID); err != nil {
		t.Fatalf("seed attachment: %v", err)
	}
	return attID
}

// downloadURLResultJSON mirrors the success shape (minus url/expires_at,
// which the PostRun fills in). Keep in sync with
// attachment.DownloadURLOutput.
type downloadURLResultJSON struct {
	ID        string `json:"id"`
	Mode      string `json:"mode"`
	Filename  string `json:"filename"`
	MimeType  string `json:"mime_type"`
	SizeBytes int64  `json:"size_bytes"`
}

func TestAttachmentDownloadURLBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_attachment_download_url_happy")
	cardID, fileID := seedCardAndFile(t, pool, "task", "report.pdf", "application/pdf", 4096)
	attID := seedAttachmentRow(t, pool, cardID, fileID, nil)

	rows := callAttachmentDownloadURLBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"id": strconv.FormatInt(attID, 10)}, // default mode
		{"id": strconv.FormatInt(attID, 10), "mode": "view"},
	})
	if len(rows) != 2 {
		t.Fatalf("rows: got %d, want 2", len(rows))
	}
	wantModes := []string{"download", "view"}
	for i, r := range rows {
		if !r.OK || r.Code != "" {
			t.Fatalf("row %d: ok=%v code=%q msg=%q", i, r.OK, r.Code, r.Message)
		}
		var got downloadURLResultJSON
		if err := json.Unmarshal(r.Result, &got); err != nil {
			t.Fatalf("row %d: unmarshal: %v", i, err)
		}
		if got.ID != strconv.FormatInt(attID, 10) {
			t.Errorf("row %d: id = %q, want %q", i, got.ID, strconv.FormatInt(attID, 10))
		}
		if got.Mode != wantModes[i] {
			t.Errorf("row %d: mode = %q, want %q", i, got.Mode, wantModes[i])
		}
		if got.Filename != "report.pdf" || got.MimeType != "application/pdf" || got.SizeBytes != 4096 {
			t.Errorf("row %d: metadata mismatch: %+v", i, got)
		}
	}
}

func TestAttachmentDownloadURLBatch_Validation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_attachment_download_url_validation")
	cardID, fileID := seedCardAndFile(t, pool, "task", "ok.txt", "text/plain", 1)
	attID := seedAttachmentRow(t, pool, cardID, fileID, nil)

	rows := callAttachmentDownloadURLBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"id": "0"},
		{"id": strconv.FormatInt(attID, 10), "mode": "bogus"},
		{"id": strconv.FormatInt(attID, 10), "mode": "download"},
	})
	if len(rows) != 3 {
		t.Fatalf("rows: got %d, want 3", len(rows))
	}
	if rows[0].OK || rows[0].Code != "validation" || !strings.Contains(rows[0].Message, "id") {
		t.Errorf("row 0 = %+v, want validation/id", rows[0])
	}
	if rows[1].OK || rows[1].Code != "validation" || !strings.Contains(rows[1].Message, "mode") {
		t.Errorf("row 1 = %+v, want validation/mode", rows[1])
	}
	if !rows[2].OK {
		t.Errorf("row 2 = %+v, want ok=true", rows[2])
	}
}

func TestAttachmentDownloadURLBatch_NotFound(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_attachment_download_url_notfound")
	cardID, fileID := seedCardAndFile(t, pool, "task", "x.bin", "application/octet-stream", 9)
	// Attachment with no thumbnail: a thumb request must 404.
	attID := seedAttachmentRow(t, pool, cardID, fileID, nil)
	// Soft-deleted attachment: any mode must 404.
	delID := seedAttachmentRow(t, pool, cardID, fileID, nil)
	if _, err := pool.Exec(context.Background(),
		`UPDATE attachment SET deleted_at = now() WHERE id = $1`, delID); err != nil {
		t.Fatalf("soft-delete: %v", err)
	}

	rows := callAttachmentDownloadURLBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"id": "999999"}, // missing
		{"id": strconv.FormatInt(attID, 10), "mode": "thumb"}, // no thumb
		{"id": strconv.FormatInt(delID, 10)},                  // deleted
	})
	if len(rows) != 3 {
		t.Fatalf("rows: got %d, want 3", len(rows))
	}
	for i, r := range rows {
		if r.OK || r.Code != "not_found" {
			t.Errorf("row %d = %+v, want not_found", i, r)
		}
	}
}

func TestAttachmentDownloadURLBatch_Thumb(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_attachment_download_url_thumb")
	cardID, fileID := seedCardAndFile(t, pool, "task", "photo.png", "image/png", 2048)
	_, thumbID := seedCardAndFile(t, pool, "task", "photo_thumb.jpg", "image/jpeg", 256)
	attID := seedAttachmentRow(t, pool, cardID, fileID, &thumbID)

	rows := callAttachmentDownloadURLBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"id": strconv.FormatInt(attID, 10), "mode": "thumb"},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("row: %+v", rows)
	}
	var got downloadURLResultJSON
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	// Thumb mode resolves the thumb file's metadata, not the original.
	if got.Mode != "thumb" || got.Filename != "photo_thumb.jpg" || got.MimeType != "image/jpeg" || got.SizeBytes != 256 {
		t.Errorf("thumb metadata mismatch: %+v", got)
	}
}
