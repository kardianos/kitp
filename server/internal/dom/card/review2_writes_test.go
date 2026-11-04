package card_test

// Regression tests for the write findings of the second 2026-11-03 review
// (area W).

import (
	"context"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

// TestMergeKeepsToFlows (round 2 #4): a status a flow uses can't be merged
// away, and a merge can't move cards into a state the caller couldn't move
// them into.
func TestMergeKeepsToFlows(t *testing.T) {
	f := setupVisibility(t, "kitp_test_r2_merge_flows")
	ctx := context.Background()
	todo := store.TemplateStatusID(t, f.sp.P, f.projectA, "Todo")
	done := store.TemplateStatusID(t, f.sp.P, f.projectA, "Done")
	if _, err := f.sp.P.Exec(ctx, `
		UPDATE flow_step SET requires_role_id = (SELECT id FROM role WHERE name = 'admin')
		WHERE to_card_id = $1`, done); err != nil {
		t.Fatal(err)
	}
	mgr := reviewUser(t, f, "mgr", "manager", f.projectA)
	r := reviewCall(t, f, mgr, "card", "merge", fmt.Sprintf(`{"survivor_id":"%d","loser_ids":["%d"]}`, done, todo))
	if r.OK || r.Error.Code != "value_referenced_by_flow" {
		t.Errorf("merge a flow's state away: %+v, want value_referenced_by_flow", r)
	}

	// A status outside the flow, holding a task, merged into the admin-only
	// state: the manager can't move the task there.
	stray := insertedID(t, reviewCall(t, f, auth.SystemUserID, "card", "insert", fmt.Sprintf(
		`{"card_type_name":"status","parent_card_id":"%d","title":"Stray"}`, f.projectA)))
	task := insertedID(t, reviewCall(t, f, auth.SystemUserID, "card", "insert", fmt.Sprintf(
		`{"card_type_name":"task","parent_card_id":"%d","title":"t","attributes":{"status":"%d"}}`, f.projectA, todo)))
	if _, err := f.sp.P.Exec(ctx, `
		UPDATE attribute_value SET value = to_jsonb($2::bigint)
		WHERE card_id = $1 AND attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'status')`, task, stray); err != nil {
		t.Fatal(err)
	}
	r = reviewCall(t, f, mgr, "card", "merge", fmt.Sprintf(`{"survivor_id":"%d","loser_ids":["%d"]}`, done, stray))
	if r.OK || r.Error.Code != "flow_role_required" {
		t.Errorf("merge into an admin-only state: %+v, want flow_role_required", r)
	}
	if r := reviewCall(t, f, auth.SystemUserID, "card", "merge", fmt.Sprintf(`{"survivor_id":"%d","loser_ids":["%d"]}`, done, stray)); !r.OK {
		t.Errorf("an admin merges into the admin-only state: %+v", r.Error)
	}
}

// TestMergeRefusesPeople (round 2 #6): people are merged with person.merge;
// card.merge would hand one person's private cards to another.
func TestMergeRefusesPeople(t *testing.T) {
	f := setupVisibility(t, "kitp_test_r2_merge_people")
	ctx := context.Background()
	adminPerson := reviewPerson(t, f, f.admin)
	ada := reviewUser(t, f, "ada", "viewer", f.projectA)
	adaPerson := reviewPerson(t, f, ada)
	list := reviewPrivateCard(t, f, "watch_list", adaPerson)
	r := reviewCall(t, f, f.admin, "card", "merge", fmt.Sprintf(`{"survivor_id":"%d","loser_ids":["%d"]}`, adminPerson, adaPerson))
	if r.OK || r.Error.Code != "use_person_merge" {
		t.Errorf("card.merge on people: %+v, want use_person_merge", r)
	}
	var visible bool
	if err := f.sp.P.QueryRow(ctx, `SELECT card_visible_to($1, $2)`, f.admin, list).Scan(&visible); err != nil {
		t.Fatal(err)
	}
	if visible {
		t.Error("the admin sees Ada's private watch list")
	}
}

// TestNumberAttributesTakeNumbers (round 2 #15): a number attribute stores
// a JSON number (a numeric string becomes one) and refuses anything else,
// through both write paths.
func TestNumberAttributesTakeNumbers(t *testing.T) {
	f := setupVisibility(t, "kitp_test_r2_number")
	ctx := context.Background()
	for _, v := range []string{`{"comment_body_id":"zz"}`, `["a",1]`, `"not a number"`, `true`, `2.5`} {
		r := reviewCall(t, f, f.worker, "attribute", "update",
			fmt.Sprintf(`{"card_id":"%d","attribute_name":"sort_order","value":%s}`, f.taskA, v))
		if r.OK || r.Error.Code != "validation" {
			t.Errorf("sort_order := %s: %+v, want validation", v, r)
		}
	}
	if r := reviewCall(t, f, f.worker, "attribute", "update",
		fmt.Sprintf(`{"card_id":"%d","attribute_name":"sort_order","value":"25"}`, f.taskA)); !r.OK {
		t.Fatalf("sort_order := \"25\": %+v", r.Error)
	}
	var typ string
	if err := f.sp.P.QueryRow(ctx, `
		SELECT jsonb_typeof(av.value) FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1 AND ad.name = 'sort_order'`, f.taskA).Scan(&typ); err != nil {
		t.Fatal(err)
	}
	if typ != "number" {
		t.Errorf("a numeric string stored as %s, want number", typ)
	}
	r := reviewCall(t, f, f.worker, "card", "insert", fmt.Sprintf(
		`{"card_type_name":"task","parent_card_id":"%d","title":"x","attributes":{"sort_order":{"a":1}}}`, f.projectA))
	if r.OK || r.Error.Code != "validation" {
		t.Errorf("card.insert with an object sort_order: %+v, want validation", r)
	}
}
