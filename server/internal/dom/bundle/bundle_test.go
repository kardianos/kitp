package bundle_test

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/bundle"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

type fixture struct {
	srv *api.Server
	sp  *store.Pool
}

func setup(t *testing.T, schemaName string) fixture {
	t.Helper()
	reg.Reset()
	pool := store.TestPool(t, schemaName)
	sp := store.NewPool(pool)
	cardtype.Register()
	card.Register(sp)
	attribute.Register(sp)
	bundle.Register(sp)
	return fixture{srv: api.NewServer(sp), sp: sp}
}

func sysCtx() context.Context { return auth.WithSystemUser(context.Background()) }

func call(f fixture, endpoint, action, data string) api.SubResponse {
	resp := f.srv.Dispatch(sysCtx(), api.BatchRequest{Subrequests: []api.SubRequest{
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
	if sr.OK {
		t.Fatalf("want %s; got OK", code)
	}
	if sr.Error == nil || sr.Error.Code != code {
		t.Fatalf("want code %s; got %+v", code, sr.Error)
	}
}

func compose(t *testing.T, f fixture, data string) bundle.ComposeOutput {
	t.Helper()
	var o bundle.ComposeOutput
	decode(t, call(f, "project", "compose", data), &o)
	return o
}

func apply(t *testing.T, f fixture, project int64, keys ...string) bundle.ApplyOutput {
	t.Helper()
	q, _ := json.Marshal(keys)
	var o bundle.ApplyOutput
	decode(t, call(f, "bundle", "apply", fmt.Sprintf(`{"project_id":"%d","keys":%s}`, project, q)), &o)
	return o
}

// titles lists the titles of a project's live children of one card type,
// sorted.
func titles(t *testing.T, f fixture, project int64, cardType string) []string {
	t.Helper()
	rows, err := f.sp.P.Query(context.Background(), `
		SELECT av.value #>> '{}'
		FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = $2
		JOIN attribute_value av ON av.card_id = c.id
		JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'title'
		WHERE card_enclosing_project(c.id) = $1 AND c.deleted_at IS NULL
		ORDER BY 1`, project, cardType)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			t.Fatal(err)
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func scalar[T any](t *testing.T, f fixture, query string, args ...any) T {
	t.Helper()
	var v T
	if err := f.sp.P.QueryRow(context.Background(), query, args...).Scan(&v); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
	return v
}

// TestComposeContentPreset composes a project from the content preset
// (tracker + publishing) and checks the copy landed wired to the NEW
// project: its own flows, screens and statuses, starter pages whose
// publish_status and parent point at the project's copies, and an origin
// row per copied card.
func TestComposeContentPreset(t *testing.T) {
	f := setup(t, "kitp_test_bundle_compose")
	out := compose(t, f, `{"name":"Docs","preset":"content"}`)
	if got := strings.Join(out.Features, ","); got != "tracker,publishing" {
		t.Fatalf("features = %s", got)
	}
	p := out.NewProjectID

	screens := strings.Join(titles(t, f, p, "screen"), ",")
	if screens != "Grid,Inbox,Incoming,Kanban,Pages,Project,Recently Closed" {
		t.Errorf("screens = %s", screens)
	}
	if got := strings.Join(titles(t, f, p, "page"), ","); got != "Getting started,Home" {
		t.Errorf("pages = %s", got)
	}
	flows := scalar[string](t, f, `
		SELECT string_agg(ad.name, ',' ORDER BY ad.name)
		FROM flow fl JOIN attribute_def ad ON ad.id = fl.attribute_def_id
		WHERE fl.scope_card_id = $1`, p)
	if flows != "publish_status,status" {
		t.Errorf("flows = %s", flows)
	}
	// The starter pages point at the project's own Draft and at each other.
	bad := scalar[int64](t, f, `
		SELECT count(*)
		FROM card pg
		JOIN card_type ct ON ct.id = pg.card_type_id AND ct.name = 'page'
		JOIN attribute_value av ON av.card_id = pg.id
		JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'publish_status'
		WHERE card_enclosing_project(pg.id) = $1
		  AND card_enclosing_project((av.value #>> '{}')::bigint) IS DISTINCT FROM $1`, p)
	if bad != 0 {
		t.Errorf("%d pages point at another project's status", bad)
	}
	parent := scalar[string](t, f, `
		SELECT pv.value #>> '{}'
		FROM card c
		JOIN attribute_value cv ON cv.card_id = c.id AND cv.value = to_jsonb('Getting started'::text)
		JOIN card par ON par.id = c.parent_card_id
		JOIN attribute_value pv ON pv.card_id = par.id
		JOIN attribute_def pd ON pd.id = pv.attribute_def_id AND pd.name = 'title'
		WHERE card_enclosing_project(c.id) = $1`, p)
	if parent != "Home" {
		t.Errorf("Getting started's parent = %q, want Home", parent)
	}
	origins := scalar[string](t, f, `
		SELECT string_agg(bundle_key || '=' || n, ',' ORDER BY bundle_key)
		FROM (SELECT bundle_key, count(*)::text AS n FROM card_origin WHERE project_id = $1 GROUP BY 1) x`, p)
	// tracker: 6 statuses + 6 screens + 1 view + 3 snippets; publishing: 4
	// statuses + Pages screen + 2 pages.
	if origins != "publishing=7,tracker=16" {
		t.Errorf("origins = %s", origins)
	}
	// is_template=false, so the new project is a real, listed project.
	if tmpl := scalar[bool](t, f, `
		SELECT av.value = to_jsonb(true)
		FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'is_template'
		WHERE av.card_id = $1`, p); tmpl {
		t.Error("composed project is flagged is_template")
	}
}

// TestApplyReapplyKeepsUserEdits re-applies a feature after the user has
// renamed one of its cards and deleted another: the rename survives, the
// deleted card stays deleted, and nothing is duplicated.
func TestApplyReapplyKeepsUserEdits(t *testing.T) {
	f := setup(t, "kitp_test_bundle_reapply")
	p := compose(t, f, `{"name":"Docs","features":["publishing"]}`).NewProjectID

	screen := scalar[int64](t, f, `
		SELECT c.id FROM card c JOIN card_origin co ON co.card_id = c.id
		WHERE co.project_id = $1 AND co.item_key = 'screen:Pages'`, p)
	var upd attribute.UpdateOutput
	decode(t, call(f, "attribute", "update",
		fmt.Sprintf(`{"card_id":"%d","attribute_name":"title","value":"Site pages"}`, screen)), &upd)
	gs := scalar[int64](t, f, `
		SELECT c.id FROM card c JOIN card_origin co ON co.card_id = c.id
		WHERE co.project_id = $1 AND co.item_key = 'page:Home/page:Getting started'`, p)
	if sr := call(f, "card", "delete", fmt.Sprintf(`{"card_id":"%d"}`, gs)); !sr.OK {
		t.Fatalf("delete page: %+v", sr.Error)
	}

	res := apply(t, f, p, "publishing").Results
	if len(res) != 1 || res[0].Status != "updated" || res[0].Copied != 0 || res[0].Existing != 7 {
		t.Fatalf("re-apply = %+v, want updated / copied 0 / existing 7", res)
	}
	if got := strings.Join(titles(t, f, p, "screen"), ","); got != "Site pages" {
		t.Errorf("screens after re-apply = %s, want the user's rename kept", got)
	}
	if got := strings.Join(titles(t, f, p, "page"), ","); got != "Home" {
		t.Errorf("pages after re-apply = %s, want the deleted page to stay deleted", got)
	}
	if n := scalar[int64](t, f, `SELECT count(*) FROM flow WHERE scope_card_id = $1`, p); n != 1 {
		t.Errorf("flows after re-apply = %d, want 1", n)
	}
}

// TestApplyToStampedProject adds features to a project stamped from the
// install's Standard Project Template (task + comm flows): publishing adds
// cleanly; conversations is refused because the project already has a
// comm flow; bundle.list reports both facts.
func TestApplyToStampedProject(t *testing.T) {
	f := setup(t, "kitp_test_bundle_stamped")
	var ins card.InsertOutput
	decode(t, call(f, "card", "insert", `{"card_type_name":"project","title":"Legacy"}`), &ins)
	p := ins.ID

	res := apply(t, f, p, "publishing").Results
	if len(res) != 1 || res[0].Status != "applied" || res[0].Copied != 7 {
		t.Fatalf("apply publishing = %+v", res)
	}
	sr := call(f, "bundle", "apply", fmt.Sprintf(`{"project_id":"%d","keys":["conversations"]}`, p))
	wantCode(t, sr, "bundle_conflict")
	if !strings.Contains(sr.Error.Message, "comm_status") {
		t.Errorf("conflict message %q doesn't name the attribute", sr.Error.Message)
	}

	var list bundle.ListOutput
	decode(t, call(f, "bundle", "list", fmt.Sprintf(`{"project_id":"%d"}`, p)), &list)
	got := map[string]bundle.Feature{}
	for _, ft := range list.Features {
		got[ft.Key] = ft
	}
	if !got["publishing"].Enabled || got["publishing"].Conflict != "" {
		t.Errorf("publishing = %+v, want enabled", got["publishing"])
	}
	if got["conversations"].Enabled || got["conversations"].Conflict == "" {
		t.Errorf("conversations = %+v, want a conflict", got["conversations"])
	}
	// The template's task flow isn't a tracker origin, so tracker reads as
	// conflicting too (the project already drives `status`).
	if got["tracker"].Enabled || got["tracker"].Conflict == "" {
		t.Errorf("tracker = %+v, want a conflict", got["tracker"])
	}
	var keys []string
	for _, p := range list.Presets {
		keys = append(keys, p.Key)
	}
	sort.Strings(keys)
	if strings.Join(keys, ",") != "content,help_desk,issue_tracker,shared_inbox" {
		t.Errorf("presets = %v", keys)
	}
}

// TestComposeRejects is the validation table for project.compose; every
// rejected row must leave no project behind.
func TestComposeRejects(t *testing.T) {
	f := setup(t, "kitp_test_bundle_reject")
	before := scalar[int64](t, f, `SELECT count(*) FROM card WHERE card_type_id = (SELECT id FROM card_type WHERE name = 'project')`)
	cases := []struct {
		name, data, code string
	}{
		{"no name", `{"preset":"content"}`, "validation"},
		{"nothing to compose", `{"name":"X"}`, "validation"},
		{"unknown preset", `{"name":"X","preset":"nope"}`, "bundle_unknown"},
		{"unknown feature", `{"name":"X","features":["tracker","nope"]}`, "bundle_unknown"},
		{"two comm flows", `{"name":"X","preset":"help_desk","features":["conversations"]}`, ""},
		// Task tracking and Help desk are two starting points of Tasks: both
		// drive status, so a project can only start from one.
		{"two task flows", `{"name":"X","features":["tracker","helpdesk"]}`, "bundle_conflict"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			sr := call(f, "project", "compose", c.data)
			if c.code == "" {
				// A duplicate feature collapses rather than conflicting.
				var o bundle.ComposeOutput
				decode(t, sr, &o)
				if got := strings.Join(o.Features, ","); got != "helpdesk,conversations" {
					t.Fatalf("features = %s", got)
				}
				return
			}
			wantCode(t, sr, c.code)
		})
	}
	after := scalar[int64](t, f, `SELECT count(*) FROM card WHERE card_type_id = (SELECT id FROM card_type WHERE name = 'project')`)
	if after != before+1 {
		t.Errorf("projects %d → %d, want exactly one (the valid compose)", before, after)
	}
}
