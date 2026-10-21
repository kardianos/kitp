package link_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/auth/token"
	"github.com/kitp/kitp/server/internal/dom/activity"
	"github.com/kitp/kitp/server/internal/dom/agent"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/link"
	"github.com/kitp/kitp/server/internal/dom/userrole"
	"github.com/kitp/kitp/server/internal/dom/usertoken"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

const clURL = "https://gerrit.example.com/c/kitp/+/42"

// fixture is one project with one task, plus a second project for the
// cross-project authz rows.
type fixture struct {
	srv      *api.Server
	sp       *store.Pool
	projectA int64
	taskA    int64
	projectB int64
}

func setup(t *testing.T, schemaName string) fixture {
	t.Helper()
	reg.Reset()
	pool := store.TestPool(t, schemaName)
	sp := store.NewPool(pool)
	cardtype.Register()
	card.Register(sp)
	attribute.Register(sp)
	activity.Register(sp)
	link.Register(sp)
	srv := api.NewServer(sp)

	f := fixture{srv: srv, sp: sp}
	f.projectA = insertCard(t, srv, `{"card_type_name":"project","title":"A"}`)
	status := store.TemplateStatusID(t, sp.P, f.projectA, "Todo")
	f.taskA = insertCard(t, srv, fmt.Sprintf(
		`{"card_type_name":"task","parent_card_id":"%d","title":"task A","attributes":{"status":"%d"}}`,
		f.projectA, status))
	f.projectB = insertCard(t, srv, `{"card_type_name":"project","title":"B"}`)
	return f
}

func insertCard(t *testing.T, srv *api.Server, data string) int64 {
	t.Helper()
	var o card.InsertOutput
	decode(t, call(srv, sysCtx(), "card", "insert", data), &o)
	return o.ID
}

func sysCtx() context.Context { return auth.WithSystemUser(context.Background()) }

func call(srv *api.Server, ctx context.Context, endpoint, action, data string) api.SubResponse {
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
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
		t.Fatalf("marshal: %v", err)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		t.Fatalf("unmarshal %s: %v", raw, err)
	}
}

func wantCode(t *testing.T, sr api.SubResponse, code string) {
	t.Helper()
	if code == "" {
		if !sr.OK {
			t.Fatalf("want OK; got %+v", sr.Error)
		}
		return
	}
	if sr.OK {
		t.Fatalf("want %s; got OK", code)
	}
	if sr.Error == nil || sr.Error.Code != code {
		t.Fatalf("want code %s; got %+v", code, sr.Error)
	}
}

func setLink(t *testing.T, f fixture, data string) link.SetOutput {
	t.Helper()
	var o link.SetOutput
	decode(t, call(f.srv, sysCtx(), "link", "set", data), &o)
	return o
}

func listLinks(t *testing.T, f fixture, ctx context.Context, taskID int64) []link.Row {
	t.Helper()
	var o link.ListOutput
	decode(t, call(f.srv, ctx, "link", "list", fmt.Sprintf(`{"task_id":"%d"}`, taskID)), &o)
	return o.Rows
}

func countLinkCards(t *testing.T, f fixture, taskID int64) int {
	t.Helper()
	var n int
	if err := f.sp.P.QueryRow(context.Background(), `
		SELECT count(*) FROM card c JOIN card_type ct ON ct.id = c.card_type_id
		WHERE ct.name = 'link' AND c.parent_card_id = $1 AND c.deleted_at IS NULL
	`, taskID).Scan(&n); err != nil {
		t.Fatalf("count links: %v", err)
	}
	return n
}

func countLinkActivity(t *testing.T, f fixture, linkID int64) int {
	t.Helper()
	var n int
	if err := f.sp.P.QueryRow(context.Background(),
		`SELECT count(*) FROM activity WHERE card_id = $1`, linkID).Scan(&n); err != nil {
		t.Fatalf("count activity: %v", err)
	}
	return n
}

// TestLinkSet_Validation: malformed inputs and non-task targets are
// per-row rejections with a stable code.
func TestLinkSet_Validation(t *testing.T) {
	f := setup(t, "kitp_test_link_set_validation")
	rows := []struct {
		label string
		data  string
		code  string
	}{
		{"missing url", fmt.Sprintf(`{"task_id":"%d"}`, f.taskA), "validation"},
		{"blank url", fmt.Sprintf(`{"task_id":"%d","url":"   "}`, f.taskA), "validation"},
		{"relative url", fmt.Sprintf(`{"task_id":"%d","url":"/c/42"}`, f.taskA), "validation"},
		{"non-http scheme", fmt.Sprintf(`{"task_id":"%d","url":"javascript:alert(1)"}`, f.taskA), "validation"},
		{"url with space", fmt.Sprintf(`{"task_id":"%d","url":"https://x.test/a b"}`, f.taskA), "validation"},
		{"bad kind slug", fmt.Sprintf(`{"task_id":"%d","url":%q,"kind":"Gerrit CL"}`, f.taskA, clURL), "validation"},
		{"bad state slug", fmt.Sprintf(`{"task_id":"%d","url":%q,"state":"9merged"}`, f.taskA, clURL), "validation"},
		{"missing task", fmt.Sprintf(`{"url":%q}`, clURL), "validation"},
		{"unknown task", fmt.Sprintf(`{"task_id":"999999","url":%q}`, clURL), "task_not_found"},
		{"project is not a task", fmt.Sprintf(`{"task_id":"%d","url":%q}`, f.projectA, clURL), "wrong_card_type"},
		{"ok", fmt.Sprintf(`{"task_id":"%d","url":%q}`, f.taskA, clURL), ""},
	}
	for _, r := range rows {
		t.Run(r.label, func(t *testing.T) {
			wantCode(t, call(f.srv, sysCtx(), "link", "set", r.data), r.code)
		})
	}
}

// TestLinkSet_Idempotent: the URL is the link's identity on its task —
// repeats PATCH the one card, an unchanged repeat writes nothing, and a
// changed state writes exactly one activity row.
func TestLinkSet_Idempotent(t *testing.T) {
	f := setup(t, "kitp_test_link_set_idempotent")
	base := fmt.Sprintf(`"task_id":"%d","url":%q`, f.taskA, clURL)

	first := setLink(t, f, `{`+base+`,"title":"server: fix x","kind":"gerrit","state":"open"}`)
	if !first.Created || !first.Changed || first.LinkID == 0 {
		t.Fatalf("first set = %+v; want created+changed", first)
	}
	acts := countLinkActivity(t, f, first.LinkID)

	steps := []struct {
		label       string
		data        string
		wantChanged bool
		wantActs    int // new activity rows
	}{
		{"identical repeat", `{` + base + `,"title":"server: fix x","kind":"gerrit","state":"open"}`, false, 0},
		{"url only", `{` + base + `}`, false, 0},
		{"url padded", fmt.Sprintf(`{"task_id":"%d","url":"  %s  "}`, f.taskA, clURL), false, 0},
		{"state change", `{` + base + `,"state":"merged"}`, true, 1},
		{"state repeat", `{` + base + `,"state":"merged"}`, false, 0},
		{"state upper-case", `{` + base + `,"state":"MERGED"}`, false, 0},
	}
	for _, s := range steps {
		got := setLink(t, f, s.data)
		if got.LinkID != first.LinkID || got.Created {
			t.Fatalf("%s: got %+v; want the existing link %d", s.label, got, first.LinkID)
		}
		if got.Changed != s.wantChanged {
			t.Errorf("%s: changed=%v want %v", s.label, got.Changed, s.wantChanged)
		}
		now := countLinkActivity(t, f, first.LinkID)
		if now-acts != s.wantActs {
			t.Errorf("%s: %d new activity rows, want %d", s.label, now-acts, s.wantActs)
		}
		acts = now
	}
	if n := countLinkCards(t, f, f.taskA); n != 1 {
		t.Fatalf("%d link cards; want exactly 1", n)
	}
	rows := listLinks(t, f, sysCtx(), f.taskA)
	if len(rows) != 1 || rows[0].State != "merged" || rows[0].Kind != "gerrit" || rows[0].Title != "server: fix x" {
		t.Fatalf("list = %+v", rows)
	}
}

// TestLinkSet_Patch: absent fields stay, "" clears kind / state, a blank
// title is ignored, and a new link's title defaults to its url.
func TestLinkSet_Patch(t *testing.T) {
	f := setup(t, "kitp_test_link_set_patch")
	base := fmt.Sprintf(`"task_id":"%d","url":%q`, f.taskA, clURL)
	setLink(t, f, `{`+base+`}`)

	type want struct{ title, kind, state string }
	steps := []struct {
		label string
		data  string
		want  want
	}{
		{"defaults", `{` + base + `}`, want{clURL, "", ""}},
		{"set all", `{` + base + `,"title":"T","kind":"gerrit","state":"open"}`, want{"T", "gerrit", "open"}},
		{"absent keeps", `{` + base + `}`, want{"T", "gerrit", "open"}},
		{"null keeps", `{` + base + `,"title":null,"kind":null,"state":null}`, want{"T", "gerrit", "open"}},
		{"blank title ignored", `{` + base + `,"title":"  "}`, want{"T", "gerrit", "open"}},
		{"empty clears state", `{` + base + `,"state":""}`, want{"T", "gerrit", ""}},
		{"empty clears kind", `{` + base + `,"kind":""}`, want{"T", "", ""}},
		{"retitle", `{` + base + `,"title":"T2"}`, want{"T2", "", ""}},
	}
	for _, s := range steps {
		setLink(t, f, s.data)
		rows := listLinks(t, f, sysCtx(), f.taskA)
		if len(rows) != 1 {
			t.Fatalf("%s: %d rows", s.label, len(rows))
		}
		got := want{rows[0].Title, rows[0].Kind, rows[0].State}
		if got != s.want {
			t.Errorf("%s: got %+v want %+v", s.label, got, s.want)
		}
	}
}

// TestLinkSet_DistinctURLs: different URLs on one task, and the same URL
// on two tasks, are separate links.
func TestLinkSet_DistinctURLs(t *testing.T) {
	f := setup(t, "kitp_test_link_set_distinct")
	status := store.TemplateStatusID(t, f.sp.P, f.projectA, "Todo")
	task2 := insertCard(t, f.srv, fmt.Sprintf(
		`{"card_type_name":"task","parent_card_id":"%d","title":"task 2","attributes":{"status":"%d"}}`,
		f.projectA, status))
	for _, data := range []string{
		fmt.Sprintf(`{"task_id":"%d","url":%q}`, f.taskA, clURL),
		fmt.Sprintf(`{"task_id":"%d","url":%q}`, f.taskA, clURL+"/2"),
		fmt.Sprintf(`{"task_id":"%d","url":%q}`, task2, clURL),
	} {
		if o := setLink(t, f, data); !o.Created {
			t.Errorf("%s: want created", data)
		}
	}
	if n := countLinkCards(t, f, f.taskA); n != 2 {
		t.Errorf("task A: %d links want 2", n)
	}
	if n := countLinkCards(t, f, task2); n != 1 {
		t.Errorf("task 2: %d links want 1", n)
	}
}

// TestLinkSet_Concurrent: simultaneous first-time sets of one URL (a forge
// firing two events at once) still produce exactly one link — the
// advisory lock serialises the lookup-or-create.
func TestLinkSet_Concurrent(t *testing.T) {
	f := setup(t, "kitp_test_link_set_concurrent")
	const n = 8
	var wg sync.WaitGroup
	results := make([]api.SubResponse, n)
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i] = call(f.srv, sysCtx(), "link", "set", fmt.Sprintf(
				`{"task_id":"%d","url":%q,"state":"open"}`, f.taskA, clURL))
		}()
	}
	wg.Wait()
	created := 0
	for _, r := range results {
		var o link.SetOutput
		decode(t, r, &o)
		if o.Created {
			created++
		}
	}
	if created != 1 {
		t.Errorf("%d calls reported created; want 1", created)
	}
	if got := countLinkCards(t, f, f.taskA); got != 1 {
		t.Fatalf("%d link cards after %d concurrent sets; want 1", got, n)
	}
}

// TestLinkDelete: delete removes the link from the list; deleting is not
// sticky — linking the URL again creates a fresh link.
func TestLinkDelete(t *testing.T) {
	f := setup(t, "kitp_test_link_delete")
	first := setLink(t, f, fmt.Sprintf(`{"task_id":"%d","url":%q}`, f.taskA, clURL))

	rows := []struct {
		label string
		data  string
		code  string
	}{
		{"missing id", `{}`, "validation"},
		{"unknown id", `{"id":"999999"}`, "link_not_found"},
		{"not a link", fmt.Sprintf(`{"id":"%d"}`, f.taskA), "wrong_card_type"},
		{"ok", fmt.Sprintf(`{"id":"%d"}`, first.LinkID), ""},
		{"already deleted", fmt.Sprintf(`{"id":"%d"}`, first.LinkID), "link_not_found"},
	}
	for _, r := range rows {
		wantCode(t, call(f.srv, sysCtx(), "link", "delete", r.data), r.code)
	}
	if got := listLinks(t, f, sysCtx(), f.taskA); len(got) != 0 {
		t.Fatalf("list after delete = %+v", got)
	}
	again := setLink(t, f, fmt.Sprintf(`{"task_id":"%d","url":%q}`, f.taskA, clURL))
	if !again.Created || again.LinkID == first.LinkID {
		t.Fatalf("relink = %+v; want a fresh link", again)
	}
}

// mkUser creates a user holding `role` scoped to scopeCardID (0 = global)
// and returns its ctx.
func mkUser(t *testing.T, f fixture, name, role string, scopeCardID int64) context.Context {
	t.Helper()
	ctx := context.Background()
	var uid int64
	if err := f.sp.P.QueryRow(ctx,
		`INSERT INTO user_account (display_name) VALUES ($1) RETURNING id`, name).Scan(&uid); err != nil {
		t.Fatalf("%s user: %v", name, err)
	}
	var scope any
	if scopeCardID != 0 {
		scope = scopeCardID
	}
	if _, err := f.sp.P.Exec(ctx, `
		INSERT INTO user_role (user_id, role_id, scope_card_id)
		SELECT $1, id, $2 FROM role WHERE name = $3
	`, uid, scope, role); err != nil {
		t.Fatalf("%s grant: %v", name, err)
	}
	return auth.WithUser(ctx, &auth.UserCtx{ID: uid, DisplayName: name})
}

// TestLinkAuthz: writes gate on card.update of the parent task's project;
// reads apply the task's visibility.
func TestLinkAuthz(t *testing.T) {
	f := setup(t, "kitp_test_link_authz")
	existing := setLink(t, f, fmt.Sprintf(`{"task_id":"%d","url":%q}`, f.taskA, clURL+"/existing"))

	rows := []struct {
		label      string
		role       string
		scope      int64
		setCode    string
		deleteCode string
		visible    bool
	}{
		{"worker in project", "worker", f.projectA, "", "", true},
		{"global worker", "worker", 0, "", "", true},
		{"worker in other project", "worker", f.projectB, "unauthorized", "unauthorized", false},
		{"commenter in project", "commenter", f.projectA, "unauthorized", "unauthorized", true},
		{"viewer in project", "viewer", f.projectA, "unauthorized", "unauthorized", true},
	}
	for i, r := range rows {
		t.Run(r.label, func(t *testing.T) {
			ctx := mkUser(t, f, fmt.Sprintf("u%d", i), r.role, r.scope)
			url := fmt.Sprintf("%s/%d", clURL, i)
			wantCode(t, call(f.srv, ctx, "link", "set",
				fmt.Sprintf(`{"task_id":"%d","url":%q}`, f.taskA, url)), r.setCode)

			got := listLinks(t, f, ctx, f.taskA)
			if (len(got) > 0) != r.visible {
				t.Errorf("visible=%v; got %d rows", r.visible, len(got))
			}

			if r.deleteCode != "" {
				wantCode(t, call(f.srv, ctx, "link", "delete",
					fmt.Sprintf(`{"id":"%d"}`, existing.LinkID)), r.deleteCode)
			}
		})
	}
}

// TestLinkPollAndPurge: a forge moving a link writes activity the task's
// background poll counts, and task.purge takes the task's links with it.
func TestLinkPollAndPurge(t *testing.T) {
	f := setup(t, "kitp_test_link_poll_purge")
	var p0 activity.PollOutput
	decode(t, call(f.srv, sysCtx(), "activity", "poll", fmt.Sprintf(`{"task_id":"%d"}`, f.taskA)), &p0)

	setLink(t, f, fmt.Sprintf(`{"task_id":"%d","url":%q,"state":"merged"}`, f.taskA, clURL))
	var p1 activity.PollOutput
	decode(t, call(f.srv, sysCtx(), "activity", "poll", fmt.Sprintf(
		`{"task_id":"%d","since_activity_id":"%d"}`, f.taskA, p0.LatestActivityID)), &p1)
	if p1.NewCount == 0 || p1.LatestActivityID <= p0.LatestActivityID {
		t.Fatalf("poll after link = %+v (baseline %+v); want new activity", p1, p0)
	}

	wantCode(t, call(f.srv, sysCtx(), "task", "purge", fmt.Sprintf(`{"card_id":"%d"}`, f.taskA)), "")
	var n int
	if err := f.sp.P.QueryRow(context.Background(), `
		SELECT count(*) FROM card c JOIN card_type ct ON ct.id = c.card_type_id
		WHERE ct.name = 'link'`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Errorf("%d link cards survive task.purge; want 0", n)
	}
}

// TestLinkHook: POST /api/v1/links links one URL to every listed task,
// one result per distinct task, idempotent across repeats, with per-task
// failures that don't block the rest.
func TestLinkHook(t *testing.T) {
	f := setup(t, "kitp_test_link_hook")
	user, err := auth.NewSystemUser(context.Background(), f.sp.P, "dev", auth.ModeOff)
	if err != nil {
		t.Fatalf("system user: %v", err)
	}
	rt := api.NewTestRouter(user)
	link.Mount(rt, link.HTTPConfig{Dispatcher: f.srv})
	ts := httptest.NewServer(rt.Mux())
	t.Cleanup(ts.Close)

	post := func(body string) (int, link.HookOutput) {
		t.Helper()
		resp, err := http.Post(ts.URL+"/api/v1/links", "application/json", bytes.NewBufferString(body))
		if err != nil {
			t.Fatalf("post: %v", err)
		}
		defer resp.Body.Close()
		var out link.HookOutput
		if resp.StatusCode == http.StatusOK {
			if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
				t.Fatalf("decode: %v", err)
			}
		}
		return resp.StatusCode, out
	}

	body := fmt.Sprintf(`{"task_ids":["%d", %d, "%d", "999999"],"url":%q,"title":"fix x","kind":"gerrit","state":"open"}`,
		f.taskA, f.taskA, f.projectA, clURL)
	status, out := post(body)
	if status != http.StatusOK {
		t.Fatalf("status %d", status)
	}
	type res struct {
		ok      bool
		created bool
		code    string
	}
	want := []res{{true, true, ""}, {false, false, "wrong_card_type"}, {false, false, "task_not_found"}}
	if len(out.Results) != len(want) {
		t.Fatalf("results = %+v; want %d (duplicate task id collapsed)", out.Results, len(want))
	}
	for i, w := range want {
		r := out.Results[i]
		if (res{r.OK, r.Created, r.Code}) != w {
			t.Errorf("result %d = %+v; want %+v", i, r, w)
		}
	}

	// A repeat is a no-op on the existing link; a new state PATCHes it.
	_, again := post(fmt.Sprintf(`{"task_ids":["%d"],"url":%q,"title":"fix x","kind":"gerrit","state":"open"}`, f.taskA, clURL))
	if r := again.Results[0]; !r.OK || r.Created || r.Changed || r.LinkID != out.Results[0].LinkID {
		t.Errorf("repeat = %+v; want unchanged existing link", r)
	}
	_, merged := post(fmt.Sprintf(`{"task_ids":["%d"],"url":%q,"state":"merged"}`, f.taskA, clURL))
	if r := merged.Results[0]; !r.OK || r.Created || !r.Changed {
		t.Errorf("merge = %+v; want changed existing link", r)
	}
	if rows := listLinks(t, f, sysCtx(), f.taskA); len(rows) != 1 || rows[0].State != "merged" {
		t.Errorf("list = %+v", rows)
	}

	bad := []struct {
		label string
		body  string
	}{
		{"not json", `nope`},
		{"unknown field", fmt.Sprintf(`{"task_ids":["%d"],"url":%q,"bogus":1}`, f.taskA, clURL)},
		{"no tasks", fmt.Sprintf(`{"task_ids":[],"url":%q}`, clURL)},
		{"no url", fmt.Sprintf(`{"task_ids":["%d"]}`, f.taskA)},
	}
	for _, b := range bad {
		if status, _ := post(b.body); status != http.StatusBadRequest {
			t.Errorf("%s: status %d want 400", b.label, status)
		}
	}
}

// TestLinkHook_WorkspaceLinksToken is the forge setup end to end: an
// admin creates a WORKSPACE agent (owned by System), grants it worker
// and mints a LINKS-ONLY token. Through the real token manager + router
// the token links a change on POST /api/v1/links, is refused on a
// full-access bearer route (stands in for MCP), and keeps working after
// the admin who set it up is deleted — staff turnover doesn't break it.
func TestLinkHook_WorkspaceLinksToken(t *testing.T) {
	f := setup(t, "kitp_test_link_hook_workspace_token")
	agent.Register(f.sp)
	userrole.Register(f.sp)
	usertoken.Register(f.sp)
	ctx := context.Background()

	var adminID int64
	if err := f.sp.P.QueryRow(ctx,
		`INSERT INTO user_account (display_name) VALUES ('Departing Admin') RETURNING id`).Scan(&adminID); err != nil {
		t.Fatalf("admin: %v", err)
	}
	// admin + worker: an agent's roles are the literal intersection with
	// its owner's, so a personal worker agent needs an owner holding worker.
	if _, err := f.sp.P.Exec(ctx,
		`INSERT INTO user_role (user_id, role_id) SELECT $1, id FROM role WHERE name IN ('admin', 'worker')`, adminID); err != nil {
		t.Fatalf("admin grant: %v", err)
	}
	adminCtx := auth.WithUser(ctx, &auth.UserCtx{ID: adminID, DisplayName: "Departing Admin"})

	var created struct {
		UserID int64 `json:"user_id,string"`
	}
	decode(t, call(f.srv, adminCtx, "agent", "create", `{"display_name":"Gerrit","owner":"system"}`), &created)
	wantCode(t, call(f.srv, adminCtx, "user_role", "set",
		fmt.Sprintf(`{"user_id":"%d","role_name":"worker"}`, created.UserID)), "")
	type mintOut struct {
		Token string `json:"token"`
		Scope string `json:"scope"`
	}
	var minted mintOut
	decode(t, call(f.srv, adminCtx, "user_token", "create",
		fmt.Sprintf(`{"user_id":"%d","label":"gerrit","scope":"links"}`, created.UserID)), &minted)
	if minted.Scope != auth.TokenScopeLinks || minted.Token == "" {
		t.Fatalf("minted = %+v", minted)
	}

	// Contrast: the same setup as the admin's PERSONAL agent.
	var personal struct {
		UserID int64 `json:"user_id,string"`
	}
	decode(t, call(f.srv, adminCtx, "agent", "create", `{"display_name":"Personal forge"}`), &personal)
	wantCode(t, call(f.srv, adminCtx, "user_role", "set",
		fmt.Sprintf(`{"user_id":"%d","role_name":"worker"}`, personal.UserID)), "")
	var personalTok mintOut
	decode(t, call(f.srv, adminCtx, "user_token", "create",
		fmt.Sprintf(`{"user_id":"%d","label":"forge","scope":"links"}`, personal.UserID)), &personalTok)

	mgr := token.New(f.sp.P, token.Config{})
	rt := api.NewRouter(api.RouterConfig{
		SessionResolver: func(*http.Request) (*auth.UserCtx, error) { return nil, nil },
		BearerResolver: func(r *http.Request) (*auth.UserCtx, error) {
			tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			if tok == "" {
				return nil, nil
			}
			u, err := mgr.Lookup(r.Context(), tok)
			if err != nil {
				return nil, err
			}
			return &auth.UserCtx{ID: u.ID, DisplayName: u.DisplayName, TokenScope: u.Scope}, nil
		},
	})
	link.Mount(rt, link.HTTPConfig{Dispatcher: f.srv})
	rt.Bearer("POST /api/v1/full", func(_ context.Context, w http.ResponseWriter, _ *http.Request, _ *auth.UserCtx) error {
		w.WriteHeader(http.StatusNoContent)
		return nil
	})
	ts := httptest.NewServer(rt.Mux())
	t.Cleanup(ts.Close)

	postAs := func(bearer, path, body string) (int, link.HookOutput) {
		t.Helper()
		req, err := http.NewRequest(http.MethodPost, ts.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		req.Header.Set("Authorization", "Bearer "+bearer)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("post: %v", err)
		}
		defer resp.Body.Close()
		var out link.HookOutput
		if resp.StatusCode == http.StatusOK {
			if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
				t.Fatalf("decode: %v", err)
			}
		}
		return resp.StatusCode, out
	}
	post := func(path, body string) (int, link.HookOutput) {
		t.Helper()
		return postAs(minted.Token, path, body)
	}

	hook := func(state string) string {
		return fmt.Sprintf(`{"task_ids":["%d"],"url":%q,"kind":"gerrit","state":%q}`, f.taskA, clURL, state)
	}
	if status, out := post("/api/v1/links", hook("open")); status != http.StatusOK || !out.Results[0].OK || !out.Results[0].Created {
		t.Fatalf("links token on the hook: status %d %+v", status, out)
	}
	if status, _ := post("/api/v1/full", `{}`); status != http.StatusForbidden {
		t.Errorf("links token on a full-access route: status %d, want 403", status)
	}

	if status, out := postAs(personalTok.Token, "/api/v1/links", hook("open")); status != http.StatusOK || !out.Results[0].OK {
		t.Fatalf("personal agent before offboarding: status %d %+v", status, out)
	}

	// Staff turnover: the admin who set the forge up is offboarded — their
	// grants are revoked (as an OIDC reconcile would).
	if _, err := f.sp.P.Exec(ctx, `DELETE FROM user_role WHERE user_id = $1`, adminID); err != nil {
		t.Fatalf("revoke admin: %v", err)
	}
	// The personal agent's power is capped by its owner's roles, so it
	// stops working; the workspace agent's owner is System, so it doesn't.
	if status, out := postAs(personalTok.Token, "/api/v1/links", hook("open")); status != http.StatusOK || out.Results[0].OK {
		t.Errorf("personal agent after offboarding: status %d %+v; want a per-task refusal", status, out)
	}
	if status, out := post("/api/v1/links", hook("reviewed")); status != http.StatusOK || !out.Results[0].OK || !out.Results[0].Changed {
		t.Fatalf("workspace agent after the admin lost their roles: status %d %+v", status, out)
	}
	// ...and their account is deleted outright (after clearing the
	// personal agent's grants, which don't cascade): the personal agent is
	// cascade-deleted with it; the workspace agent is untouched.
	if _, err := f.sp.P.Exec(ctx, `DELETE FROM user_role WHERE user_id = $1`, personal.UserID); err != nil {
		t.Fatalf("clear personal agent grants: %v", err)
	}
	if _, err := f.sp.P.Exec(ctx, `DELETE FROM user_account WHERE id = $1`, adminID); err != nil {
		t.Fatalf("delete admin: %v", err)
	}
	var personalLeft int
	if err := f.sp.P.QueryRow(ctx, `SELECT count(*) FROM user_account WHERE id = $1`, personal.UserID).Scan(&personalLeft); err != nil {
		t.Fatalf("count: %v", err)
	}
	if personalLeft != 0 {
		t.Errorf("personal agent survived its owner's deletion")
	}
	if status, out := post("/api/v1/links", hook("merged")); status != http.StatusOK || !out.Results[0].OK || !out.Results[0].Changed {
		t.Fatalf("after the admin was deleted: status %d %+v", status, out)
	}
	rows := listLinks(t, f, sysCtx(), f.taskA)
	if len(rows) != 1 || rows[0].State != "merged" || rows[0].CreatedBy != "Gerrit" {
		t.Errorf("links = %+v", rows)
	}
}
