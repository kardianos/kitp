// Direct PL/pgSQL test for card_undelete_batch — Phase 4 of
// docs/UNIFIED_HANDLER_PLAN.md (write handler miscategorised in the
// original Phase 5 read bucket).
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

type cardUndeleteRow struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callCardUndeleteBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []cardUndeleteRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM card_undelete_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var out []cardUndeleteRow
	for rows.Next() {
		var r cardUndeleteRow
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

// seedDeletedCard inserts a card row and immediately soft-deletes it.
func seedDeletedCard(t *testing.T, pool *pgxpool.Pool, cardTypeName string) int64 {
	t.Helper()
	id := seedSimpleCard(t, pool, cardTypeName)
	if _, err := pool.Exec(context.Background(),
		`UPDATE card SET deleted_at = now() WHERE id = $1`, id); err != nil {
		t.Fatalf("soft-delete seed card: %v", err)
	}
	return id
}

// TestCardUndeleteBatch_Happy — single happy path: a soft-deleted card
// becomes live again and an activity row of kind card_undelete is written.
func TestCardUndeleteBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_undelete_batch_happy")
	cardID := seedDeletedCard(t, pool, "project")
	rows := callCardUndeleteBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": strconv.FormatInt(cardID, 10)},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("undelete failed: %+v", rows)
	}
	// deleted_at cleared.
	var deletedAt *string
	if err := pool.QueryRow(context.Background(),
		`SELECT deleted_at::text FROM card WHERE id = $1`, cardID).Scan(&deletedAt); err != nil {
		t.Fatalf("read deleted_at: %v", err)
	}
	if deletedAt != nil {
		t.Fatalf("card still soft-deleted: %s", *deletedAt)
	}
	// Activity row written.
	var nActs int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM activity WHERE kind='card_undelete' AND card_id = $1`,
		cardID).Scan(&nActs); err != nil {
		t.Fatalf("count activity: %v", err)
	}
	if nActs != 1 {
		t.Errorf("activity rows = %d, want 1", nActs)
	}
}

// TestCardUndeleteBatch_MultiRow — N inputs, all distinct soft-deleted
// cards, all ok, idx order matches.
func TestCardUndeleteBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_undelete_batch_multi")
	ids := []int64{
		seedDeletedCard(t, pool, "project"),
		seedDeletedCard(t, pool, "project"),
		seedDeletedCard(t, pool, "project"),
	}
	inputs := []map[string]any{}
	for _, id := range ids {
		inputs = append(inputs, map[string]any{"card_id": strconv.FormatInt(id, 10)})
	}
	rows := callCardUndeleteBatch(t, pool, auth.SystemUserID, inputs)
	if len(rows) != 3 {
		t.Fatalf("rows: got %d, want 3", len(rows))
	}
	for i, r := range rows {
		if r.Idx != i || !r.OK {
			t.Errorf("row %d: %+v", i, r)
		}
	}
}

// TestCardUndeleteBatch_Validation — card_id=0 fails with 'validation'.
func TestCardUndeleteBatch_Validation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_undelete_batch_validation")
	rows := callCardUndeleteBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": "0"},
	})
	if len(rows) != 1 || rows[0].OK {
		t.Fatalf("want fail: %+v", rows)
	}
	if rows[0].Code != "validation" {
		t.Errorf("code=%q, want 'validation'", rows[0].Code)
	}
}

// TestCardUndeleteBatch_NotFound — a missing card surfaces
// 'card_not_found'.
func TestCardUndeleteBatch_NotFound(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_undelete_batch_404")
	rows := callCardUndeleteBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": "9999999"},
	})
	if len(rows) != 1 || rows[0].OK {
		t.Fatalf("want fail: %+v", rows)
	}
	if rows[0].Code != "card_not_found" {
		t.Errorf("code=%q, want 'card_not_found'", rows[0].Code)
	}
}

// TestCardUndeleteBatch_AlreadyLive — undeleting a card that isn't
// soft-deleted fails with 'card_not_found' (legacy "missing or already
// live" diagnostic, now pinned per-row).
func TestCardUndeleteBatch_AlreadyLive(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_undelete_batch_alive")
	cardID := seedSimpleCard(t, pool, "project") // not soft-deleted
	rows := callCardUndeleteBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": strconv.FormatInt(cardID, 10)},
	})
	if len(rows) != 1 || rows[0].OK {
		t.Fatalf("want fail: %+v", rows)
	}
	if rows[0].Code != "card_not_found" {
		t.Errorf("code=%q, want 'card_not_found'", rows[0].Code)
	}
}
