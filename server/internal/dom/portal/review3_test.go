package portal_test

// Regression test for the third 2026-11-03 review, finding 21.

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

// TestMovedPageLeavesThePortal (round 3 #21): a published page moved out
// from under the portal's root isn't served from the last build, and the
// portal is marked for a rebuild.
func TestMovedPageLeavesThePortal(t *testing.T) {
	f := setup(t, "kitp_test_r3_portal_move")
	ctx := context.Background()
	_, pub := publicSite(t, f)
	if code, _, _ := get(t, pub, "docs.example.test", "/getting-started/"); code != http.StatusOK {
		t.Fatalf("guide before the move: %d", code)
	}
	if _, err := f.sp.P.Exec(ctx, `UPDATE portal_state SET dirty_since = NULL`); err != nil {
		t.Fatal(err)
	}
	mv := call(f, sysCtx(), "card", "move", fmt.Sprintf(`{"card_id":"%d","new_parent_card_id":"%d"}`, f.guide, f.project))
	if !mv.OK {
		t.Fatalf("card.move: %+v", mv.Error)
	}
	var dirty int
	if err := f.sp.P.QueryRow(ctx, `SELECT count(*) FROM portal_state WHERE dirty_since IS NOT NULL`).Scan(&dirty); err != nil {
		t.Fatal(err)
	}
	if dirty == 0 {
		t.Error("moving a published page marked no portal for a rebuild")
	}
	if code, _, _ := get(t, pub, "docs.example.test", "/getting-started/"); code == http.StatusOK {
		t.Errorf("a page moved out from under the root is still served (%d)", code)
	}
}

// TestMovedPageLeavesTheNavigation (round 4 #14): after a published page
// is moved out from under the root, the rebuilt site doesn't link it, and
// the build says why.
func TestMovedPageLeavesTheNavigation(t *testing.T) {
	f := setup(t, "kitp_test_r4_portal_nav")
	_, pub := publicSite(t, f)
	if _, body, _ := get(t, pub, "docs.example.test", "/"); !strings.Contains(body, "getting-started/") {
		t.Fatalf("home doesn't link the guide before the move")
	}
	if mv := call(f, sysCtx(), "card", "move", fmt.Sprintf(`{"card_id":"%d","new_parent_card_id":"%d"}`, f.guide, f.project)); !mv.OK {
		t.Fatalf("card.move: %+v", mv.Error)
	}
	build(t, f)
	if _, body, _ := get(t, pub, "docs.example.test", "/"); strings.Contains(body, "getting-started/") {
		t.Error("after the move and a rebuild, home still links the moved page")
	}
}
