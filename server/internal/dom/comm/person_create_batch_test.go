// Direct PL/pgSQL test for person_create_batch — Phase 4 of
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

type personCreateResult struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callPersonCreateBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []personCreateResult {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM person_create_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var out []personCreateResult
	for rows.Next() {
		var r personCreateResult
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

// TestPersonCreateBatch_HappyContact — tier=contact creates a person
// card with title + person_kind=contact + optional email; no
// user_account row appears.
func TestPersonCreateBatch_HappyContact(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_person_create_batch_contact")
	rows := callPersonCreateBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"title": "Alice", "email": "alice@example.com", "tier": "contact"},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("happy: %+v", rows)
	}
	var got struct {
		PersonCardID  string `json:"person_card_id"`
		UserAccountID string `json:"user_account_id"`
	}
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.PersonCardID == "" {
		t.Fatal("empty person_card_id")
	}
	if got.UserAccountID != "0" {
		t.Errorf("user_account_id=%q want 0", got.UserAccountID)
	}

	var title, email, kind string
	if err := pool.QueryRow(context.Background(), `
		SELECT
			(SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1::bigint AND ad.name='title'),
			(SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1::bigint AND ad.name='email'),
			(SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1::bigint AND ad.name='person_kind')
	`, got.PersonCardID).Scan(&title, &email, &kind); err != nil {
		t.Fatalf("read attrs: %v", err)
	}
	if title != "Alice" {
		t.Errorf("title=%q want Alice", title)
	}
	if email != "alice@example.com" {
		t.Errorf("email=%q want alice@example.com", email)
	}
	if kind != "contact" {
		t.Errorf("kind=%q want contact", kind)
	}
}

// TestPersonCreateBatch_MultiRow — three rows, three distinct cards.
// Two with tier='assignee' (no user_account), one tier='user' (with
// user_account row).
func TestPersonCreateBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_person_create_batch_multi")
	rows := callPersonCreateBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"title": "Worker A", "tier": "assignee"},
		{"title": "Worker B", "tier": "assignee", "email": "b@example.com"},
		{"title": "User C", "tier": "user", "email": "c@example.com"},
	})
	if len(rows) != 3 {
		t.Fatalf("rows: %d", len(rows))
	}
	type out struct {
		PersonCardID  string `json:"person_card_id"`
		UserAccountID string `json:"user_account_id"`
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
	if got[0].PersonCardID == got[1].PersonCardID || got[1].PersonCardID == got[2].PersonCardID {
		t.Errorf("duplicate person ids: %+v", got)
	}
	if got[0].UserAccountID != "0" || got[1].UserAccountID != "0" {
		t.Errorf("assignee rows must not create user_account: %+v", got[:2])
	}
	if got[2].UserAccountID == "" || got[2].UserAccountID == "0" {
		t.Errorf("user row must create user_account: %+v", got[2])
	}

	// Verify the user_account row + link exist for row 2.
	var displayName, email string
	if err := pool.QueryRow(context.Background(), `
		SELECT display_name, COALESCE(email, '')
		FROM user_account WHERE id=$1::bigint
	`, got[2].UserAccountID).Scan(&displayName, &email); err != nil {
		t.Fatalf("read user_account: %v", err)
	}
	if displayName != "User C" || email != "c@example.com" {
		t.Errorf("user_account=%q,%q want User C,c@example.com", displayName, email)
	}
	var linked int
	if err := pool.QueryRow(context.Background(), `
		SELECT count(*) FROM user_account_person
		WHERE user_account_id=$1::bigint AND person_card_id=$2::bigint
	`, got[2].UserAccountID, got[2].PersonCardID).Scan(&linked); err != nil {
		t.Fatalf("read link: %v", err)
	}
	if linked != 1 {
		t.Errorf("user_account_person link count=%d want 1", linked)
	}
}

// TestPersonCreateBatch_PerRowFailure — mixed bag of validation
// failures with happy siblings.
func TestPersonCreateBatch_PerRowFailure(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_person_create_batch_perrow")
	rows := callPersonCreateBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"title": "OK Contact", "tier": "contact"},
		{"title": "", "tier": "contact"},                       // title required
		{"title": "Bad Tier", "tier": "moderator"},             // unknown tier
		{"title": "User No Email", "tier": "user"},             // tier=user needs email
		{"title": "OK User", "tier": "user", "email": "ok@x.io"},
	})
	if len(rows) != 5 {
		t.Fatalf("rows: %d", len(rows))
	}
	if !rows[0].OK || !rows[4].OK {
		t.Errorf("happy rows must pass: [0]=%+v [4]=%+v", rows[0], rows[4])
	}
	if rows[1].OK || rows[1].Code != "validation" || !strings.Contains(rows[1].Message, "title is required") {
		t.Errorf("row 1 want validation/title required; got %+v", rows[1])
	}
	if rows[2].OK || rows[2].Code != "validation" || !strings.Contains(rows[2].Message, "tier") {
		t.Errorf("row 2 want validation/tier; got %+v", rows[2])
	}
	if rows[3].OK || rows[3].Code != "validation" || !strings.Contains(rows[3].Message, "email is required") {
		t.Errorf("row 3 want validation/email required; got %+v", rows[3])
	}
}

// TestPersonCreateBatch_ContactNoEmail — tier='contact' may omit the
// email field; no email attribute_value row is written.
func TestPersonCreateBatch_ContactNoEmail(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_person_create_batch_no_email")
	rows := callPersonCreateBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"title": "Anon", "tier": "contact"},
	})
	if !rows[0].OK {
		t.Fatalf("happy: %+v", rows[0])
	}
	var got struct {
		PersonCardID string `json:"person_card_id"`
	}
	_ = json.Unmarshal(rows[0].Result, &got)

	var emailCount int
	if err := pool.QueryRow(context.Background(), `
		SELECT count(*) FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id=$1::bigint AND ad.name='email'
	`, got.PersonCardID).Scan(&emailCount); err != nil {
		t.Fatalf("count email: %v", err)
	}
	if emailCount != 0 {
		t.Errorf("email row count=%d; expected 0 when email omitted", emailCount)
	}
}

// TestPersonCreateBatch_UserTierWritesEmailAttr — tier='user' must
// also write the email attribute (the future OIDC match key) on the
// person card. This guards the conditional WHERE NOT (ord=3 AND
// _email='') in the multi-attribute writes CTE.
func TestPersonCreateBatch_UserTierWritesEmailAttr(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_person_create_batch_user_email")
	rows := callPersonCreateBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"title": "User Alpha", "tier": "user", "email": "alpha@example.com"},
	})
	if !rows[0].OK {
		t.Fatalf("happy: %+v", rows[0])
	}
	var got struct {
		PersonCardID  string `json:"person_card_id"`
		UserAccountID string `json:"user_account_id"`
	}
	_ = json.Unmarshal(rows[0].Result, &got)

	var email, kind string
	if err := pool.QueryRow(context.Background(), `
		SELECT
			(SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1::bigint AND ad.name='email'),
			(SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1::bigint AND ad.name='person_kind')
	`, got.PersonCardID).Scan(&email, &kind); err != nil {
		t.Fatalf("read attrs: %v", err)
	}
	if email != "alpha@example.com" {
		t.Errorf("email=%q want alpha@example.com", email)
	}
	if kind != "member" {
		t.Errorf("kind=%q want member (tier=user maps to member)", kind)
	}
}
