// Direct PL/pgSQL test for tag_remove_batch — Phase 2 of
// docs/UNIFIED_HANDLER_PLAN.md. Calls the function over `pool.Query`
// and asserts per-row outputs.
package tag_test

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

func callTagRemoveBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []tagRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM tag_remove_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var out []tagRow
	for rows.Next() {
		var r tagRow
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

// seedAppliedTags applies the given tag ids to the target by calling
// tag_apply_batch — keeps the remove test independent of any direct
// attribute_value seeding logic and exercises the same write path
// production uses.
func seedAppliedTags(t *testing.T, pool *pgxpool.Pool, targetID int64, tagIDs ...int64) {
	t.Helper()
	inputs := make([]map[string]any, 0, len(tagIDs))
	for _, tid := range tagIDs {
		inputs = append(inputs, map[string]any{
			"target_card_id": strconv.FormatInt(targetID, 10),
			"tag_card_id":    strconv.FormatInt(tid, 10),
		})
	}
	rows := callTagApplyBatch(t, pool, auth.SystemUserID, inputs)
	for i, r := range rows {
		if !r.OK {
			t.Fatalf("seed apply row %d: %+v", i, r)
		}
	}
}

// TestTagRemoveBatch_Happy — single happy path: remove a previously
// applied tag, target's array shrinks accordingly.
func TestTagRemoveBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_tag_remove_batch_happy")
	f := seedTagFixtures(t, pool)
	t1 := f.makeTagCard(t, "team/frontend", "")
	t2 := f.makeTagCard(t, "area/login", "")
	seedAppliedTags(t, pool, f.taskID, t1, t2)

	rows := callTagRemoveBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"target_card_id": strconv.FormatInt(f.taskID, 10),
			"tag_card_id": strconv.FormatInt(t1, 10)},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(rows))
	}
	r := rows[0]
	if !r.OK || r.Code != "" {
		t.Fatalf("want ok=true; got ok=%v code=%q msg=%q", r.OK, r.Code, r.Message)
	}
	var got struct {
		OK         bool   `json:"ok"`
		ActivityID string `json:"activity_id"`
	}
	if err := json.Unmarshal(r.Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !got.OK || got.ActivityID == "" {
		t.Errorf("bad result: %+v", got)
	}
	cur := readTagsArray(t, pool, f.taskID)
	if len(cur) != 1 || cur[0] != t2 {
		t.Errorf("tags after remove: got %v, want [%d]", cur, t2)
	}
}

// TestTagRemoveBatch_MultiRow — remove two tags in one batch.
func TestTagRemoveBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_tag_remove_batch_multi")
	f := seedTagFixtures(t, pool)
	t1 := f.makeTagCard(t, "team/frontend", "")
	t2 := f.makeTagCard(t, "area/login", "")
	t3 := f.makeTagCard(t, "phase/dev", "")
	seedAppliedTags(t, pool, f.taskID, t1, t2, t3)

	rows := callTagRemoveBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"target_card_id": strconv.FormatInt(f.taskID, 10),
			"tag_card_id": strconv.FormatInt(t1, 10)},
		{"target_card_id": strconv.FormatInt(f.taskID, 10),
			"tag_card_id": strconv.FormatInt(t3, 10)},
	})
	if len(rows) != 2 {
		t.Fatalf("rows: got %d, want 2", len(rows))
	}
	for i, r := range rows {
		if r.Idx != i {
			t.Errorf("row %d: idx=%d", i, r.Idx)
		}
		if !r.OK {
			t.Errorf("row %d: ok=false code=%q msg=%q", i, r.Code, r.Message)
		}
	}
	cur := readTagsArray(t, pool, f.taskID)
	if len(cur) != 1 || cur[0] != t2 {
		t.Errorf("tags after multi-remove: got %v, want [%d]", cur, t2)
	}
}

// TestTagRemoveBatch_PerRowValidationFailure — 1 of 3 inputs is missing
// tag_card_id; the other two succeed.
func TestTagRemoveBatch_PerRowValidationFailure(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_tag_remove_batch_perrow")
	f := seedTagFixtures(t, pool)
	t1 := f.makeTagCard(t, "team/frontend", "")
	t2 := f.makeTagCard(t, "area/login", "")
	seedAppliedTags(t, pool, f.taskID, t1, t2)

	inputs := []map[string]any{
		{"target_card_id": strconv.FormatInt(f.taskID, 10),
			"tag_card_id": strconv.FormatInt(t1, 10)},
		{"target_card_id": strconv.FormatInt(f.taskID, 10),
			"tag_card_id": "0"},
		{"target_card_id": strconv.FormatInt(f.taskID, 10),
			"tag_card_id": strconv.FormatInt(t2, 10)},
	}
	rows := callTagRemoveBatch(t, pool, auth.SystemUserID, inputs)
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
		t.Errorf("row 1 code=%q, want 'validation'", rows[1].Code)
	}
	if !strings.Contains(rows[1].Message, "tag_card_id") {
		t.Errorf("row 1 message=%q, want contains 'tag_card_id'", rows[1].Message)
	}
}

// TestTagRemoveBatch_TargetNotFound — target_card_id with no row
// returns code='card_not_found'.
func TestTagRemoveBatch_TargetNotFound(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_tag_remove_batch_target_404")
	f := seedTagFixtures(t, pool)
	tagID := f.makeTagCard(t, "team/frontend", "")
	rows := callTagRemoveBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"target_card_id": "999999",
			"tag_card_id": strconv.FormatInt(tagID, 10)},
	})
	if len(rows) != 1 || rows[0].OK {
		t.Fatalf("want one failing row; got %+v", rows)
	}
	if rows[0].Code != "card_not_found" {
		t.Errorf("code=%q, want 'card_not_found'", rows[0].Code)
	}
}

// TestTagRemoveBatch_IdempotentMissing — removing a tag the target
// does not currently hold succeeds (array unchanged); mirrors the Go
// runRemove behaviour, which simply filtered and wrote back.
func TestTagRemoveBatch_IdempotentMissing(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_tag_remove_batch_idem")
	f := seedTagFixtures(t, pool)
	t1 := f.makeTagCard(t, "team/frontend", "")
	t2 := f.makeTagCard(t, "area/login", "")
	seedAppliedTags(t, pool, f.taskID, t1)

	// Remove t2, which was never applied.
	rows := callTagRemoveBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"target_card_id": strconv.FormatInt(f.taskID, 10),
			"tag_card_id": strconv.FormatInt(t2, 10)},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("want success on idempotent remove; got %+v", rows)
	}
	cur := readTagsArray(t, pool, f.taskID)
	if len(cur) != 1 || cur[0] != t1 {
		t.Errorf("tags: got %v, want [%d]", cur, t1)
	}
}
