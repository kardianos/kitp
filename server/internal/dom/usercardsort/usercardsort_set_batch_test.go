// Direct PL/pgSQL test for user_card_sort_set_batch — Phase 2 of
// docs/UNIFIED_HANDLER_PLAN.md. Tests call the function over
// `tx.Query` and assert per-row outputs, separate from the
// dispatcher-driven integration test in usercardsort_test.go.
package usercardsort_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

// batchRow mirrors the function's RETURNS TABLE shape.
type batchRow struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callUserCardSortSetBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []batchRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM user_card_sort_set_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var out []batchRow
	for rows.Next() {
		var r batchRow
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

// seedTaskCard inserts one task card directly (bypassing the
// dispatcher / Gate kernel) so the function test stays focused on
// the function body. It cuts the same corner as the comment test —
// no parent / status edge required at this layer, since the function
// itself doesn't enforce them.
func seedTaskCard(t *testing.T, pool *pgxpool.Pool) int64 {
	t.Helper()
	ctx := context.Background()
	var id int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO card (card_type_id)
		SELECT id FROM card_type WHERE name = 'task'
		RETURNING id
	`).Scan(&id); err != nil {
		t.Fatalf("seed card: %v", err)
	}
	return id
}

// TestUserCardSortSetBatch_Happy — single happy path: one input,
// one ok row, the upsert lands.
func TestUserCardSortSetBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_ucs_batch_happy")
	cardID := seedTaskCard(t, pool)
	rows := callUserCardSortSetBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": int64ToString(cardID), "sort_order": 12.5},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(rows))
	}
	r := rows[0]
	if !r.OK || r.Code != "" {
		t.Errorf("want ok=true code=''; got ok=%v code=%q msg=%q", r.OK, r.Code, r.Message)
	}
	var got struct {
		OK bool `json:"ok"`
	}
	if err := json.Unmarshal(r.Result, &got); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	if !got.OK {
		t.Errorf("result.ok = false")
	}
	// Verify the row actually landed.
	var got_so float64
	if err := pool.QueryRow(context.Background(),
		`SELECT sort_order FROM user_card_sort WHERE user_id = $1 AND card_id = $2`,
		auth.SystemUserID, cardID,
	).Scan(&got_so); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if got_so != 12.5 {
		t.Errorf("sort_order: got %v, want 12.5", got_so)
	}
}

// TestUserCardSortSetBatch_MultiRow — N inputs, all ok, ordered.
// Verifies a re-set wins (PK upsert).
func TestUserCardSortSetBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_ucs_batch_multi")
	c1 := seedTaskCard(t, pool)
	c2 := seedTaskCard(t, pool)
	c3 := seedTaskCard(t, pool)
	rows := callUserCardSortSetBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": int64ToString(c1), "sort_order": 10.0},
		{"card_id": int64ToString(c2), "sort_order": 20.0},
		{"card_id": int64ToString(c3), "sort_order": 30.0},
		// Re-set c1 to a new value — last write wins.
		{"card_id": int64ToString(c1), "sort_order": 99.0},
	})
	if len(rows) != 4 {
		t.Fatalf("rows: got %d, want 4", len(rows))
	}
	for i, r := range rows {
		if r.Idx != i {
			t.Errorf("row %d: idx=%d, want %d", i, r.Idx, i)
		}
		if !r.OK {
			t.Errorf("row %d: ok=false code=%q msg=%q", i, r.Code, r.Message)
		}
	}
	// PK ensures one row per (user, card); c1 final value is 99.
	var got float64
	if err := pool.QueryRow(context.Background(),
		`SELECT sort_order FROM user_card_sort WHERE user_id = $1 AND card_id = $2`,
		auth.SystemUserID, c1,
	).Scan(&got); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if got != 99.0 {
		t.Errorf("c1 sort_order: got %v, want 99.0 (upsert should overwrite)", got)
	}
}

// TestUserCardSortSetBatch_PerRowValidation — 1 of 3 inputs is
// missing card_id; the other two succeed and the validation row
// reports code='validation' with the right message.
func TestUserCardSortSetBatch_PerRowValidation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_ucs_batch_validation")
	c1 := seedTaskCard(t, pool)
	c2 := seedTaskCard(t, pool)
	rows := callUserCardSortSetBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": int64ToString(c1), "sort_order": 1.0},
		{"card_id": "0", "sort_order": 2.0}, // missing card_id
		{"card_id": int64ToString(c2), "sort_order": 3.0},
	})
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
	if !strings.Contains(rows[1].Message, "card_id is required") {
		t.Errorf("row 1: message=%q, want contains 'card_id is required'", rows[1].Message)
	}
}

// TestUserCardSortSetBatch_FKViolation — a card_id that doesn't
// resolve trips the foreign-key constraint. The function doesn't
// pre-check existence (the legacy Go path didn't either), so this
// surfaces as a pg FK error — which the dispatcher's `mapPGError`
// maps to code='fk_violation'. The direct test here just confirms
// the function raises; the dispatcher-level mapping is covered by
// the integration test.
func TestUserCardSortSetBatch_FKViolation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_ucs_batch_fk")
	body, _ := json.Marshal([]map[string]any{
		{"card_id": "999999999", "sort_order": 1.0},
	})
	_, err := pool.Exec(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM user_card_sort_set_batch($1::bigint, $2::jsonb)
	`, auth.SystemUserID, body)
	if err == nil {
		t.Fatalf("expected FK violation, got nil error")
	}
	if !strings.Contains(err.Error(), "foreign key") &&
		!strings.Contains(err.Error(), "violates") {
		t.Errorf("error %q does not look like an FK violation", err.Error())
	}
}

// int64ToString matches the dispatcher's wire convention: bigint
// ids travel as strings in JSON. The function's NULLIF / cast does
// the rest.
func int64ToString(v int64) string {
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
