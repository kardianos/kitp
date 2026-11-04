package myscreen_test

// Regression test for the fourth 2026-11-03 review, finding 17.

import (
	"context"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/watch"
)

// TestWatchCountsOnlyWhatYouSee (round 4 #17): after its owner loses a
// project, a watch list counts none of that project's cards.
func TestWatchCountsOnlyWhatYouSee(t *testing.T) {
	f := setup(t, "kitp_test_r4_watch_count")
	var lists watch.ListOutput
	into(t, call(t, f.srv, f.ada, "watch_list", "list", map[string]any{}), &lists)
	stars := lists.Lists[0].ID
	task := f.task(t, f.p2, "ops secret")
	if r := call(t, f.srv, f.ada, "watch", "set", map[string]any{"watch_list_id": fmt.Sprint(stars), "card_id": fmt.Sprint(task), "on": true}); !r.OK {
		t.Fatalf("watch.set: %+v", r.Error)
	}
	if _, err := f.sp.P.Exec(context.Background(), `DELETE FROM user_role WHERE user_id = $1 AND scope_card_id = $2`, auth.ActorOrSystem(f.ada), f.p2); err != nil {
		t.Fatal(err)
	}
	into(t, call(t, f.srv, f.ada, "watch_list", "list", map[string]any{"card_id": fmt.Sprint(task)}), &lists)
	if lists.Lists[0].Count != 0 || lists.Lists[0].HasCard {
		t.Errorf("after losing the project: count=%d has_card=%v, want 0 and false", lists.Lists[0].Count, lists.Lists[0].HasCard)
	}
}
