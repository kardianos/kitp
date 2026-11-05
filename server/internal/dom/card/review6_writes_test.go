package card_test

// Regression tests for the writes findings of the fifth 2026-11-03 review
// (#5, #11, #13, #16 and smaller ones).

import (
	"context"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/schema/hcsv"
	"github.com/kitp/kitp/server/internal/store"
)

// sqlCard inserts a card directly and returns its id.
func sqlCard(t *testing.T, f *visibilityFixture, cardType string, parent, privateTo any) int64 {
	t.Helper()
	var id int64
	if err := f.sp.P.QueryRow(context.Background(), `
		INSERT INTO card (card_type_id, parent_card_id, private_to)
		SELECT id, $2, $3 FROM card_type WHERE name = $1 RETURNING id`, cardType, parent, privateTo).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func r5SetAttr(t *testing.T, f *visibilityFixture, card int64, attr, value string) {
	t.Helper()
	if _, err := f.sp.P.Exec(context.Background(), `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		SELECT $1, id, $3::jsonb FROM attribute_def WHERE name = $2
		ON CONFLICT (card_id, attribute_def_id) DO UPDATE SET value = EXCLUDED.value`, card, attr, value); err != nil {
		t.Fatal(err)
	}
}

func r5ParentOf(t *testing.T, f *visibilityFixture, card int64) int64 {
	t.Helper()
	var p *int64
	if err := f.sp.P.QueryRow(context.Background(), `SELECT parent_card_id FROM card WHERE id = $1`, card).Scan(&p); err != nil {
		t.Fatal(err)
	}
	if p == nil {
		return 0
	}
	return *p
}

// TestMoveKeepsWhatItsProjectUses (#5): a card its project still uses — a
// flow's state, or one its cards point at — doesn't move to another
// project; one nothing uses does.
func TestMoveKeepsWhatItsProjectUses(t *testing.T) {
	f := setupVisibility(t, "kitp_test_r5b_move_in_use")
	ctx := context.Background()
	sys := auth.SystemUserID
	fresh := insertedID(t, reviewCall(t, f, sys, "card", "insert", fmt.Sprintf(
		`{"card_type_name":"status","parent_card_id":"%d","title":"Fresh"}`, f.projectA)))
	if _, err := f.sp.P.Exec(ctx, `
		UPDATE flow SET default_create_status_id = $2
		WHERE scope_card_id = $1 AND attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'status')`,
		f.projectA, fresh); err != nil {
		t.Fatal(err)
	}
	used := sqlCard(t, f, "milestone", f.projectA, nil)
	r5SetAttr(t, f, f.taskA, "milestone_ref", fmt.Sprint(used))
	tagged := sqlCard(t, f, "tag", f.projectA, nil)
	r5SetAttr(t, f, f.taskA, "tags", fmt.Sprintf("[%d]", tagged))
	idle := sqlCard(t, f, "milestone", f.projectA, nil)
	for _, c := range []struct {
		name string
		card int64
		want string
	}{
		{"the flow's starting state", fresh, "value_referenced_by_flow"},
		{"a milestone a task uses", used, "value_in_use"},
		{"a tag a task has", tagged, "value_in_use"},
		{"a milestone nothing uses", idle, ""},
	} {
		r := reviewCall(t, f, sys, "card", "move", fmt.Sprintf(`{"card_id":"%d","new_parent_card_id":"%d"}`, c.card, f.projectB))
		got := ""
		if !r.OK {
			got = r.Error.Code
		}
		if got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
}

// TestPersonalCapsHold (#11): card.undelete keeps a person within their
// cap, a personal screen can't be moved under a project (out of the
// count), and entries on cards that are gone don't fill a watch list.
func TestPersonalCapsHold(t *testing.T) {
	f := setupVisibility(t, "kitp_test_r5b_caps_hold")
	ctx := context.Background()
	person := reviewPerson(t, f, f.admin)
	rows := make([]map[string]any, 200)
	for i := range rows {
		rows[i] = map[string]any{"title": fmt.Sprintf("l%d", i)}
	}
	if codes := batchCodes(t, f, "watch_list_set_batch", f.admin, rows); codes[199] != "" {
		t.Fatalf("200th list: %q", codes[199])
	}
	var gone int64
	if err := f.sp.P.QueryRow(ctx, `SELECT id FROM card WHERE private_to = $1 ORDER BY id LIMIT 1`, person).Scan(&gone); err != nil {
		t.Fatal(err)
	}
	if r := reviewCall(t, f, f.admin, "card", "delete", fmt.Sprintf(`{"card_id":"%d"}`, gone)); !r.OK {
		t.Fatalf("delete: %+v", r.Error)
	}
	if codes := batchCodes(t, f, "watch_list_set_batch", f.admin, []map[string]any{{"title": "again"}}); codes[0] != "" {
		t.Fatalf("a list in the freed place: %q", codes[0])
	}
	if r := reviewCall(t, f, f.admin, "card", "undelete", fmt.Sprintf(`{"card_id":"%d"}`, gone)); r.OK || r.Error.Code != "limit" {
		t.Errorf("undelete past the cap: %+v, want limit", r)
	}

	screen := sqlCard(t, f, "screen", nil, person)
	if r := reviewCall(t, f, f.admin, "card", "move", fmt.Sprintf(`{"card_id":"%d","new_parent_card_id":"%d"}`, screen, f.projectA)); r.OK || r.Error.Code != "forbidden" {
		t.Errorf("a personal screen moved under a project: %+v, want forbidden", r)
	}

	var list int64
	if err := f.sp.P.QueryRow(ctx, `SELECT id FROM card WHERE private_to = $1 AND deleted_at IS NULL ORDER BY id LIMIT 1`, person).Scan(&list); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sp.P.Exec(ctx, `
		WITH t AS (
			INSERT INTO card (card_type_id, parent_card_id, deleted_at)
			SELECT ct.id, $2, now() FROM card_type ct, generate_series(1, 5000) WHERE ct.name = 'task'
			RETURNING id)
		INSERT INTO watch_entry (watch_list_id, card_id, sort_order) SELECT $1, t.id, t.id FROM t`, list, f.projectA); err != nil {
		t.Fatal(err)
	}
	codes := batchCodes(t, f, "watch_set_batch", f.admin, []map[string]any{
		{"watch_list_id": fmt.Sprint(list), "card_id": fmt.Sprint(f.taskA), "on": true}})
	if codes[0] != "" {
		t.Errorf("a list full of deleted cards refused a live one: %q", codes[0])
	}
}

// TestMergeKeepsChildren (#13): the merged cards' children move to the
// survivor; a survivor under a card being merged is refused.
func TestMergeKeepsChildren(t *testing.T) {
	f := setupVisibility(t, "kitp_test_r5b_merge_children")
	sys := auth.SystemUserID
	keep := sqlCard(t, f, "page", f.projectA, nil)
	dup := sqlCard(t, f, "page", f.projectA, nil)
	child := sqlCard(t, f, "page", dup, nil)
	if r := reviewCall(t, f, sys, "card", "merge", fmt.Sprintf(`{"survivor_id":"%d","loser_ids":["%d"]}`, keep, dup)); !r.OK {
		t.Fatalf("merge: %+v", r.Error)
	}
	if got := r5ParentOf(t, f, child); got != keep {
		t.Errorf("the merged page's child is under %d, want the survivor %d", got, keep)
	}
	top := sqlCard(t, f, "page", f.projectA, nil)
	under := sqlCard(t, f, "page", top, nil)
	if r := reviewCall(t, f, sys, "card", "merge", fmt.Sprintf(`{"survivor_id":"%d","loser_ids":["%d"]}`, under, top)); r.OK || r.Error.Code != "cycle" {
		t.Errorf("merge a page into its own child: %+v, want cycle", r)
	}
}

// TestSharedUnderPrivateBecomesPrivate (#16): migration 0039 makes a shared
// card that sits under someone's private card private to them.
func TestSharedUnderPrivateBecomesPrivate(t *testing.T) {
	f := setupVisibility(t, "kitp_test_r5b_private_backfill")
	ctx := context.Background()
	person := reviewPerson(t, f, f.admin)
	screen := sqlCard(t, f, "screen", nil, person)
	view := sqlCard(t, f, "filter", screen, nil)
	elsewhere := sqlCard(t, f, "filter", sqlCard(t, f, "screen", f.projectA, nil), nil)
	if _, err := f.sp.P.Exec(ctx, `DELETE FROM schema_version WHERE name = '0039_private_under_private'`); err != nil {
		t.Fatal(err)
	}
	if err := store.ApplySchema(ctx, f.sp.P, hcsv.GenerateOptions{Demo: false}); err != nil {
		t.Fatalf("re-apply: %v", err)
	}
	var owner, other *int64
	if err := f.sp.P.QueryRow(ctx, `SELECT (SELECT private_to FROM card WHERE id = $1), (SELECT private_to FROM card WHERE id = $2)`, view, elsewhere).Scan(&owner, &other); err != nil {
		t.Fatal(err)
	}
	if owner == nil || *owner != person {
		t.Errorf("the view under a personal screen: private_to %v, want %d", owner, person)
	}
	if other != nil {
		t.Errorf("a view on a shared screen became private to %d", *other)
	}
}

// TestSmallWriteChecks (round 5 smaller items): flow.set takes only a live
// starting state of its own project; user_card_sort.set answers a bad
// sort_order per row; comment.insert refuses a deleted card.
func TestSmallWriteChecks(t *testing.T) {
	f := setupVisibility(t, "kitp_test_r5b_small_checks")
	ctx := context.Background()
	var def int64
	var name string
	if err := f.sp.P.QueryRow(ctx, `
		SELECT attribute_def_id, name FROM flow
		WHERE scope_card_id = $1 AND attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'status')`, f.projectA).Scan(&def, &name); err != nil {
		t.Fatal(err)
	}
	dead := insertedID(t, reviewCall(t, f, auth.SystemUserID, "card", "insert", fmt.Sprintf(
		`{"card_type_name":"status","parent_card_id":"%d","title":"Dead"}`, f.projectA)))
	if _, err := f.sp.P.Exec(ctx, `UPDATE card SET deleted_at = now() WHERE id = $1`, dead); err != nil {
		t.Fatal(err)
	}
	theirs := store.TemplateStatusID(t, f.sp.P, f.projectB, "Todo")
	for _, c := range []struct {
		start int64
		want  string
	}{{dead, "default_status_not_found"}, {theirs, "cross_project_ref"}} {
		codes := batchCodes(t, f, "flow_set_batch", auth.SystemUserID, []map[string]any{{
			"name": name, "attribute_def_id": fmt.Sprint(def), "scope_card_id": fmt.Sprint(f.projectA),
			"default_create_status_id": fmt.Sprint(c.start)}})
		if codes[0] != c.want {
			t.Errorf("starting state %d: %q, want %q", c.start, codes[0], c.want)
		}
	}
	codes := batchCodes(t, f, "user_card_sort_set_batch", f.admin, []map[string]any{
		{"card_id": fmt.Sprint(f.taskA), "sort_order": "soon"},
		{"card_id": fmt.Sprint(f.taskA), "sort_order": 2.5}})
	if codes[0] != "validation" || codes[1] != "" {
		t.Errorf("user_card_sort.set: %v, want [validation, ok]", codes)
	}
	if _, err := f.sp.P.Exec(ctx, `UPDATE card SET deleted_at = now() WHERE id = $1`, f.taskB); err != nil {
		t.Fatal(err)
	}
	codes = batchCodes(t, f, "comment_insert_batch", auth.SystemUserID, []map[string]any{{"card_id": fmt.Sprint(f.taskB), "body": "hi"}})
	if codes[0] != "card_not_found" {
		t.Errorf("a comment on a deleted card: %q, want card_not_found", codes[0])
	}
}

// TestOwnPrivateCardsKeepTheBundleSourceCheck (round 5, worth a look):
// writing your own private card needs no role grant, but a personal view
// still can't be put into a feature bundle's source project, which kitp
// rebuilds and copies into projects.
func TestOwnPrivateCardsKeepTheBundleSourceCheck(t *testing.T) {
	f := setupVisibility(t, "kitp_test_r5b_private_bundle_source")
	ctx := context.Background()
	reviewPerson(t, f, f.admin)
	var src int64
	if err := f.sp.P.QueryRow(ctx, `SELECT source_project_id FROM bundle WHERE source_project_id IS NOT NULL ORDER BY key LIMIT 1`).Scan(&src); err != nil {
		t.Fatal(err)
	}
	view := func(screen int64) api.SubResponse {
		t.Helper()
		return reviewCall(t, f, f.admin, "card", "insert", fmt.Sprintf(
			`{"card_type_name":"filter","parent_card_id":"%d","title":"mine","private":true}`, screen))
	}
	if r := view(sqlCard(t, f, "screen", f.projectA, nil)); !r.OK {
		t.Fatalf("a personal view on a project's screen: %+v", r.Error)
	}
	if r := view(sqlCard(t, f, "screen", src, nil)); r.OK || r.Error.Code != "forbidden" {
		t.Errorf("a personal view in a bundle source: %+v, want forbidden", r)
	}
}
