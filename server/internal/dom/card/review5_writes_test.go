package card_test

// Regression tests for the writes area of the fifth 2026-11-03 review
// (the items left open after round 4).

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

// statusOfTask reads a task's status attribute.
func statusOfTask(t *testing.T, f *visibilityFixture, task int64) int64 {
	t.Helper()
	var st int64
	if err := f.sp.P.QueryRow(context.Background(), `
		SELECT (av.value #>> '{}')::bigint FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'status'
		WHERE av.card_id = $1`, task).Scan(&st); err != nil {
		t.Fatal(err)
	}
	return st
}

// TestTaskMoveTakesTheStartingState: a task moved without a status lands
// in the destination flow's starting state, as a new task there would, not
// the first triage state by sort order.
func TestTaskMoveTakesTheStartingState(t *testing.T) {
	f := setupVisibility(t, "kitp_test_r5_move_start")
	ctx := context.Background()
	doing := store.TemplateStatusID(t, f.sp.P, f.projectB, "Doing")
	if _, err := f.sp.P.Exec(ctx, `
		UPDATE flow SET default_create_status_id = $2
		WHERE scope_card_id = $1 AND attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'status')`,
		f.projectB, doing); err != nil {
		t.Fatal(err)
	}
	r := reviewCall(t, f, auth.SystemUserID, "task", "move", fmt.Sprintf(`{"card_id":"%d","new_project_id":"%d"}`, f.taskA, f.projectB))
	if !r.OK {
		t.Fatalf("task.move: %+v", r.Error)
	}
	if got := statusOfTask(t, f, f.taskA); got != doing {
		t.Errorf("moved task's status %d, want the destination's starting state %d", got, doing)
	}
}

// TestFlowStartingStateStays: a flow's starting state can't be deleted or
// merged away, even when no step leads from or to it yet.
func TestFlowStartingStateStays(t *testing.T) {
	f := setupVisibility(t, "kitp_test_r5_start_stays")
	ctx := context.Background()
	fresh := insertedID(t, reviewCall(t, f, auth.SystemUserID, "card", "insert", fmt.Sprintf(
		`{"card_type_name":"status","parent_card_id":"%d","title":"Fresh"}`, f.projectA)))
	if _, err := f.sp.P.Exec(ctx, `
		UPDATE flow SET default_create_status_id = $2
		WHERE scope_card_id = $1 AND attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'status')`,
		f.projectA, fresh); err != nil {
		t.Fatal(err)
	}
	todo := store.TemplateStatusID(t, f.sp.P, f.projectA, "Todo")
	for _, c := range []struct{ name, endpoint, action, data string }{
		{"delete", "card", "delete", fmt.Sprintf(`{"card_id":"%d"}`, fresh)},
		{"merge", "card", "merge", fmt.Sprintf(`{"survivor_id":"%d","loser_ids":["%d"]}`, todo, fresh)},
	} {
		r := reviewCall(t, f, auth.SystemUserID, c.endpoint, c.action, c.data)
		if r.OK || r.Error.Code != "value_referenced_by_flow" {
			t.Errorf("%s the starting state: %+v, want value_referenced_by_flow", c.name, r)
		}
	}
	if deletedAt(t, f, fresh) {
		t.Error("the starting state was deleted")
	}
}

// TestMoveUnderPersonalCards: only a card private to the same person goes
// under a personal card; a personal view may still sit on a shared screen
// (docs/PERSONAL_SCREENS.md P10).
func TestMoveUnderPersonalCards(t *testing.T) {
	f := setupVisibility(t, "kitp_test_r5_move_private")
	ctx := context.Background()
	me := reviewPerson(t, f, f.admin)
	mk := func(cardType string, parent, privateTo any) int64 {
		t.Helper()
		var id int64
		if err := f.sp.P.QueryRow(ctx, `
			INSERT INTO card (card_type_id, parent_card_id, private_to)
			SELECT id, $2, $3 FROM card_type WHERE name = $1 RETURNING id`, cardType, parent, privateTo).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	shared := mk("screen", f.projectA, nil)
	sharedView := mk("filter", shared, nil)
	myView := mk("filter", shared, me)
	myScreen := mk("screen", nil, me)

	move := func(card, parent int64) (bool, string) {
		r := reviewCall(t, f, f.admin, "card", "move", fmt.Sprintf(`{"card_id":"%d","new_parent_card_id":"%d"}`, card, parent))
		if r.OK {
			return true, ""
		}
		return false, r.Error.Code
	}
	if ok, code := move(sharedView, myScreen); ok || code != "forbidden" {
		t.Errorf("a shared view under my screen: ok=%v code=%q, want forbidden", ok, code)
	}
	if ok, code := move(myView, myScreen); !ok {
		t.Errorf("my view onto my screen: %q", code)
	}
	if ok, code := move(myView, shared); !ok {
		t.Errorf("my view back onto a shared screen: %q", code)
	}
}

// TestMergeMessagesStayInTheirProject: a message (reply_body, no parent
// card) belongs to its thread's project, so card.merge won't fold one
// project's message into another's.
func TestMergeMessagesStayInTheirProject(t *testing.T) {
	f := setupVisibility(t, "kitp_test_r5_merge_messages")
	ctx := context.Background()
	message := func(task int64) int64 {
		t.Helper()
		var reply, thread int64
		if err := f.sp.P.QueryRow(ctx, `INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'reply_body' RETURNING id`).Scan(&reply); err != nil {
			t.Fatal(err)
		}
		if err := f.sp.P.QueryRow(ctx, `INSERT INTO card (card_type_id, parent_card_id) SELECT id, $1 FROM card_type WHERE name = 'comm' RETURNING id`, task).Scan(&thread); err != nil {
			t.Fatal(err)
		}
		if _, err := f.sp.P.Exec(ctx, `
			INSERT INTO attribute_value (card_id, attribute_def_id, value)
			SELECT $1, id, jsonb_build_array($2::bigint) FROM attribute_def WHERE name = 'replies'`, thread, reply); err != nil {
			t.Fatal(err)
		}
		return reply
	}
	inA, inB, alsoInA := message(f.taskA), message(f.taskB), message(f.taskA)
	r := reviewCall(t, f, f.admin, "card", "merge", fmt.Sprintf(`{"survivor_id":"%d","loser_ids":["%d"]}`, inA, inB))
	if r.OK || r.Error.Code != "forbidden" {
		t.Errorf("merge another project's message: %+v, want forbidden", r)
	}
	if deletedAt(t, f, inB) {
		t.Error("the other project's message was merged away")
	}
	if r := reviewCall(t, f, f.admin, "card", "merge", fmt.Sprintf(`{"survivor_id":"%d","loser_ids":["%d"]}`, inA, alsoInA)); !r.OK {
		t.Errorf("merge two messages of one project: %+v", r.Error)
	}
}

// batchCodes calls a <endpoint>_<action>_batch function directly and
// returns each row's code ("" when ok).
func batchCodes(t *testing.T, f *visibilityFixture, fn string, actor int64, inputs any) []string {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatal(err)
	}
	rows, err := f.sp.P.Query(context.Background(),
		`SELECT ok, code FROM `+fn+`($1::bigint, $2::jsonb) ORDER BY idx`, actor, body)
	if err != nil {
		t.Fatalf("%s: %v", fn, err)
	}
	defer rows.Close()
	var codes []string
	for rows.Next() {
		var ok bool
		var code string
		if err := rows.Scan(&ok, &code); err != nil {
			t.Fatal(err)
		}
		if ok {
			code = ""
		}
		codes = append(codes, code)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return codes
}

// TestPersonalCardCaps: personal screens, watch lists, calendars and a
// list's entries are capped per person.
func TestPersonalCardCaps(t *testing.T) {
	f := setupVisibility(t, "kitp_test_r5_personal_caps")
	ctx := context.Background()
	reviewPerson(t, f, f.admin)
	many := func(n int, row map[string]any) []map[string]any {
		out := make([]map[string]any, n)
		for i := range out {
			out[i] = map[string]any{}
			for k, v := range row {
				out[i][k] = v
			}
			out[i]["title"] = fmt.Sprintf("n%d", i)
		}
		return out
	}
	for _, c := range []struct {
		fn  string
		max int
	}{
		{"my_screen_set_batch", 200},
		{"watch_list_set_batch", 200},
		{"calendar_set_batch", 50},
	} {
		t.Run(c.fn, func(t *testing.T) {
			codes := batchCodes(t, f, c.fn, f.admin, many(c.max+1, map[string]any{}))
			if len(codes) != c.max+1 {
				t.Fatalf("%d rows, want %d", len(codes), c.max+1)
			}
			if codes[c.max-1] != "" {
				t.Errorf("number %d refused: %q", c.max, codes[c.max-1])
			}
			if codes[c.max] != "limit" {
				t.Errorf("number %d: %q, want limit", c.max+1, codes[c.max])
			}
		})
	}

	var list int64
	if err := f.sp.P.QueryRow(ctx, `
		SELECT c.id FROM card c JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'watch_list'
		WHERE c.deleted_at IS NULL ORDER BY c.id LIMIT 1`).Scan(&list); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sp.P.Exec(ctx, `
		WITH t AS (
			INSERT INTO card (card_type_id, parent_card_id)
			SELECT ct.id, $2 FROM card_type ct, generate_series(1, 5000) WHERE ct.name = 'task'
			RETURNING id)
		INSERT INTO watch_entry (watch_list_id, card_id, sort_order) SELECT $1, t.id, t.id FROM t`, list, f.projectA); err != nil {
		t.Fatal(err)
	}
	watch := func(card int64) string {
		return batchCodes(t, f, "watch_set_batch", f.admin, []map[string]any{
			{"watch_list_id": fmt.Sprint(list), "card_id": fmt.Sprint(card), "on": true}})[0]
	}
	if got := watch(f.taskA); got != "limit" {
		t.Errorf("entry 5001: %q, want limit", got)
	}
	var onList int64
	if err := f.sp.P.QueryRow(ctx, `SELECT card_id FROM watch_entry WHERE watch_list_id = $1 LIMIT 1`, list).Scan(&onList); err != nil {
		t.Fatal(err)
	}
	if got := watch(onList); got != "" {
		t.Errorf("a card already on the full list: %q, want ok", got)
	}
}
