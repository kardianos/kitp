// Direct PL/pgSQL test for card_search_batch — Phase 5 of
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

func callCardSearchBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []selectResultRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM card_search_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var out []selectResultRow
	for rows.Next() {
		var r selectResultRow
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

type searchHit struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

func parseSearchHits(t *testing.T, raw json.RawMessage) []searchHit {
	t.Helper()
	var o struct {
		Rows []searchHit `json:"rows"`
	}
	if err := json.Unmarshal(raw, &o); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return o.Rows
}

// seedCardWithTitle inserts a card with the given card_type + parent
// and writes a title attribute_value directly (bypassing the
// dispatcher). Returns the card id.
func seedCardWithTitle(t *testing.T, pool *pgxpool.Pool, cardTypeName string, parent *int64, title string) int64 {
	t.Helper()
	ctx := context.Background()
	id := seedCardOfType(t, pool, cardTypeName, parent)
	var attrDefID int64
	if err := pool.QueryRow(ctx, `SELECT id FROM attribute_def WHERE name='title'`).Scan(&attrDefID); err != nil {
		t.Fatalf("attr def: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		VALUES ($1, $2, to_jsonb($3::text))
	`, id, attrDefID, title); err != nil {
		t.Fatalf("title write: %v", err)
	}
	return id
}

// TestCardSearchBatch_Happy — substring match across two tasks.
func TestCardSearchBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_search_batch_happy")
	project := seedCardOfType(t, pool, "project", nil)
	tA := seedCardWithTitle(t, pool, "task", &project, "Alpha rework")
	tB := seedCardWithTitle(t, pool, "task", &project, "Beta build")
	_ = seedCardWithTitle(t, pool, "task", &project, "Gamma")

	res := callCardSearchBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_type_name": "task", "query": "rework"},
	})
	if len(res) != 1 || !res[0].OK {
		t.Fatalf("want one ok row, got %+v", res)
	}
	hits := parseSearchHits(t, res[0].Result)
	if len(hits) != 1 || hits[0].ID != strconv.FormatInt(tA, 10) {
		t.Errorf("want [%d], got %+v", tA, hits)
	}
	_ = tB
}

// TestCardSearchBatch_NumericFastPath — typing the task's id surfaces
// the row even when title doesn't contain the digits.
func TestCardSearchBatch_NumericFastPath(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_search_batch_numeric")
	project := seedCardOfType(t, pool, "project", nil)
	tid := seedCardWithTitle(t, pool, "task", &project, "no-digits-here")

	res := callCardSearchBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_type_name": "task", "query": strconv.FormatInt(tid, 10)},
	})
	if len(res) != 1 || !res[0].OK {
		t.Fatalf("want one ok row, got %+v", res)
	}
	hits := parseSearchHits(t, res[0].Result)
	found := false
	for _, h := range hits {
		if h.ID == strconv.FormatInt(tid, 10) {
			found = true
		}
	}
	if !found {
		t.Errorf("numeric fast-path: want id %d in hits %+v", tid, hits)
	}
}

// TestCardSearchBatch_Validation — missing card_type_name fails.
func TestCardSearchBatch_Validation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_search_batch_validation")
	res := callCardSearchBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"query": "abc"},
	})
	if len(res) != 1 || res[0].OK || res[0].Code != "validation" {
		t.Errorf("want validation failure, got %+v", res)
	}
}

// TestCardSearchBatch_MultiInput — two independent searches.
func TestCardSearchBatch_MultiInput(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_search_batch_multi")
	project := seedCardOfType(t, pool, "project", nil)
	seedCardWithTitle(t, pool, "task", &project, "Alpha")
	seedCardWithTitle(t, pool, "task", &project, "Beta")

	res := callCardSearchBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_type_name": "task", "query": "Alpha"},
		{"card_type_name": "task", "query": "Beta"},
	})
	if len(res) != 2 {
		t.Fatalf("res: got %d, want 2", len(res))
	}
	if got := len(parseSearchHits(t, res[0].Result)); got != 1 {
		t.Errorf("row 0: got %d hits, want 1", got)
	}
	if got := len(parseSearchHits(t, res[1].Result)); got != 1 {
		t.Errorf("row 1: got %d hits, want 1", got)
	}
}

// TestCardSearchBatch_Visibility — a scoped worker only sees cards in
// their project; the SAME query against the same data returns 0 hits
// for project B and 1 hit for project A.
func TestCardSearchBatch_Visibility(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_search_batch_vis")
	ctx := context.Background()

	pa := seedCardOfType(t, pool, "project", nil)
	pb := seedCardOfType(t, pool, "project", nil)
	taskA := seedCardWithTitle(t, pool, "task", &pa, "needle-task-A")
	_ = seedCardWithTitle(t, pool, "task", &pb, "needle-task-B")

	var worker int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO user_account (display_name) VALUES ('search-vis-worker') RETURNING id`,
	).Scan(&worker); err != nil {
		t.Fatalf("worker: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO user_role (user_id, role_id, scope_card_id)
		SELECT $1, id, $2 FROM role WHERE name='worker'
	`, worker, pa); err != nil {
		t.Fatalf("user_role: %v", err)
	}

	res := callCardSearchBatch(t, pool, worker, []map[string]any{
		{"card_type_name": "task", "query": "needle-task"},
	})
	hits := parseSearchHits(t, res[0].Result)
	if len(hits) != 1 || hits[0].ID != strconv.FormatInt(taskA, 10) {
		t.Errorf("worker: want only task A (%d); got %+v", taskA, hits)
	}

	// Admin sees both.
	resSys := callCardSearchBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_type_name": "task", "query": "needle-task"},
	})
	if got := len(parseSearchHits(t, resSys[0].Result)); got != 2 {
		t.Errorf("system: got %d hits, want 2", got)
	}
}

// TestCardSearchBatch_ExcludeTerminal — `exclude_terminal` drops tasks whose
// `status` value-card is terminal, keeping only open (triage/active) work. The
// subtask parent/child picker relies on this so done tasks don't crowd the
// recency-capped list.
func TestCardSearchBatch_ExcludeTerminal(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_search_batch_exclude_terminal")
	ctx := context.Background()
	project := seedCardOfType(t, pool, "project", nil)

	// Two status value-cards: one active, one terminal.
	doing := seedCardWithTitle(t, pool, "status", &project, "Doing")
	done := seedCardWithTitle(t, pool, "status", &project, "Done")
	if _, err := pool.Exec(ctx, `UPDATE card SET phase='active' WHERE id=$1`, doing); err != nil {
		t.Fatalf("phase active: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE card SET phase='terminal' WHERE id=$1`, done); err != nil {
		t.Fatalf("phase terminal: %v", err)
	}

	openTask := seedCardWithTitle(t, pool, "task", &project, "Open task")
	closedTask := seedCardWithTitle(t, pool, "task", &project, "Closed task")
	setCardRefAttr(t, pool, openTask, "status", doing)
	setCardRefAttr(t, pool, closedTask, "status", done)

	// Baseline: both tasks come back (scoped to this project so seeded
	// demo tasks in the fresh DB don't count).
	res := callCardSearchBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_type_name": "task", "parent_card_id": strconv.FormatInt(project, 10)},
	})
	if len(res) != 1 || !res[0].OK {
		t.Fatalf("baseline: want one ok row, got %+v", res)
	}
	if got := len(parseSearchHits(t, res[0].Result)); got != 2 {
		t.Fatalf("baseline: want 2 hits, got %d", got)
	}

	// exclude_terminal drops the done task, keeps the open one.
	res = callCardSearchBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_type_name": "task", "parent_card_id": strconv.FormatInt(project, 10), "exclude_terminal": true},
	})
	hits := parseSearchHits(t, res[0].Result)
	if len(hits) != 1 || hits[0].ID != strconv.FormatInt(openTask, 10) {
		t.Errorf("exclude_terminal: want only open task %d, got %+v", openTask, hits)
	}
	_ = closedTask
}

// TestCardSearchBatch_IDLookupBypassesFilters — an exact id query resolves a
// task from ANY project/phase, ignoring the parent_card_id + exclude_terminal
// convenience filters. A non-id (title) query stays scoped to them. Visibility
// still applies (system actor here sees all).
func TestCardSearchBatch_IDLookupBypassesFilters(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_search_batch_id_lookup")
	ctx := context.Background()

	projA := seedCardOfType(t, pool, "project", nil)
	projB := seedCardOfType(t, pool, "project", nil)

	done := seedCardWithTitle(t, pool, "status", &projA, "Done")
	if _, err := pool.Exec(ctx, `UPDATE card SET phase='terminal' WHERE id=$1`, done); err != nil {
		t.Fatalf("phase terminal: %v", err)
	}

	// A terminal task in project A, and a task in project B.
	closedInA := seedCardWithTitle(t, pool, "task", &projA, "Closed-in-A")
	setCardRefAttr(t, pool, closedInA, "status", done)
	taskInB := seedCardWithTitle(t, pool, "task", &projB, "Task-in-B")

	scopeA := strconv.FormatInt(projA, 10)

	// id lookup of the TERMINAL task in A — bypasses exclude_terminal.
	res := callCardSearchBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_type_name": "task", "parent_card_id": scopeA, "exclude_terminal": true,
			"query": strconv.FormatInt(closedInA, 10)},
	})
	if hits := parseSearchHits(t, res[0].Result); len(hits) != 1 || hits[0].ID != strconv.FormatInt(closedInA, 10) {
		t.Errorf("id lookup of terminal task: want [%d], got %+v", closedInA, hits)
	}

	// id lookup of a task in project B while scoped to A — bypasses parent_card_id.
	res = callCardSearchBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_type_name": "task", "parent_card_id": scopeA,
			"query": strconv.FormatInt(taskInB, 10)},
	})
	if hits := parseSearchHits(t, res[0].Result); len(hits) != 1 || hits[0].ID != strconv.FormatInt(taskInB, 10) {
		t.Errorf("cross-project id lookup: want [%d], got %+v", taskInB, hits)
	}

	// A NON-id (title) search for project B's task, scoped to A, still excludes it.
	res = callCardSearchBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_type_name": "task", "parent_card_id": scopeA, "query": "Task-in-B"},
	})
	if hits := parseSearchHits(t, res[0].Result); len(hits) != 0 {
		t.Errorf("title search must stay project-scoped: want [], got %+v", hits)
	}
}

// setCardRefAttr writes a card_ref attribute_value directly (bypassing the
// dispatcher) — value stored as the JSON number the card_ref convention uses.
func setCardRefAttr(t *testing.T, pool *pgxpool.Pool, cardID int64, attrName string, refID int64) {
	t.Helper()
	ctx := context.Background()
	var defID int64
	if err := pool.QueryRow(ctx, `SELECT id FROM attribute_def WHERE name=$1`, attrName).Scan(&defID); err != nil {
		t.Fatalf("attr def %s: %v", attrName, err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		VALUES ($1, $2, to_jsonb($3::bigint))
	`, cardID, defID, refID); err != nil {
		t.Fatalf("attr write %s: %v", attrName, err)
	}
}
