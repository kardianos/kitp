package approval_test

// Regression tests for the write findings of the second 2026-11-03 review
// (area W). This package's fixture has the people they need: Dana and Lee,
// workers on the fixture project.

import (
	"context"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/store"
)

// TestTaskMoveKeepsToRoleGatedStates (round 2 #4): a worker can't move a
// task from another project into a state only a manager may move cards into.
func TestTaskMoveKeepsToRoleGatedStates(t *testing.T) {
	f := setup(t, "kitp_test_r2_move_gated")
	ctx := context.Background()
	p2 := insertCard(t, f, `{"card_type_name":"project","title":"Zeus"}`)
	done2 := store.TemplateStatusID(t, f.sp.P, p2, "Done")
	todo2 := store.TemplateStatusID(t, f.sp.P, p2, "Todo")
	for _, q := range []string{
		fmt.Sprintf(`INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT %d, id, %d FROM role WHERE name = 'worker'`, f.dana.userID, p2),
		fmt.Sprintf(`UPDATE flow_step SET requires_role_id = (SELECT id FROM role WHERE name = 'manager') WHERE to_card_id = %d`, done2),
	} {
		if _, err := f.sp.P.Exec(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	sr := call(f, f.dana.ctx, "task", "move", fmt.Sprintf(`{"card_id":"%d","new_project_id":"%d","new_status_id":"%d"}`, f.task, p2, done2))
	if sr.OK || sr.Error.Code != "flow_role_required" {
		t.Fatalf("task.move into a manager-only state: %+v, want flow_role_required", sr)
	}
	sr = call(f, f.dana.ctx, "task", "move", fmt.Sprintf(`{"card_id":"%d","new_project_id":"%d","new_status_id":"%d"}`, f.task, p2, todo2))
	if !sr.OK {
		t.Fatalf("task.move into an open state: %+v", sr.Error)
	}
}

// TestTaskMoveGivesThreadsTheDestinationsAccount (round 2 #13): a moved
// task's threads send from the destination project's mail account, or from
// none (reply.post says so) — never the source project's.
func TestTaskMoveGivesThreadsTheDestinationsAccount(t *testing.T) {
	f := setup(t, "kitp_test_r2_move_channel")
	ctx := context.Background()
	newChannel := func(project int64) int64 {
		var id int64
		if err := f.sp.P.QueryRow(ctx, `
			INSERT INTO card (card_type_id, parent_card_id)
			SELECT id, $1 FROM card_type WHERE name = 'comm_channel' RETURNING id`, project).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	src := newChannel(f.project)
	var thread int64
	if err := f.sp.P.QueryRow(ctx, `
		WITH c AS (INSERT INTO card (card_type_id, parent_card_id)
		           SELECT id, $1 FROM card_type WHERE name = 'comm' RETURNING id)
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		SELECT c.id, ad.id, to_jsonb($2::bigint) FROM c, attribute_def ad WHERE ad.name = 'channel_ref'
		RETURNING card_id`, f.task, src).Scan(&thread); err != nil {
		t.Fatal(err)
	}
	channelOf := func() int64 {
		var ch int64
		if err := f.sp.P.QueryRow(ctx, `
			SELECT COALESCE((SELECT (av.value)::text::bigint FROM attribute_value av
			                 JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'channel_ref'
			                 WHERE av.card_id = $1), 0)`, thread).Scan(&ch); err != nil {
			t.Fatal(err)
		}
		return ch
	}
	move := func(project int64) {
		t.Helper()
		sr := call(f, sysCtx(), "task", "move", fmt.Sprintf(`{"card_id":"%d","new_project_id":"%d"}`, f.task, project))
		if !sr.OK {
			t.Fatalf("task.move: %+v", sr.Error)
		}
	}
	p2 := insertCard(t, f, `{"card_type_name":"project","title":"With mail"}`)
	dest := newChannel(p2)
	move(p2)
	if got := channelOf(); got != dest {
		t.Errorf("after the move the thread's account is %d, want the destination's %d", got, dest)
	}
	p3 := insertCard(t, f, `{"card_type_name":"project","title":"No mail"}`)
	move(p3)
	if got := channelOf(); got != 0 {
		t.Errorf("moved into a project with no account, the thread still has account %d", got)
	}
	sr := call(f, sysCtx(), "reply", "post", fmt.Sprintf(`{"comm_id":"%d","body":"hello"}`, thread))
	if sr.OK || sr.Error.Code != "no_mail_account" {
		t.Errorf("reply.post on a thread with no account: %+v, want no_mail_account", sr)
	}
}

// TestTaskPurgeTakesRequestsAndThreadFiles (round 2 #21): a task with an
// approval request, or whose thread holds a file, can be purged.
func TestTaskPurgeTakesRequestsAndThreadFiles(t *testing.T) {
	f := setup(t, "kitp_test_r2_purge")
	ctx := context.Background()
	withRequest := insertCard(t, f, fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"purge me","attributes":{"status":"%d"}}`, f.project, f.statuses["Review"]))
	if sr := call(f, sysCtx(), "approval", "set", fmt.Sprintf(`{"task_id":"%d","from_status_id":"%d","to_status_id":"%d","approver_ids":["%d"]}`,
		withRequest, f.statuses["Review"], f.statuses["Done"], f.lee.personID)); !sr.OK {
		t.Fatalf("approval.set: %+v", sr.Error)
	}
	if sr := call(f, sysCtx(), "task", "purge", fmt.Sprintf(`{"card_id":"%d"}`, withRequest)); !sr.OK {
		t.Errorf("purge a task with a request: %+v", sr.Error)
	}

	withFile := insertCard(t, f, fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"purge me 2","attributes":{"status":"%d"}}`, f.project, f.statuses["Todo"]))
	var commID, fileID int64
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO card (card_type_id, parent_card_id) SELECT id, $1 FROM card_type WHERE name = 'comm' RETURNING id`, withFile).Scan(&commID); err != nil {
		t.Fatal(err)
	}
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO file (filename, size_bytes, created_by) VALUES ('a.pdf', 1, 1) RETURNING id`).Scan(&fileID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sp.P.Exec(ctx, `INSERT INTO attachment (card_id, file_id) VALUES ($1, $2)`, commID, fileID); err != nil {
		t.Fatal(err)
	}
	if sr := call(f, sysCtx(), "task", "purge", fmt.Sprintf(`{"card_id":"%d"}`, withFile)); !sr.OK {
		t.Errorf("purge a task whose thread has a file: %+v", sr.Error)
	}
}

// TestCommentEditNeedsTheCommentGrant (round 2 #21): someone who may no
// longer comment in a project may no longer edit their comments there; a
// commenter may comment.
func TestCommentEditNeedsTheCommentGrant(t *testing.T) {
	f := setup(t, "kitp_test_r2_comment_grant")
	ctx := context.Background()
	var out struct {
		ActivityID string `json:"activity_id"`
	}
	decode(t, call(f, f.lee.ctx, "comment", "insert", fmt.Sprintf(`{"card_id":"%d","body":"original"}`, f.task)), &out)
	if sr := call(f, f.lee.ctx, "comment", "update", fmt.Sprintf(`{"activity_id":"%s","body":"edited"}`, out.ActivityID)); !sr.OK {
		t.Fatalf("lee edits her own comment: %+v", sr.Error)
	}
	elsewhere := insertCard(t, f, `{"card_type_name":"project","title":"Elsewhere"}`)
	for _, q := range []string{
		fmt.Sprintf(`DELETE FROM user_role WHERE user_id = %d`, f.lee.userID),
		fmt.Sprintf(`INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT %d, id, %d FROM role WHERE name = 'worker'`, f.lee.userID, elsewhere),
		fmt.Sprintf(`INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT %d, id, %d FROM role WHERE name = 'commenter'`, f.pat.userID, f.project),
		fmt.Sprintf(`DELETE FROM user_role WHERE user_id = %d AND role_id <> (SELECT id FROM role WHERE name = 'commenter')`, f.pat.userID),
	} {
		if _, err := f.sp.P.Exec(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	if sr := call(f, f.lee.ctx, "comment", "update", fmt.Sprintf(`{"activity_id":"%s","body":"rewritten after removal"}`, out.ActivityID)); sr.OK {
		t.Error("a former member edited her comment in a project she no longer has")
	}
	if sr := call(f, f.pat.ctx, "comment", "insert", fmt.Sprintf(`{"card_id":"%d","body":"a commenter's word"}`, f.task)); !sr.OK {
		t.Errorf("a commenter's comment: %+v", sr.Error)
	}
}
