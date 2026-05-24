// Direct PL/pgSQL test for attachment_delete_batch — Phase 2 of
// docs/UNIFIED_HANDLER_PLAN.md. Tests call the function over
// `pool.Query` and assert per-row outputs, separate from the
// dispatcher-driven integration tests in attachment_test.go.
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

// deleteResultRow mirrors the function's RETURNS TABLE shape.
type deleteResultRow struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callAttachmentDeleteBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []deleteResultRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM attachment_delete_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var out []deleteResultRow
	for rows.Next() {
		var r deleteResultRow
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

// seedAttachment inserts a card + file + attachment row directly,
// returning the new attachment id. We bypass the dispatcher so this
// function test stays independent of card.insert / file.create /
// attachment.create behaviour.
func seedAttachment(t *testing.T, pool *pgxpool.Pool, cardTypeName string) int64 {
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
	`, "seed.txt", "text/plain", 0, auth.SystemUserID).Scan(&fileID); err != nil {
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
	return attID
}

// TestAttachmentDeleteBatch_Happy — single happy path: one ok row,
// result JSON is {"ok": true}, and the row is soft-deleted with a
// matching attachment_delete activity row.
func TestAttachmentDeleteBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_attachment_delete_batch_happy")
	attID := seedAttachment(t, pool, "task")

	rows := callAttachmentDeleteBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"id": strconv.FormatInt(attID, 10)},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(rows))
	}
	r := rows[0]
	if !r.OK || r.Code != "" {
		t.Fatalf("want ok=true code=''; got ok=%v code=%q msg=%q", r.OK, r.Code, r.Message)
	}
	var got struct {
		OK bool `json:"ok"`
	}
	if err := json.Unmarshal(r.Result, &got); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	if !got.OK {
		t.Errorf("result.ok = false; want true")
	}
	// Soft-delete landed.
	var deletedAt *string
	if err := pool.QueryRow(context.Background(),
		`SELECT deleted_at::text FROM attachment WHERE id = $1`, attID).Scan(&deletedAt); err != nil {
		t.Fatalf("read deleted_at: %v", err)
	}
	if deletedAt == nil {
		t.Fatalf("attachment %d not soft-deleted", attID)
	}
	// Activity row written.
	var nActs int
	if err := pool.QueryRow(context.Background(), `
		SELECT count(*) FROM activity
		WHERE kind = 'attachment_delete'
		  AND (value_old->>'attachment_id')::bigint = $1
	`, attID).Scan(&nActs); err != nil {
		t.Fatalf("count activity: %v", err)
	}
	if nActs != 1 {
		t.Errorf("attachment_delete activity rows = %d, want 1", nActs)
	}
}

// TestAttachmentDeleteBatch_MultiRow — N inputs, all distinct
// attachments, all ok, idx order matches input order, every
// attachment ends up soft-deleted.
func TestAttachmentDeleteBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_attachment_delete_batch_multi")
	ids := []int64{
		seedAttachment(t, pool, "task"),
		seedAttachment(t, pool, "task"),
		seedAttachment(t, pool, "task"),
	}
	inputs := []map[string]any{
		{"id": strconv.FormatInt(ids[0], 10)},
		{"id": strconv.FormatInt(ids[1], 10)},
		{"id": strconv.FormatInt(ids[2], 10)},
	}
	rows := callAttachmentDeleteBatch(t, pool, auth.SystemUserID, inputs)
	if len(rows) != 3 {
		t.Fatalf("rows: got %d, want 3", len(rows))
	}
	for i, r := range rows {
		if r.Idx != i {
			t.Errorf("row %d: idx=%d, want %d", i, r.Idx, i)
		}
		if !r.OK {
			t.Errorf("row %d: ok=false code=%q msg=%q", i, r.Code, r.Message)
		}
	}
	var deletedCount int
	if err := pool.QueryRow(context.Background(), `
		SELECT count(*) FROM attachment
		WHERE id = ANY($1::bigint[]) AND deleted_at IS NOT NULL
	`, ids).Scan(&deletedCount); err != nil {
		t.Fatalf("count deleted: %v", err)
	}
	if deletedCount != len(ids) {
		t.Errorf("soft-deleted rows = %d, want %d", deletedCount, len(ids))
	}
}

// TestAttachmentDeleteBatch_NotFound — an id that doesn't resolve
// surfaces as code='not_found'.
func TestAttachmentDeleteBatch_NotFound(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_attachment_delete_batch_404")
	rows := callAttachmentDeleteBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"id": "999999"},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(rows))
	}
	r := rows[0]
	if r.OK {
		t.Fatalf("row 0 should fail: %+v", r)
	}
	if r.Code != "not_found" {
		t.Errorf("code=%q, want 'not_found'", r.Code)
	}
	if !strings.Contains(r.Message, "not found") {
		t.Errorf("message=%q, want contains 'not found'", r.Message)
	}
}

// TestAttachmentDeleteBatch_AlreadyDeleted — a second delete of the
// same attachment also returns 'not_found' (same surface as
// runDelete's original WHERE deleted_at IS NULL filter).
func TestAttachmentDeleteBatch_AlreadyDeleted(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_attachment_delete_batch_redelete")
	attID := seedAttachment(t, pool, "task")

	// First delete: ok.
	rows := callAttachmentDeleteBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"id": strconv.FormatInt(attID, 10)},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("first delete should succeed: %+v", rows)
	}

	// Second delete: not_found.
	rows = callAttachmentDeleteBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"id": strconv.FormatInt(attID, 10)},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(rows))
	}
	if rows[0].OK {
		t.Fatalf("second delete should fail: %+v", rows[0])
	}
	if rows[0].Code != "not_found" {
		t.Errorf("code=%q, want 'not_found'", rows[0].Code)
	}
}

// TestAttachmentDeleteBatch_Validation — id=0 / missing id fails
// with code='validation'.
func TestAttachmentDeleteBatch_Validation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_attachment_delete_batch_validation")
	rows := callAttachmentDeleteBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"id": "0"},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(rows))
	}
	if rows[0].OK {
		t.Fatalf("row 0 should fail: %+v", rows[0])
	}
	if rows[0].Code != "validation" {
		t.Errorf("code=%q, want 'validation'", rows[0].Code)
	}
}
