// Direct PL/pgSQL test for card_move_batch — Phase 2 of
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

type cardMoveRow struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callCardMoveBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []cardMoveRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM card_move_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var out []cardMoveRow
	for rows.Next() {
		var r cardMoveRow
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

// seedCardUnder inserts a card row of cardTypeName under parentID.
// Pass parentID=0 for a top-level card.
func seedCardUnder(t *testing.T, pool *pgxpool.Pool, cardTypeName string, parentID int64) int64 {
	t.Helper()
	var id int64
	var parent any
	if parentID == 0 {
		parent = nil
	} else {
		parent = parentID
	}
	if err := pool.QueryRow(context.Background(), `
		INSERT INTO card (card_type_id, parent_card_id)
		SELECT id, $2 FROM card_type WHERE name = $1
		RETURNING id
	`, cardTypeName, parent).Scan(&id); err != nil {
		t.Fatalf("seed card: %v", err)
	}
	return id
}

// TestCardMoveBatch_Happy — move a task from one project to another.
func TestCardMoveBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_move_batch_happy")
	p1 := seedCardUnder(t, pool, "project", 0)
	p2 := seedCardUnder(t, pool, "project", 0)
	taskID := seedCardUnder(t, pool, "task", p1)

	rows := callCardMoveBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": strconv.FormatInt(taskID, 10),
			"new_parent_card_id": strconv.FormatInt(p2, 10)},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("move failed: %+v", rows)
	}
	var parent int64
	if err := pool.QueryRow(context.Background(),
		`SELECT parent_card_id FROM card WHERE id = $1`, taskID).Scan(&parent); err != nil {
		t.Fatalf("read parent: %v", err)
	}
	if parent != p2 {
		t.Errorf("parent=%d, want %d", parent, p2)
	}
}

// TestCardMoveBatch_MultiRow — move two tasks at once.
func TestCardMoveBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_move_batch_multi")
	p1 := seedCardUnder(t, pool, "project", 0)
	p2 := seedCardUnder(t, pool, "project", 0)
	t1 := seedCardUnder(t, pool, "task", p1)
	t2 := seedCardUnder(t, pool, "task", p1)
	rows := callCardMoveBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": strconv.FormatInt(t1, 10),
			"new_parent_card_id": strconv.FormatInt(p2, 10)},
		{"card_id": strconv.FormatInt(t2, 10),
			"new_parent_card_id": strconv.FormatInt(p2, 10)},
	})
	if len(rows) != 2 {
		t.Fatalf("rows: got %d, want 2", len(rows))
	}
	for i, r := range rows {
		if r.Idx != i || !r.OK {
			t.Errorf("row %d: %+v", i, r)
		}
	}
}

// TestCardMoveBatch_Validation — card_id=0 → 'validation'.
func TestCardMoveBatch_Validation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_move_batch_validation")
	rows := callCardMoveBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": "0", "new_parent_card_id": "1"},
	})
	if len(rows) != 1 || rows[0].OK {
		t.Fatalf("want fail: %+v", rows)
	}
	if rows[0].Code != "validation" {
		t.Errorf("code=%q, want 'validation'", rows[0].Code)
	}
}

// TestCardMoveBatch_EdgeViolation — moving a task under a status (wrong
// parent type) is rejected with 'edge_violation'.
func TestCardMoveBatch_EdgeViolation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_move_batch_edge")
	p := seedCardUnder(t, pool, "project", 0)
	task := seedCardUnder(t, pool, "task", p)
	status := seedCardUnder(t, pool, "status", p)
	rows := callCardMoveBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": strconv.FormatInt(task, 10),
			"new_parent_card_id": strconv.FormatInt(status, 10)},
	})
	if len(rows) != 1 || rows[0].OK {
		t.Fatalf("want fail: %+v", rows)
	}
	if rows[0].Code != "edge_violation" {
		t.Errorf("code=%q, want 'edge_violation'", rows[0].Code)
	}
}

// TestCardMoveBatch_ParentNotFound — non-existent new_parent_card_id →
// 'parent_not_found'.
func TestCardMoveBatch_ParentNotFound(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_move_batch_no_parent")
	p := seedCardUnder(t, pool, "project", 0)
	task := seedCardUnder(t, pool, "task", p)
	rows := callCardMoveBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": strconv.FormatInt(task, 10), "new_parent_card_id": "999999"},
	})
	if len(rows) != 1 || rows[0].OK {
		t.Fatalf("want fail: %+v", rows)
	}
	if rows[0].Code != "parent_not_found" {
		t.Errorf("code=%q, want 'parent_not_found'", rows[0].Code)
	}
}

// TestCardMoveBatch_SelfParentCycle — moving a card under itself is
// rejected with 'cycle' (A1 / SEC-1). Tasks allow self-parenting, so
// the parent-type check would otherwise pass; the cycle guard is what
// must fire.
func TestCardMoveBatch_SelfParentCycle(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_move_batch_self_cycle")
	p := seedCardUnder(t, pool, "project", 0)
	task := seedCardUnder(t, pool, "task", p)
	rows := callCardMoveBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": strconv.FormatInt(task, 10),
			"new_parent_card_id": strconv.FormatInt(task, 10)},
	})
	if len(rows) != 1 || rows[0].OK {
		t.Fatalf("want fail: %+v", rows)
	}
	if rows[0].Code != "cycle" {
		t.Errorf("code=%q, want 'cycle'", rows[0].Code)
	}
}

// TestCardMoveBatch_DescendantCycle — A→B (B parented under A), then
// moving A under B is rejected with 'cycle': B is a descendant of A so
// re-parenting A under B would close a loop. Both are tasks
// (allow_self_parent) so the parent-type check passes — the cycle
// guard is the only thing that can reject this.
func TestCardMoveBatch_DescendantCycle(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_move_batch_desc_cycle")
	p := seedCardUnder(t, pool, "project", 0)
	a := seedCardUnder(t, pool, "task", p)
	b := seedCardUnder(t, pool, "task", a) // B is a child of A
	rows := callCardMoveBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": strconv.FormatInt(a, 10),
			"new_parent_card_id": strconv.FormatInt(b, 10)},
	})
	if len(rows) != 1 || rows[0].OK {
		t.Fatalf("want fail: %+v", rows)
	}
	if rows[0].Code != "cycle" {
		t.Errorf("code=%q, want 'cycle' (descendant cycle)", rows[0].Code)
	}
	// A's parent must be unchanged after the rejected move.
	var parent int64
	if err := pool.QueryRow(context.Background(),
		`SELECT parent_card_id FROM card WHERE id = $1`, a).Scan(&parent); err != nil {
		t.Fatalf("read parent: %v", err)
	}
	if parent != p {
		t.Errorf("A's parent changed to %d after rejected cycle move (want %d)", parent, p)
	}
}

// setMilestoneRef stamps a card_ref `milestone_ref` value on a card,
// pointing at the given milestone card id. Direct SQL — the test just
// needs a stored card_ref value to drive card_ref_cross_project.
func setMilestoneRef(t *testing.T, pool *pgxpool.Pool, cardID, milestoneID int64) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		SELECT $1, ad.id, to_jsonb($2::bigint)
		FROM attribute_def ad WHERE ad.name = 'milestone_ref'
		ON CONFLICT (card_id, attribute_def_id) DO UPDATE SET value = EXCLUDED.value
	`, cardID, milestoneID)
	if err != nil {
		t.Fatalf("set milestone_ref: %v", err)
	}
}

// TestCardMoveBatch_CrossProjectRefRejected is the A11 / BE-M5
// regression: a task in project A whose milestone_ref points at a
// milestone in project A cannot be moved to project B, because after the
// move the ref would cross projects. card.insert / attribute.update
// enforce this at write time; card.move must re-validate it on
// re-parent.
func TestCardMoveBatch_CrossProjectRefRejected(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_move_xproj_ref")
	pA := seedCardUnder(t, pool, "project", 0)
	pB := seedCardUnder(t, pool, "project", 0)
	milestoneA := seedCardUnder(t, pool, "milestone", pA)
	task := seedCardUnder(t, pool, "task", pA)
	setMilestoneRef(t, pool, task, milestoneA)

	rows := callCardMoveBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": strconv.FormatInt(task, 10),
			"new_parent_card_id": strconv.FormatInt(pB, 10)},
	})
	if len(rows) != 1 || rows[0].OK {
		t.Fatalf("want cross_project_ref failure: %+v", rows)
	}
	if rows[0].Code != "cross_project_ref" {
		t.Errorf("code=%q, want 'cross_project_ref'", rows[0].Code)
	}
	// The move must NOT have happened.
	var parent int64
	if err := pool.QueryRow(context.Background(),
		`SELECT parent_card_id FROM card WHERE id = $1`, task).Scan(&parent); err != nil {
		t.Fatalf("read parent: %v", err)
	}
	if parent != pA {
		t.Errorf("task re-parented to %d despite cross_project_ref rejection (want %d)", parent, pA)
	}
}

// TestCardMoveBatch_SameProjectRefAllowed: moving WITHIN the same
// project (or moving a card whose only refs are global) is unaffected by
// the A11 check — the milestone_ref still points into the destination
// project, so the move proceeds.
func TestCardMoveBatch_SameProjectRefAllowed(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_move_sameproj_ref")
	pA := seedCardUnder(t, pool, "project", 0)
	milestoneA := seedCardUnder(t, pool, "milestone", pA)
	// A sub-task chain inside project A: moving the task under a sibling
	// milestone (still in A) keeps the ref in-project.
	task := seedCardUnder(t, pool, "task", pA)
	setMilestoneRef(t, pool, task, milestoneA)

	// Move the task under another task in the same project (tasks allow
	// self-parent), enclosing project unchanged.
	host := seedCardUnder(t, pool, "task", pA)
	rows := callCardMoveBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": strconv.FormatInt(task, 10),
			"new_parent_card_id": strconv.FormatInt(host, 10)},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("same-project move should succeed: %+v", rows)
	}
}
