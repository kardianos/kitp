// activity_feed_test.go: what the project Activity page reads — rows that
// carry names and titles instead of bare ids (agents named with their
// owner), the actor / kind / card-type / text filters, and the facets.
// Runs through the dispatcher so the Go Row / Facets types must carry
// every field the SQL emits.
package activity_test

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/activity"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/store"
)

func TestSelectFeed(t *testing.T) {
	srv, sp := setup(t, "kitp_test_activity_feed")
	ctx := auth.WithSystemUser(context.Background())
	pool := sp.P

	insert := func(data string) int64 {
		t.Helper()
		resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "i", Endpoint: "card", Action: "insert", Data: json.RawMessage(data)},
		}})
		mustOK(t, resp.Subresponses[0])
		var out card.InsertOutput
		buf, err := json.Marshal(resp.Subresponses[0].Data)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		if err := json.Unmarshal(buf, &out); err != nil {
			t.Fatalf("decode insert: %v", err)
		}
		return out.ID
	}
	projectID := insert(`{"card_type_name":"project","title":"Feed"}`)
	todo := store.TemplateStatusID(t, pool, projectID, "Todo")
	done := store.TemplateStatusID(t, pool, projectID, "Done")
	taskID := insert(fmt.Sprintf(
		`{"card_type_name":"task","parent_card_id":"%d","title":"Ship the feed","attributes":{"status":"%d"}}`,
		projectID, todo))
	linkID := insert(fmt.Sprintf(
		`{"card_type_name":"link","parent_card_id":"%d","title":"Fix the feed","attributes":{"link_url":"https://g.example/c/1","link_kind":"gerrit","link_state":"open"}}`,
		taskID))

	user := func(name string, agent bool, parent int64) int64 {
		t.Helper()
		var p *int64
		if parent != 0 {
			p = &parent
		}
		var id int64
		if err := pool.QueryRow(ctx,
			`INSERT INTO user_account (display_name, is_agent, parent_user_id) VALUES ($1, $2, $3) RETURNING id`,
			name, agent, p).Scan(&id); err != nil {
			t.Fatalf("user %s: %v", name, err)
		}
		return id
	}
	daniel := user("Daniel", false, 0)
	claude := user("claude", true, daniel)
	gerrit := user("Gerrit", true, auth.SystemUserID)

	act := func(cardID int64, kind, attr string, actor int64, oldV, newV string) {
		t.Helper()
		if _, err := pool.Exec(ctx, `
			INSERT INTO activity (card_id, kind, attribute_def_id, actor_id, value_old, value_new)
			VALUES ($1, $2, (SELECT id FROM attribute_def WHERE name = NULLIF($3, '')), $4,
			        NULLIF($5, '')::jsonb, NULLIF($6, '')::jsonb)
		`, cardID, kind, attr, actor, oldV, newV); err != nil {
			t.Fatalf("activity %s: %v", kind, err)
		}
	}
	act(taskID, "attr_update", "status", claude, fmt.Sprintf(`"%d"`, todo), fmt.Sprintf(`"%d"`, done))
	act(linkID, "attr_update", "link_state", gerrit, `"open"`, `"merged"`)
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "c", Endpoint: "comment", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d","body":"the needle is here"}`, taskID))},
	}})
	mustOK(t, resp.Subresponses[0])

	sel := func(input map[string]any) activity.SelectOutput {
		t.Helper()
		input["project_id"] = fmt.Sprint(projectID)
		data, err := json.Marshal(input)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "s", Endpoint: "activity", Action: "select", Data: data},
		}})
		mustOK(t, resp.Subresponses[0])
		buf, err := json.Marshal(resp.Subresponses[0].Data)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		var out activity.SelectOutput
		if err := json.Unmarshal(buf, &out); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return out
	}
	find := func(rows []activity.Row, kind, attr string) *activity.Row {
		for i := range rows {
			if rows[i].Kind == kind && (attr == "" || (rows[i].AttributeName != nil && *rows[i].AttributeName == attr)) {
				return &rows[i]
			}
		}
		return nil
	}

	all := sel(map[string]any{"facets": true})
	status := find(all.Rows, "attr_update", "status")
	if status == nil {
		t.Fatalf("no status row in %+v", all.Rows)
	}
	if status.ActorName != "claude (for Daniel)" {
		t.Errorf("agent actor_name = %q, want its owner named", status.ActorName)
	}
	if status.CardType != "task" || status.CardTitle != "Ship the feed" ||
		status.NavCardID != taskID || status.NavCardType != "task" || status.NavTitle != "Ship the feed" {
		t.Errorf("status row card/nav = %+v", status)
	}
	var refs map[string]string
	if err := json.Unmarshal(status.Refs, &refs); err != nil {
		t.Fatalf("refs %s: %v", status.Refs, err)
	}
	if refs[fmt.Sprint(todo)] != "Todo" || refs[fmt.Sprint(done)] != "Done" {
		t.Errorf("refs = %v, want the two statuses titled", refs)
	}
	if status.ValueType == nil || *status.ValueType != "card_ref" {
		t.Errorf("value_type = %v", status.ValueType)
	}
	state := find(all.Rows, "attr_update", "link_state")
	if state == nil {
		t.Fatalf("no link_state row")
	}
	if state.ActorName != "Gerrit" {
		t.Errorf("workspace agent actor_name = %q, want the bare name", state.ActorName)
	}
	if state.CardType != "link" || state.CardTitle != "Fix the feed" || state.NavCardID != taskID || state.NavTitle != "Ship the feed" {
		t.Errorf("link row card/nav = %+v", state)
	}
	if len(state.Refs) != 0 && string(state.Refs) != "null" {
		t.Errorf("text attr has refs %s", state.Refs)
	}

	if all.Facets == nil {
		t.Fatalf("no facets")
	}
	if all.Facets.Total != len(all.Rows) {
		t.Errorf("facets.total = %d, rows = %d", all.Facets.Total, len(all.Rows))
	}
	var actorNames []string
	for _, a := range all.Facets.Actors {
		actorNames = append(actorNames, a.Name)
	}
	for _, want := range []string{"claude (for Daniel)", "Gerrit", "System"} {
		if !slices.Contains(actorNames, want) {
			t.Errorf("facet actors %v missing %q", actorNames, want)
		}
	}
	var cardTypes []string
	for _, c := range all.Facets.CardTypes {
		cardTypes = append(cardTypes, c.CardType)
	}
	if !slices.Contains(cardTypes, "link") || !slices.Contains(cardTypes, "task") {
		t.Errorf("facet card types = %v", cardTypes)
	}

	// Filters narrow the rows; facets ignore them.
	kindsOf := func(out activity.SelectOutput) []string {
		var ks []string
		for _, r := range out.Rows {
			k := r.Kind
			if r.AttributeName != nil {
				k += ":" + *r.AttributeName
			}
			ks = append(ks, k)
		}
		slices.Sort(ks)
		return ks
	}
	cases := []struct {
		name  string
		input map[string]any
		want  []string
	}{
		{"actor", map[string]any{"actor_ids": []string{fmt.Sprint(claude)}}, []string{"attr_update:status"}},
		{"exclude actors", map[string]any{"exclude_actor_ids": []string{fmt.Sprint(gerrit), fmt.Sprint(auth.SystemUserID)}},
			[]string{"attr_update:status"}},
		{"kind", map[string]any{"kinds": []string{"comment"}}, []string{"comment"}},
		{"card type + kind", map[string]any{"card_types": []string{"link"}, "kinds": []string{"attr_update"}},
			nil},
		{"comment body", map[string]any{"q": "NEEDLE"}, []string{"comment"}},
		{"card title", map[string]any{"q": "fix the", "kinds": []string{"attr_update"}}, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out := sel(tc.input)
			got := kindsOf(out)
			want := tc.want
			if want == nil {
				// Every link attr_update: the insert's initial values plus
				// Gerrit's state change.
				for _, r := range all.Rows {
					if r.CardType == "link" && r.Kind == "attr_update" {
						want = append(want, "attr_update:"+*r.AttributeName)
					}
				}
				slices.Sort(want)
			}
			if !slices.Equal(got, want) {
				t.Errorf("rows = %v, want %v", got, want)
			}
			if out.Facets != nil {
				t.Errorf("facets returned unasked")
			}
		})
	}
	// "#<id>" matches every row that opens the task.
	byID := sel(map[string]any{"q": fmt.Sprintf("#%d", taskID)})
	for _, r := range byID.Rows {
		if r.NavCardID != taskID {
			t.Errorf("q #id returned a row for card %d", r.NavCardID)
		}
	}
	if len(byID.Rows) == 0 {
		t.Errorf("q #id matched nothing")
	}

	for _, bad := range []string{`{"actor_ids":["x"]}`, `{"exclude_actor_ids":["x"]}`} {
		resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "bad", Endpoint: "activity", Action: "select", Data: json.RawMessage(bad)},
		}})
		if resp.Subresponses[0].OK {
			t.Errorf("%s: a non-numeric actor id was accepted", bad)
		}
	}
}
