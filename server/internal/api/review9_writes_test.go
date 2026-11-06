// review9_writes_test.go: the writes fixes of the 2026-11-06 round-8
// review — task.move's cascade stays in its project, card.undelete brings a
// card back with its own project's values only, card.move of a mail account
// is a workspace admin's, and a title has a cap.
package api_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/activity"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/comm"
	"github.com/kitp/kitp/server/internal/dom/comment"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/dom/tag"
	"github.com/kitp/kitp/server/internal/dom/usercardsort"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

func r9wSetup(t *testing.T, schema string) (*api.Server, *store.Pool) {
	t.Helper()
	reg.Reset()
	pool := store.TestPool(t, schema)
	sp := store.NewPool(pool)
	echo.Register()
	cardtype.Register()
	card.Register(sp)
	attribute.Register(sp)
	activity.Register(sp)
	comment.Register(sp)
	usercardsort.Register(sp)
	comm.Register(sp)
	tag.Register(sp)
	return api.NewServer(sp), sp
}

// r9wCard makes a card with a title straight in SQL.
func r9wCard(t *testing.T, sp *store.Pool, typ string, parent int64, title string) int64 {
	t.Helper()
	ctx := context.Background()
	var p any
	if parent != 0 {
		p = parent
	}
	var id int64
	if err := sp.P.QueryRow(ctx, `INSERT INTO card (card_type_id, parent_card_id) SELECT id, $2 FROM card_type WHERE name = $1 RETURNING id`, typ, p).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if _, err := sp.P.Exec(ctx, `INSERT INTO attribute_value (card_id, attribute_def_id, value) SELECT $1, id, to_jsonb($2::text) FROM attribute_def WHERE name = 'title'`, id, title); err != nil {
		t.Fatal(err)
	}
	return id
}

func r9wInsert(t *testing.T, srv *api.Server, data string) int64 {
	t.Helper()
	r := srv.Dispatch(auth.WithSystemUser(context.Background()), api.BatchRequest{Subrequests: []api.SubRequest{r8Sub("i", "card", "insert", data)}})
	if !r.Subresponses[0].OK {
		t.Fatalf("insert %s: %+v", data, r.Subresponses[0].Error)
	}
	var o card.InsertOutput
	b, _ := json.Marshal(r.Subresponses[0].Data)
	if err := json.Unmarshal(b, &o); err != nil {
		t.Fatal(err)
	}
	return o.ID
}

func r9wProject(t *testing.T, sp *store.Pool, id int64) int64 {
	t.Helper()
	var p *int64
	if err := sp.P.QueryRow(context.Background(), `SELECT card_enclosing_project($1)`, id).Scan(&p); err != nil {
		t.Fatal(err)
	}
	if p == nil {
		return 0
	}
	return *p
}

func r9wParentTask(t *testing.T, sp *store.Pool, id int64) int64 {
	t.Helper()
	var p int64
	err := sp.P.QueryRow(context.Background(), `
		SELECT COALESCE((SELECT (av.value)::text::bigint FROM attribute_value av
		                 JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'parent_task'
		                 WHERE av.card_id = $1 AND jsonb_typeof(av.value) = 'number'), 0)`, id).Scan(&p)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func r9wMsg(r api.BatchResponse) string {
	for _, s := range r.Subresponses {
		if s.Error != nil && s.Error.Code != "aborted" {
			return s.Error.Message
		}
	}
	return ""
}

// TestTaskMoveCascadeStaysInItsProject (round 8 #8): a subtask left in A
// pointing at a parent in B (an older move, or data from before L5) isn't
// pulled out of A when someone with no role there moves the parent on, in
// either mode, and the move doesn't name it.
func TestTaskMoveCascadeStaysInItsProject(t *testing.T) {
	srv, sp := r9wSetup(t, "kitp_test_r9w_cascade")
	ctx := context.Background()
	projA, _ := makeProjectAndTask(t, srv, "A")
	projB, _ := makeProjectAndTask(t, srv, "B")
	projD, _ := makeProjectAndTask(t, srv, "D")
	statusA := store.TemplateStatusID(t, sp.P, projA, "Todo")
	statusB := store.TemplateStatusID(t, sp.P, projB, "Todo")
	attacker := grantRole(t, sp, "worker-B-D", "worker", &projB)
	grantRole(t, sp, "worker-B-D", "worker", &projD)

	for _, mode := range []string{"cascade", "break"} {
		parent := r9wInsert(t, srv, fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"T parent","attributes":{"status":"%d"}}`, projB, statusB))
		// B's own subtask rides along (cascade) or is unlinked (break).
		own := r9wInsert(t, srv, fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"B's subtask","parent_task":"%d","attributes":{"status":"%d"}}`, projB, parent, statusB))
		// A's subtask with a link across, as data from before L5 has it.
		sub := r9wInsert(t, srv, fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"S confidential subtask of A","attributes":{"status":"%d"}}`, projA, statusA))
		if _, err := sp.P.Exec(ctx, `
			INSERT INTO attribute_value (card_id, attribute_def_id, value)
			SELECT $1, ad.id, CASE ad.name WHEN 'parent_task' THEN to_jsonb($2::bigint) ELSE to_jsonb('subtask'::text) END
			FROM attribute_def ad WHERE ad.name IN ('parent_task', 'parent_relationship')`, sub, parent); err != nil {
			t.Fatal(err)
		}
		r := r8As(srv, attacker, r8Sub("m", "task", "move", fmt.Sprintf(`{"card_id":"%d","new_project_id":"%d","subtask_strategy":%q}`, parent, projD, mode)))
		if !r.Subresponses[0].OK {
			t.Fatalf("%s: worker of B and D moves B's task to D: %+v", mode, r.Subresponses[0].Error)
		}
		var out card.TaskMoveOutput
		b, _ := json.Marshal(r.Subresponses[0].Data)
		if err := json.Unmarshal(b, &out); err != nil {
			t.Fatal(err)
		}
		for _, id := range append(append([]int64{}, out.MovedCardIDs...), out.BrokenChildIDs...) {
			if id == sub {
				t.Errorf("%s: the move names A's subtask %d: %+v", mode, sub, out)
			}
		}
		if p := r9wProject(t, sp, sub); p != projA {
			t.Errorf("%s: A's subtask is now in project %d, want A (%d)", mode, p, projA)
		}
		if p := r9wParentTask(t, sp, sub); p != parent {
			t.Errorf("%s: A's subtask was written: parent_task %d, want %d", mode, p, parent)
		}
		switch mode {
		case "cascade":
			if p := r9wProject(t, sp, own); p != projD {
				t.Errorf("cascade: B's own subtask is in %d, want D (%d)", p, projD)
			}
		case "break":
			if p := r9wParentTask(t, sp, own); p != 0 {
				t.Errorf("break: B's own subtask keeps parent_task %d", p)
			}
			var n int
			if err := sp.P.QueryRow(ctx, `
				SELECT count(*) FROM activity a JOIN attribute_def ad ON ad.id = a.attribute_def_id AND ad.name = 'parent_task'
				WHERE a.card_id = $1 AND a.kind = 'attr_update' AND a.value_new = 'null'::jsonb`, own).Scan(&n); err != nil {
				t.Fatal(err)
			}
			if n != 1 {
				t.Errorf("break: %d activity rows for the unlinked subtask, want 1", n)
			}
		}
	}
}

// TestUndeleteBringsBackOwnProjectValuesOnly (round 8 #8): delete a
// subtask, move its parent to another project, undelete it — the link goes
// (with a history row), as task.move drops it; a value of another kind that
// moved away refuses the undelete.
func TestUndeleteBringsBackOwnProjectValuesOnly(t *testing.T) {
	srv, sp := r9wSetup(t, "kitp_test_r9w_undelete")
	ctx := context.Background()
	projA, _ := makeProjectAndTask(t, srv, "A")
	projB, _ := makeProjectAndTask(t, srv, "B")
	statusA := store.TemplateStatusID(t, sp.P, projA, "Todo")
	admin := grantRole(t, sp, "admin-A-B", "admin", &projA)
	grantRole(t, sp, "admin-A-B", "admin", &projB)

	parent := r9wInsert(t, srv, fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"T","attributes":{"status":"%d"}}`, projA, statusA))
	sub := r9wInsert(t, srv, fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"S","parent_task":"%d","attributes":{"status":"%d"}}`, projA, parent, statusA))
	for _, s := range []api.SubRequest{
		r8Sub("d", "card", "delete", fmt.Sprintf(`{"card_id":"%d"}`, sub)),
		r8Sub("m", "task", "move", fmt.Sprintf(`{"card_id":"%d","new_project_id":"%d"}`, parent, projB)),
		r8Sub("u", "card", "undelete", fmt.Sprintf(`{"card_id":"%d"}`, sub)),
	} {
		if r := r8As(srv, admin, s); !r.Subresponses[0].OK {
			t.Fatalf("%s.%s: %+v", s.Endpoint, s.Action, r.Subresponses[0].Error)
		}
	}
	if p := r9wProject(t, sp, sub); p != projA {
		t.Errorf("S is in %d, want A (%d)", p, projA)
	}
	if p := r9wParentTask(t, sp, sub); p != 0 {
		t.Errorf("S came back pointing at B's task %d", p)
	}
	var n int
	if err := sp.P.QueryRow(ctx, `
		SELECT count(*) FROM activity a JOIN attribute_def ad ON ad.id = a.attribute_def_id AND ad.name = 'parent_task'
		WHERE a.card_id = $1 AND a.kind = 'attr_update' AND a.value_new = 'null'::jsonb`, sub).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("%d history rows for the dropped link, want 1", n)
	}

	// A milestone moved to B while the task naming it was deleted.
	ms := r9wInsert(t, srv, fmt.Sprintf(`{"card_type_name":"milestone","parent_card_id":"%d","title":"M"}`, projA))
	x := r9wInsert(t, srv, fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"X","attributes":{"status":"%d","milestone_ref":"%d"}}`, projA, statusA, ms))
	for _, s := range []api.SubRequest{
		r8Sub("d", "card", "delete", fmt.Sprintf(`{"card_id":"%d"}`, x)),
		r8Sub("m", "card", "move", fmt.Sprintf(`{"card_id":"%d","new_parent_card_id":"%d"}`, ms, projB)),
	} {
		if r := r8As(srv, admin, s); !r.Subresponses[0].OK {
			t.Fatalf("%s.%s: %+v", s.Endpoint, s.Action, r.Subresponses[0].Error)
		}
	}
	r := r8As(srv, admin, r8Sub("u", "card", "undelete", fmt.Sprintf(`{"card_id":"%d"}`, x)))
	if c := r8Code(r); c != "cross_project_ref" {
		t.Errorf("undelete of a task whose milestone moved to B: %q, want cross_project_ref", c)
	}
	if strings.Contains(r9wMsg(r), "project") {
		t.Errorf("the refusal names the milestone's project: %q", r9wMsg(r))
	}
	if !r8Deleted(t, sp, x) {
		t.Error("X came back with B's milestone")
	}
}

// TestOnlyAWorkspaceAdminMovesAMailAccount (round 8 L1): an admin of two
// projects can't card.move A's mail account (or a sink) into B.
func TestOnlyAWorkspaceAdminMovesAMailAccount(t *testing.T) {
	srv, sp := r9wSetup(t, "kitp_test_r9w_move_channel")
	projA, _ := makeProjectAndTask(t, srv, "A")
	projB, _ := makeProjectAndTask(t, srv, "B")
	padmin := grantRole(t, sp, "padmin-A-B", "admin", &projA)
	grantRole(t, sp, "padmin-A-B", "admin", &projB)
	wsAdmin := grantRole(t, sp, "workspace-admin", "admin", nil)
	for _, typ := range []string{"comm_channel", "activity_sink"} {
		c := r9wCard(t, sp, typ, projA, typ+" of A")
		if code := r8Code(r8As(srv, padmin, r8Sub("m", "card", "move", fmt.Sprintf(`{"card_id":"%d","new_parent_card_id":"%d"}`, c, projB)))); code != "forbidden" {
			t.Errorf("project admin moves %s into B: %q, want forbidden", typ, code)
		}
		if p := r9wProject(t, sp, c); p != projA {
			t.Errorf("%s moved to %d", typ, p)
		}
		if r := r8As(srv, wsAdmin, r8Sub("m", "card", "move", fmt.Sprintf(`{"card_id":"%d","new_parent_card_id":"%d"}`, c, projB))); !r.Subresponses[0].OK {
			t.Errorf("a workspace admin moves %s: %+v", typ, r.Subresponses[0].Error)
		}
	}
}

// TestATitleHasACap (round 8 #7): 500 characters, on every card type,
// through card.insert and attribute.update.
func TestATitleHasACap(t *testing.T) {
	srv, sp := r9wSetup(t, "kitp_test_r9w_title_cap")
	projA, taskA := makeProjectAndTask(t, srv, "A")
	statusA := store.TemplateStatusID(t, sp.P, projA, "Todo")
	worker := grantRole(t, sp, "worker-A", "worker", &projA)
	long, ok := strings.Repeat("é", 501), strings.Repeat("é", 500)
	ins := func(title string) api.BatchResponse {
		return r8As(srv, worker, r8Sub("i", "card", "insert", fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":%q,"attributes":{"status":"%d"}}`, projA, title, statusA)))
	}
	upd := func(title string) api.BatchResponse {
		return r8As(srv, worker, r8Sub("u", "attribute", "update", fmt.Sprintf(`{"card_id":"%d","attribute_name":"title","value":%q}`, taskA, title)))
	}
	if c := r8Code(ins(long)); c != "validation" {
		t.Errorf("card.insert of a 501-character title: %q, want validation", c)
	}
	if c := r8Code(upd(long)); c != "validation" {
		t.Errorf("attribute.update of a 501-character title: %q, want validation", c)
	}
	if r := ins(ok); !r.Subresponses[0].OK {
		t.Errorf("card.insert of a 500-character title: %+v", r.Subresponses[0].Error)
	}
	if r := upd(ok); !r.Subresponses[0].OK {
		t.Errorf("attribute.update of a 500-character title: %+v", r.Subresponses[0].Error)
	}
}
