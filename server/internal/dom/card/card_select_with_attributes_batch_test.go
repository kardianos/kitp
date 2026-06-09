// Direct PL/pgSQL test for card_select_with_attributes_batch — Phase 5
// of docs/UNIFIED_HANDLER_PLAN.md.
//
// The Go-side dispatcher integration tests (select_attrs_test.go,
// visibility_test.go, personal_sort_test.go, routed_to_me_test.go)
// already cover end-to-end behaviour. These tests pin the function
// shape itself: happy + empty + multi-input on raw JSONB inputs, plus
// a visibility regression to confirm the SQL function's recursive
// up-walk gates on the project-scoped user_role correctly.
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

type swaRow struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callCardSelectWithAttrsBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []swaRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM card_select_with_attributes_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var out []swaRow
	for rows.Next() {
		var r swaRow
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

type swaResultRow struct {
	ID           string                     `json:"id"`
	CardTypeName string                     `json:"card_type_name"`
	Title        string                     `json:"title"`
	Attributes   map[string]json.RawMessage `json:"attributes"`
}

type swaResult struct {
	Rows []swaResultRow `json:"rows"`
}

func decodeSWA(t *testing.T, raw json.RawMessage) swaResult {
	t.Helper()
	var out swaResult
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("decode result: %v\n%s", err, raw)
	}
	return out
}

// seedProjectWithTask creates a minimal project + status + task and
// returns (project_id, task_id). Skips card.insert so this test stays
// independent of the writer migration.
func seedProjectWithTask(t *testing.T, pool *pgxpool.Pool, title string) (int64, int64) {
	t.Helper()
	ctx := context.Background()
	var projectID, taskID, titleAttrDefID int64
	if err := pool.QueryRow(ctx,
		`SELECT id FROM attribute_def WHERE name = 'title'`).Scan(&titleAttrDefID); err != nil {
		t.Fatalf("title attr_def: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO card (card_type_id)
		SELECT id FROM card_type WHERE name = 'project'
		RETURNING id`).Scan(&projectID); err != nil {
		t.Fatalf("project: %v", err)
	}
	_, err := pool.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		VALUES ($1, $2, to_jsonb($3::text))
	`, projectID, titleAttrDefID, title+" Project")
	if err != nil {
		t.Fatalf("project title: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO card (card_type_id, parent_card_id)
		SELECT id, $1 FROM card_type WHERE name = 'task'
		RETURNING id`, projectID).Scan(&taskID); err != nil {
		t.Fatalf("task: %v", err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		VALUES ($1, $2, to_jsonb($3::text))
	`, taskID, titleAttrDefID, title+" Task")
	if err != nil {
		t.Fatalf("task title: %v", err)
	}
	return projectID, taskID
}

// TestCardSelectWithAttrsBatch_Happy seeds a project + task and reads
// the task with the unified function. Verifies the per-row JSONB shape:
// id (string), card_type_name, attributes map carrying the title.
func TestCardSelectWithAttrsBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_swa_batch_happy")
	projectID, taskID := seedProjectWithTask(t, pool, "happy")

	rows := callCardSelectWithAttrsBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"parent_card_id": strconv.FormatInt(projectID, 10), "card_type_name": "task"},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("happy failed: %+v", rows)
	}
	res := decodeSWA(t, rows[0].Result)
	if len(res.Rows) != 1 {
		t.Fatalf("rows count: %+v", res.Rows)
	}
	if res.Rows[0].ID != strconv.FormatInt(taskID, 10) {
		t.Errorf("row id=%q, want %q", res.Rows[0].ID, strconv.FormatInt(taskID, 10))
	}
	if res.Rows[0].CardTypeName != "task" {
		t.Errorf("card_type_name=%q", res.Rows[0].CardTypeName)
	}
	title := res.Rows[0].Attributes["title"]
	if string(title) != `"happy Task"` {
		t.Errorf("title=%s; want \"happy Task\"", string(title))
	}
}

// TestCardSelectWithAttrsBatch_IdSearch — the synthetic `id` predicate matches
// the card's own primary key, powering the search bar's numeric "jump to #ID".
// The OR(id eq N, title contains …) shape the client builds returns the exact
// card even when its title doesn't contain the digits; a wrong id matches none.
func TestCardSelectWithAttrsBatch_IdSearch(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_swa_id_search")
	projectID, taskID := seedProjectWithTask(t, pool, "happy")

	// OR(id eq taskID, title contains "zzz") — the title leaf can't match, so a
	// hit proves the id leaf compiled to `c.id = taskID`.
	rows := callCardSelectWithAttrsBatch(t, pool, auth.SystemUserID, []map[string]any{
		{
			"parent_card_id": strconv.FormatInt(projectID, 10),
			"card_type_name": "task",
			"tree": map[string]any{
				"connective": "or",
				"children": []any{
					map[string]any{"attr": "id", "op": "eq", "values": []any{strconv.FormatInt(taskID, 10)}},
					map[string]any{"attr": "title", "op": "contains", "values": []any{"zzz-no-match"}},
				},
			},
		},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("id search failed: %+v", rows)
	}
	res := decodeSWA(t, rows[0].Result)
	if len(res.Rows) != 1 || res.Rows[0].ID != strconv.FormatInt(taskID, 10) {
		t.Fatalf("id search rows=%+v, want exactly task %d", res.Rows, taskID)
	}

	// A non-matching id returns nothing (and the unmatched title leaf too).
	rows = callCardSelectWithAttrsBatch(t, pool, auth.SystemUserID, []map[string]any{
		{
			"parent_card_id": strconv.FormatInt(projectID, 10),
			"card_type_name": "task",
			"tree":           map[string]any{"attr": "id", "op": "eq", "values": []any{"9999999"}},
		},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("id miss failed: %+v", rows)
	}
	if res := decodeSWA(t, rows[0].Result); len(res.Rows) != 0 {
		t.Errorf("wrong-id search returned %d rows, want 0", len(res.Rows))
	}
}

// TestCardSelectWithAttrsBatch_Empty — no matching rows returns
// an empty rows array (not null).
func TestCardSelectWithAttrsBatch_Empty(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_swa_batch_empty")
	rows := callCardSelectWithAttrsBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"parent_card_id": "9999999", "card_type_name": "task"},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("empty case failed: %+v", rows)
	}
	res := decodeSWA(t, rows[0].Result)
	if res.Rows == nil {
		t.Errorf("rows=nil; want non-nil empty array")
	}
	if len(res.Rows) != 0 {
		t.Errorf("rows=%v; want []", res.Rows)
	}
}

// TestCardSelectWithAttrsBatch_MultiInput — two separate filters in
// one call; both return distinct rows in idx order.
func TestCardSelectWithAttrsBatch_MultiInput(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_swa_batch_multi")
	projectA, _ := seedProjectWithTask(t, pool, "A")
	projectB, _ := seedProjectWithTask(t, pool, "B")

	rows := callCardSelectWithAttrsBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"parent_card_id": strconv.FormatInt(projectA, 10), "card_type_name": "task"},
		{"parent_card_id": strconv.FormatInt(projectB, 10), "card_type_name": "task"},
	})
	if len(rows) != 2 {
		t.Fatalf("row count: %d", len(rows))
	}
	for i, r := range rows {
		if !r.OK || r.Idx != i {
			t.Fatalf("rows[%d]: %+v", i, r)
		}
		res := decodeSWA(t, r.Result)
		if len(res.Rows) != 1 {
			t.Errorf("rows[%d]: want 1, got %v", i, res.Rows)
		}
	}
}

// TestCardSelectWithAttrsBatch_VisibilityScoped seeds two parallel
// projects and a worker-scoped user_role attached only to project A.
// Reading under projectB must return zero rows for that worker even
// though the row exists — the SQL function's visibility predicate
// (B7) must walk parent_card_id and pin against user_role.
func TestCardSelectWithAttrsBatch_VisibilityScoped(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_swa_batch_visibility")
	ctx := context.Background()
	pA, tA := seedProjectWithTask(t, pool, "VisA")
	pB, _ := seedProjectWithTask(t, pool, "VisB")

	// Worker user scoped to project A.
	var workerID int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO user_account (display_name) VALUES ('swa-worker') RETURNING id`).
		Scan(&workerID); err != nil {
		t.Fatalf("worker: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO user_role (user_id, role_id, scope_card_id)
		SELECT $1, id, $2 FROM role WHERE name = 'worker'
	`, workerID, pA); err != nil {
		t.Fatalf("user_role: %v", err)
	}

	// As worker, reading projectA's tasks: see tA only.
	rows := callCardSelectWithAttrsBatch(t, pool, workerID, []map[string]any{
		{"parent_card_id": strconv.FormatInt(pA, 10), "card_type_name": "task"},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("worker→A: %+v", rows)
	}
	res := decodeSWA(t, rows[0].Result)
	if len(res.Rows) != 1 || res.Rows[0].ID != strconv.FormatInt(tA, 10) {
		t.Errorf("worker→A rows=%v; want [%d]", res.Rows, tA)
	}

	// As worker, reading projectB's tasks: visibility predicate hides
	// the row even though it exists.
	rows = callCardSelectWithAttrsBatch(t, pool, workerID, []map[string]any{
		{"parent_card_id": strconv.FormatInt(pB, 10), "card_type_name": "task"},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("worker→B: %+v", rows)
	}
	res = decodeSWA(t, rows[0].Result)
	if len(res.Rows) != 0 {
		t.Errorf("worker→B leaked tasks: %v", res.Rows)
	}
}

// TestCardSelectWithAttrsBatch_AssigneeMe — the dynamic "@me" person-ref token
// resolves to the CALLER's person card id (via user_account_person), so an
// "assignee == @me" filter returns only the caller's own tasks. A caller with
// no linked person resolves "@me" to nothing (matches no rows).
func TestCardSelectWithAttrsBatch_AssigneeMe(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_swa_assignee_me")
	ctx := context.Background()

	var projectID, assigneeDefID int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name='project' RETURNING id`).
		Scan(&projectID); err != nil {
		t.Fatalf("project: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT id FROM attribute_def WHERE name='assignee'`).Scan(&assigneeDefID); err != nil {
		t.Fatalf("assignee attr_def: %v", err)
	}
	mkPerson := func() int64 {
		var id int64
		if err := pool.QueryRow(ctx,
			`INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name='person' RETURNING id`).
			Scan(&id); err != nil {
			t.Fatalf("person: %v", err)
		}
		return id
	}
	mkTaskAssignedTo := func(person int64) int64 {
		var id int64
		if err := pool.QueryRow(ctx,
			`INSERT INTO card (card_type_id, parent_card_id) SELECT id, $1 FROM card_type WHERE name='task' RETURNING id`,
			projectID).Scan(&id); err != nil {
			t.Fatalf("task: %v", err)
		}
		if _, err := pool.Exec(ctx,
			`INSERT INTO attribute_value (card_id, attribute_def_id, value) VALUES ($1, $2, to_jsonb($3::bigint))`,
			id, assigneeDefID, person); err != nil {
			t.Fatalf("assignee value: %v", err)
		}
		return id
	}
	// A worker-scoped user so the caller can SEE the project's tasks.
	mkWorker := func(name string) int64 {
		var uid int64
		if err := pool.QueryRow(ctx,
			`INSERT INTO user_account (display_name) VALUES ($1) RETURNING id`, name).Scan(&uid); err != nil {
			t.Fatalf("user: %v", err)
		}
		if _, err := pool.Exec(ctx,
			`INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT $1, id, $2 FROM role WHERE name='worker'`,
			uid, projectID); err != nil {
			t.Fatalf("user_role: %v", err)
		}
		return uid
	}

	personMine := mkPerson()
	personOther := mkPerson()
	myTask := mkTaskAssignedTo(personMine)
	otherTask := mkTaskAssignedTo(personOther)

	// `me` is linked to personMine; `noPerson` has visibility but no person.
	me := mkWorker("me-user")
	if _, err := pool.Exec(ctx,
		`INSERT INTO user_account_person (user_account_id, person_card_id) VALUES ($1, $2)`,
		me, personMine); err != nil {
		t.Fatalf("link person: %v", err)
	}
	noPerson := mkWorker("no-person-user")

	meTree := []map[string]any{{
		"card_type_name": "task",
		"parent_card_id": strconv.FormatInt(projectID, 10),
		"tree":           map[string]any{"attr": "assignee", "op": "eq", "values": []any{"@me"}},
	}}

	// As `me`: "@me" resolves to personMine → only myTask matches.
	rows := callCardSelectWithAttrsBatch(t, pool, me, meTree)
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("me query: %+v", rows)
	}
	res := decodeSWA(t, rows[0].Result)
	ids := map[string]bool{}
	for _, r := range res.Rows {
		ids[r.ID] = true
	}
	if !ids[strconv.FormatInt(myTask, 10)] {
		t.Errorf("assignee==@me should match my task %d; got %v", myTask, res.Rows)
	}
	if ids[strconv.FormatInt(otherTask, 10)] {
		t.Errorf("assignee==@me leaked another user's task %d", otherTask)
	}

	// As `noPerson`: "@me" resolves to nothing → no rows (despite visibility).
	rows = callCardSelectWithAttrsBatch(t, pool, noPerson, meTree)
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("noPerson query: %+v", rows)
	}
	res = decodeSWA(t, rows[0].Result)
	if len(res.Rows) != 0 {
		t.Errorf("no linked person → @me should match nothing; got %v", res.Rows)
	}
}

// TestCardSelectWithAttrsBatch_WithinLastDays — the within_last_days op on the
// top-level last_activity_at field matches only cards whose most-recent activity
// is within N days (a card last touched 30 days ago is excluded at N=15). This
// is the backbone of "closed in the last 15 days" (terminal + this op).
func TestCardSelectWithAttrsBatch_WithinLastDays(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_swa_within_last_days")
	ctx := context.Background()

	var projectID, recentTask, oldTask int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name='project' RETURNING id`).
		Scan(&projectID); err != nil {
		t.Fatalf("project: %v", err)
	}
	mkTask := func() int64 {
		var id int64
		if err := pool.QueryRow(ctx,
			`INSERT INTO card (card_type_id, parent_card_id) SELECT id, $1 FROM card_type WHERE name='task' RETURNING id`,
			projectID).Scan(&id); err != nil {
			t.Fatalf("task: %v", err)
		}
		return id
	}
	recentTask = mkTask()
	oldTask = mkTask()

	// recentTask's last activity is now(); oldTask's is 30 days ago.
	if _, err := pool.Exec(ctx,
		`INSERT INTO activity (card_id, kind, actor_id, created_at) VALUES ($1, 'test', $2, now())`,
		recentTask, auth.SystemUserID); err != nil {
		t.Fatalf("recent activity: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO activity (card_id, kind, actor_id, created_at) VALUES ($1, 'test', $2, now() - interval '30 days')`,
		oldTask, auth.SystemUserID); err != nil {
		t.Fatalf("old activity: %v", err)
	}

	inputs := []map[string]any{{
		"card_type_name": "task",
		"parent_card_id": strconv.FormatInt(projectID, 10),
		"tree":           map[string]any{"attr": "last_activity_at", "op": "within_last_days", "values": []any{15}},
	}}
	rows := callCardSelectWithAttrsBatch(t, pool, auth.SystemUserID, inputs)
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("want ok; got %+v", rows[0])
	}
	res := decodeSWA(t, rows[0].Result)
	got := map[string]bool{}
	for _, r := range res.Rows {
		got[r.ID] = true
	}
	if !got[strconv.FormatInt(recentTask, 10)] {
		t.Errorf("recent task (activity today) should match within_last_days 15")
	}
	if got[strconv.FormatInt(oldTask, 10)] {
		t.Errorf("old task (activity 30d ago) should NOT match within_last_days 15")
	}
}
