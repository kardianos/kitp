// Direct PL/pgSQL test for card_delete_batch — Phase 2 of
// docs/UNIFIED_HANDLER_PLAN.md.
package card_test

import (
	"context"
	"encoding/json"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

type cardDeleteRow struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callCardDeleteBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []cardDeleteRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM card_delete_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var out []cardDeleteRow
	for rows.Next() {
		var r cardDeleteRow
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

// seedSimpleCard inserts a bare card row of `cardTypeName`. Skips the
// dispatcher so this test stays independent of card.insert.
func seedSimpleCard(t *testing.T, pool *pgxpool.Pool, cardTypeName string) int64 {
	t.Helper()
	var id int64
	if err := pool.QueryRow(context.Background(), `
		INSERT INTO card (card_type_id)
		SELECT id FROM card_type WHERE name = $1
		RETURNING id
	`, cardTypeName).Scan(&id); err != nil {
		t.Fatalf("seed card: %v", err)
	}
	return id
}

// TestCardDeleteBatch_Happy — single happy path.
func TestCardDeleteBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_delete_batch_happy")
	cardID := seedSimpleCard(t, pool, "project")
	rows := callCardDeleteBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": strconv.FormatInt(cardID, 10)},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("delete failed: %+v", rows)
	}
	// deleted_at populated.
	var deletedAt *string
	if err := pool.QueryRow(context.Background(),
		`SELECT deleted_at::text FROM card WHERE id = $1`, cardID).Scan(&deletedAt); err != nil {
		t.Fatalf("read deleted_at: %v", err)
	}
	if deletedAt == nil {
		t.Fatalf("card not soft-deleted")
	}
	// Activity row written.
	var nActs int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM activity WHERE kind='card_delete' AND card_id = $1`,
		cardID).Scan(&nActs); err != nil {
		t.Fatalf("count activity: %v", err)
	}
	if nActs != 1 {
		t.Errorf("activity rows = %d, want 1", nActs)
	}
}

// TestCardDeleteBatch_MultiRow — N inputs, all distinct cards, all ok,
// idx order matches.
func TestCardDeleteBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_delete_batch_multi")
	ids := []int64{
		seedSimpleCard(t, pool, "project"),
		seedSimpleCard(t, pool, "project"),
		seedSimpleCard(t, pool, "project"),
	}
	inputs := []map[string]any{}
	for _, id := range ids {
		inputs = append(inputs, map[string]any{"card_id": strconv.FormatInt(id, 10)})
	}
	rows := callCardDeleteBatch(t, pool, auth.SystemUserID, inputs)
	if len(rows) != 3 {
		t.Fatalf("rows: got %d, want 3", len(rows))
	}
	for i, r := range rows {
		if r.Idx != i || !r.OK {
			t.Errorf("row %d: %+v", i, r)
		}
	}
}

// TestCardDeleteBatch_Validation — card_id=0 fails with 'validation'.
func TestCardDeleteBatch_Validation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_delete_batch_validation")
	rows := callCardDeleteBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": "0"},
	})
	if len(rows) != 1 || rows[0].OK {
		t.Fatalf("want fail: %+v", rows)
	}
	if rows[0].Code != "validation" {
		t.Errorf("code=%q, want 'validation'", rows[0].Code)
	}
}

// TestCardDeleteBatch_NotFound — a missing card surfaces
// 'card_not_found' (the legacy "missing or already deleted" path).
func TestCardDeleteBatch_NotFound(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_delete_batch_404")
	rows := callCardDeleteBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": "9999999"},
	})
	if len(rows) != 1 || rows[0].OK {
		t.Fatalf("want fail: %+v", rows)
	}
	if rows[0].Code != "card_not_found" {
		t.Errorf("code=%q, want 'card_not_found'", rows[0].Code)
	}
}
