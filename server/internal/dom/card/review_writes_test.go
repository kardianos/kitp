package card_test

// Regression tests for the card-write findings of the 2026-11-03 review
// (area B): card.merge scope (#2), kitp-set attributes (#6, #20), private refs
// on insert (#23a), merged people keeping their private cards (#23c), typed
// text / bool values (#4b) and role-gated flow states (#16, #24).

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

func reviewUser(t *testing.T, f *visibilityFixture, name, role string, scope any) int64 {
	t.Helper()
	ctx := context.Background()
	var uid int64
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ($1) RETURNING id`, name).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	if role != "" {
		if _, err := f.sp.P.Exec(ctx, `
			INSERT INTO user_role (user_id, role_id, scope_card_id)
			SELECT $1, id, $2 FROM role WHERE name = $3`, uid, scope, role); err != nil {
			t.Fatal(err)
		}
	}
	return uid
}

// reviewPerson gives a login a person card and returns the card id.
func reviewPerson(t *testing.T, f *visibilityFixture, uid int64) int64 {
	t.Helper()
	ctx := context.Background()
	var p int64
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'person' RETURNING id`).Scan(&p); err != nil {
		t.Fatal(err)
	}
	if uid != 0 {
		if _, err := f.sp.P.Exec(ctx, `INSERT INTO user_account_person (user_account_id, person_card_id) VALUES ($1, $2)`, uid, p); err != nil {
			t.Fatal(err)
		}
	}
	return p
}

func reviewPrivateCard(t *testing.T, f *visibilityFixture, cardType string, owner int64) int64 {
	t.Helper()
	var id int64
	if err := f.sp.P.QueryRow(context.Background(), `
		INSERT INTO card (card_type_id, private_to) SELECT id, $1 FROM card_type WHERE name = $2 RETURNING id`,
		owner, cardType).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func deletedAt(t *testing.T, f *visibilityFixture, id int64) bool {
	t.Helper()
	var del bool
	if err := f.sp.P.QueryRow(context.Background(), `SELECT deleted_at IS NOT NULL FROM card WHERE id = $1`, id).Scan(&del); err != nil {
		t.Fatal(err)
	}
	return del
}

func reviewCall(t *testing.T, f *visibilityFixture, uid int64, endpoint, action, data string) api.SubResponse {
	t.Helper()
	return dispatchAsVis(t, f, uid, api.SubRequest{ID: "x", Endpoint: endpoint, Action: action, Data: json.RawMessage(data)})
}

func insertedID(t *testing.T, r api.SubResponse) int64 {
	t.Helper()
	if !r.OK {
		t.Fatalf("insert: %+v", r.Error)
	}
	var out struct {
		ID int64 `json:"id,string"`
	}
	b, _ := json.Marshal(r.Data)
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out.ID
}

// TestMergeStaysInScope (#2): the losers of a merge share the survivor's
// project and privacy, or nothing happens.
func TestMergeStaysInScope(t *testing.T) {
	f := setupVisibility(t, "kitp_test_review_merge")
	mgr := reviewUser(t, f, "merge-mgr", "manager", f.projectA)
	me := reviewPerson(t, f, mgr)
	other := reviewPerson(t, f, 0)
	myList := reviewPrivateCard(t, f, "watch_list", me)
	myOtherList := reviewPrivateCard(t, f, "watch_list", me)
	theirList := reviewPrivateCard(t, f, "watch_list", other)
	sys := auth.SystemUserID
	taskA2 := insertedID(t, reviewCall(t, f, sys, "card", "insert", fmt.Sprintf(
		`{"card_type_name":"task","parent_card_id":"%d","title":"dup"}`, f.projectA)))

	merge := func(survivor, loser int64) api.SubResponse {
		return reviewCall(t, f, mgr, "card", "merge", fmt.Sprintf(`{"survivor_id":"%d","loser_ids":["%d"]}`, survivor, loser))
	}
	cases := []struct {
		name            string
		survivor, loser int64
		ok              bool
	}{
		{"another project's task", f.taskA, f.taskB, false},
		{"another project", f.projectA, f.projectB, false},
		{"someone else's watch list into mine", myList, theirList, false},
		{"my own watch lists", myList, myOtherList, true},
		{"two tasks in my project", f.taskA, taskA2, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := merge(c.survivor, c.loser)
			if r.OK != c.ok {
				t.Fatalf("merge ok = %v, want %v (%+v)", r.OK, c.ok, r.Error)
			}
			if got := deletedAt(t, f, c.loser); got != c.ok {
				t.Errorf("loser deleted = %v, want %v", got, c.ok)
			}
		})
	}
}

// TestPersonMergeKeepsPrivateCards (#23c): a merged person's private cards
// follow them to the survivor.
func TestPersonMergeKeepsPrivateCards(t *testing.T) {
	f := setupVisibility(t, "kitp_test_review_merge_person")
	keep := reviewPerson(t, f, 0)
	gone := reviewPerson(t, f, 0)
	list := reviewPrivateCard(t, f, "watch_list", gone)
	r := reviewCall(t, f, f.admin, "card", "merge", fmt.Sprintf(`{"survivor_id":"%d","loser_ids":["%d"]}`, keep, gone))
	if !r.OK {
		t.Fatalf("merge: %+v", r.Error)
	}
	var owner int64
	if err := f.sp.P.QueryRow(context.Background(), `SELECT private_to FROM card WHERE id = $1`, list).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	if owner != keep {
		t.Errorf("watch list private_to = %d, want the survivor %d", owner, keep)
	}
}

// TestKitpSetAttributes (#6, #20): replies, comms and subscriber are written
// by kitp's own handlers only.
func TestKitpSetAttributes(t *testing.T) {
	f := setupVisibility(t, "kitp_test_review_kitp_set")
	sys := auth.SystemUserID
	ctx := context.Background()
	var thread, msgB int64
	if err := f.sp.P.QueryRow(ctx, `
		INSERT INTO card (card_type_id, parent_card_id) SELECT id, $1 FROM card_type WHERE name = 'comm' RETURNING id`,
		f.taskA).Scan(&thread); err != nil {
		t.Fatal(err)
	}
	if err := f.sp.P.QueryRow(ctx, `
		INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'reply_body' RETURNING id`).Scan(&msgB); err != nil {
		t.Fatal(err)
	}
	owner := reviewPerson(t, f, f.worker)
	list := reviewPrivateCard(t, f, "watch_list", owner)
	victim := reviewPerson(t, f, 0)

	for _, c := range []struct {
		name, data string
		uid        int64
	}{
		{"replies on a thread", fmt.Sprintf(`{"card_id":"%d","attribute_name":"replies","value":["%d"]}`, thread, msgB), f.worker},
		{"comms on a task", fmt.Sprintf(`{"card_id":"%d","attribute_name":"comms","value":["%d"]}`, f.taskA, thread), f.worker},
		{"subscriber on my own watch list", fmt.Sprintf(`{"card_id":"%d","attribute_name":"subscriber","value":"%d"}`, list, victim), f.worker},
		{"replies, even for an admin", fmt.Sprintf(`{"card_id":"%d","attribute_name":"replies","value":["%d"]}`, thread, msgB), f.admin},
	} {
		t.Run(c.name, func(t *testing.T) {
			r := reviewCall(t, f, c.uid, "attribute", "update", c.data)
			if r.OK || r.Error == nil || r.Error.Code != "validation" {
				t.Fatalf("attribute.update: ok=%v err=%+v, want the validation refusal", r.OK, r.Error)
			}
		})
	}
	r := reviewCall(t, f, sys, "card", "insert", fmt.Sprintf(
		`{"card_type_name":"comm","parent_card_id":"%d","title":"t2","attributes":{"replies":["%d"]}}`, f.taskA, msgB))
	if r.OK || r.Error == nil || r.Error.Code != "validation" {
		t.Fatalf("card.insert set replies: ok=%v err=%+v", r.OK, r.Error)
	}
}

// TestTypedScalarValues (#4b): a text attribute holds a string and a bool a
// boolean, through both write paths.
func TestTypedScalarValues(t *testing.T) {
	f := setupVisibility(t, "kitp_test_review_scalars")
	upd := func(attr, value string) api.SubResponse {
		return reviewCall(t, f, f.worker, "attribute", "update",
			fmt.Sprintf(`{"card_id":"%d","attribute_name":%q,"value":%s}`, f.taskA, attr, value))
	}
	if r := upd("title", `{"comment_body_id":"1"}`); r.OK {
		t.Error("an object was stored as a text value")
	}
	if r := upd("title", `["x"]`); r.OK {
		t.Error("an array was stored as a text value")
	}
	if r := upd("title", `"plain"`); !r.OK {
		t.Errorf("a string title was refused: %+v", r.Error)
	}
	if r := upd("description", `42`); !r.OK {
		t.Errorf("a number for a text attribute was refused: %+v", r.Error)
	}
	var stored string
	if err := f.sp.P.QueryRow(context.Background(), `
		SELECT jsonb_typeof(av.value) FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1 AND ad.name = 'description'`, f.taskA).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != "string" {
		t.Errorf("description stored as %s, want string", stored)
	}
	r := reviewCall(t, f, auth.SystemUserID, "card", "insert", fmt.Sprintf(
		`{"card_type_name":"task","parent_card_id":"%d","title":"x","attributes":{"description":{"a":1}}}`, f.projectA))
	if r.OK {
		t.Error("card.insert stored an object as a text value")
	}
}

// TestInsertPrivateRef (#23a): card.insert refuses a reference to someone's
// private view, as attribute.update does.
func TestInsertPrivateRef(t *testing.T) {
	f := setupVisibility(t, "kitp_test_review_private_ref")
	ada := reviewUser(t, f, "ada", "viewer", f.projectA)
	reviewPerson(t, f, ada)
	screen := insertedID(t, reviewCall(t, f, auth.SystemUserID, "card", "insert", fmt.Sprintf(
		`{"card_type_name":"screen","parent_card_id":"%d","title":"Shared","attributes":{"layout":"list","slug":"shared-x"}}`, f.projectA)))
	view := insertedID(t, reviewCall(t, f, ada, "card", "insert", fmt.Sprintf(
		`{"card_type_name":"filter","parent_card_id":"%d","title":"Ada: private","private":true}`, screen)))
	r := reviewCall(t, f, f.admin, "card", "insert", fmt.Sprintf(
		`{"card_type_name":"screen","parent_card_id":"%d","title":"Probe","attributes":{"layout":"list","slug":"probe","default_filter":"%d"}}`,
		f.projectA, view))
	if r.OK || r.Error == nil || r.Error.Code != "private_ref" {
		t.Fatalf("card.insert with someone's private view as a ref: ok=%v err=%+v, want private_ref", r.OK, r.Error)
	}
}

// TestRoleGatedStates (#16, #24): a state every step into which needs a role
// can't be started on without that role, and a role ranked above the one a
// step needs passes it (an admin passes a manager step).
func TestRoleGatedStates(t *testing.T) {
	f := setupVisibility(t, "kitp_test_review_role_states")
	ctx := context.Background()
	todo := store.TemplateStatusID(t, f.sp.P, f.projectA, "Todo")
	done := store.TemplateStatusID(t, f.sp.P, f.projectA, "Done")
	if _, err := f.sp.P.Exec(ctx, `
		UPDATE flow_step SET requires_role_id = (SELECT id FROM role WHERE name = 'manager')
		WHERE to_card_id = $1`, done); err != nil {
		t.Fatal(err)
	}
	projectAdmin := reviewUser(t, f, "proj-admin", "admin", f.projectA)
	mgr := reviewUser(t, f, "proj-mgr", "manager", f.projectA)

	insert := func(uid, status int64) api.SubResponse {
		return reviewCall(t, f, uid, "card", "insert", fmt.Sprintf(
			`{"card_type_name":"task","parent_card_id":"%d","title":"gated","attributes":{"status":"%d"}}`, f.projectA, status))
	}
	if r := insert(f.worker, done); r.OK || r.Error == nil || r.Error.Code != "flow_role_required" {
		t.Errorf("worker started a task in a manager-only state: ok=%v err=%+v", r.OK, r.Error)
	}
	if r := insert(f.worker, todo); !r.OK {
		t.Errorf("worker can't start a task in Todo: %+v", r.Error)
	}
	if r := insert(mgr, done); !r.OK {
		t.Errorf("manager can't start a task in Done: %+v", r.Error)
	}
	if r := insert(projectAdmin, done); !r.OK {
		t.Errorf("project admin can't start a task in Done (admin covers manager): %+v", r.Error)
	}
	move := func(uid int64) api.SubResponse {
		task := insertedID(t, insert(auth.SystemUserID, todo))
		return reviewCall(t, f, uid, "attribute", "update", fmt.Sprintf(
			`{"card_id":"%d","attribute_name":"status","value":"%d"}`, task, done))
	}
	if r := move(f.worker); r.OK {
		t.Error("worker moved a task into a manager-only state")
	}
	if r := move(projectAdmin); !r.OK {
		t.Errorf("project admin can't take a manager step (admin covers manager): %+v", r.Error)
	}
}
