// Direct PL/pgSQL tests for user_role_set_batch and user_role_revoke_batch
// — Phase 3 of docs/UNIFIED_HANDLER_PLAN.md.
package userrole_test

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

func callBatch(t *testing.T, pool *pgxpool.Pool, fn string, actorID int64, inputs any) []resultRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(),
		`SELECT idx, ok, code, message, result FROM `+fn+`($1::bigint, $2::jsonb) ORDER BY idx`,
		actorID, body)
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

func seedUser(t *testing.T, pool *pgxpool.Pool, name string) int64 {
	t.Helper()
	var uid int64
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO user_account (display_name) VALUES ($1) RETURNING id`, name,
	).Scan(&uid); err != nil {
		t.Fatalf("user %s: %v", name, err)
	}
	return uid
}

func TestUserRoleSetBatch_HappyGlobal(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_user_role_set_happy")
	uid := seedUser(t, pool, "alice-r")

	rows := callBatch(t, pool, "user_role_set_batch", auth.SystemUserID, []map[string]any{
		{"user_id": strconv.FormatInt(uid, 10), "role_name": "worker"},
	})
	if !rows[0].OK {
		t.Fatalf("want ok=true: %+v", rows[0])
	}
	var got struct {
		OK         bool   `json:"ok"`
		UserRoleID string `json:"user_role_id"`
	}
	_ = json.Unmarshal(rows[0].Result, &got)
	if !got.OK || got.UserRoleID == "" {
		t.Errorf("result: %+v", got)
	}
	// Verify grant.
	var n int
	if err := pool.QueryRow(context.Background(), `
		SELECT count(*) FROM user_role ur JOIN role r ON r.id = ur.role_id
		WHERE ur.user_id = $1 AND r.name = 'worker' AND ur.scope_card_id IS NULL
	`, uid).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("user_role count=%d, want 1", n)
	}
}

func TestUserRoleSetBatch_IdempotentReGrant(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_user_role_set_idemp")
	uid := seedUser(t, pool, "alice-idemp")

	// First grant.
	r1 := callBatch(t, pool, "user_role_set_batch", auth.SystemUserID, []map[string]any{
		{"user_id": strconv.FormatInt(uid, 10), "role_name": "worker"},
	})
	if !r1[0].OK {
		t.Fatalf("first grant: %+v", r1[0])
	}
	var g1 struct {
		UserRoleID string `json:"user_role_id"`
	}
	_ = json.Unmarshal(r1[0].Result, &g1)

	// Second grant — same (user, role, scope) — must return the SAME id.
	r2 := callBatch(t, pool, "user_role_set_batch", auth.SystemUserID, []map[string]any{
		{"user_id": strconv.FormatInt(uid, 10), "role_name": "worker"},
	})
	if !r2[0].OK {
		t.Fatalf("second grant: %+v", r2[0])
	}
	var g2 struct {
		UserRoleID string `json:"user_role_id"`
	}
	_ = json.Unmarshal(r2[0].Result, &g2)
	if g1.UserRoleID != g2.UserRoleID {
		t.Errorf("ids: first=%q second=%q — should be equal (idempotent re-grant)",
			g1.UserRoleID, g2.UserRoleID)
	}
}

func TestUserRoleSetBatch_PerRowValidation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_user_role_set_validation")
	uid := seedUser(t, pool, "ok-row")
	inputs := []map[string]any{
		{"user_id": strconv.FormatInt(uid, 10), "role_name": "worker"},
		{"user_id": strconv.FormatInt(uid, 10), "role_name": ""},
		{"user_id": strconv.FormatInt(uid, 10), "role_name": "not-a-real-role"},
	}
	rows := callBatch(t, pool, "user_role_set_batch", auth.SystemUserID, inputs)
	if !rows[0].OK {
		t.Errorf("row 0: %+v", rows[0])
	}
	if rows[1].OK || rows[1].Code != "validation" {
		t.Errorf("row 1: %+v", rows[1])
	}
	if rows[2].OK || rows[2].Code != "validation" {
		t.Errorf("row 2 (unknown role): %+v", rows[2])
	}
	if !strings.Contains(rows[2].Message, "not found") {
		t.Errorf("row 2 message=%q", rows[2].Message)
	}
}

func TestUserRoleRevokeBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_user_role_revoke_happy")
	uid := seedUser(t, pool, "alice-rv")

	// Seed a grant.
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO user_role (user_id, role_id)
		SELECT $1, id FROM role WHERE name = 'worker'
	`, uid); err != nil {
		t.Fatal(err)
	}

	rows := callBatch(t, pool, "user_role_revoke_batch", auth.SystemUserID, []map[string]any{
		{"user_id": strconv.FormatInt(uid, 10), "role_name": "worker"},
	})
	if !rows[0].OK {
		t.Fatalf("want ok: %+v", rows[0])
	}
	var got struct {
		OK      bool `json:"ok"`
		Deleted int  `json:"deleted"`
	}
	_ = json.Unmarshal(rows[0].Result, &got)
	if !got.OK || got.Deleted != 1 {
		t.Errorf("result: %+v", got)
	}
	// Verify grant removed.
	var n int
	if err := pool.QueryRow(context.Background(), `
		SELECT count(*) FROM user_role ur JOIN role r ON r.id = ur.role_id
		WHERE ur.user_id = $1 AND r.name = 'worker'
	`, uid).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("user_role count=%d, want 0", n)
	}
}

func TestUserRoleRevokeBatch_IdempotentAbsent(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_user_role_revoke_absent")
	uid := seedUser(t, pool, "alice-rv-absent")

	rows := callBatch(t, pool, "user_role_revoke_batch", auth.SystemUserID, []map[string]any{
		{"user_id": strconv.FormatInt(uid, 10), "role_name": "worker"},
	})
	if !rows[0].OK {
		t.Fatalf("call should ok (idempotent): %+v", rows[0])
	}
	var got struct {
		OK      bool `json:"ok"`
		Deleted int  `json:"deleted"`
	}
	_ = json.Unmarshal(rows[0].Result, &got)
	if got.OK || got.Deleted != 0 {
		t.Errorf("expected ok=false deleted=0, got %+v", got)
	}
}

func TestUserRoleRevokeBatch_PerRowValidation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_user_role_revoke_validation")
	rows := callBatch(t, pool, "user_role_revoke_batch", auth.SystemUserID, []map[string]any{
		{"role_name": "worker"},
	})
	if rows[0].OK {
		t.Fatal("row should fail (missing user_id)")
	}
	if rows[0].Code != "validation" {
		t.Errorf("code=%q", rows[0].Code)
	}
}
