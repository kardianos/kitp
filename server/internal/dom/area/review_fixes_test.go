package area_test

// Review fixes, area 4 (docs/REVIEW_FIXES.md): visibility agrees with
// card_in_off_area and card_visible_to (A14), a hidden thread's messages
// (A9), Approvals off (A8), switches say when and who (A22), and the
// nesting cap (A26).

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/approval"
	"github.com/kitp/kitp/server/internal/dom/area"
	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/schema"
)

func switchArea(t *testing.T, f fixture, key string, on bool) {
	t.Helper()
	ctx := context.Background()
	if on {
		if _, err := f.sp.P.Exec(ctx, `DELETE FROM project_area WHERE project_id = $1 AND area_key = $2`, f.project, key); err != nil {
			t.Fatal(err)
		}
		return
	}
	if _, err := f.sp.P.Exec(ctx, `
		INSERT INTO project_area (project_id, area_key, state) VALUES ($1, $2, 'off')
		ON CONFLICT (project_id, area_key) DO UPDATE SET state = 'off'`, f.project, key); err != nil {
		t.Fatal(err)
	}
}

// message adds a reply_body (no parent card, like every message) to the
// fixture's thread's replies list.
func message(t *testing.T, f fixture) int64 {
	t.Helper()
	ctx := context.Background()
	var id int64
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'reply_body' RETURNING id`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sp.P.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		SELECT $1, id, jsonb_build_array($2::bigint) FROM attribute_def WHERE name = 'replies'
		ON CONFLICT (card_id, attribute_def_id) DO UPDATE SET value = attribute_value.value || jsonb_build_array($2::bigint)`,
		f.comm, id); err != nil {
		t.Fatal(err)
	}
	return id
}

// TestVisibilityAgrees (A14, A9): schema.VisibilityClause folds the area
// test into its own parent walk and card_visible_to is the same predicate
// in PL/pgSQL; for every card and user, in every area state, both must
// answer exactly what the rule says: a role covers the card's project (or
// is global), and card_in_off_area is false. A message is hidden with its
// thread, and seen by the thread's project members.
func TestVisibilityAgrees(t *testing.T) {
	f := setup(t, "kitp_test_area_visibility_agrees")
	ctx := context.Background()
	msg := message(t, f)
	var outsider, otherProject int64
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ('outsider') RETURNING id`).Scan(&outsider); err != nil {
		t.Fatal(err)
	}
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'project' RETURNING id`).Scan(&otherProject); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sp.P.Exec(ctx, `INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT $1, id, $2 FROM role WHERE name = 'worker'`, outsider, otherProject); err != nil {
		t.Fatal(err)
	}
	users := map[string]int64{"system": auth.SystemUserID, "manager": userID(f.manager), "worker": userID(f.worker), "outsider": outsider}
	cards := map[string]int64{"project": f.project, "task": f.task, "comm": f.comm, "page": f.page, "message": msg}

	query := `SELECT ` + schema.VisibilityClause(":card", ":user") + `, card_visible_to(:user, :card),
		NOT card_in_off_area(:card) AND (
			EXISTS (SELECT 1 FROM user_role_visible(:user) ur WHERE ur.scope_card_id IS NULL)
			OR EXISTS (SELECT 1 FROM user_role_visible(:user) ur
			           WHERE ur.scope_card_id = COALESCE(card_enclosing_project(:card),
			                 card_enclosing_project((SELECT rv.card_id FROM attribute_value rv
			                   JOIN attribute_def rd ON rd.id = rv.attribute_def_id AND rd.name = 'replies'
			                   WHERE jsonb_typeof(rv.value) = 'array' AND rv.value @> to_jsonb(:card) LIMIT 1)))))`
	check := func(state string) {
		t.Helper()
		for un, u := range users {
			for cn, c := range cards {
				b := named.New()
				b.Set("user", u)
				b.Set("card", c)
				q, args, err := b.Compile(query)
				if err != nil {
					t.Fatal(err)
				}
				var clause, fn, rule bool
				if err := f.sp.P.QueryRow(ctx, q, args...).Scan(&clause, &fn, &rule); err != nil {
					t.Fatalf("%s/%s/%s: %v", state, un, cn, err)
				}
				if clause != rule || fn != rule {
					t.Errorf("%s, %s sees %s: VisibilityClause %v, card_visible_to %v, rule %v", state, un, cn, clause, fn, rule)
				}
			}
		}
	}
	check("all on")
	for _, key := range []string{"tasks", "conversations", "content"} {
		switchArea(t, f, key, false)
		check(key + " off")
		switchArea(t, f, key, true)
	}

	// The message specifically: seen by the project's manager, hidden from
	// everyone with Conversations off (A9).
	seen := func(u int64) bool {
		var v bool
		if err := f.sp.P.QueryRow(ctx, `SELECT card_visible_to($1, $2)`, u, msg).Scan(&v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	if !seen(userID(f.manager)) {
		t.Error("the project's manager can't see a message on its thread")
	}
	switchArea(t, f, "conversations", false)
	if seen(auth.SystemUserID) || seen(userID(f.manager)) {
		t.Error("a hidden thread's message is still visible")
	}
	var swa struct {
		Rows []struct {
			ID int64 `json:"id,string"`
		} `json:"rows"`
	}
	decode(t, call(f, sysCtx(), "card", "select_with_attributes", `{"card_type_name":"reply_body"}`), &swa)
	for _, r := range swa.Rows {
		if r.ID == msg {
			t.Error("card.select_with_attributes returns a hidden thread's message")
		}
	}
}

func userID(ctx context.Context) int64 {
	u, _ := auth.FromContext(ctx)
	return u.ID
}

// TestApprovalsOff (A8): switching Approvals off refuses approval writes
// (they gate on the task, so the dispatcher needs the handler's Area),
// hides open requests and hides approval votes from the activity feed.
func TestApprovalsOff(t *testing.T) {
	f := setup(t, "kitp_test_area_approvals_off")
	approval.Register(f.sp)
	ctx := context.Background()
	var vote int64
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO activity (card_id, kind, actor_id, value_new) VALUES ($1, 'approval_decision', 1, '{"decision":"approve"}') RETURNING id`, f.task).Scan(&vote); err != nil {
		t.Fatal(err)
	}
	var request int64
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO card (card_type_id, parent_card_id) SELECT id, $1 FROM card_type WHERE name = 'approval' RETURNING id`, f.task).Scan(&request); err != nil {
		t.Fatal(err)
	}
	feedHas := func(id int64) bool {
		var feed struct {
			Rows []struct {
				ID int64 `json:"id,string"`
			} `json:"rows"`
		}
		decode(t, call(f, sysCtx(), "activity", "select", fmt.Sprintf(`{"card_id":"%d"}`, f.task)), &feed)
		for _, r := range feed.Rows {
			if r.ID == id {
				return true
			}
		}
		return false
	}
	decide := func() api.SubResponse {
		return call(f, sysCtx(), "approval", "decide",
			fmt.Sprintf(`{"task_id":"%d","from_status_id":"1","to_status_id":"2","decision":"approve"}`, f.task))
	}
	if !feedHas(vote) {
		t.Fatal("with Approvals on, the vote should be in the task's activity")
	}
	if r := decide(); !r.OK && r.Error != nil && r.Error.Code == "area_off" {
		t.Fatalf("approval.decide refused as area_off with Approvals on")
	}
	var openOn int
	if err := f.sp.P.QueryRow(ctx, `SELECT count(*) FROM approval_open($1)`, f.task).Scan(&openOn); err != nil {
		t.Fatal(err)
	}
	if openOn != 1 {
		t.Fatalf("approval_open with Approvals on = %d, want the request", openOn)
	}
	switchArea(t, f, "approvals", false)
	if r := decide(); r.OK || r.Error == nil || r.Error.Code != "area_off" {
		t.Errorf("approval.decide with Approvals off: want area_off, got %+v", r.Error)
	}
	if feedHas(vote) {
		t.Error("an approval vote stays in the task's activity with Approvals off")
	}
	var open int
	if err := f.sp.P.QueryRow(ctx, `SELECT count(*) FROM approval_open($1)`, f.task).Scan(&open); err != nil {
		t.Fatal(err)
	}
	if open != 0 {
		t.Errorf("approval_open with Approvals off = %d requests, want none", open)
	}
	var hidden bool
	if err := f.sp.P.QueryRow(ctx, `SELECT activity_hidden('approval_decision', $1), activity_hidden('comment', $1)`, f.task).Scan(&hidden, new(bool)); err != nil || !hidden {
		t.Errorf("activity_hidden(approval_decision) = %v (%v), want true", hidden, err)
	}
	if visible(t, f, sysCtx(), "approval")[request] {
		t.Error("the approval card is still readable with Approvals off")
	}
}

// TestSwitchesSayWhenAndWho (A22): area.list reports an area's last switch
// — the workspace's Sites included, which has no card for an activity row.
func TestSwitchesSayWhenAndWho(t *testing.T) {
	f := setup(t, "kitp_test_area_switched")
	var o area.SetOutput
	decode(t, call(f, sysCtx(), "area", "set", `{"key":"sites","on":false}`), &o)
	decode(t, set(f, f.manager, "content", false), &o)
	var out struct {
		Areas []struct {
			Key      string `json:"key"`
			Switched *struct {
				State string `json:"state"`
				At    string `json:"at"`
				By    string `json:"by"`
			} `json:"switched"`
		} `json:"areas"`
	}
	raw := call(f, sysCtx(), "area", "list", fmt.Sprintf(`{"project_id":"%d"}`, f.project))
	b, _ := json.Marshal(raw.Data)
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, a := range out.Areas {
		if a.Switched != nil {
			got[a.Key] = a.Switched.State + " by " + a.Switched.By
			if a.Switched.At == "" {
				t.Errorf("%s: switched without a time", a.Key)
			}
		}
	}
	if got["content"] != "off by Mia" {
		t.Errorf("content switched = %q, want off by Mia", got["content"])
	}
	raw = call(f, sysCtx(), "area", "list", `{}`)
	b, _ = json.Marshal(raw.Data)
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	sites := false
	for _, a := range out.Areas {
		if a.Key == "sites" && a.Switched != nil && a.Switched.State == "off" {
			sites = true
		}
	}
	if !sites {
		t.Error("the workspace's Sites switch isn't reported")
	}
}

// TestNestingCap (A26): cards nest at most 14 deep, so every capped parent
// walk reaches the project (its roles and its areas).
func TestNestingCap(t *testing.T) {
	f := setup(t, "kitp_test_area_nesting")
	parent := f.page
	var last api.SubResponse
	depth := 0
	for i := range 20 {
		last = call(f, sysCtx(), "card", "insert",
			fmt.Sprintf(`{"card_type_name":"page","parent_card_id":"%d","title":"Level %d"}`, parent, i))
		if !last.OK {
			break
		}
		var ins struct {
			ID int64 `json:"id,string"`
		}
		decode(t, last, &ins)
		parent = ins.ID
		depth++
	}
	if last.OK || last.Error == nil || last.Error.Code != "too_deep" {
		t.Fatalf("after %d levels: want too_deep, got %+v", depth, last.Error)
	}
	var inProject bool
	if err := f.sp.P.QueryRow(context.Background(), `SELECT card_enclosing_project($1) = $2`, parent, f.project).Scan(&inProject); err != nil || !inProject {
		t.Errorf("the deepest page doesn't reach its project (%v)", err)
	}
	// Moving a subtree under the deepest page is refused too.
	if r := call(f, sysCtx(), "card", "move", fmt.Sprintf(`{"card_id":"%d","new_parent_card_id":"%d"}`, f.page, parent)); r.OK {
		t.Error("moving a page under its deepest descendant's level was allowed")
	}
}
