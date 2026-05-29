// Direct PL/pgSQL tests for card_merge_batch + person_merge_batch (the merge
// feature). Exercises the SQL functions against a seeded test DB.
package card_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"

	"github.com/jackc/pgx/v5/pgxpool"
)

type mergeRow struct {
	ok   bool
	code string
	res  map[string]any
}

func callMerge(t *testing.T, pool *pgxpool.Pool, fn string, survivor int64, losers []string) mergeRow {
	t.Helper()
	ctx := context.Background()
	loserJSON, _ := json.Marshal(losers)
	input := []byte(`[{"survivor_id":"` + itoa(survivor) + `","loser_ids":` + string(loserJSON) + `}]`)
	var ok bool
	var code string
	var res []byte
	err := pool.QueryRow(ctx,
		`SELECT ok, code, result FROM `+fn+`($1::bigint, $2::jsonb)`,
		auth.SystemUserID, input,
	).Scan(&ok, &code, &res)
	if err != nil {
		t.Fatalf("%s: %v", fn, err)
	}
	out := mergeRow{ok: ok, code: code}
	if len(res) > 0 {
		_ = json.Unmarshal(res, &out.res)
	}
	return out
}

func itoa(n int64) string { b, _ := json.Marshal(n); return string(b) }

// insertCard inserts a bare card of the named type (no validation — direct row)
// and returns its id.
func insertCard(t *testing.T, pool *pgxpool.Pool, cardTypeName string, parent *int64) int64 {
	t.Helper()
	ctx := context.Background()
	var id int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO card (card_type_id, parent_card_id)
		SELECT id, $2 FROM card_type WHERE name = $1
		RETURNING id
	`, cardTypeName, parent).Scan(&id); err != nil {
		t.Fatalf("insert %s card: %v", cardTypeName, err)
	}
	return id
}

// setAttr upserts an attribute_value (rawJSON is the jsonb value text).
func setAttr(t *testing.T, pool *pgxpool.Pool, cardID int64, attrName, rawJSON string) {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		SELECT $1, ad.id, $3::jsonb FROM attribute_def ad WHERE ad.name = $2
		ON CONFLICT (card_id, attribute_def_id) DO UPDATE SET value = EXCLUDED.value
	`, cardID, attrName, rawJSON); err != nil {
		t.Fatalf("set attr %s on %d: %v", attrName, cardID, err)
	}
}

func attrText(t *testing.T, pool *pgxpool.Pool, cardID int64, attrName string) string {
	t.Helper()
	ctx := context.Background()
	var v *string
	err := pool.QueryRow(ctx, `
		SELECT av.value #>> '{}' FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1 AND ad.name = $2
	`, cardID, attrName).Scan(&v)
	if err != nil {
		return ""
	}
	if v == nil {
		return ""
	}
	return *v
}

func attrRaw(t *testing.T, pool *pgxpool.Pool, cardID int64, attrName string) string {
	t.Helper()
	ctx := context.Background()
	var v []byte
	if err := pool.QueryRow(ctx, `
		SELECT av.value FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1 AND ad.name = $2
	`, cardID, attrName).Scan(&v); err != nil {
		return ""
	}
	return string(v)
}

func isDeleted(t *testing.T, pool *pgxpool.Pool, cardID int64) bool {
	t.Helper()
	var deleted bool
	if err := pool.QueryRow(context.Background(),
		`SELECT deleted_at IS NOT NULL FROM card WHERE id = $1`, cardID).Scan(&deleted); err != nil {
		t.Fatalf("read deleted_at %d: %v", cardID, err)
	}
	return deleted
}

// TestCardMergeRepointsRefsAndSoftDeletes covers the generic kernel: scalar +
// array card_ref repoint (with dedup), soft-delete, and the same-type guard.
func TestCardMergeRepointsRefsAndSoftDeletes(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_merge")

	survivor := insertCard(t, pool, "person", nil)
	loser := insertCard(t, pool, "person", nil)
	other := insertCard(t, pool, "person", nil) // an unrelated recipient
	task := insertCard(t, pool, "task", nil)

	// Scalar card_ref (assignee) -> loser; array card_ref (comm_recipients)
	// contains the loser + another person.
	setAttr(t, pool, task, "assignee", itoa(loser))
	setAttr(t, pool, task, "comm_recipients", "["+itoa(loser)+","+itoa(other)+"]")

	res := callMerge(t, pool, "card_merge_batch", survivor, []string{itoa(loser)})
	if !res.ok {
		t.Fatalf("card.merge failed: code=%s", res.code)
	}

	if got := attrText(t, pool, task, "assignee"); got != itoa(survivor) {
		t.Errorf("assignee = %s, want survivor %d", got, survivor)
	}
	// comm_recipients: loser replaced by survivor, `other` kept.
	rec := attrRaw(t, pool, task, "comm_recipients")
	var ids []int64
	_ = json.Unmarshal([]byte(rec), &ids)
	if !containsAll(ids, survivor, other) || contains(ids, loser) {
		t.Errorf("comm_recipients = %s, want [survivor=%d, other=%d] (no loser=%d)", rec, survivor, other, loser)
	}
	if !isDeleted(t, pool, loser) {
		t.Error("loser was not soft-deleted")
	}
	if isDeleted(t, pool, survivor) {
		t.Error("survivor must not be deleted")
	}
}

func TestCardMergeRejectsCardTypeMismatch(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_merge_mismatch")
	survivor := insertCard(t, pool, "person", nil)
	loser := insertCard(t, pool, "milestone", nil) // different card_type
	res := callMerge(t, pool, "card_merge_batch", survivor, []string{itoa(loser)})
	if res.ok || res.code != "card_type_mismatch" {
		t.Fatalf("expected card_type_mismatch, got ok=%v code=%s", res.ok, res.code)
	}
	if isDeleted(t, pool, loser) {
		t.Error("a rejected merge must not delete the loser")
	}
}

// TestPersonMergeMovesLoginAndBackfillsEmail covers the person wrapper's extras.
func TestPersonMergeMovesLoginAndBackfillsEmail(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_person_merge")
	ctx := context.Background()

	survivor := insertCard(t, pool, "person", nil) // blank email, no login
	loser := insertCard(t, pool, "person", nil)
	setAttr(t, pool, loser, "email", `"contact@example.invalid"`)

	// Loser is the ONLY one with a login.
	var ua int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO user_account (display_name) VALUES ('merge-login') RETURNING id`).Scan(&ua); err != nil {
		t.Fatalf("create user_account: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO user_account_person (user_account_id, person_card_id) VALUES ($1, $2)`, ua, loser); err != nil {
		t.Fatalf("link login: %v", err)
	}

	res := callMerge(t, pool, "person_merge_batch", survivor, []string{itoa(loser)})
	if !res.ok {
		t.Fatalf("person.merge failed: code=%s", res.code)
	}
	if res.res["moved_login"] != true {
		t.Errorf("moved_login = %v, want true", res.res["moved_login"])
	}

	// Login now points at the survivor.
	var linked int64
	if err := pool.QueryRow(ctx,
		`SELECT person_card_id FROM user_account_person WHERE user_account_id = $1`, ua).Scan(&linked); err != nil {
		t.Fatalf("read link: %v", err)
	}
	if linked != survivor {
		t.Errorf("login linked to %d, want survivor %d", linked, survivor)
	}
	// Survivor's blank email was backfilled from the loser.
	if got := attrText(t, pool, survivor, "email"); got != "contact@example.invalid" {
		t.Errorf("survivor email = %q, want backfilled 'contact@example.invalid'", got)
	}
	if !isDeleted(t, pool, loser) {
		t.Error("loser person not soft-deleted")
	}
}

func TestPersonMergeRejectsTwoLogins(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_person_merge_login_conflict")
	ctx := context.Background()
	survivor := insertCard(t, pool, "person", nil)
	loser := insertCard(t, pool, "person", nil)

	// BOTH carry a login → merge must refuse (login merge is out of scope).
	for _, pid := range []int64{survivor, loser} {
		var ua int64
		if err := pool.QueryRow(ctx,
			`INSERT INTO user_account (display_name) VALUES ('u') RETURNING id`).Scan(&ua); err != nil {
			t.Fatalf("user_account: %v", err)
		}
		if _, err := pool.Exec(ctx,
			`INSERT INTO user_account_person (user_account_id, person_card_id) VALUES ($1, $2)`, ua, pid); err != nil {
			t.Fatalf("link: %v", err)
		}
	}

	res := callMerge(t, pool, "person_merge_batch", survivor, []string{itoa(loser)})
	if res.ok || res.code != "merge_login_conflict" {
		t.Fatalf("expected merge_login_conflict, got ok=%v code=%s", res.ok, res.code)
	}
	if isDeleted(t, pool, loser) {
		t.Error("a refused merge must not delete the loser")
	}
}

func contains(xs []int64, v int64) bool {
	for _, x := range xs {
		if x == v {
			return true
		}
	}
	return false
}

func containsAll(xs []int64, vs ...int64) bool {
	for _, v := range vs {
		if !contains(xs, v) {
			return false
		}
	}
	return true
}
