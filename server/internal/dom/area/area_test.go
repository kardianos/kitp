package area_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/activity"
	"github.com/kitp/kitp/server/internal/dom/area"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/bundle"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

type fixture struct {
	srv     *api.Server
	sp      *store.Pool
	project int64
	task    int64
	comm    int64
	page    int64
	manager context.Context // a manager on the project
	worker  context.Context // a worker on the project
}

func sysCtx() context.Context { return auth.WithSystemUser(context.Background()) }

func call(f fixture, ctx context.Context, endpoint, action, data string) api.SubResponse {
	resp := f.srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "x", Endpoint: endpoint, Action: action, Data: json.RawMessage(data)},
	}})
	return resp.Subresponses[0]
}

func decode(t *testing.T, sr api.SubResponse, out any) {
	t.Helper()
	if !sr.OK {
		t.Fatalf("want OK; got %+v", sr.Error)
	}
	raw, err := json.Marshal(sr.Data)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		t.Fatalf("unmarshal %s: %v", raw, err)
	}
}

func fails(t *testing.T, sr api.SubResponse, code string) {
	t.Helper()
	if sr.OK || sr.Error == nil || sr.Error.Code != code {
		t.Errorf("want error %s; got ok=%v %+v", code, sr.OK, sr.Error)
	}
}

// member adds a login with a role scoped to the project.
func member(t *testing.T, f fixture, name, role string) context.Context {
	t.Helper()
	ctx := context.Background()
	var id int64
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ($1) RETURNING id`, name).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sp.P.Exec(ctx,
		`INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT $1, id, $2 FROM role WHERE name = $3`,
		id, f.project, role); err != nil {
		t.Fatal(err)
	}
	return auth.WithUser(ctx, &auth.UserCtx{ID: id, DisplayName: name})
}

func setup(t *testing.T, schemaName string) fixture {
	t.Helper()
	reg.Reset()
	pool := store.TestPool(t, schemaName)
	sp := store.NewPool(pool)
	cardtype.Register()
	card.Register(sp)
	activity.Register(sp)
	attribute.Register(sp)
	bundle.Register(sp)
	area.Register(sp)
	f := fixture{srv: api.NewServer(sp), sp: sp}
	var out bundle.ComposeOutput
	decode(t, call(f, sysCtx(), "project", "compose", `{"name":"Care","features":["tracker","conversations","publishing"]}`), &out)
	f.project = out.NewProjectID
	var ins card.InsertOutput
	decode(t, call(f, sysCtx(), "card", "insert",
		fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"Printer jam"}`, f.project)), &ins)
	f.task = ins.ID
	// A comm (an email thread) on the task, written directly: the comm
	// handlers need a mail account.
	if err := pool.QueryRow(context.Background(), `
		INSERT INTO card (card_type_id, parent_card_id)
		SELECT id, $1 FROM card_type WHERE name = 'comm' RETURNING id`, f.task).Scan(&f.comm); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO activity (card_id, kind, actor_id) VALUES ($1, 'card_create', 1)`, f.comm); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(context.Background(), `
		SELECT c.id FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'page'
		WHERE c.parent_card_id = $1 AND c.deleted_at IS NULL ORDER BY c.id LIMIT 1`, f.project).Scan(&f.page); err != nil {
		t.Fatalf("home page: %v", err)
	}
	f.manager = member(t, f, "Mia", "manager")
	f.worker = member(t, f, "Wes", "worker")
	return f
}

func states(t *testing.T, f fixture, ctx context.Context, project int64) map[string]area.Area {
	t.Helper()
	var out area.ListOutput
	data := `{}`
	if project != 0 {
		data = fmt.Sprintf(`{"project_id":"%d"}`, project)
	}
	decode(t, call(f, ctx, "area", "list", data), &out)
	m := map[string]area.Area{}
	for _, a := range out.Areas {
		m[a.Key] = a
	}
	return m
}

func set(f fixture, ctx context.Context, key string, on bool) api.SubResponse {
	return call(f, ctx, "area", "set", fmt.Sprintf(`{"project_id":"%d","key":%q,"on":%v}`, f.project, key, on))
}

// visible lists the ids of a card type the caller can read.
func visible(t *testing.T, f fixture, ctx context.Context, cardType string) map[int64]bool {
	t.Helper()
	var out struct {
		Rows []struct {
			ID int64 `json:"id,string"`
		} `json:"rows"`
	}
	decode(t, call(f, ctx, "card", "select_with_attributes", fmt.Sprintf(`{"card_type_name":%q}`, cardType)), &out)
	m := map[int64]bool{}
	for _, r := range out.Rows {
		m[r.ID] = true
	}
	return m
}

// TestAreaList: a composed project's areas, their states and screens; the
// workspace's Sites.
func TestAreaList(t *testing.T) {
	f := setup(t, "kitp_test_area_list")
	got := states(t, f, sysCtx(), f.project)
	for key, want := range map[string]string{"tasks": "on", "conversations": "on", "approvals": "unused", "content": "on"} {
		if got[key].State != want {
			t.Errorf("%s: state %q, want %q", key, got[key].State, want)
		}
	}
	if len(got["tasks"].Screens) == 0 || len(got["content"].Screens) != 1 || len(got["conversations"].Screens) == 0 {
		t.Errorf("screens by area: tasks %v, content %v, conversations %v",
			got["tasks"].Screens, got["content"].Screens, got["conversations"].Screens)
	}
	if got["tasks"].Items == nil || *got["tasks"].Items != 1 {
		t.Errorf("an admin sees tasks' item count 1, got %v", got["tasks"].Items)
	}
	if mgr := states(t, f, f.manager, f.project); mgr["tasks"].Items != nil {
		t.Error("a manager sees item counts; only admins should")
	}
	if len(got["conversations"].Added) != 1 || got["conversations"].Added[0] != "conversations" {
		t.Errorf("conversations added %v", got["conversations"].Added)
	}
	all := states(t, f, sysCtx(), 0)
	if len(all) != 5 || all["sites"].State != "on" || all["sites"].Scope != "workspace" || all["content"].State != "unused" {
		t.Errorf("the catalog without a project = %+v", all)
	}
	if _, ok := got["sites"]; ok {
		t.Error("a project's areas include the workspace's Sites")
	}
}

// TestOffHidesEverything: an area that is off is hidden from every read —
// admins included — and refuses writes; switching it on (admin only)
// restores it. Dependencies hold both ways.
func TestOffHidesEverything(t *testing.T) {
	f := setup(t, "kitp_test_area_off")

	feedHas := func(card int64) bool {
		var feed struct {
			Rows []struct {
				CardID int64 `json:"card_id,string"`
			} `json:"rows"`
		}
		decode(t, call(f, sysCtx(), "activity", "select", fmt.Sprintf(`{"project_id":"%d"}`, f.project)), &feed)
		for _, r := range feed.Rows {
			if r.CardID == card {
				return true
			}
		}
		return false
	}
	if !feedHas(f.comm) || !visible(t, f, sysCtx(), "comm")[f.comm] {
		t.Fatal("with every area on, the comm and its activity should be visible")
	}

	fails(t, set(f, f.worker, "conversations", false), "unauthorized")
	var o area.SetOutput
	decode(t, set(f, f.manager, "conversations", false), &o)
	if o.State != "off" {
		t.Fatalf("set = %+v", o)
	}
	for who, ctx := range map[string]context.Context{"admin": sysCtx(), "manager": f.manager, "worker": f.worker} {
		if visible(t, f, ctx, "comm")[f.comm] {
			t.Errorf("%s still sees the comm of a switched-off Conversations", who)
		}
		if !visible(t, f, ctx, "task")[f.task] {
			t.Errorf("%s lost the task: only Conversations is off", who)
		}
	}
	fails(t, call(f, sysCtx(), "attribute", "update",
		fmt.Sprintf(`{"card_id":"%d","attribute_name":"title","value":"x"}`, f.comm)), "area_off")
	// Search and the activity feed don't show it either.
	var found struct {
		Rows []struct {
			ID int64 `json:"id,string"`
		} `json:"rows"`
	}
	decode(t, call(f, sysCtx(), "card", "search", fmt.Sprintf(`{"card_type_name":"comm","ids":["%d"]}`, f.comm)), &found)
	if len(found.Rows) != 0 {
		t.Errorf("card.search finds the comm of a switched-off Conversations: %+v", found.Rows)
	}
	if feedHas(f.comm) {
		t.Error("the activity feed shows the comm of a switched-off Conversations")
	}
	if got := states(t, f, sysCtx(), f.project)["conversations"].State; got != "off" {
		t.Errorf("state after off = %q", got)
	}

	fails(t, set(f, f.manager, "conversations", true), "forbidden") // only an admin turns on
	decode(t, set(f, sysCtx(), "conversations", true), &o)
	if !visible(t, f, sysCtx(), "comm")[f.comm] {
		t.Error("switching Conversations back on didn't restore the comm")
	}
	// Tasks can't go off while an area that needs it is on (Approvals).
	decode(t, set(f, sysCtx(), "approvals", true), &o)
	fails(t, set(f, f.manager, "tasks", false), "area_needed")
	decode(t, set(f, f.manager, "approvals", false), &o)

	// Content off hides pages and refuses edits to them.
	decode(t, set(f, f.manager, "content", false), &o)
	if visible(t, f, sysCtx(), "page")[f.page] {
		t.Error("a page is visible with Content off")
	}
	fails(t, call(f, f.manager, "attribute", "update",
		fmt.Sprintf(`{"card_id":"%d","attribute_name":"title","value":"x"}`, f.page)), "area_off")
	fails(t, call(f, f.manager, "card", "insert",
		fmt.Sprintf(`{"card_type_name":"page","parent_card_id":"%d","title":"New"}`, f.project)), "area_off")

	// Conversations doesn't need Tasks (a thread can stand on its own,
	// docs/CONVERSATIONS.md): Tasks goes off while Conversations stays on.
	decode(t, set(f, f.manager, "tasks", false), &o)
	if visible(t, f, sysCtx(), "task")[f.task] {
		t.Error("a task is visible with Tasks off")
	}
	if st := states(t, f, sysCtx(), f.project); st["conversations"].State != "on" {
		t.Errorf("Conversations is %s after Tasks went off, want on", st["conversations"].State)
	}

	// Turning on what needs an off area turns that on too.
	decode(t, set(f, sysCtx(), "approvals", true), &o)
	st := states(t, f, sysCtx(), f.project)
	if st["tasks"].State != "on" || st["approvals"].State != "on" {
		t.Errorf("switching on Approvals should switch on Tasks: %s / %s", st["tasks"].State, st["approvals"].State)
	}

	var acts int
	if err := f.sp.P.QueryRow(context.Background(),
		`SELECT count(*) FROM activity WHERE card_id = $1 AND kind = 'area_set'`, f.project).Scan(&acts); err != nil {
		t.Fatal(err)
	}
	if acts < 6 {
		t.Errorf("%d area_set activity rows, want one per switch", acts)
	}
}

// TestSwitchOnAddsStartingPoint: an area that never had a starting point
// gets its default (or the one asked for) when switched on; compose can
// start areas off.
func TestSwitchOnAddsStartingPoint(t *testing.T) {
	f := setup(t, "kitp_test_area_start")
	var out bundle.ComposeOutput
	decode(t, call(f, sysCtx(), "project", "compose",
		`{"name":"Plain","features":["tracker"],"areas_off":["content","approvals"]}`), &out)
	plain := out.NewProjectID
	st := states(t, f, sysCtx(), plain)
	if st["content"].State != "off" || st["approvals"].State != "off" || st["conversations"].State != "unused" || st["tasks"].State != "on" {
		t.Fatalf("composed states: tasks %s, conversations %s, approvals %s, content %s",
			st["tasks"].State, st["conversations"].State, st["approvals"].State, st["content"].State)
	}
	var o area.SetOutput
	decode(t, call(f, sysCtx(), "area", "set", fmt.Sprintf(`{"project_id":"%d","key":"content","on":true}`, plain)), &o)
	if len(o.Applied) != 1 || o.Applied[0] != "publishing" {
		t.Errorf("switching Content on applied %v, want its starting point", o.Applied)
	}
	if st := states(t, f, sysCtx(), plain); st["content"].State != "on" || len(st["content"].Screens) != 1 {
		t.Errorf("content after switching on: %+v", st["content"])
	}
	fails(t, call(f, sysCtx(), "area", "set", fmt.Sprintf(`{"project_id":"%d","key":"sites","on":false}`, plain)), "validation")
	fails(t, call(f, sysCtx(), "project", "compose", `{"name":"Bad","features":["tracker"],"areas_off":["sites"]}`), "internal")
}

// TestProjectWithItsOwnFlows: a project set up without a starting point —
// copied from a template, or created before areas existed — has the
// statuses and screens of Tasks and Conversations but no card_origin, and
// maybe no items yet. It has those areas: they read 'on', switching one
// off and on again adds no starting point (which would duplicate its
// flow), and an area that needs Tasks (Approvals) can be set up. An area
// it lacks (Content) still starts from its starting point.
func TestProjectWithItsOwnFlows(t *testing.T) {
	f := setup(t, "kitp_test_area_own_flows")
	ctx := context.Background()
	var tpl int64
	if err := f.sp.P.QueryRow(ctx, `
		SELECT c.id FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'project'
		JOIN attribute_value av ON av.card_id = c.id
		JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'title'
		WHERE av.value #>> '{}' = 'Standard Project Template' AND c.deleted_at IS NULL`).Scan(&tpl); err != nil {
		t.Fatalf("template project: %v", err)
	}
	var origins, items int
	if err := f.sp.P.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM card_origin WHERE project_id = $1),
		       (SELECT count(*) FROM card c JOIN card_type ct ON ct.id = c.card_type_id
		        WHERE c.parent_card_id = $1 AND ct.name IN ('task', 'comm_channel', 'page'))`, tpl).Scan(&origins, &items); err != nil {
		t.Fatal(err)
	}
	if origins != 0 || items != 0 {
		t.Fatalf("the template should have no starting point and no items: origins %d, items %d", origins, items)
	}
	flows := func(attr string) int {
		t.Helper()
		var n int
		if err := f.sp.P.QueryRow(ctx, `
			SELECT count(*) FROM flow f JOIN attribute_def ad ON ad.id = f.attribute_def_id
			WHERE f.scope_card_id = $1 AND ad.name = $2`, tpl, attr).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	setOn := func(key string, on bool) area.SetOutput {
		t.Helper()
		var o area.SetOutput
		decode(t, call(f, sysCtx(), "area", "set", fmt.Sprintf(`{"project_id":"%d","key":%q,"on":%v}`, tpl, key, on)), &o)
		return o
	}

	st := states(t, f, sysCtx(), tpl)
	for key, want := range map[string]string{"tasks": "on", "conversations": "on", "approvals": "unused", "content": "unused"} {
		if st[key].State != want {
			t.Errorf("%s: state %s, want %s", key, st[key].State, want)
		}
	}
	if len(st["tasks"].Screens) == 0 || len(st["conversations"].Screens) == 0 {
		t.Errorf("its own screens belong to their areas: tasks %v, conversations %v", st["tasks"].Screens, st["conversations"].Screens)
	}
	taskScreens := len(st["tasks"].Screens)

	// Approvals turns Tasks on first; Tasks is there, so nothing is added.
	if o := setOn("approvals", true); len(o.Applied) != 0 {
		t.Errorf("setting up Approvals applied %v, want nothing", o.Applied)
	}
	// Off and on again: no starting point, no second flow.
	setOn("approvals", false)
	setOn("tasks", false)
	if got := states(t, f, sysCtx(), tpl)["tasks"].State; got != "off" {
		t.Fatalf("tasks after switching off: %s", got)
	}
	if o := setOn("tasks", true); len(o.Applied) != 0 {
		t.Errorf("switching Tasks back on applied %v, want nothing", o.Applied)
	}
	if o := setOn("conversations", true); len(o.Applied) != 0 {
		t.Errorf("switching Conversations on applied %v, want nothing", o.Applied)
	}
	if n := flows("status"); n != 1 {
		t.Errorf("task flows: %d, want 1", n)
	}
	if n := flows("comm_status"); n != 1 {
		t.Errorf("comm flows: %d, want 1", n)
	}
	if got := len(states(t, f, sysCtx(), tpl)["tasks"].Screens); got != taskScreens {
		t.Errorf("task screens: %d, want %d (unchanged)", got, taskScreens)
	}
	// Content it doesn't have: setting it up adds its starting point.
	if o := setOn("content", true); len(o.Applied) != 1 || o.Applied[0] != "publishing" {
		t.Errorf("setting up Content applied %v, want [publishing]", o.Applied)
	}
}
