package attribute_test

// Strict dates (docs/MAIL_INTAKE_AND_CALENDARS.md §1): every date that
// enters kitp is YYYY-MM-DD (a real day), every timestamp RFC 3339.

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/activity"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/comm"
	"github.com/kitp/kitp/server/internal/dom/usertoken"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

func dateServer(t *testing.T) *api.Server {
	t.Helper()
	reg.Reset()
	sp := store.NewPool(store.TestPool(t, "kitp_test_strict_dates"))
	cardtype.Register()
	card.Register(sp)
	attribute.Register(sp)
	activity.Register(sp)
	comm.Register(sp)
	usertoken.Register(sp)
	return api.NewServer(sp)
}

func call(t *testing.T, srv *api.Server, endpoint, action string, data any) api.SubResponse {
	t.Helper()
	b, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	return srv.Dispatch(auth.WithSystemUser(context.Background()), api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "x", Endpoint: endpoint, Action: action, Data: b},
	}}).Subresponses[0]
}

func insertID(t *testing.T, r api.SubResponse) int64 {
	t.Helper()
	if !r.OK {
		t.Fatalf("insert: %+v", r.Error)
	}
	b, _ := json.Marshal(r.Data)
	var out card.InsertOutput
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out.ID
}

func TestDatesAreCheckedOnTheWayIn(t *testing.T) {
	srv := dateServer(t)
	project := insertID(t, call(t, srv, "card", "insert", map[string]any{"card_type_name": "project", "title": "Dates"}))
	task := insertID(t, call(t, srv, "card", "insert", map[string]any{
		"card_type_name": "task", "parent_card_id": fmt.Sprint(project), "title": "T",
		"attributes": map[string]any{"due_date": "2026-11-03"},
	}))

	type check struct {
		name             string
		endpoint, action string
		data             any
		ok               bool
	}
	update := func(v any) map[string]any {
		return map[string]any{"card_id": fmt.Sprint(task), "attribute_name": "due_date", "value": v}
	}
	newTask := func(v any) map[string]any {
		return map[string]any{"card_type_name": "task", "parent_card_id": fmt.Sprint(project), "title": "N",
			"attributes": map[string]any{"due_date": v}}
	}
	for _, c := range []check{
		{"update: a date", "attribute", "update", update("2026-12-01"), true},
		{"update: a timestamp", "attribute", "update", update("2026-12-01T10:00:00Z"), false},
		{"update: not a real day", "attribute", "update", update("2026-02-30"), false},
		{"update: a postgres keyword", "attribute", "update", update("today"), false},
		{"update: a number", "attribute", "update", update(20261201), false},
		{"update: removal", "attribute", "update", update(nil), true},
		{"insert: a date", "card", "insert", newTask("2026-12-02"), true},
		{"insert: words", "card", "insert", newTask("Dec 2"), false},
		{"activity: from_date", "activity", "select", map[string]any{"card_id": fmt.Sprint(task), "from_date": "2026-11-01"}, true},
		{"activity: from_date keyword", "activity", "select", map[string]any{"card_id": fmt.Sprint(task), "from_date": "yesterday"}, false},
		{"activity: to_date slashes", "activity", "select", map[string]any{"card_id": fmt.Sprint(task), "to_date": "11/03/2026"}, false},
		{"comm log: since", "comm_log", "list", map[string]any{"project_id": fmt.Sprint(project), "since": "2026-11-01T00:00:00Z"}, true},
		{"comm log: since keyword", "comm_log", "list", map[string]any{"project_id": fmt.Sprint(project), "since": "now"}, false},
		{"comm log: since date only", "comm_log", "list", map[string]any{"project_id": fmt.Sprint(project), "since": "2026-11-01"}, false},
		{"token: expires infinity", "user_token", "create", map[string]any{"user_id": "1", "label": "inf", "expires_at": "infinity"}, false},
		{"filter: a date", "card", "select_with_attributes", map[string]any{"card_type_name": "task",
			"tree": map[string]any{"connective": "and", "children": []any{map[string]any{"attr": "due_date", "op": "eq", "values": []any{"2026-12-02"}}}}}, true},
		{"filter: not a date", "card", "select_with_attributes", map[string]any{"card_type_name": "task",
			"tree": map[string]any{"connective": "and", "children": []any{map[string]any{"attr": "due_date", "op": "in", "values": []any{"soon"}}}}}, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			r := call(t, srv, c.endpoint, c.action, c.data)
			if r.OK != c.ok {
				t.Fatalf("ok = %v, want %v: %+v", r.OK, c.ok, r.Error)
			}
			if !c.ok && c.name != "filter: not a date" && (r.Error == nil || r.Error.Code != "validation") {
				t.Errorf("refused with %+v, want validation", r.Error)
			}
			if !c.ok && r.Error != nil && !strings.Contains(r.Error.Message, "date") && !strings.Contains(r.Error.Message, "RFC 3339") && !strings.Contains(r.Error.Message, "expires_at") {
				t.Errorf("message doesn't say what's wrong: %q", r.Error.Message)
			}
		})
	}
}

// TestSQLFilterCompilerChecksDates: card_compile_predicate (the SQL twin of
// card.CompileTree) refuses a non-date value against a date attribute.
func TestSQLFilterCompilerChecksDates(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_strict_dates_sql")
	ctx := context.Background()
	compile := func(v string) error {
		var out string
		return pool.QueryRow(ctx, `SELECT card_compile_predicate(jsonb_build_object('attr','due_date','op','eq','values',jsonb_build_array($1::text)), '[]'::jsonb, ARRAY[]::bigint[])::text`, v).Scan(&out)
	}
	if err := compile("2026-11-03"); err != nil {
		t.Errorf("a date: %v", err)
	}
	if err := compile("next week"); err == nil || !strings.Contains(err.Error(), "not a date") {
		t.Errorf("not a date: %v", err)
	}
}
