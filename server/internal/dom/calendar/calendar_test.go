package calendar_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/calendar"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

var today = time.Date(2026, 11, 3, 15, 0, 0, 0, time.UTC)

type fixture struct {
	srv     *api.Server
	sp      *store.Pool
	h       http.Handler
	project int64
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
	if project != 0 {
		if _, err := sp.P.Exec(ctx, `INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT $1, id, $2 FROM role WHERE name = 'worker'`, uid, project); err != nil {
			t.Fatal(err)
		}
	}
	return auth.WithUser(ctx, &auth.UserCtx{ID: uid, DisplayName: name}), pid
}

func setup(t *testing.T, schema string) *fixture {
	t.Helper()
	reg.Reset()
	sp := store.NewPool(store.TestPool(t, schema))
	cardtype.Register()
	card.Register(sp)
	attribute.Register(sp)
	calendar.Register(sp)
	f := &fixture{srv: api.NewServer(sp), sp: sp}
	sys := auth.WithSystemUser(context.Background())
	var p card.InsertOutput
	into(t, call(t, f.srv, sys, "card", "insert", map[string]any{"card_type_name": "project", "title": "Launch"}), &p)
	f.project = p.ID
	f.ada, f.adaPID = person(t, sp, "ada", p.ID)
	f.bob, _ = person(t, sp, "bob", p.ID)
	rt := api.NewRouter(api.RouterConfig{})
	calendar.Mount(rt, calendar.FeedConfig{Pool: sp, PublicURL: "https://kitp.example", Now: func() time.Time { return today }})
	f.h = rt.Mux()
	return f
}

func (f *fixture) task(t *testing.T, project int64, title, due string, attrs map[string]any) int64 {
	t.Helper()
	a := map[string]any{"due_date": due}
	for k, v := range attrs {
		a[k] = v
	}
	var out card.InsertOutput
	into(t, call(t, f.srv, auth.WithSystemUser(context.Background()), "card", "insert", map[string]any{
		"card_type_name": "task", "parent_card_id": fmt.Sprint(project), "title": title, "attributes": a,
	}), &out)
	return out.ID
}

func (f *fixture) fetch(t *testing.T, token string) (int, string) {
	t.Helper()
	req := httptest.NewRequest("GET", calendar.FeedPathPrefix+token+".ics", nil)
	req.Header.Set("User-Agent", "Google-Calendar-Importer")
	rr := httptest.NewRecorder()
	f.h.ServeHTTP(rr, req)
	return rr.Code, rr.Body.String()
}

func TestCalendarFeed(t *testing.T) {
	f := setup(t, "kitp_test_calendar_feed")
	done := store.TemplateStatusID(t, f.sp.P, f.project, "Done")
	soon := f.task(t, f.project, "Ship it, finally; really", "2026-11-10", nil)
	past := f.task(t, f.project, "Last week", "2026-10-28", map[string]any{"status": fmt.Sprint(done)})
	mine := f.task(t, f.project, "Mine", "2026-11-20", map[string]any{"assignee": fmt.Sprint(f.adaPID)})
	tooFar := f.task(t, f.project, "Next decade", "2036-01-01", nil)
	tooOld := f.task(t, f.project, "Ages ago", "2026-01-01", nil)
	var other card.InsertOutput
	into(t, call(t, f.srv, auth.WithSystemUser(context.Background()), "card", "insert", map[string]any{"card_type_name": "project", "title": "Secret"}), &other)
	hidden := f.task(t, other.ID, "Not ada's project", "2026-11-12", nil)

	var cal calendar.IDOutput
	into(t, call(t, f.srv, f.ada, "calendar", "set", map[string]any{"title": "Ada's work"}), &cal)
	var u calendar.URLCreateOutput
	into(t, call(t, f.srv, f.ada, "calendar_url", "create", map[string]any{"calendar_id": fmt.Sprint(cal.ID), "comment": "phone"}), &u)

	code, body := f.fetch(t, u.Token)
	if code != 200 || !strings.HasPrefix(body, "BEGIN:VCALENDAR\r\n") {
		t.Fatalf("feed: %d %q", code, body)
	}
	has := func(id int64) bool { return strings.Contains(body, fmt.Sprintf("UID:task-%d@", id)) }
	for _, id := range []int64{soon, past, mine} {
		if !has(id) {
			t.Errorf("task %d (in the window) missing", id)
		}
	}
	for _, id := range []int64{tooFar, tooOld, hidden} {
		if has(id) {
			t.Errorf("task %d shouldn't be in the feed", id)
		}
	}
	for _, want := range []string{
		"X-WR-CALNAME:Ada's work",
		"DTSTART;VALUE=DATE:20261110",
		"DTEND;VALUE=DATE:20261111",
		fmt.Sprintf(`SUMMARY:#%d Ship it\, finally\; really`, soon),
		fmt.Sprintf("SUMMARY:✓ #%d Last week", past),
		fmt.Sprintf("URL:https://kitp.example/task/%d", soon),
		"TRANSP:TRANSPARENT",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("feed lacks %q", want)
		}
	}
	for _, line := range strings.Split(body, "\r\n") {
		if len(line) > 75 {
			t.Errorf("unfolded line (%d octets): %q", len(line), line)
		}
	}

	// A filter with @me, and a narrower window.
	into(t, call(t, f.srv, f.ada, "calendar", "set", map[string]any{"id": fmt.Sprint(cal.ID),
		"predicate": `{"connective":"and","children":[{"attr":"assignee","op":"eq","values":["@me"]}]}`}), &cal)
	if _, body = f.fetch(t, u.Token); !has(mine) || has(soon) {
		t.Errorf("assigned to @me: mine %v soon %v", has(mine), has(soon))
	}
	into(t, call(t, f.srv, f.ada, "calendar", "set", map[string]any{"id": fmt.Sprint(cal.ID), "predicate": "", "past_days": 0}), &cal)
	if _, body = f.fetch(t, u.Token); has(past) || !has(soon) {
		t.Errorf("past_days 0: past %v soon %v", has(past), has(soon))
	}

	var list calendar.ListOutput
	into(t, call(t, f.srv, f.ada, "calendar", "list", map[string]any{}), &list)
	if len(list.Calendars) != 1 || len(list.Calendars[0].URLs) != 1 || list.Calendars[0].URLs[0].LastClient != "Google-Calendar-Importer" || list.Calendars[0].URLs[0].LastUsedAt == "" {
		t.Errorf("list = %+v", list)
	}
	if strings.Contains(fmt.Sprint(list), u.Token) {
		t.Error("calendar.list shows the token")
	}

	// Someone else can't touch it.
	if r := call(t, f.srv, f.bob, "calendar", "set", map[string]any{"id": fmt.Sprint(cal.ID), "title": "mine now"}); r.OK {
		t.Error("bob renamed ada's calendar")
	}
	if r := call(t, f.srv, f.bob, "calendar_url", "create", map[string]any{"calendar_id": fmt.Sprint(cal.ID)}); r.OK {
		t.Error("bob added a URL to ada's calendar")
	}
	if r := call(t, f.srv, f.bob, "calendar_url", "delete", map[string]any{"id": fmt.Sprint(u.ID)}); r.OK {
		t.Error("bob revoked ada's URL")
	}

	if code, _ := f.fetch(t, strings.Repeat("a", 40)); code != 404 {
		t.Errorf("unknown token: %d", code)
	}
	into(t, call(t, f.srv, f.ada, "calendar_url", "delete", map[string]any{"id": fmt.Sprint(u.ID)}), &cal)
	if code, _ := f.fetch(t, u.Token); code != 404 {
		t.Errorf("a revoked URL: %d", code)
	}
	var u2 calendar.URLCreateOutput
	into(t, call(t, f.srv, f.ada, "calendar_url", "create", map[string]any{"calendar_id": fmt.Sprint(list.Calendars[0].ID)}), &u2)
	into(t, call(t, f.srv, f.ada, "calendar", "delete", map[string]any{"id": fmt.Sprint(list.Calendars[0].ID)}), &cal)
	if code, _ := f.fetch(t, u2.Token); code != 404 {
		t.Errorf("a deleted calendar's URL: %d", code)
	}
}

func TestCalendarValidation(t *testing.T) {
	f := setup(t, "kitp_test_calendar_validation")
	for _, in := range []map[string]any{
		{"title": ""},
		{"title": "x", "past_days": 4000},
		{"title": "x", "future_days": -1},
		{"title": "x", "predicate": "not json"},
		{"title": "x", "predicate": `{"connective":"and","children":[{"attr":"due_date","op":"eq","values":["soon"]}]}`},
	} {
		if r := call(t, f.srv, f.ada, "calendar", "set", in); r.OK {
			t.Errorf("calendar.set %v accepted", in)
		}
	}
}

// TestCalendarRangeUsesTheIndex: the due-date range the feed runs is an
// index scan on attribute_value_def_value (with sequential scans off, so a
// tiny test table can't make the planner prefer one).
func TestCalendarRangeUsesTheIndex(t *testing.T) {
	f := setup(t, "kitp_test_calendar_index")
	f.task(t, f.project, "One", "2026-11-10", nil)
	ctx := context.Background()
	tx, err := f.sp.P.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SET LOCAL enable_seqscan = off`); err != nil {
		t.Fatal(err)
	}
	rows, err := tx.Query(ctx, `EXPLAIN SELECT av.card_id FROM attribute_value av
		WHERE av.attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'due_date')
		  AND av.value_type_id < 50
		  AND av.value >= to_jsonb('2026-10-01'::text) AND av.value <= to_jsonb('2027-11-03'::text)`)
	if err != nil {
		t.Fatal(err)
	}
	var plan []string
	for rows.Next() {
		var line string
		_ = rows.Scan(&line)
		plan = append(plan, line)
	}
	rows.Close()
	if !strings.Contains(strings.Join(plan, "\n"), "attribute_value_def_value") {
		t.Errorf("the range doesn't use attribute_value_def_value:\n%s", strings.Join(plan, "\n"))
	}
}
