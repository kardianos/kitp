// Direct PL/pgSQL test for person_upsert_by_email_batch — Phase 3 of
// docs/UNIFIED_HANDLER_PLAN.md.
package comm_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

type personUpsertResult struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callPersonUpsertByEmailBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []personUpsertResult {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM person_upsert_by_email_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var out []personUpsertResult
	for rows.Next() {
		var r personUpsertResult
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

// TestPersonUpsertByEmailBatch_HappyCreate — first call with a new
// email materialises a person card; the result carries created=true
// and the three core attributes land.
func TestPersonUpsertByEmailBatch_HappyCreate(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_person_upsert_by_email_batch_create")
	rows := callPersonUpsertByEmailBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"email": "alice@example.com", "display_name": "Alice"},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("happy: %+v", rows)
	}
	var got struct {
		PersonID string `json:"person_id"`
		Created  bool   `json:"created"`
	}
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.PersonID == "" || !got.Created {
		t.Fatalf("want created=true with id; got %+v", got)
	}
	var title, email, kind string
	if err := pool.QueryRow(context.Background(), `
		SELECT
			(SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1::bigint AND ad.name='title'),
			(SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1::bigint AND ad.name='email'),
			(SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1::bigint AND ad.name='person_kind')
	`, got.PersonID).Scan(&title, &email, &kind); err != nil {
		t.Fatalf("read attrs: %v", err)
	}
	if title != "Alice" {
		t.Errorf("title=%q want Alice", title)
	}
	if email != "alice@example.com" {
		t.Errorf("email=%q want alice@example.com (lowered)", email)
	}
	if kind != "contact" {
		t.Errorf("kind=%q want contact (default)", kind)
	}
}

// TestPersonUpsertByEmailBatch_MultiRow — three inputs:
//   - new email -> create
//   - case-variant of (1) -> hits the SAME row (no second insert)
//   - distinct new email -> second create
func TestPersonUpsertByEmailBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_person_upsert_by_email_batch_multi")
	rows := callPersonUpsertByEmailBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"email": "Alice@Example.com"},
		{"email": "alice@example.com"},
		{"email": "Bob@example.com"},
	})
	if len(rows) != 3 {
		t.Fatalf("rows: %d", len(rows))
	}
	type out struct {
		PersonID string `json:"person_id"`
		Created  bool   `json:"created"`
	}
	var got [3]out
	for i, r := range rows {
		if !r.OK {
			t.Fatalf("row %d failed: %+v", i, r)
		}
		if err := json.Unmarshal(r.Result, &got[i]); err != nil {
			t.Fatalf("row %d unmarshal: %v", i, err)
		}
	}
	if !got[0].Created {
		t.Errorf("row 0: expected created=true")
	}
	if got[1].Created {
		t.Errorf("row 1: expected created=false (case-insensitive match)")
	}
	if got[0].PersonID != got[1].PersonID {
		t.Errorf("rows 0+1 should share id: %q vs %q", got[0].PersonID, got[1].PersonID)
	}
	if !got[2].Created || got[2].PersonID == got[0].PersonID {
		t.Errorf("row 2 should be a NEW id; got created=%v id=%q (vs %q)",
			got[2].Created, got[2].PersonID, got[0].PersonID)
	}
}

// TestPersonUpsertByEmailBatch_PerRowFailure — one missing email, one
// bad kind. Both fail with code=validation; sibling happy rows succeed.
func TestPersonUpsertByEmailBatch_PerRowFailure(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_person_upsert_by_email_batch_perrow")
	rows := callPersonUpsertByEmailBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"email": "c@example.com"},
		{"email": ""},
		{"email": "d@example.com", "kind": "vip"}, // not member / contact
		{"email": "e@example.com"},
	})
	if len(rows) != 4 {
		t.Fatalf("rows: %d", len(rows))
	}
	if !rows[0].OK || !rows[3].OK {
		t.Errorf("happy siblings should pass; got [0]=%+v [3]=%+v", rows[0], rows[3])
	}
	if rows[1].OK || rows[1].Code != "validation" {
		t.Errorf("row 1 want validation; got %+v", rows[1])
	}
	if !strings.Contains(rows[1].Message, "email is required") {
		t.Errorf("row 1 message: %q", rows[1].Message)
	}
	if rows[2].OK || rows[2].Code != "validation" {
		t.Errorf("row 2 want validation; got %+v", rows[2])
	}
	if !strings.Contains(rows[2].Message, "kind") {
		t.Errorf("row 2 message: %q", rows[2].Message)
	}
}

// TestPersonUpsertByEmailBatch_NoReclassify — an existing person with
// person_kind='member' is NOT downgraded to 'contact' on a re-upsert.
// Mirrors the comm_test.go Bob scenario but exercises the function
// directly.
func TestPersonUpsertByEmailBatch_NoReclassify(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_person_upsert_by_email_batch_member")
	ctx := context.Background()
	// Insert a member person directly.
	var personID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO card (card_type_id)
		SELECT id FROM card_type WHERE name='person'
		RETURNING id
	`).Scan(&personID); err != nil {
		t.Fatalf("seed person: %v", err)
	}
	for _, w := range []struct{ name, val string }{
		{"title", "Bob"}, {"email", "bob@example.com"}, {"person_kind", "member"},
	} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO attribute_value (card_id, attribute_def_id, value)
			SELECT $1, ad.id, to_jsonb($2::text) FROM attribute_def ad WHERE ad.name=$3
		`, personID, w.val, w.name); err != nil {
			t.Fatalf("seed %s: %v", w.name, err)
		}
	}
	// Re-upsert with kind='contact' — must hit the existing row, not
	// rewrite person_kind.
	rows := callPersonUpsertByEmailBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"email": "bob@example.com", "kind": "contact"},
	})
	if !rows[0].OK {
		t.Fatalf("upsert: %+v", rows[0])
	}
	var got struct {
		PersonID string `json:"person_id"`
		Created  bool   `json:"created"`
	}
	_ = json.Unmarshal(rows[0].Result, &got)
	if got.Created {
		t.Errorf("created=true on existing person; want false")
	}
	var kind string
	if err := pool.QueryRow(ctx, `
		SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id=$1 AND ad.name='person_kind'
	`, personID).Scan(&kind); err != nil {
		t.Fatalf("read kind: %v", err)
	}
	if kind != "member" {
		t.Errorf("kind=%q want member (existing kind must survive)", kind)
	}
}
