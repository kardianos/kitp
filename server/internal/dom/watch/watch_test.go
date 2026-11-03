package watch_test

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/watch"
	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

type fixture struct {
	srv     *api.Server
	sp      *store.Pool
	project int64
	other   int64
	ada     context.Context
	adaPID  int64
	bob     context.Context
}

func call(t *testing.T, srv *api.Server, ctx context.Context, endpoint, action string, data any) api.SubResponse {
	t.Helper()
	b, _ := json.Marshal(data)
	return srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{{ID: "x", Endpoint: endpoint, Action: action, Data: b}}}).Subresponses[0]
}

func into(t *testing.T, r api.SubResponse, v any) {
	t.Helper()
	if !r.OK {
		t.Fatalf("dispatch: %+v", r.Error)
	}
	b, _ := json.Marshal(r.Data)
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatal(err)
	}
}

func code(r api.SubResponse) string {
	if r.OK || r.Error == nil {
		return ""
	}
	return r.Error.Code
}

// person makes a login with a person card and a worker role on project.
func person(t *testing.T, sp *store.Pool, name string, project int64) (context.Context, int64) {
	t.Helper()
	ctx := context.Background()
	var uid, pid int64
	if err := sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ($1) RETURNING id`, name).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	if err := sp.P.QueryRow(ctx, `INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'person' RETURNING id`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	if _, err := sp.P.Exec(ctx, `INSERT INTO user_account_person (user_account_id, person_card_id) VALUES ($1, $2)`, uid, pid); err != nil {
		t.Fatal(err)
	}
	if _, err := sp.P.Exec(ctx, `INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT $1, id, $2 FROM role WHERE name = 'worker'`, uid, project); err != nil {
		t.Fatal(err)
	}
	return auth.WithUser(ctx, &auth.UserCtx{ID: uid, DisplayName: name}), pid
}

func setup(t *testing.T, schemaName string) *fixture {
	t.Helper()
	reg.Reset()
	sp := store.NewPool(store.TestPool(t, schemaName))
	cardtype.Register()
	card.Register(sp)
	attribute.Register(sp)
	watch.Register(sp)
	f := &fixture{srv: api.NewServer(sp), sp: sp}
	sys := auth.WithSystemUser(context.Background())
	var p card.InsertOutput
	into(t, call(t, f.srv, sys, "card", "insert", map[string]any{"card_type_name": "project", "title": "Launch"}), &p)
	f.project = p.ID
	into(t, call(t, f.srv, sys, "card", "insert", map[string]any{"card_type_name": "project", "title": "Elsewhere"}), &p)
	f.other = p.ID
	f.ada, f.adaPID = person(t, sp, "ada", f.project)
	f.bob, _ = person(t, sp, "bob", f.project)
	return f
}

func (f *fixture) task(t *testing.T, project int64, title string) int64 {
	t.Helper()
	var out card.InsertOutput
	into(t, call(t, f.srv, auth.WithSystemUser(context.Background()), "card", "insert", map[string]any{
		"card_type_name": "task", "parent_card_id": fmt.Sprint(project), "title": title,
	}), &out)
	return out.ID
}

func lists(t *testing.T, f *fixture, ctx context.Context, cardID int64) []watch.ListRow {
	t.Helper()
	in := map[string]any{}
	if cardID != 0 {
		in["card_id"] = fmt.Sprint(cardID)
	}
	var out watch.ListOutput
	into(t, call(t, f.srv, ctx, "watch_list", "list", in), &out)
	return out.Lists
}

func items(t *testing.T, f *fixture, ctx context.Context, list int64) []int64 {
	t.Helper()
	var out watch.ItemsOutput
	into(t, call(t, f.srv, ctx, "watch", "items", map[string]any{"watch_list_id": fmt.Sprint(list)}), &out)
	ids := []int64{}
	for _, it := range out.Items {
		ids = append(ids, it.CardID)
	}
	return ids
}

func setOn(t *testing.T, f *fixture, ctx context.Context, list, cardID int64, on bool) api.SubResponse {
	t.Helper()
	return call(t, f.srv, ctx, "watch", "set", map[string]any{"watch_list_id": fmt.Sprint(list), "card_id": fmt.Sprint(cardID), "on": on})
}

// TestWatchListsStartWithStars: an account's first list call makes Stars
// (once); lists are created, renamed and deleted by their owner only; a
// deleted Stars stays deleted.
func TestWatchListsStartWithStars(t *testing.T) {
	f := setup(t, "kitp_test_watch_lists")
	got := lists(t, f, f.ada, 0)
	if len(got) != 1 || got[0].Title != "Stars" || got[0].Symbol != "★" || got[0].Description != "" {
		t.Fatalf("first lists = %+v, want Stars ★", got)
	}
	stars := got[0].ID
	if again := lists(t, f, f.ada, 0); len(again) != 1 || again[0].ID != stars {
		t.Errorf("second call = %+v, want the same Stars", again)
	}

	var made watch.IDOutput
	into(t, call(t, f.srv, f.ada, "watch_list", "set", map[string]any{"title": "Waiting on others", "symbol": "⏳", "description": "Chase on Fridays"}), &made)
	into(t, call(t, f.srv, f.ada, "watch_list", "set", map[string]any{"id": fmt.Sprint(made.ID), "title": "Waiting"}), &made)
	got = lists(t, f, f.ada, 0)
	if len(got) != 2 || got[1].Title != "Waiting" || got[1].Symbol != "⏳" || got[1].Description != "Chase on Fridays" {
		t.Errorf("after create + rename = %+v", got)
	}
	// A symbol defaults to ★; a name is required.
	if c := code(call(t, f.srv, f.ada, "watch_list", "set", map[string]any{"title": ""})); c != "validation" {
		t.Errorf("no name: %q, want validation", c)
	}

	// Bob has his own Stars and can't touch Ada's lists.
	if b := lists(t, f, f.bob, 0); len(b) != 1 || b[0].ID == stars {
		t.Errorf("bob's lists = %+v, want his own Stars", b)
	}
	if c := code(call(t, f.srv, f.bob, "watch_list", "set", map[string]any{"id": fmt.Sprint(stars), "title": "Mine now"})); c != "not_found" {
		t.Errorf("bob renaming ada's list: %q, want not_found", c)
	}
	if c := code(call(t, f.srv, f.bob, "watch_list", "delete", map[string]any{"id": fmt.Sprint(stars)})); c != "not_found" {
		t.Errorf("bob deleting ada's list: %q, want not_found", c)
	}

	into(t, call(t, f.srv, f.ada, "watch_list", "delete", map[string]any{"id": fmt.Sprint(stars)}), &made)
	if got := lists(t, f, f.ada, 0); len(got) != 1 || got[0].ID == stars {
		t.Errorf("after deleting Stars = %+v, want only Waiting (Stars not made again)", got)
	}
}

// TestWatchEntries: tasks go on a list at the top, move by sort_order, come
// off; a card the caller can't see, a card that isn't a task or thread, and
// someone else's list are refused; has_card and count follow.
func TestWatchEntries(t *testing.T) {
	f := setup(t, "kitp_test_watch_entries")
	stars := lists(t, f, f.ada, 0)[0].ID
	one := f.task(t, f.project, "One")
	two := f.task(t, f.project, "Two")
	hidden := f.task(t, f.other, "Hidden")

	for _, id := range []int64{one, two} {
		if r := setOn(t, f, f.ada, stars, id, true); !r.OK {
			t.Fatalf("watch.set %d: %+v", id, r.Error)
		}
	}
	setOn(t, f, f.ada, stars, one, true) // again: no change
	if got := items(t, f, f.ada, stars); !slices.Equal(got, []int64{two, one}) {
		t.Errorf("items = %v, want [two one] (newest on top)", got)
	}
	var out watch.ItemsOutput
	into(t, call(t, f.srv, f.ada, "watch", "items", map[string]any{"watch_list_id": fmt.Sprint(stars)}), &out)
	if it := out.Items[0]; it.CardType != "task" || it.Title != "Two" || it.ProjectID != f.project || it.ProjectTitle != "Launch" || it.Status == "" || it.Phase == "" {
		t.Errorf("item = %+v, want task Two in Launch with a status", it)
	}

	// Move One above Two.
	var mv watch.MoveOutput
	into(t, call(t, f.srv, f.ada, "watch", "move", map[string]any{
		"watch_list_id": fmt.Sprint(stars), "card_id": fmt.Sprint(one), "sort_order": out.Items[0].SortOrder - 1,
	}), &mv)
	if got := items(t, f, f.ada, stars); !slices.Equal(got, []int64{one, two}) {
		t.Errorf("after the move = %v, want [one two]", got)
	}
	if c := code(call(t, f.srv, f.ada, "watch", "move", map[string]any{
		"watch_list_id": fmt.Sprint(stars), "card_id": fmt.Sprint(hidden), "sort_order": 0,
	})); c != "not_on_list" {
		t.Errorf("moving a card not on the list: %q", c)
	}

	if l := lists(t, f, f.ada, one); !l[0].HasCard || l[0].Count != 2 {
		t.Errorf("list with card_id = %+v, want has_card and count 2", l[0])
	}
	setOn(t, f, f.ada, stars, one, false)
	if l := lists(t, f, f.ada, one); l[0].HasCard || l[0].Count != 1 {
		t.Errorf("after taking One off = %+v", l[0])
	}

	if c := code(setOn(t, f, f.ada, stars, hidden, true)); c != "card_not_found" {
		t.Errorf("a card in another project: %q, want card_not_found", c)
	}
	if c := code(setOn(t, f, f.ada, stars, f.project, true)); c != "validation" {
		t.Errorf("a project: %q, want validation", c)
	}
	bobStars := lists(t, f, f.bob, 0)[0].ID
	if c := code(setOn(t, f, f.ada, bobStars, two, true)); c != "not_found" {
		t.Errorf("ada on bob's list: %q, want not_found", c)
	}
	if c := code(call(t, f.srv, f.bob, "watch", "items", map[string]any{"watch_list_id": fmt.Sprint(stars)})); c != "not_found" {
		t.Errorf("bob reading ada's list: %q, want not_found", c)
	}
}

// TestWatchListFilter: the watch_list filter leaf — "@me" = any of the
// viewer's lists, a list id = that list, not in = the rest — in both the
// SQL compiler (card.select_with_attributes) and the Go one (CompileTree).
func TestWatchListFilter(t *testing.T) {
	f := setup(t, "kitp_test_watch_filter")
	stars := lists(t, f, f.ada, 0)[0].ID
	var waiting watch.IDOutput
	into(t, call(t, f.srv, f.ada, "watch_list", "set", map[string]any{"title": "Waiting"}), &waiting)
	one := f.task(t, f.project, "One")
	two := f.task(t, f.project, "Two")
	three := f.task(t, f.project, "Three")
	setOn(t, f, f.ada, stars, one, true)
	setOn(t, f, f.ada, waiting.ID, two, true)

	selectIDs := func(ctx context.Context, tree map[string]any) []int64 {
		t.Helper()
		var out struct {
			Rows []struct {
				ID int64 `json:"id,string"`
			} `json:"rows"`
		}
		into(t, call(t, f.srv, ctx, "card", "select_with_attributes", map[string]any{
			"card_type_name": "task", "parent_card_id": fmt.Sprint(f.project),
			"tree": map[string]any{"connective": "and", "children": []any{tree}},
		}), &out)
		ids := []int64{}
		for _, r := range out.Rows {
			ids = append(ids, r.ID)
		}
		slices.Sort(ids)
		return ids
	}
	cases := []struct {
		name string
		ctx  context.Context
		tree map[string]any
		want []int64
	}{
		{"any of my lists", f.ada, map[string]any{"attr": "watch_list", "op": "in", "values": []any{"@me"}}, []int64{one, two}},
		{"one list", f.ada, map[string]any{"attr": "watch_list", "op": "in", "values": []any{fmt.Sprint(waiting.ID)}}, []int64{two}},
		{"not on my lists", f.ada, map[string]any{"attr": "watch_list", "op": "not in", "values": []any{"@me"}}, []int64{three}},
		{"bob watches nothing", f.bob, map[string]any{"attr": "watch_list", "op": "in", "values": []any{"@me"}}, []int64{}},
	}
	for _, c := range cases {
		if got := selectIDs(c.ctx, c.tree); !slices.Equal(got, c.want) {
			t.Errorf("SQL compiler, %s: %v, want %v", c.name, got, c.want)
		}
	}

	// The Go compiler (calendar feeds, notification filters) agrees.
	ctx := context.Background()
	snap, err := schema.Load(ctx, f.sp.P)
	if err != nil {
		t.Fatal(err)
	}
	b := named.New()
	b.Set("project", f.project)
	where, err := card.CompileTree(ctx, f.sp.P, card.CardWhereGroup{Connective: "and", Children: []card.CardWhereTreeNode{{
		Attr: "watch_list", Op: "in", Values: []json.RawMessage{json.RawMessage(fmt.Sprint(f.adaPID))},
	}}}, b.Bind, snap)
	if err != nil {
		t.Fatalf("CompileTree: %v", err)
	}
	q, args, err := b.Compile(`SELECT c.id FROM card c WHERE c.parent_card_id = :project AND ` + where + ` ORDER BY c.id`)
	if err != nil {
		t.Fatal(err)
	}
	rows, err := f.sp.P.Query(ctx, q, args...)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var got []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		got = append(got, id)
	}
	if !slices.Equal(got, []int64{one, two}) {
		t.Errorf("Go compiler, ada's person: %v, want [one two]", got)
	}
	if _, err := card.CompileTree(ctx, f.sp.P, card.CardWhereGroup{Connective: "and", Children: []card.CardWhereTreeNode{{
		Attr: "watch_list", Op: "within_last_days",
	}}}, named.New().Bind, snap); err == nil {
		t.Error("an unsupported op compiled")
	}
}
