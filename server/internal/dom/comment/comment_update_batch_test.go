// Direct PL/pgSQL test for comment_update_batch — Phase 2 of
// docs/UNIFIED_HANDLER_PLAN.md. Tests call the function over
// `tx.Query` and assert per-row outputs, separate from the
// dispatcher-driven integration tests in comment_test.go. Mirrors
// comment_insert_batch_test.go in shape.
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

func callCommentUpdateBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []resultRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM comment_update_batch($1::bigint, $2::jsonb)
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

// seedComment inserts a comment_body + activity(kind='comment') pair
// authored by actorID and returns the activity id. Bypasses the
// dispatcher so the function test stays independent of comment.insert.
func seedComment(t *testing.T, pool *pgxpool.Pool, cardID, actorID int64, body string) int64 {
	t.Helper()
	ctx := context.Background()
	var bodyID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO comment_body (body) VALUES ($1) RETURNING id
	`, body).Scan(&bodyID); err != nil {
		t.Fatalf("seed comment_body: %v", err)
	}
	var actID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO activity (card_id, kind, value_new, actor_id)
		VALUES ($1, 'comment',
		        jsonb_build_object('comment_body_id', ($2::bigint)::text),
		        $3)
		RETURNING id
	`, cardID, bodyID, actorID).Scan(&actID); err != nil {
		t.Fatalf("seed activity: %v", err)
	}
	return actID
}

// readCommentBody fetches the linked comment_body.body for an activity
// of kind='comment'. Used to assert the in-place body update landed.
func readCommentBody(t *testing.T, pool *pgxpool.Pool, activityID int64) string {
	t.Helper()
	var body string
	if err := pool.QueryRow(context.Background(), `
		SELECT b.body
		FROM activity a
		JOIN comment_body b ON b.id = (a.value_new->>'comment_body_id')::bigint
		WHERE a.id = $1
	`, activityID).Scan(&body); err != nil {
		t.Fatalf("read body: %v", err)
	}
	return body
}

// TestCommentUpdateBatch_Happy — single happy edit by the original
// author: ok row, body updated in place, edit_activity_id present.
func TestCommentUpdateBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comment_update_batch_happy")
	cardID := seedCard(t, pool, "task")
	actID := seedComment(t, pool, cardID, auth.SystemUserID, "original")

	rows := callCommentUpdateBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"activity_id": jsonInt(actID), "body": "edited"},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(rows))
	}
	r := rows[0]
	if !r.OK || r.Code != "" {
		t.Fatalf("want ok=true code=''; got ok=%v code=%q msg=%q", r.OK, r.Code, r.Message)
	}
	if r.Result == nil {
		t.Fatalf("result is nil on happy path")
	}
	var got struct {
		OK             bool   `json:"ok"`
		EditActivityID string `json:"edit_activity_id"`
	}
	if err := json.Unmarshal(r.Result, &got); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	if !got.OK || got.EditActivityID == "" {
		t.Errorf("bad result: %+v", got)
	}
	if body := readCommentBody(t, pool, actID); body != "edited" {
		t.Errorf("body = %q, want %q", body, "edited")
	}
}

// TestCommentUpdateBatch_MultiRow — N inputs, all ok, edit ids
// unique, idx order matches input order, bodies all updated.
func TestCommentUpdateBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comment_update_batch_multi")
	cardID := seedCard(t, pool, "task")
	a1 := seedComment(t, pool, cardID, auth.SystemUserID, "one")
	a2 := seedComment(t, pool, cardID, auth.SystemUserID, "two")
	a3 := seedComment(t, pool, cardID, auth.SystemUserID, "three")

	inputs := []map[string]any{
		{"activity_id": jsonInt(a1), "body": "one-edited"},
		{"activity_id": jsonInt(a2), "body": "two-edited"},
		{"activity_id": jsonInt(a3), "body": "three-edited"},
	}
	rows := callCommentUpdateBatch(t, pool, auth.SystemUserID, inputs)
	if len(rows) != 3 {
		t.Fatalf("rows: got %d, want 3", len(rows))
	}
	seen := map[string]bool{}
	for i, r := range rows {
		if r.Idx != i {
			t.Errorf("row %d: idx=%d, want %d", i, r.Idx, i)
		}
		if !r.OK {
			t.Errorf("row %d: ok=false code=%q msg=%q", i, r.Code, r.Message)
			continue
		}
		var got struct {
			EditActivityID string `json:"edit_activity_id"`
		}
		if err := json.Unmarshal(r.Result, &got); err != nil {
			t.Fatalf("row %d: unmarshal: %v", i, err)
		}
		if seen[got.EditActivityID] {
			t.Errorf("row %d: duplicate edit_activity_id %s", i, got.EditActivityID)
		}
		seen[got.EditActivityID] = true
	}
	wantBodies := map[int64]string{a1: "one-edited", a2: "two-edited", a3: "three-edited"}
	for actID, want := range wantBodies {
		if got := readCommentBody(t, pool, actID); got != want {
			t.Errorf("activity %d: body=%q, want %q", actID, got, want)
		}
	}
}

// TestCommentUpdateBatch_ActivityNotFound — activity_id that doesn't
// resolve produces code='not_found'.
func TestCommentUpdateBatch_ActivityNotFound(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comment_update_batch_404")
	rows := callCommentUpdateBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"activity_id": "999999", "body": "no activity here"},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(rows))
	}
	if rows[0].OK {
		t.Fatalf("row 0 should fail: %+v", rows[0])
	}
	if rows[0].Code != "not_found" {
		t.Errorf("code=%q, want 'not_found'", rows[0].Code)
	}
}

// TestCommentUpdateBatch_WrongKind — activity exists but kind !=
// 'comment' (e.g. card_create) produces code='validation' with a
// message mentioning the actual kind.
func TestCommentUpdateBatch_WrongKind(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comment_update_batch_wrongkind")
	cardID := seedCard(t, pool, "task")
	// Seed a card_create activity row directly.
	ctx := context.Background()
	var ccID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO activity (card_id, kind, actor_id)
		VALUES ($1, 'card_create', $2)
		RETURNING id
	`, cardID, auth.SystemUserID).Scan(&ccID); err != nil {
		t.Fatalf("seed card_create: %v", err)
	}
	rows := callCommentUpdateBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"activity_id": jsonInt(ccID), "body": "should fail"},
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
	if !strings.Contains(rows[0].Message, "not 'comment'") {
		t.Errorf("message=%q, want mention of 'not 'comment''", rows[0].Message)
	}
}

// TestCommentUpdateBatch_NotAuthor — actor differs from original
// author produces code='forbidden'. Seeds a second user_account
// directly so we have two distinct ids.
func TestCommentUpdateBatch_NotAuthor(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comment_update_batch_notauthor")
	cardID := seedCard(t, pool, "task")
	ctx := context.Background()
	var otherID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO user_account (email, display_name)
		VALUES ('other@example.test', 'other')
		RETURNING id
	`).Scan(&otherID); err != nil {
		t.Fatalf("seed other user: %v", err)
	}
	// Author is `otherID`, but the call uses SystemUserID.
	actID := seedComment(t, pool, cardID, otherID, "not yours")
	rows := callCommentUpdateBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"activity_id": jsonInt(actID), "body": "trying to edit"},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(rows))
	}
	if rows[0].OK {
		t.Fatalf("row 0 should fail: %+v", rows[0])
	}
	if rows[0].Code != "forbidden" {
		t.Errorf("code=%q, want 'forbidden'", rows[0].Code)
	}
	if body := readCommentBody(t, pool, actID); body != "not yours" {
		t.Errorf("body changed despite forbidden: %q", body)
	}
}

// TestCommentUpdateBatch_MissingBody — empty body produces
// code='validation'.
func TestCommentUpdateBatch_MissingBody(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comment_update_batch_nobody")
	cardID := seedCard(t, pool, "task")
	actID := seedComment(t, pool, cardID, auth.SystemUserID, "original")
	rows := callCommentUpdateBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"activity_id": jsonInt(actID), "body": ""},
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
	if !strings.Contains(rows[0].Message, "body is required") {
		t.Errorf("message=%q, want 'body is required'", rows[0].Message)
	}
}
