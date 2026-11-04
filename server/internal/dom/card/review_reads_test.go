package card_test

// Regression tests for the read findings of the 2026-11-03 review (area C):
// child-path filters (#15), the activity feed's comment bodies (#4) and the
// flow-step lists (#25).

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/activity"
	"github.com/kitp/kitp/server/internal/dom/flow"
)

// TestChildPathRespectsPrivacyAndAreas (#15): a child-path leaf can't match
// on someone else's private child, or on a child in a switched-off area.
func TestChildPathRespectsPrivacyAndAreas(t *testing.T) {
	f := setupVisibility(t, "kitp_test_review_child_path")
	ctx := context.Background()
	ada := reviewUser(t, f, "ada-cp", "worker", f.projectA)
	reviewPerson(t, f, ada)
	sys := auth.SystemUserID
	screen := insertedID(t, reviewCall(t, f, sys, "card", "insert", fmt.Sprintf(
		`{"card_type_name":"screen","parent_card_id":"%d","title":"Board","attributes":{"layout":"list","slug":"board-cp"}}`, f.projectA)))
	if r := reviewCall(t, f, ada, "card", "insert", fmt.Sprintf(
		`{"card_type_name":"filter","parent_card_id":"%d","title":"ada interviewing zebra","private":true}`, screen)); !r.OK {
		t.Fatalf("private view: %+v", r.Error)
	}
	screens := func(uid int64, needle string) int {
		t.Helper()
		r := reviewCall(t, f, uid, "card", "select_with_attributes", fmt.Sprintf(
			`{"card_type_name":"screen","parent_card_id":"%d","tree":{"connective":"and","children":[{"attr":"filter.title","op":"contains","values":[%q]}]}}`,
			f.projectA, needle))
		if !r.OK {
			t.Fatalf("select: %+v", r.Error)
		}
		var out struct {
			Rows []json.RawMessage `json:"rows"`
		}
		b, _ := json.Marshal(r.Data)
		if err := json.Unmarshal(b, &out); err != nil {
			t.Fatal(err)
		}
		return len(out.Rows)
	}
	if n := screens(f.worker, "zebra"); n != 0 {
		t.Errorf("another worker matched a screen on Ada's private view's title (%d rows)", n)
	}
	if n := screens(ada, "zebra"); n != 1 {
		t.Errorf("Ada's own view: %d rows, want 1", n)
	}

	// A thread under a task, then Conversations off: its title no longer
	// matches through comm.title.
	var thread int64
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO card (card_type_id, parent_card_id) SELECT id, $1 FROM card_type WHERE name = 'comm' RETURNING id`, f.taskA).Scan(&thread); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sp.P.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		SELECT $1, id, to_jsonb('secret quarterly numbers'::text) FROM attribute_def WHERE name = 'title'`, thread); err != nil {
		t.Fatal(err)
	}
	tasks := func() int {
		r := reviewCall(t, f, f.worker, "card", "select_with_attributes", fmt.Sprintf(
			`{"card_type_name":"task","parent_card_id":"%d","tree":{"connective":"and","children":[{"attr":"comm.title","op":"contains","values":["quarterly"]}]}}`, f.projectA))
		if !r.OK {
			t.Fatalf("select: %+v", r.Error)
		}
		var out struct {
			Rows []json.RawMessage `json:"rows"`
		}
		b, _ := json.Marshal(r.Data)
		if err := json.Unmarshal(b, &out); err != nil {
			t.Fatal(err)
		}
		return len(out.Rows)
	}
	if n := tasks(); n != 1 {
		t.Fatalf("with Conversations on, comm.title matched %d tasks, want 1", n)
	}
	if _, err := f.sp.P.Exec(ctx, `INSERT INTO project_area (project_id, area_key, state) VALUES ($1, 'conversations', 'off')`, f.projectA); err != nil {
		t.Fatal(err)
	}
	if n := tasks(); n != 0 {
		t.Errorf("with Conversations off, comm.title still matched %d tasks", n)
	}
}

// TestActivityCommentBodies (#4): only comment and approval rows show a
// comment body; any other row shaped like one shows none, and a broken
// one doesn't break the feed.
func TestActivityCommentBodies(t *testing.T) {
	f := setupVisibility(t, "kitp_test_review_activity_body")
	activity.Register(f.sp)
	ctx := context.Background()
	var bodyID int64
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO comment_body (body) VALUES ('B''s private comment') RETURNING id`).Scan(&bodyID); err != nil {
		t.Fatal(err)
	}
	// Rows a text attribute could once have produced (attribute.update now
	// refuses objects, so they're written directly).
	for _, v := range []string{fmt.Sprintf(`{"comment_body_id":"%d"}`, bodyID), `{"comment_body_id":"zz"}`} {
		if _, err := f.sp.P.Exec(ctx, `
			INSERT INTO activity (card_id, kind, attribute_def_id, value_new, actor_id)
			SELECT $1, 'attr_update', id, $2::jsonb, $3 FROM attribute_def WHERE name = 'title'`, f.taskA, v, f.worker); err != nil {
			t.Fatal(err)
		}
	}
	for _, data := range []string{fmt.Sprintf(`{"card_id":"%d"}`, f.taskA), fmt.Sprintf(`{"project_id":"%d"}`, f.projectA)} {
		r := reviewCall(t, f, f.worker, "activity", "select", data)
		if !r.OK {
			t.Fatalf("activity.select %s: %+v", data, r.Error)
		}
		b, _ := json.Marshal(r.Data)
		if strings.Contains(string(b), "private comment") {
			t.Errorf("activity.select %s showed a comment body on an attribute row", data)
		}
	}
}

// TestFlowStepsNeedVisibility (#25): the step lists answer nothing about a
// card or flow the caller can't see.
func TestFlowStepsNeedVisibility(t *testing.T) {
	f := setupVisibility(t, "kitp_test_review_flow_steps")
	flow.Register(f.sp)
	rows := func(uid int64, action, data string) int {
		t.Helper()
		r := reviewCall(t, f, uid, "flow_step", action, data)
		if !r.OK {
			t.Fatalf("flow_step.%s: %+v", action, r.Error)
		}
		var out struct {
			Rows []json.RawMessage `json:"rows"`
		}
		b, _ := json.Marshal(r.Data)
		if err := json.Unmarshal(b, &out); err != nil {
			t.Fatal(err)
		}
		return len(out.Rows)
	}
	card := fmt.Sprintf(`{"card_id":"%d"}`, f.taskB)
	if n := rows(f.stranger, "list_for_card", card); n != 0 {
		t.Errorf("a stranger saw %d steps for another project's task", n)
	}
	if n := rows(f.admin, "list_for_card", card); n == 0 {
		t.Error("an admin saw no steps for the task")
	}
	var flowID int64
	if err := f.sp.P.QueryRow(context.Background(), `SELECT id FROM flow WHERE scope_card_id = $1 LIMIT 1`, f.projectB).Scan(&flowID); err != nil {
		t.Fatal(err)
	}
	flowData := fmt.Sprintf(`{"flow_id":"%d"}`, flowID)
	if n := rows(f.worker, "list", flowData); n != 0 {
		t.Errorf("a worker on A saw %d steps of B's flow", n)
	}
	if n := rows(f.admin, "list", flowData); n == 0 {
		t.Error("an admin saw no steps of the flow")
	}
}
