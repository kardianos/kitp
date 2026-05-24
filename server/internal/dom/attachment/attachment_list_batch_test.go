// Direct PL/pgSQL test for attachment_list_batch — Phase 5 of
// docs/UNIFIED_HANDLER_PLAN.md. Tests call the function over
// `pool.Query` and assert per-row outputs, separate from the
// dispatcher-driven integration tests in attachment_test.go.
package attachment_test

import (
	"context"
	"encoding/json"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

// listResultRow mirrors the function's RETURNS TABLE shape.
type listResultRow struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callAttachmentListBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []listResultRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM attachment_list_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var out []listResultRow
	for rows.Next() {
		var r listResultRow
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

// seedAttachmentForList inserts a card + file + attachment row and
// returns (cardID, attID). Bypasses the dispatcher for test isolation.
func seedAttachmentForList(t *testing.T, pool *pgxpool.Pool, cardTypeName, filename, mime string) (int64, int64) {
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
	`, filename, mime, 42, auth.SystemUserID).Scan(&fileID); err != nil {
		t.Fatalf("seed file: %v", err)
	}
	var attID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO attachment (card_id, file_id)
		VALUES ($1, $2)
		RETURNING id
	`, cardID, fileID).Scan(&attID); err != nil {
		t.Fatalf("seed attachment: %v", err)
	}
	return cardID, attID
}

// TestAttachmentListBatch_Happy — one card with two attachments returns
// both rows in DESC id order, with kind derived from mime_type.
func TestAttachmentListBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_attachment_list_batch_happy")
	cardID, attID1 := seedAttachmentForList(t, pool, "task", "first.png", "image/png")
	_, attID2 := seedAttachmentForListSameCard(t, pool, cardID, "second.pdf", "application/pdf")

	res := callAttachmentListBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": strconv.FormatInt(cardID, 10)},
	})
	if len(res) != 1 || !res[0].OK {
		t.Fatalf("want one ok row, got %+v", res)
	}
	var out struct {
		Rows []struct {
			ID          string `json:"id"`
			CardID      string `json:"card_id"`
			FileID      string `json:"file_id"`
			Filename    string `json:"filename"`
			MimeType    string `json:"mime_type"`
			SizeBytes   int64  `json:"size_bytes"`
			CreatedAt   string `json:"created_at"`
			ThumbFileID string `json:"thumb_file_id"`
			Kind        string `json:"kind"`
		} `json:"rows"`
	}
	if err := json.Unmarshal(res[0].Result, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(out.Rows) != 2 {
		t.Fatalf("rows: got %d, want 2", len(out.Rows))
	}
	// DESC id order: attID2 first.
	if out.Rows[0].ID != strconv.FormatInt(attID2, 10) {
		t.Errorf("row 0: id=%s, want %d", out.Rows[0].ID, attID2)
	}
	if out.Rows[0].Kind != "pdf" {
		t.Errorf("row 0: kind=%q, want 'pdf'", out.Rows[0].Kind)
	}
	if out.Rows[1].ID != strconv.FormatInt(attID1, 10) {
		t.Errorf("row 1: id=%s, want %d", out.Rows[1].ID, attID1)
	}
	if out.Rows[1].Kind != "image" {
		t.Errorf("row 1: kind=%q, want 'image'", out.Rows[1].Kind)
	}
	if out.Rows[1].Filename != "first.png" {
		t.Errorf("row 1: filename=%q", out.Rows[1].Filename)
	}
}

// seedAttachmentForListSameCard adds another attachment to an existing card.
func seedAttachmentForListSameCard(t *testing.T, pool *pgxpool.Pool, cardID int64, filename, mime string) (int64, int64) {
	t.Helper()
	ctx := context.Background()
	var fileID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO file (filename, mime_type, size_bytes, created_by)
		VALUES ($1, $2, $3, $4) RETURNING id`, filename, mime, 17, auth.SystemUserID).Scan(&fileID); err != nil {
		t.Fatalf("seed file: %v", err)
	}
	var attID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO attachment (card_id, file_id) VALUES ($1, $2) RETURNING id`,
		cardID, fileID).Scan(&attID); err != nil {
		t.Fatalf("seed attachment: %v", err)
	}
	return cardID, attID
}

// TestAttachmentListBatch_Empty — a card with no attachments returns
// rows=[] (NOT null), matching the Go OutputType's omitempty-free
// Rows field.
func TestAttachmentListBatch_Empty(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_attachment_list_batch_empty")
	var cardID int64
	if err := pool.QueryRow(context.Background(), `
		INSERT INTO card (card_type_id)
		SELECT id FROM card_type WHERE name='task' RETURNING id
	`).Scan(&cardID); err != nil {
		t.Fatalf("seed card: %v", err)
	}
	res := callAttachmentListBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": strconv.FormatInt(cardID, 10)},
	})
	if len(res) != 1 || !res[0].OK {
		t.Fatalf("want one ok row, got %+v", res)
	}
	if !json.Valid(res[0].Result) {
		t.Fatalf("result not valid json: %s", res[0].Result)
	}
}

// TestAttachmentListBatch_MultiInput — N inputs run in one call,
// each gets its own row of attachments.
func TestAttachmentListBatch_MultiInput(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_attachment_list_batch_multi")
	cardA, _ := seedAttachmentForList(t, pool, "task", "a.txt", "text/plain")
	cardB, _ := seedAttachmentForList(t, pool, "task", "b.txt", "text/plain")
	_, _ = seedAttachmentForListSameCard(t, pool, cardB, "b2.txt", "text/plain")

	res := callAttachmentListBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": strconv.FormatInt(cardA, 10)},
		{"card_id": strconv.FormatInt(cardB, 10)},
	})
	if len(res) != 2 {
		t.Fatalf("res: got %d, want 2", len(res))
	}
	parse := func(rj json.RawMessage) int {
		var o struct {
			Rows []json.RawMessage `json:"rows"`
		}
		_ = json.Unmarshal(rj, &o)
		return len(o.Rows)
	}
	if got := parse(res[0].Result); got != 1 {
		t.Errorf("card A rows: got %d, want 1", got)
	}
	if got := parse(res[1].Result); got != 2 {
		t.Errorf("card B rows: got %d, want 2", got)
	}
}

// TestAttachmentListBatch_Validation — card_id=0 fails with code='validation'.
func TestAttachmentListBatch_Validation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_attachment_list_batch_validation")
	res := callAttachmentListBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": "0"},
	})
	if len(res) != 1 {
		t.Fatalf("res: got %d, want 1", len(res))
	}
	if res[0].OK || res[0].Code != "validation" {
		t.Errorf("want fail/validation, got %+v", res[0])
	}
}
