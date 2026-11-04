package watch_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/schema"
)

// TestWatchFilterIsYours (review 2026-11-03 #8): the watch_list filter only
// ever reads the viewer's own lists. Bob naming Ada's person id or her list
// id gets nothing, through either compiler; Ada gets her task.
func TestWatchFilterIsYours(t *testing.T) {
	f := setup(t, "kitp_test_watch_filter_yours")
	stars := lists(t, f, f.ada, 0)[0].ID
	watched := f.task(t, f.project, "Secretly watched")
	f.task(t, f.project, "Other")
	if r := setOn(t, f, f.ada, stars, watched, true); !r.OK {
		t.Fatalf("watch: %+v", r.Error)
	}
	selectIDs := func(ctx context.Context, value string) []int64 {
		t.Helper()
		var out struct {
			Rows []struct {
				ID int64 `json:"id,string"`
			} `json:"rows"`
		}
		into(t, call(t, f.srv, ctx, "card", "select_with_attributes", map[string]any{
			"card_type_name": "task", "parent_card_id": fmt.Sprint(f.project),
			"tree": map[string]any{"connective": "and", "children": []any{
				map[string]any{"attr": "watch_list", "op": "in", "values": []any{value}}}},
		}), &out)
		ids := make([]int64, 0, len(out.Rows))
		for _, r := range out.Rows {
			ids = append(ids, r.ID)
		}
		return ids
	}
	if got := selectIDs(f.bob, fmt.Sprint(f.adaPID)); len(got) != 0 {
		t.Errorf("Bob filtering by Ada's person id sees %v", got)
	}
	if got := selectIDs(f.bob, fmt.Sprint(stars)); len(got) != 0 {
		t.Errorf("Bob filtering by Ada's list id sees %v", got)
	}
	if got := selectIDs(f.ada, "@me"); len(got) != 1 || got[0] != watched {
		t.Errorf("Ada filtering by @me sees %v, want [%d]", got, watched)
	}

	// The Go compiler (calendar feeds, digests) evaluated as Bob.
	ctx := context.Background()
	snap, err := schema.Load(ctx, f.sp.P)
	if err != nil {
		t.Fatal(err)
	}
	var bobPID int64
	if err := f.sp.P.QueryRow(ctx, `SELECT person_card_id FROM user_account_person uap
		JOIN user_account ua ON ua.id = uap.user_account_id WHERE ua.display_name = 'bob'`).Scan(&bobPID); err != nil {
		t.Fatal(err)
	}
	for _, v := range []int64{f.adaPID, stars} {
		b := named.New()
		b.Set("project", f.project)
		where, err := card.CompileTree(ctx, f.sp.P, card.CardWhereGroup{Connective: "and", Children: []card.CardWhereTreeNode{{
			Attr: "watch_list", Op: "in", Values: []json.RawMessage{json.RawMessage(fmt.Sprint(v))},
		}}}, b.Bind, snap, bobPID)
		if err != nil {
			t.Fatal(err)
		}
		q, args, err := b.Compile(`SELECT count(*) FROM card c WHERE c.parent_card_id = :project AND ` + where)
		if err != nil {
			t.Fatal(err)
		}
		var n int
		if err := f.sp.P.QueryRow(ctx, q, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Errorf("Go compiler as Bob, value %d: %d rows, want 0", v, n)
		}
	}
}
