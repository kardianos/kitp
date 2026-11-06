package portal_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/auth"
)

// TestALargePageCantTakeTheBuilderDown (review 2026-11-06 #6): a page's
// text is at most 512 KB on write; one stored larger (from before) is
// published without its text, with a warning, and so is one whose
// placeholders expand past the cap. A build's try counts before it starts,
// so one that never finishes backs off.
func TestALargePageCantTakeTheBuilderDown(t *testing.T) {
	f := setup(t, "kitp_test_r8_portal_size")
	ctx := context.Background()
	prod := newPortal(t, f, fmt.Sprintf(`{"title":"Docs","root_page_id":"%d","host":"docs.example.test","public":true}`, f.home))
	setAttr(t, f, f.status["Published"], "publishes_to", []string{fmt.Sprint(prod)})
	move(t, f, f.home, "Published")
	move(t, f, f.guide, "Published")
	build(t, f)

	var uid int64
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ('w') RETURNING id`).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sp.P.Exec(ctx, `INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT $1, id, $2 FROM role WHERE name = 'worker'`, uid, f.project); err != nil {
		t.Fatal(err)
	}
	wctx := auth.WithUser(ctx, &auth.UserCtx{ID: uid, DisplayName: "w"})
	big, _ := json.Marshal(strings.Repeat("- a\n", (600<<10)/4))
	if sr := call(f, wctx, "attribute", "update", fmt.Sprintf(`{"card_id":"%d","attribute_name":"description","value":%s}`, f.guide, big)); sr.OK || sr.Error.Code != "validation" {
		t.Fatalf("a 600 KB page text: %+v, want validation", sr)
	}

	// Stored past the write cap some other way, and a placeholder bomb.
	for _, body := range []string{strings.Repeat("- a\n", (2<<20)/4), strings.Repeat("{{<nav>}}", (400<<10)/9)} {
		if _, err := f.sp.P.Exec(ctx, `
			UPDATE attribute_value SET value = to_jsonb($2::text)
			WHERE card_id = $1 AND attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'description')`, f.guide, body); err != nil {
			t.Fatal(err)
		}
		move(t, f, f.guide, "Draft")
		move(t, f, f.guide, "Published")
		if err := f.builder.RunOnce(ctx); err != nil {
			t.Fatalf("build: %v", err)
		}
		var fails int
		var lastErr *string
		var warnings []byte
		if err := f.sp.P.QueryRow(ctx, `
			SELECT ps.fail_count, ps.last_error, COALESCE(b.warnings::text, '[]')::bytea
			FROM portal_state ps LEFT JOIN portal_build b ON b.id = ps.active_build_id
			WHERE ps.portal_id = $1`, prod).Scan(&fails, &lastErr, &warnings); err != nil {
			t.Fatal(err)
		}
		if fails != 0 || lastErr != nil {
			t.Errorf("a %d KB body: fail_count %d, last_error %v; want the build to go through", len(body)>>10, fails, lastErr)
		}
		if !strings.Contains(string(warnings), "too large to publish") {
			t.Errorf("a %d KB body: warnings %s, want the page named as too large", len(body)>>10, warnings)
		}
	}

	// A try counts before the build: kitpd dying mid-build still backs off.
	if err := f.builder.MarkAttemptForTest(ctx, prod); err != nil {
		t.Fatal(err)
	}
	var fails int
	if err := f.sp.P.QueryRow(ctx, `SELECT fail_count FROM portal_state WHERE portal_id = $1`, prod).Scan(&fails); err != nil {
		t.Fatal(err)
	}
	if fails != 1 {
		t.Errorf("fail_count after a try that didn't finish: %d, want 1", fails)
	}
}
