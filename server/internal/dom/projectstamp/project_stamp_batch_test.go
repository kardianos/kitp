// Direct PL/pgSQL test for project_stamp_batch — Phase 4 of
// docs/UNIFIED_HANDLER_PLAN.md. Calls the function over `pool.Query`
// and asserts per-row outputs and the descendant counts of the stamped
// project, independent of the dispatcher.
//
// Coverage:
//   - happy path: stamp the install-seed template; verify the new
//     project carries the canonical 7 screens + 6 task statuses + 3
//     comm statuses + status flow + comm flow + flow_steps +
//     predicate_snippets.
//   - validation: empty name, missing template_project_id.
//   - lookup: template_not_found, template_not_project.
//   - multi-row batch: two stamps in one call, both ok=true with
//     distinct new_project_id values.
package projectstamp_test

import (
	"context"
	"encoding/json"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

type stampBatchRow struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callProjectStampBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []stampBatchRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM project_stamp_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var out []stampBatchRow
	for rows.Next() {
		var r stampBatchRow
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

// lookupInstallSeedTemplate fetches the install-seed template's project
// card id. The seed loader creates one is_template=TRUE project per
// fresh DB; failing this lookup means the test DB isn't seeded.
func lookupInstallSeedTemplate(t *testing.T, pool *pgxpool.Pool) int64 {
	t.Helper()
	var id int64
	if err := pool.QueryRow(context.Background(), `
		SELECT c.id FROM card c
		JOIN attribute_value av ON av.card_id = c.id
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE ad.name = 'is_template' AND av.value = to_jsonb(TRUE)
		LIMIT 1
	`).Scan(&id); err != nil {
		t.Fatalf("seed template lookup (DB not seeded?): %v", err)
	}
	return id
}

// countDescendantsByCardType counts non-deleted descendants of `root`
// whose card_type.name matches `typ`.
func countDescendantsByCardType(t *testing.T, pool *pgxpool.Pool, root int64, typ string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), `
		WITH RECURSIVE walk AS (
			SELECT id, card_type_id, parent_card_id FROM card
			WHERE parent_card_id = $1 AND deleted_at IS NULL
			UNION ALL
			SELECT c.id, c.card_type_id, c.parent_card_id FROM card c
			JOIN walk w ON w.id = c.parent_card_id
			WHERE c.deleted_at IS NULL
		)
		SELECT count(*) FROM walk w JOIN card_type ct ON ct.id = w.card_type_id WHERE ct.name = $2
	`, root, typ).Scan(&n); err != nil {
		t.Fatalf("count %s: %v", typ, err)
	}
	return n
}

// TestProjectStampBatch_HappyInstallSeed exercises the canonical happy
// path: stamp the install-seed template and verify the new project
// carries the same structural shape (7 screens + 9 statuses + 2 flows
// + flow_steps + predicate_snippets) with fresh ids.
func TestProjectStampBatch_HappyInstallSeed(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_project_stamp_batch_happy")
	templateID := lookupInstallSeedTemplate(t, pool)

	rows := callProjectStampBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"template_project_id": strconv.FormatInt(templateID, 10), "name": "Stamped"},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(rows))
	}
	r := rows[0]
	if !r.OK {
		t.Fatalf("want ok=true; got ok=%v code=%q msg=%q", r.OK, r.Code, r.Message)
	}
	var got struct {
		NewProjectID string   `json:"new_project_id"`
		Warnings     []string `json:"warnings"`
	}
	if err := json.Unmarshal(r.Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	newID, err := strconv.ParseInt(got.NewProjectID, 10, 64)
	if err != nil || newID == 0 {
		t.Fatalf("new_project_id parse: %v (raw=%q)", err, got.NewProjectID)
	}
	if newID == templateID {
		t.Fatalf("new project id equals template id (%d)", templateID)
	}
	// Install-seed template carries content → no V24 warnings.
	if len(got.Warnings) != 0 {
		t.Errorf("unexpected warnings on populated template: %+v", got.Warnings)
	}

	// 7 screens (6 original + Comms from Gate 7 of email_comm_spec).
	if n := countDescendantsByCardType(t, pool, newID, "screen"); n != 7 {
		t.Errorf("screens = %d, want 7", n)
	}
	// 9 statuses (6 task + 3 comm).
	if n := countDescendantsByCardType(t, pool, newID, "status"); n != 9 {
		t.Errorf("statuses = %d, want 9", n)
	}
	// Predicate snippets carried by the template (Overdue / Due within
	// 3 days / Heads — 3 of them per declarative.toml seed).
	if n := countDescendantsByCardType(t, pool, newID, "predicate_snippet"); n != 3 {
		t.Errorf("predicate_snippets = %d, want 3", n)
	}

	// Two flows under the new project (status + comm).
	var flowN int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM flow WHERE scope_card_id = $1`, newID).Scan(&flowN); err != nil {
		t.Fatalf("flow count: %v", err)
	}
	if flowN != 2 {
		t.Errorf("flows = %d, want 2 (status + comm)", flowN)
	}

	// Status flow has 12 flow_steps; comm flow has 3. Total 15.
	var stepN int
	if err := pool.QueryRow(context.Background(), `
		SELECT count(*) FROM flow_step fs
		JOIN flow f ON f.id = fs.flow_id
		WHERE f.scope_card_id = $1
	`, newID).Scan(&stepN); err != nil {
		t.Fatalf("flow_step count: %v", err)
	}
	if stepN != 15 {
		t.Errorf("flow_steps = %d, want 15 (12 task + 3 comm)", stepN)
	}

	// New project's is_template attribute_value is FALSE (the stamp
	// output is not itself a template).
	var isTemplate bool
	if err := pool.QueryRow(context.Background(), `
		SELECT (av.value)::text::boolean FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1 AND ad.name = 'is_template'
	`, newID).Scan(&isTemplate); err != nil {
		t.Fatalf("new project is_template lookup: %v", err)
	}
	if isTemplate {
		t.Errorf("new project is_template = true; should be false")
	}

	// Title was written from the input.
	var newTitle string
	if err := pool.QueryRow(context.Background(), `
		SELECT av.value #>> '{}' FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1 AND ad.name = 'title'
	`, newID).Scan(&newTitle); err != nil {
		t.Fatalf("title lookup: %v", err)
	}
	if newTitle != "Stamped" {
		t.Errorf("title = %q, want %q", newTitle, "Stamped")
	}
}

// TestProjectStampBatch_ValidationFailures covers the per-row
// validation rejections: empty name, missing template id, template not
// found, template not a project.
func TestProjectStampBatch_ValidationFailures(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_project_stamp_batch_validation")
	templateID := lookupInstallSeedTemplate(t, pool)

	// Locate a non-project card (any task in the seed will do).
	var someTaskID int64
	if err := pool.QueryRow(context.Background(), `
		SELECT c.id FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id
		WHERE ct.name = 'task' AND c.deleted_at IS NULL
		LIMIT 1
	`).Scan(&someTaskID); err != nil {
		// If the seed has no tasks, fall back to any non-project card.
		if err := pool.QueryRow(context.Background(), `
			SELECT c.id FROM card c
			JOIN card_type ct ON ct.id = c.card_type_id
			WHERE ct.name <> 'project' AND c.deleted_at IS NULL
			LIMIT 1
		`).Scan(&someTaskID); err != nil {
			t.Fatalf("locate a non-project card: %v", err)
		}
	}

	rows := callProjectStampBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"template_project_id": strconv.FormatInt(templateID, 10), "name": ""},
		{"template_project_id": "", "name": "no template"},
		{"template_project_id": "999999999", "name": "missing"},
		{"template_project_id": strconv.FormatInt(someTaskID, 10), "name": "wrong type"},
	})
	if len(rows) != 4 {
		t.Fatalf("rows: got %d, want 4", len(rows))
	}
	wantCodes := []string{"validation", "validation", "template_not_found", "template_not_project"}
	for i, want := range wantCodes {
		if rows[i].OK {
			t.Errorf("row %d: ok=true; want ok=false", i)
		}
		if rows[i].Code != want {
			t.Errorf("row %d: code=%q, want %q (msg=%q)", i, rows[i].Code, want, rows[i].Message)
		}
	}
}

// TestProjectStampBatch_MultiRow runs two stamps in one batch and
// confirms both succeed with distinct new_project_id values.
func TestProjectStampBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_project_stamp_batch_multi")
	templateID := lookupInstallSeedTemplate(t, pool)

	rows := callProjectStampBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"template_project_id": strconv.FormatInt(templateID, 10), "name": "First"},
		{"template_project_id": strconv.FormatInt(templateID, 10), "name": "Second"},
	})
	if len(rows) != 2 {
		t.Fatalf("rows: got %d, want 2", len(rows))
	}
	seen := make(map[string]bool)
	for i, r := range rows {
		if !r.OK {
			t.Fatalf("row %d: ok=false code=%q msg=%q", i, r.Code, r.Message)
		}
		var got struct {
			NewProjectID string `json:"new_project_id"`
		}
		if err := json.Unmarshal(r.Result, &got); err != nil {
			t.Fatalf("row %d: unmarshal: %v", i, err)
		}
		if got.NewProjectID == "" || got.NewProjectID == "0" {
			t.Errorf("row %d: new_project_id empty", i)
		}
		if seen[got.NewProjectID] {
			t.Errorf("row %d: duplicate new_project_id %s", i, got.NewProjectID)
		}
		seen[got.NewProjectID] = true
	}
}
