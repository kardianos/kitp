// Direct PL/pgSQL test for attachment_create_batch — Phase 2/3 of
// docs/UNIFIED_HANDLER_PLAN.md. These tests bypass the dispatcher
// entirely so they exercise the SQL function shape without the
// PostRun (thumbnail) hook — the integration tests in
// attachment_test.go cover the full create + thumb wire path.
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

// createResultRow mirrors the function's RETURNS TABLE shape.
type createResultRow struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callAttachmentCreateBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []createResultRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM attachment_create_batch($1::bigint, $2::jsonb)
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

// seedCardAndFile inserts a card + file row directly and returns their
// ids. Used by the create-function tests to set up the FK targets
// without going through card.insert / file.create handlers.
func seedCardAndFile(t *testing.T, pool *pgxpool.Pool, cardTypeName, filename, mime string, size int64) (int64, int64) {
	t.Helper()
	ctx := context.Background()
	var cardID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO card (card_type_id)
		SELECT id FROM card_type WHERE name = $1
		RETURNING id
	`, cardTypeName).Scan(&cardID); err != nil {
		t.Fatalf("seed card: %v", err)
	}
	var fileID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO file (filename, mime_type, size_bytes, created_by)
		VALUES ($1, $2, $3, $4)
		RETURNING id
	`, filename, mime, size, auth.SystemUserID).Scan(&fileID); err != nil {
		t.Fatalf("seed file: %v", err)
	}
	return cardID, fileID
}

// createOutputJSON is the shape attachment_create_batch returns on
// success. Mirrors attachment.CreateOutput — keep it in sync.
type createOutputJSON struct {
	ID          string `json:"id"`
	CardID      string `json:"card_id"`
	FileID      string `json:"file_id"`
	Filename    string `json:"filename"`
	MimeType    string `json:"mime_type"`
	SizeBytes   int64  `json:"size_bytes"`
	ThumbFileID string `json:"thumb_file_id"`
	Kind        string `json:"kind"`
}

// TestAttachmentCreateBatch_Happy — single input goes through cleanly,
// writes the attachment row + activity row, and surfaces the file's
// metadata in `result`. thumb_file_id is "0" at the SQL level — the
// Go-side PostRun hook overwrites it later for image MIME types.
func TestAttachmentCreateBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_attachment_create_batch_happy")
	cardID, fileID := seedCardAndFile(t, pool, "task", "notes.txt", "text/plain", 42)

	rows := callAttachmentCreateBatch(t, pool, auth.SystemUserID, []map[string]any{
		{
			"card_id": strconv.FormatInt(cardID, 10),
			"file_id": strconv.FormatInt(fileID, 10),
		},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(rows))
	}
	r := rows[0]
	if !r.OK || r.Code != "" {
		t.Fatalf("want ok=true; got ok=%v code=%q msg=%q", r.OK, r.Code, r.Message)
	}
	var got createOutputJSON
	if err := json.Unmarshal(r.Result, &got); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	if got.CardID != strconv.FormatInt(cardID, 10) {
		t.Errorf("card_id = %q, want %q", got.CardID, strconv.FormatInt(cardID, 10))
	}
	if got.FileID != strconv.FormatInt(fileID, 10) {
		t.Errorf("file_id = %q, want %q", got.FileID, strconv.FormatInt(fileID, 10))
	}
	if got.Filename != "notes.txt" || got.MimeType != "text/plain" || got.SizeBytes != 42 {
		t.Errorf("metadata mismatch: %+v", got)
	}
	if got.Kind != "other" {
		t.Errorf("kind = %q, want 'other'", got.Kind)
	}
	if got.ThumbFileID != "0" {
		t.Errorf("thumb_file_id = %q, want '0' (PostRun populates this)", got.ThumbFileID)
	}
	// attachment row landed with thumb_file_id NULL — the PostRun
	// hook fills it in only when a thumb is generated.
	var thumbFileID *int64
	if err := pool.QueryRow(context.Background(),
		`SELECT thumb_file_id FROM attachment WHERE id = $1`,
		mustAtoi64(t, got.ID)).Scan(&thumbFileID); err != nil {
		t.Fatalf("read attachment: %v", err)
	}
	if thumbFileID != nil {
		t.Errorf("attachment.thumb_file_id = %d, want NULL", *thumbFileID)
	}
	// Matching activity row written.
	var nActs int
	if err := pool.QueryRow(context.Background(), `
		SELECT count(*) FROM activity
		WHERE kind = 'attachment_create'
		  AND (value_new->>'attachment_id')::bigint = $1
		  AND value_new->>'filename' = 'notes.txt'
	`, mustAtoi64(t, got.ID)).Scan(&nActs); err != nil {
		t.Fatalf("count activity: %v", err)
	}
	if nActs != 1 {
		t.Errorf("attachment_create activity rows = %d, want 1", nActs)
	}
}

// TestAttachmentCreateBatch_MultiRow — N inputs over a mix of mime
// types; ok=true on every row, idx ordering preserved, kind reflects
// the source mime, attachments + activities all land.
func TestAttachmentCreateBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_attachment_create_batch_multi")
	cardA, fA := seedCardAndFile(t, pool, "task", "a.png", "image/png", 100)
	cardB, fB := seedCardAndFile(t, pool, "task", "b.pdf", "application/pdf", 200)
	cardC, fC := seedCardAndFile(t, pool, "task", "c.bin", "application/octet-stream", 300)

	inputs := []map[string]any{
		{"card_id": strconv.FormatInt(cardA, 10), "file_id": strconv.FormatInt(fA, 10)},
		{"card_id": strconv.FormatInt(cardB, 10), "file_id": strconv.FormatInt(fB, 10)},
		{"card_id": strconv.FormatInt(cardC, 10), "file_id": strconv.FormatInt(fC, 10)},
	}
	rows := callAttachmentCreateBatch(t, pool, auth.SystemUserID, inputs)
	if len(rows) != 3 {
		t.Fatalf("rows: got %d, want 3", len(rows))
	}
	wantKinds := []string{"image", "pdf", "other"}
	for i, r := range rows {
		if r.Idx != i {
			t.Errorf("row %d: idx=%d, want %d", i, r.Idx, i)
		}
		if !r.OK {
			t.Fatalf("row %d: ok=false code=%q msg=%q", i, r.Code, r.Message)
		}
		var got createOutputJSON
		if err := json.Unmarshal(r.Result, &got); err != nil {
			t.Fatalf("row %d: unmarshal result: %v", i, err)
		}
		if got.Kind != wantKinds[i] {
			t.Errorf("row %d: kind = %q, want %q", i, got.Kind, wantKinds[i])
		}
	}
	var attCount int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM attachment WHERE card_id = ANY($1::bigint[])`,
		[]int64{cardA, cardB, cardC}).Scan(&attCount); err != nil {
		t.Fatalf("count attachments: %v", err)
	}
	if attCount != 3 {
		t.Errorf("attachment rows = %d, want 3", attCount)
	}
}

// TestAttachmentCreateBatch_Validation — missing card_id or file_id
// each surface as code='validation' on the offending row, while
// well-formed siblings still write rows in the same call.
func TestAttachmentCreateBatch_Validation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_attachment_create_batch_validation")
	cardID, fileID := seedCardAndFile(t, pool, "task", "ok.txt", "text/plain", 1)

	inputs := []map[string]any{
		{"card_id": "0", "file_id": strconv.FormatInt(fileID, 10)},
		{"card_id": strconv.FormatInt(cardID, 10), "file_id": "0"},
		{"card_id": strconv.FormatInt(cardID, 10), "file_id": strconv.FormatInt(fileID, 10)},
	}
	rows := callAttachmentCreateBatch(t, pool, auth.SystemUserID, inputs)
	if len(rows) != 3 {
		t.Fatalf("rows: got %d, want 3", len(rows))
	}
	if rows[0].OK || rows[0].Code != "validation" || !strings.Contains(rows[0].Message, "card_id") {
		t.Errorf("row 0 = %+v, want validation/card_id", rows[0])
	}
	if rows[1].OK || rows[1].Code != "validation" || !strings.Contains(rows[1].Message, "file_id") {
		t.Errorf("row 1 = %+v, want validation/file_id", rows[1])
	}
	if !rows[2].OK {
		t.Errorf("row 2 = %+v, want ok=true", rows[2])
	}
}

// TestAttachmentCreateBatch_FileNotFound — pointing at a missing file
// id surfaces as code='not_found' (mirrors the legacy runCreate
// surface).
func TestAttachmentCreateBatch_FileNotFound(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_attachment_create_batch_404_file")
	var cardID int64
	if err := pool.QueryRow(context.Background(), `
		INSERT INTO card (card_type_id)
		SELECT id FROM card_type WHERE name = 'task'
		RETURNING id
	`).Scan(&cardID); err != nil {
		t.Fatalf("seed card: %v", err)
	}
	rows := callAttachmentCreateBatch(t, pool, auth.SystemUserID, []map[string]any{
		{
			"card_id": strconv.FormatInt(cardID, 10),
			"file_id": "999999",
		},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(rows))
	}
	if rows[0].OK {
		t.Fatalf("row should fail: %+v", rows[0])
	}
	if rows[0].Code != "not_found" {
		t.Errorf("code = %q, want 'not_found'", rows[0].Code)
	}
	if !strings.Contains(rows[0].Message, "not found") {
		t.Errorf("message = %q, want contains 'not found'", rows[0].Message)
	}
}

// TestAttachmentCreateBatch_UnknownCard — pointing at a card_id that
// doesn't exist falls out of the function body and surfaces as a
// FK violation at the tx level. The function itself doesn't
// pre-check card existence (the legacy Go body didn't either); FK
// is the gate. The wrapper maps SQLSTATE 23503 to code='fk_violation'.
func TestAttachmentCreateBatch_UnknownCard(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_attachment_create_batch_unknown_card")
	var fileID int64
	if err := pool.QueryRow(context.Background(), `
		INSERT INTO file (filename, mime_type, size_bytes, created_by)
		VALUES ($1, $2, $3, $4)
		RETURNING id
	`, "x.txt", "text/plain", 1, auth.SystemUserID).Scan(&fileID); err != nil {
		t.Fatalf("seed file: %v", err)
	}
	// Call the function directly; expect a foreign_key_violation
	// from the attachment INSERT (card_id 999999 doesn't exist).
	// Wrap in a tx so the failed statement doesn't leave a busted
	// connection behind in the pool (FK violation aborts the tx —
	// we rollback to release it cleanly).
	body, _ := json.Marshal([]map[string]any{
		{"card_id": "999999", "file_id": strconv.FormatInt(fileID, 10)},
	})
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, qErr := tx.Query(ctx, `
		SELECT idx, ok, code, message, result
		FROM attachment_create_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, auth.SystemUserID, body)
	if qErr == nil {
		for rows.Next() {
		}
		qErr = rows.Err()
		rows.Close()
	}
	if qErr == nil {
		t.Fatalf("expected fk violation error, got nil")
	}
	if !strings.Contains(qErr.Error(), "foreign key") && !strings.Contains(qErr.Error(), "23503") {
		t.Fatalf("expected fk violation, got: %v", qErr)
	}
}

func mustAtoi64(t *testing.T, s string) int64 {
	t.Helper()
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		t.Fatalf("parse int %q: %v", s, err)
	}
	return v
}
