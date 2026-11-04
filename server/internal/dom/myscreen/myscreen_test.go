package myscreen_test

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
	"github.com/kitp/kitp/server/internal/dom/myscreen"
	"github.com/kitp/kitp/server/internal/dom/watch"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

type fixture struct {
	srv          *api.Server
	sp           *store.Pool
	p1, p2       int64
	ada, bob     context.Context
	viewer       context.Context
	admin        context.Context
	outsider     context.Context
	sharedScreen int64
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

// login makes an account with a person card and a role (global when
// project is 0).
func login(t *testing.T, sp *store.Pool, name, role string, project int64) context.Context {
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
	if role != "" {
		var scope any
		if project != 0 {
			scope = project
		}
		if _, err := sp.P.Exec(ctx, `INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT $1, id, $2 FROM role WHERE name = $3`, uid, scope, role); err != nil {
			t.Fatal(err)
		}
	}
	return auth.WithUser(ctx, &auth.UserCtx{ID: uid, DisplayName: name})
}

func setup(t *testing.T, schemaName string) *fixture {
	t.Helper()
	reg.Reset()
	sp := store.NewPool(store.TestPool(t, schemaName))
	cardtype.Register()
	card.Register(sp)
	attribute.Register(sp)
	watch.Register(sp)
	myscreen.Register(sp)
	f := &fixture{srv: api.NewServer(sp), sp: sp}
	sys := auth.WithSystemUser(context.Background())
	var p card.InsertOutput
	into(t, call(t, f.srv, sys, "card", "insert", map[string]any{"card_type_name": "project", "title": "Launch"}), &p)
	f.p1 = p.ID
	into(t, call(t, f.srv, sys, "card", "insert", map[string]any{"card_type_name": "project", "title": "Ops"}), &p)
	f.p2 = p.ID
	f.ada = login(t, sp, "ada", "worker", f.p1)
	if _, err := sp.P.Exec(context.Background(), `INSERT INTO user_role (user_id, role_id, scope_card_id)
		SELECT $1, id, $2 FROM role WHERE name = 'worker'`, auth.ActorOrSystem(f.ada), f.p2); err != nil {
		t.Fatal(err)
	}
	f.bob = login(t, sp, "bob", "worker", f.p1)
	f.viewer = login(t, sp, "vic", "viewer", f.p1)
	f.admin = login(t, sp, "root", "admin", 0)
	f.outsider = login(t, sp, "olga", "worker", f.p2)
	if err := sp.P.QueryRow(context.Background(), `
		SELECT c.id FROM card c JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'screen'
		WHERE c.parent_card_id = $1 ORDER BY c.id LIMIT 1`, f.p1).Scan(&f.sharedScreen); err != nil {
		t.Fatalf("a template screen in the project: %v", err)
	}
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

// sees lists card ids of a type (optionally under a parent) as ctx sees them.
func sees(t *testing.T, f *fixture, ctx context.Context, cardType string, parent int64, tree map[string]any) []int64 {
	t.Helper()
	in := map[string]any{"card_type_name": cardType}
	if parent != 0 {
		in["parent_card_id"] = fmt.Sprint(parent)
	}
	if tree != nil {
		in["tree"] = map[string]any{"connective": "and", "children": []any{tree}}
	}
	r := call(t, f.srv, ctx, "card", "select_with_attributes", in)
	if !r.OK {
		if r.Error != nil && r.Error.Code == "unauthorized" {
			return []int64{}
		}
		t.Fatalf("select: %+v", r.Error)
	}
	var out struct {
		Rows []struct {
			ID      int64 `json:"id,string"`
			Private bool  `json:"private"`
		} `json:"rows"`
	}
	into(t, r, &out)
	ids := []int64{}
	for _, row := range out.Rows {
		ids = append(ids, row.ID)
	}
	slices.Sort(ids)
	return ids
}

// TestPersonalScreens: an account makes, lists, edits and deletes its own
// screens and their views; nobody else — another worker, an admin — sees or
// touches them.
func TestPersonalScreens(t *testing.T) {
	f := setup(t, "kitp_test_my_screens")
	pred := fmt.Sprintf(`{"attr":"project","op":"in","values":["%d"]}`, f.p1)
	var made myscreen.IDOutput
	into(t, call(t, f.srv, f.ada, "my_screen", "set", map[string]any{
		"title": "Launch, active", "layout": "grid", "list_card_type": "task", "predicate": pred,
	}), &made)
	screen := made.ID
	into(t, call(t, f.srv, f.ada, "my_screen", "set", map[string]any{"title": "Threads", "list_card_type": "comm"}), &made)

	var list myscreen.ListOutput
	into(t, call(t, f.srv, f.ada, "my_screen", "list", map[string]any{}), &list)
	if len(list.Screens) != 2 || list.Screens[0].ID != screen || list.Screens[0].Layout != "grid" || list.Screens[0].Predicate != pred ||
		list.Screens[1].Layout != "list" || list.Screens[1].ListCardType != "comm" || list.Screens[1].SortOrder <= list.Screens[0].SortOrder {
		t.Fatalf("ada's screens = %+v", list.Screens)
	}
	into(t, call(t, f.srv, f.bob, "my_screen", "list", map[string]any{}), &list)
	if len(list.Screens) != 0 {
		t.Errorf("bob lists ada's screens: %+v", list.Screens)
	}
	for _, c := range []struct {
		name string
		r    api.SubResponse
	}{
		{"bob renames", call(t, f.srv, f.bob, "my_screen", "set", map[string]any{"id": fmt.Sprint(screen), "title": "Mine"})},
		{"bob deletes", call(t, f.srv, f.bob, "my_screen", "delete", map[string]any{"id": fmt.Sprint(screen)})},
		{"bad layout", call(t, f.srv, f.ada, "my_screen", "set", map[string]any{"id": fmt.Sprint(screen), "layout": "kanban"})},
		{"bad filter", call(t, f.srv, f.ada, "my_screen", "set", map[string]any{"id": fmt.Sprint(screen), "predicate": `{"attr":"project","op":"before_today"}`})},
	} {
		if c.r.OK {
			t.Errorf("%s: went through", c.name)
		}
	}
	// The screen card reads only for ada — not for bob, nor an admin.
	for name, ctx := range map[string]context.Context{"bob": f.bob, "admin": f.admin} {
		r := call(t, f.srv, ctx, "card", "select_with_attributes", map[string]any{"card_type_name": "screen", "ids": []string{fmt.Sprint(screen)}})
		var out struct {
			Rows []json.RawMessage `json:"rows"`
		}
		if r.OK {
			into(t, r, &out)
		}
		if len(out.Rows) != 0 {
			t.Errorf("%s reads ada's screen", name)
		}
	}
	var mine struct {
		Rows []struct {
			Private bool `json:"private"`
		} `json:"rows"`
	}
	into(t, call(t, f.srv, f.ada, "card", "select_with_attributes", map[string]any{"card_type_name": "screen", "ids": []string{fmt.Sprint(screen)}}), &mine)
	if len(mine.Rows) != 1 || !mine.Rows[0].Private {
		t.Errorf("ada's own screen = %+v, want it, marked private", mine.Rows)
	}

	// A view on her screen: the generic card.insert, no role grant needed;
	// private by inheritance; hers to rename, nobody else's.
	var view card.InsertOutput
	into(t, call(t, f.srv, f.ada, "card", "insert", map[string]any{
		"card_type_name": "filter", "parent_card_id": fmt.Sprint(screen), "title": "Mine only",
		"attributes": map[string]any{"predicate": `{"connective":"and","children":[]}`},
	}), &view)
	if got := sees(t, f, f.ada, "filter", screen, nil); !slices.Equal(got, []int64{view.ID}) {
		t.Errorf("ada's views = %v", got)
	}
	if got := sees(t, f, f.bob, "filter", screen, nil); len(got) != 0 {
		t.Errorf("bob sees ada's views: %v", got)
	}
	rename := func(ctx context.Context) api.SubResponse {
		return call(t, f.srv, ctx, "attribute", "update", map[string]any{"card_id": fmt.Sprint(view.ID), "attribute_name": "title", "value": "Renamed"})
	}
	if c := code(rename(f.bob)); c == "" {
		t.Error("bob renamed ada's view")
	}
	if c := code(rename(f.admin)); c == "" {
		t.Error("an admin renamed ada's view")
	}
	if r := rename(f.ada); !r.OK {
		t.Errorf("ada renames her view: %+v", r.Error)
	}
	into(t, call(t, f.srv, f.ada, "my_screen", "set", map[string]any{"id": fmt.Sprint(screen), "default_filter": fmt.Sprint(view.ID)}), &made)
	into(t, call(t, f.srv, f.ada, "my_screen", "list", map[string]any{}), &list)
	if list.Screens[0].DefaultFilter != view.ID || list.Screens[0].ViewCount != 1 {
		t.Errorf("after the default = %+v", list.Screens[0])
	}

	into(t, call(t, f.srv, f.ada, "my_screen", "delete", map[string]any{"id": fmt.Sprint(screen)}), &made)
	into(t, call(t, f.srv, f.ada, "my_screen", "list", map[string]any{}), &list)
	if len(list.Screens) != 1 {
		t.Errorf("after delete = %+v", list.Screens)
	}
	var deleted bool
	if err := f.sp.P.QueryRow(context.Background(), `SELECT deleted_at IS NOT NULL FROM card WHERE id = $1`, view.ID).Scan(&deleted); err != nil || !deleted {
		t.Errorf("the screen's view went with it: deleted=%v err=%v", deleted, err)
	}
}

// TestPersonalViewsOnASharedScreen: anyone who can see a screen — a viewer
// too — saves a view only they see; others list only the shared ones; a
// shared card can't point at a private one.
func TestPersonalViewsOnASharedScreen(t *testing.T) {
	f := setup(t, "kitp_test_my_views")
	shared := sees(t, f, f.bob, "filter", f.sharedScreen, nil)
	var adaView, vicView card.InsertOutput
	into(t, call(t, f.srv, f.ada, "card", "insert", map[string]any{
		"card_type_name": "filter", "parent_card_id": fmt.Sprint(f.sharedScreen), "title": "Ada's", "private": true,
	}), &adaView)
	into(t, call(t, f.srv, f.viewer, "card", "insert", map[string]any{
		"card_type_name": "filter", "parent_card_id": fmt.Sprint(f.sharedScreen), "title": "Vic's", "private": true,
	}), &vicView)
	if got := sees(t, f, f.bob, "filter", f.sharedScreen, nil); !slices.Equal(got, shared) {
		t.Errorf("bob's views on the screen = %v, want only the shared %v", got, shared)
	}
	if got := sees(t, f, f.ada, "filter", f.sharedScreen, nil); !slices.Contains(got, adaView.ID) || slices.Contains(got, vicView.ID) {
		t.Errorf("ada's views on the screen = %v, want hers and not vic's", got)
	}
	// Someone with no role in the project can't put one there.
	if c := code(call(t, f.srv, f.outsider, "card", "insert", map[string]any{
		"card_type_name": "filter", "parent_card_id": fmt.Sprint(f.sharedScreen), "title": "Olga's", "private": true,
	})); c != "parent_not_found" {
		t.Errorf("an outsider's private view: %q, want parent_not_found", c)
	}
	// Only views can be made private this way.
	if c := code(call(t, f.srv, f.ada, "card", "insert", map[string]any{
		"card_type_name": "task", "parent_card_id": fmt.Sprint(f.p1), "title": "Secret task", "private": true,
	})); c == "" {
		t.Error("a private task was made")
	}
	// The shared screen can't default to ada's own view.
	if c := code(call(t, f.srv, f.ada, "attribute", "update", map[string]any{
		"card_id": fmt.Sprint(f.sharedScreen), "attribute_name": "default_filter", "value": fmt.Sprint(adaView.ID),
	})); c != "private_ref" {
		t.Errorf("a shared screen defaulting to a private view: %q, want private_ref", c)
	}
	// my_default on her own view is hers to set.
	if r := call(t, f.srv, f.ada, "attribute", "update", map[string]any{
		"card_id": fmt.Sprint(adaView.ID), "attribute_name": "my_default", "value": true,
	}); !r.OK {
		t.Errorf("ada marks her view as her default: %+v", r.Error)
	}
	// Its history is hers too.
	r := call(t, f.srv, f.bob, "activity", "select", map[string]any{"card_id": fmt.Sprint(adaView.ID)})
	var acts struct {
		Rows []json.RawMessage `json:"rows"`
	}
	if r.OK {
		into(t, r, &acts)
	}
	if len(acts.Rows) != 0 {
		t.Errorf("bob reads the history of ada's view: %d rows", len(acts.Rows))
	}
}

// TestWatchListsArePrivate: one account's watch lists don't list for
// anyone else, admins included.
func TestWatchListsArePrivate(t *testing.T) {
	f := setup(t, "kitp_test_private_watch")
	var lists watch.ListOutput
	into(t, call(t, f.srv, f.ada, "watch_list", "list", map[string]any{}), &lists)
	stars := lists.Lists[0].ID
	for name, ctx := range map[string]context.Context{"bob": f.bob, "admin": f.admin} {
		if got := sees(t, f, ctx, "watch_list", 0, nil); slices.Contains(got, stars) {
			t.Errorf("%s lists ada's Stars", name)
		}
	}
	if got := sees(t, f, f.ada, "watch_list", 0, nil); !slices.Contains(got, stars) {
		t.Errorf("ada doesn't list her own Stars: %v", got)
	}
}

// TestProjectFilter: the project leaf keeps or drops cards by their
// enclosing project.
func TestProjectFilter(t *testing.T) {
	f := setup(t, "kitp_test_project_filter")
	a := f.task(t, f.p1, "In launch")
	b := f.task(t, f.p2, "In ops")
	in := sees(t, f, f.ada, "task", 0, map[string]any{"attr": "project", "op": "in", "values": []any{fmt.Sprint(f.p1)}})
	if !slices.Contains(in, a) || slices.Contains(in, b) {
		t.Errorf("project in [launch] = %v", in)
	}
	out := sees(t, f, f.ada, "task", 0, map[string]any{"attr": "project", "op": "not in", "values": []any{fmt.Sprint(f.p1)}})
	if slices.Contains(out, a) || !slices.Contains(out, b) {
		t.Errorf("project not in [launch] = %v", out)
	}
	all := sees(t, f, f.ada, "task", 0, nil)
	if !slices.Contains(all, a) || !slices.Contains(all, b) {
		t.Errorf("no project leaf = %v, want both projects' tasks", all)
	}
}
