// Direct PL/pgSQL test for user_unlink_person_batch — Phase 3 of
// docs/UNIFIED_HANDLER_PLAN.md.
package user_test

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

type resultRow struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callUserUnlinkPersonBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []resultRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM user_unlink_person_batch($1::bigint, $2::jsonb)
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

// seedLinkedUser creates a user_account + a person card + the
// user_account_person link, returning the user_account id.
func seedLinkedUser(t *testing.T, pool *pgxpool.Pool, name string) int64 {
	t.Helper()
	ctx := context.Background()
	var uid int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO user_account (display_name) VALUES ($1) RETURNING id`, name,
	).Scan(&uid); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	var cardID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO card (card_type_id)
		SELECT id FROM card_type WHERE name = 'person'
		RETURNING id
	`).Scan(&cardID); err != nil {
		t.Fatalf("seed person card: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO user_account_person (user_account_id, person_card_id)
		VALUES ($1, $2)
	`, uid, cardID); err != nil {
		t.Fatalf("seed link: %v", err)
	}
	return uid
}

func TestUserUnlinkPersonBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_unlink_person_happy")
	uid := seedLinkedUser(t, pool, "linky")

	rows := callUserUnlinkPersonBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"user_account_id": strconv.FormatInt(uid, 10)},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d", len(rows))
	}
	if !rows[0].OK {
		t.Fatalf("want ok=true; got %+v", rows[0])
	}
	var got struct {
		Deleted bool `json:"deleted"`
	}
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !got.Deleted {
		t.Errorf("deleted should be true: %+v", got)
	}
	// Verify the link is gone but user_account remains.
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM user_account_person WHERE user_account_id = $1`, uid,
	).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("link should be gone: count=%d", n)
	}
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM user_account WHERE id = $1`, uid,
	).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("user_account should remain: count=%d", n)
	}
}

func TestUserUnlinkPersonBatch_IdempotentAbsent(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_unlink_person_absent")
	// A user with no linked person card.
	var uid int64
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO user_account (display_name) VALUES ($1) RETURNING id`, "loner",
	).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	rows := callUserUnlinkPersonBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"user_account_id": strconv.FormatInt(uid, 10)},
	})
	if !rows[0].OK {
		t.Fatalf("idempotent call should succeed: %+v", rows[0])
	}
	var got struct {
		Deleted bool `json:"deleted"`
	}
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatal(err)
	}
	if got.Deleted {
		t.Errorf("want deleted=false (no-op), got true")
	}
}

func TestUserUnlinkPersonBatch_PerRowValidation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_unlink_person_validation")
	uid := seedLinkedUser(t, pool, "ok-row")
	inputs := []map[string]any{
		{"user_account_id": strconv.FormatInt(uid, 10)},
		{}, // missing id
	}
	rows := callUserUnlinkPersonBatch(t, pool, auth.SystemUserID, inputs)
	if len(rows) != 2 {
		t.Fatalf("rows: got %d", len(rows))
	}
	if !rows[0].OK {
		t.Errorf("row 0 should ok: %+v", rows[0])
	}
	if rows[1].OK {
		t.Errorf("row 1 should fail")
	}
	if rows[1].Code != "validation" {
		t.Errorf("row 1 code=%q", rows[1].Code)
	}
	if !strings.Contains(rows[1].Message, "user_account_id is required") {
		t.Errorf("row 1 message=%q", rows[1].Message)
	}
}

func TestUserUnlinkPersonBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_unlink_person_multi")
	a := seedLinkedUser(t, pool, "a-link")
	b := seedLinkedUser(t, pool, "b-link")
	c := seedLinkedUser(t, pool, "c-link")

	inputs := []map[string]any{
		{"user_account_id": strconv.FormatInt(a, 10)},
		{"user_account_id": strconv.FormatInt(b, 10)},
		{"user_account_id": strconv.FormatInt(c, 10)},
	}
	rows := callUserUnlinkPersonBatch(t, pool, auth.SystemUserID, inputs)
	if len(rows) != 3 {
		t.Fatalf("rows: got %d", len(rows))
	}
	for i, r := range rows {
		if !r.OK {
			t.Errorf("row %d: %+v", i, r)
		}
	}
}
