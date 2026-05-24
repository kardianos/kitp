// Direct PL/pgSQL test for tag_apply_batch — Phase 2 of
// docs/UNIFIED_HANDLER_PLAN.md. Calls the function over `pool.Query`
// and asserts per-row outputs, separate from the dispatcher-driven
// integration tests in tag_test.go.
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

// tagRow mirrors the function's RETURNS TABLE shape.
type tagRow struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callTagApplyBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []tagRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM tag_apply_batch($1::bigint, $2::jsonb)
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

// tagFixtures seeds a minimal project + task tree directly via SQL
// (bypassing card.insert so the function test stays independent of
// the broader dispatcher path). Returns the task id, the project id,
// and helpers to mint tag cards with given path / exclusion root.
type tagFixtures struct {
	pool      *pgxpool.Pool
	projectID int64
	taskID    int64
}

func seedTagFixtures(t *testing.T, pool *pgxpool.Pool) tagFixtures {
	t.Helper()
	ctx := context.Background()
	var projectCT, taskCT int64
	if err := pool.QueryRow(ctx, `SELECT id FROM card_type WHERE name='project'`).Scan(&projectCT); err != nil {
		t.Fatalf("project card_type: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT id FROM card_type WHERE name='task'`).Scan(&taskCT); err != nil {
		t.Fatalf("task card_type: %v", err)
	}
	var projectID, taskID int64
	if err := pool.QueryRow(ctx, `INSERT INTO card (card_type_id) VALUES ($1) RETURNING id`,
		projectCT).Scan(&projectID); err != nil {
		t.Fatalf("project: %v", err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO card (card_type_id, parent_card_id) VALUES ($1, $2) RETURNING id`,
		taskCT, projectID).Scan(&taskID); err != nil {
		t.Fatalf("task: %v", err)
	}
	return tagFixtures{pool: pool, projectID: projectID, taskID: taskID}
}

// makeTagCard creates a tag card under projectID with the given path
// and root_exclusive_at. An empty root means the tag is not part of any
// mutually-exclusive group.
func (f *tagFixtures) makeTagCard(t *testing.T, path, root string) int64 {
	t.Helper()
	ctx := context.Background()
	var tagCT, pathAttr, rootAttr int64
	if err := f.pool.QueryRow(ctx, `SELECT id FROM card_type WHERE name='tag'`).Scan(&tagCT); err != nil {
		t.Fatalf("tag card_type: %v", err)
	}
	if err := f.pool.QueryRow(ctx, `SELECT id FROM attribute_def WHERE name='path'`).Scan(&pathAttr); err != nil {
		t.Fatalf("path attr: %v", err)
	}
	if err := f.pool.QueryRow(ctx, `SELECT id FROM attribute_def WHERE name='root_exclusive_at'`).Scan(&rootAttr); err != nil {
		t.Fatalf("root attr: %v", err)
	}
	var id int64
	if err := f.pool.QueryRow(ctx,
		`INSERT INTO card (card_type_id, parent_card_id) VALUES ($1, $2) RETURNING id`,
		tagCT, f.projectID).Scan(&id); err != nil {
		t.Fatalf("tag card: %v", err)
	}
	if _, err := f.pool.Exec(ctx,
		`INSERT INTO attribute_value (card_id, attribute_def_id, value) VALUES ($1, $2, to_jsonb($3::text))`,
		id, pathAttr, path); err != nil {
		t.Fatalf("path value: %v", err)
	}
	if root != "" {
		if _, err := f.pool.Exec(ctx,
			`INSERT INTO attribute_value (card_id, attribute_def_id, value) VALUES ($1, $2, to_jsonb($3::text))`,
			id, rootAttr, root); err != nil {
			t.Fatalf("root value: %v", err)
		}
	}
	return id
}

// readTagsArray returns the target card's current `tags` jsonb array,
// decoded as []int64 (matches the canonical numeric storage form).
func readTagsArray(t *testing.T, pool *pgxpool.Pool, cardID int64) []int64 {
	t.Helper()
	var raw []byte
	err := pool.QueryRow(context.Background(), `
		SELECT av.value FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1 AND ad.name = 'tags'
	`, cardID).Scan(&raw)
	if err != nil {
		// Treat missing row as empty.
		return nil
	}
	var arr []int64
	_ = json.Unmarshal(raw, &arr)
	return arr
}

// TestTagApplyBatch_Happy — single happy path: apply one tag, target
// gets the tag id in its array.
func TestTagApplyBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_tag_apply_batch_happy")
	f := seedTagFixtures(t, pool)
	tagID := f.makeTagCard(t, "team/frontend", "")
	rows := callTagApplyBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"target_card_id": strconv.FormatInt(f.taskID, 10),
			"tag_card_id": strconv.FormatInt(tagID, 10)},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(rows))
	}
	r := rows[0]
	if !r.OK || r.Code != "" {
		t.Fatalf("want ok=true; got ok=%v code=%q msg=%q", r.OK, r.Code, r.Message)
	}
	var got struct {
		OK            bool     `json:"ok"`
		ActivityID    string   `json:"activity_id"`
		RemovedTagIDs []string `json:"removed_tag_ids,omitempty"`
	}
	if err := json.Unmarshal(r.Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !got.OK || got.ActivityID == "" {
		t.Errorf("bad result: %+v", got)
	}
	if len(got.RemovedTagIDs) != 0 {
		t.Errorf("removed should be empty on first apply: %+v", got.RemovedTagIDs)
	}
	cur := readTagsArray(t, pool, f.taskID)
	if len(cur) != 1 || cur[0] != tagID {
		t.Errorf("tags: got %v, want [%d]", cur, tagID)
	}
}

// TestTagApplyBatch_MultiRow — two non-exclusive tags applied in one
// call. Both land; idx order matches input order.
func TestTagApplyBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_tag_apply_batch_multi")
	f := seedTagFixtures(t, pool)
	t1 := f.makeTagCard(t, "team/frontend", "")
	t2 := f.makeTagCard(t, "area/login", "")
	rows := callTagApplyBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"target_card_id": strconv.FormatInt(f.taskID, 10),
			"tag_card_id": strconv.FormatInt(t1, 10)},
		{"target_card_id": strconv.FormatInt(f.taskID, 10),
			"tag_card_id": strconv.FormatInt(t2, 10)},
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
	if len(cur) != 2 || cur[0] != t1 || cur[1] != t2 {
		t.Errorf("tags: got %v, want [%d, %d]", cur, t1, t2)
	}
}

// TestTagApplyBatch_PerRowValidationFailure — 1 of 3 inputs is missing
// target_card_id; the other rows succeed.
func TestTagApplyBatch_PerRowValidationFailure(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_tag_apply_batch_perrow")
	f := seedTagFixtures(t, pool)
	t1 := f.makeTagCard(t, "team/frontend", "")
	t2 := f.makeTagCard(t, "area/login", "")
	inputs := []map[string]any{
		{"target_card_id": strconv.FormatInt(f.taskID, 10),
			"tag_card_id": strconv.FormatInt(t1, 10)},
		{"target_card_id": "0",
			"tag_card_id": strconv.FormatInt(t1, 10)},
		{"target_card_id": strconv.FormatInt(f.taskID, 10),
			"tag_card_id": strconv.FormatInt(t2, 10)},
	}
	rows := callTagApplyBatch(t, pool, auth.SystemUserID, inputs)
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
	if !strings.Contains(rows[1].Message, "target_card_id") {
		t.Errorf("row 1 message=%q, want contains 'target_card_id'", rows[1].Message)
	}
}

// TestTagApplyBatch_TargetNotFound — target_card_id with no row returns
// code='card_not_found'.
func TestTagApplyBatch_TargetNotFound(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_tag_apply_batch_target_404")
	f := seedTagFixtures(t, pool)
	tagID := f.makeTagCard(t, "team/frontend", "")
	rows := callTagApplyBatch(t, pool, auth.SystemUserID, []map[string]any{
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

// TestTagApplyBatch_TagNotFound — tag_card_id with no row (or not of
// card_type='tag') returns code='tag_not_found'.
func TestTagApplyBatch_TagNotFound(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_tag_apply_batch_tag_404")
	f := seedTagFixtures(t, pool)
	rows := callTagApplyBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"target_card_id": strconv.FormatInt(f.taskID, 10),
			"tag_card_id": "999999"},
	})
	if len(rows) != 1 || rows[0].OK {
		t.Fatalf("want one failing row; got %+v", rows)
	}
	if rows[0].Code != "tag_not_found" {
		t.Errorf("code=%q, want 'tag_not_found'", rows[0].Code)
	}
}

// TestTagApplyBatch_MutualExclusion — applying priority/high then
// priority/low must atomically remove high. Run as two single-input
// calls to mirror the dispatcher's per-input semantics; the function
// reads the live attribute_value between calls.
func TestTagApplyBatch_MutualExclusion(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_tag_apply_batch_mutex")
	f := seedTagFixtures(t, pool)
	high := f.makeTagCard(t, "priority/high", "priority")
	low := f.makeTagCard(t, "priority/low", "priority")

	// Apply high.
	rows := callTagApplyBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"target_card_id": strconv.FormatInt(f.taskID, 10),
			"tag_card_id": strconv.FormatInt(high, 10)},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("apply high: %+v", rows)
	}

	// Apply low — must remove high.
	rows = callTagApplyBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"target_card_id": strconv.FormatInt(f.taskID, 10),
			"tag_card_id": strconv.FormatInt(low, 10)},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("apply low: %+v", rows)
	}
	var got struct {
		RemovedTagIDs []string `json:"removed_tag_ids"`
	}
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got.RemovedTagIDs) != 1 || got.RemovedTagIDs[0] != strconv.FormatInt(high, 10) {
		t.Errorf("removed: got %v, want [%q]", got.RemovedTagIDs, strconv.FormatInt(high, 10))
	}
	cur := readTagsArray(t, pool, f.taskID)
	if len(cur) != 1 || cur[0] != low {
		t.Errorf("tags after mutex: got %v, want [%d]", cur, low)
	}
}
