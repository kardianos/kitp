// Direct PL/pgSQL test for comment_insert_batch — the Phase 1
// reference of docs/UNIFIED_HANDLER_PLAN.md. Tests call the function
// over `tx.Query` and assert per-row outputs, separate from the
// dispatcher-driven integration test in comment_test.go.
package comment_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

// resultRow mirrors the function's RETURNS TABLE shape.
type resultRow struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callCommentInsertBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []resultRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM comment_insert_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var out []resultRow
	for rows.Next() {
		var r resultRow
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

// seedCard creates a card row directly and returns its id. We
// bypass the dispatcher so the function test stays independent of
// card.insert's behaviour.
func seedCard(t *testing.T, pool *pgxpool.Pool, cardTypeName string) int64 {
	t.Helper()
	ctx := context.Background()
	var id int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO card (card_type_id)
		SELECT id FROM card_type WHERE name = $1
		RETURNING id
	`, cardTypeName).Scan(&id); err != nil {
		t.Fatalf("seed card: %v", err)
	}
	return id
}

// TestCommentInsertBatch_Happy — single happy path: one input,
// one ok row, result JSONB matches InsertOutput shape.
func TestCommentInsertBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comment_insert_batch_happy")
	cardID := seedCard(t, pool, "task")
	rows := callCommentInsertBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": jsonInt(cardID), "body": "hello world"},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(rows))
	}
	r := rows[0]
	if !r.OK || r.Code != "" {
		t.Errorf("want ok=true code=''; got ok=%v code=%q msg=%q", r.OK, r.Code, r.Message)
	}
	if r.Result == nil {
		t.Fatalf("result is nil on happy path")
	}
	var got struct {
		OK            bool   `json:"ok"`
		ActivityID    string `json:"activity_id"`
		CommentBodyID string `json:"comment_body_id"`
	}
	if err := json.Unmarshal(r.Result, &got); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	if !got.OK {
		t.Errorf("result.ok = false")
	}
	if got.ActivityID == "" || got.CommentBodyID == "" {
		t.Errorf("result ids missing: %+v", got)
	}
}

// TestCommentInsertBatch_MultiRow — N inputs, all ok, ids unique,
// idx order matches input order.
func TestCommentInsertBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comment_insert_batch_multi")
	cardID := seedCard(t, pool, "task")
	inputs := []map[string]any{
		{"card_id": jsonInt(cardID), "body": "first"},
		{"card_id": jsonInt(cardID), "body": "second"},
		{"card_id": jsonInt(cardID), "body": "third"},
	}
	rows := callCommentInsertBatch(t, pool, auth.SystemUserID, inputs)
	if len(rows) != 3 {
		t.Fatalf("rows: got %d, want 3", len(rows))
	}
	seen := map[string]bool{}
	for i, r := range rows {
		if r.Idx != i {
			t.Errorf("row %d: idx=%d, want %d", i, r.Idx, i)
		}
		if !r.OK {
			t.Errorf("row %d: ok=false code=%q", i, r.Code)
			continue
		}
		var got struct {
			ActivityID string `json:"activity_id"`
		}
		if err := json.Unmarshal(r.Result, &got); err != nil {
			t.Fatalf("row %d: unmarshal: %v", i, err)
		}
		if seen[got.ActivityID] {
			t.Errorf("row %d: duplicate activity_id %s", i, got.ActivityID)
		}
		seen[got.ActivityID] = true
	}
}

// TestCommentInsertBatch_PerRowFailure — 1 of 3 inputs fails
// validation (missing body); the other two succeed. The dispatcher's
// first-error semantics live on top of this, but the function
// itself reports per-row.
func TestCommentInsertBatch_PerRowFailure(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comment_insert_batch_perrow")
	cardID := seedCard(t, pool, "task")
	inputs := []map[string]any{
		{"card_id": jsonInt(cardID), "body": "good"},
		{"card_id": jsonInt(cardID), "body": ""},         // missing body
		{"card_id": jsonInt(cardID), "body": "also good"},
	}
	rows := callCommentInsertBatch(t, pool, auth.SystemUserID, inputs)
	if len(rows) != 3 {
		t.Fatalf("rows: got %d, want 3", len(rows))
	}
	if !rows[0].OK || !rows[2].OK {
		t.Errorf("rows 0 and 2 should be ok; got [0]=%+v [2]=%+v", rows[0], rows[2])
	}
	if rows[1].OK {
		t.Fatalf("row 1 should fail")
	}
	if rows[1].Code != "validation" {
		t.Errorf("row 1: code=%q, want 'validation'", rows[1].Code)
	}
	if !strings.Contains(rows[1].Message, "body is required") {
		t.Errorf("row 1: message=%q, want contains 'body is required'", rows[1].Message)
	}
}

// TestCommentInsertBatch_CardNotFound — card_id that doesn't
// resolve produces code='card_not_found'.
func TestCommentInsertBatch_CardNotFound(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comment_insert_batch_404")
	rows := callCommentInsertBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": "999999", "body": "no card here"},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(rows))
	}
	if rows[0].OK {
		t.Fatalf("row 0 should fail: %+v", rows[0])
	}
	if rows[0].Code != "card_not_found" {
		t.Errorf("code=%q, want 'card_not_found'", rows[0].Code)
	}
}

// jsonInt formats an int64 as the string-of-digits the dispatcher's
// wire convention uses for 64-bit ids.
func jsonInt(v int64) string {
	return decToString(v)
}

func decToString(v int64) string {
	// strconv would do — avoid the import churn in tests.
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
