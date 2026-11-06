package portal_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/portal"
)

// TestAWideTableDoesntFreezeThePortal (review 2026-11-06 round 8 #7): a
// worker's 6 KB page of a 1,000-column table made every later build fail
// ("a page came out larger than 8 MB"), so the site never updated again.
// Now the table shows as text, with a warning, and the build goes through.
func TestAWideTableDoesntFreezeThePortal(t *testing.T) {
	f := setup(t, "kitp_test_r8i_tablebomb")
	ctx := context.Background()
	prod := newPortal(t, f, fmt.Sprintf(`{"title":"Docs","root_page_id":"%d","host":"docs.example.test","public":true}`, f.home))
	setAttr(t, f, f.status["Published"], "publishes_to", []string{fmt.Sprint(prod)})
	move(t, f, f.home, "Published")
	build(t, f)

	var uid int64
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ('w') RETURNING id`).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sp.P.Exec(ctx, `INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT $1, id, $2 FROM role WHERE name = 'worker'`, uid, f.project); err != nil {
		t.Fatal(err)
	}
	wctx := auth.WithUser(ctx, &auth.UserCtx{ID: uid, DisplayName: "w"})
	body, err := json.Marshal(strings.Repeat("|a", 1000) + "|\n" + strings.Repeat("|-", 1000) + "|\n" + strings.Repeat("a\n", 1000))
	if err != nil {
		t.Fatal(err)
	}
	for _, sr := range []struct{ attr, value string }{{"description", string(body)}, {"publish_status", fmt.Sprintf(`"%d"`, f.status["Published"])}} {
		if r := call(f, wctx, "attribute", "update", fmt.Sprintf(`{"card_id":"%d","attribute_name":%q,"value":%s}`, f.guide, sr.attr, sr.value)); !r.OK {
			t.Fatalf("worker attribute.update %s: %+v", sr.attr, r.Error)
		}
	}
	build(t, f)
	var fails int
	var lastErr *string
	var warnings string
	if err := f.sp.P.QueryRow(ctx, `
		SELECT ps.fail_count, ps.last_error, b.warnings::text
		FROM portal_state ps JOIN portal_build b ON b.id = ps.active_build_id
		WHERE ps.portal_id = $1`, prod).Scan(&fails, &lastErr, &warnings); err != nil {
		t.Fatal(err)
	}
	if fails != 0 || lastErr != nil {
		t.Errorf("fail_count %d, last_error %v; want the build to go through", fails, lastErr)
	}
	if !strings.Contains(warnings, "table too large to publish") {
		t.Errorf("warnings %s, want the table named", warnings)
	}
}

// TestATryNamesItselfUnfinished: a try that starts says the last build
// didn't finish, even over an older build's error, until it ends one way
// or the other (review 2026-11-06 round 8, worth a look).
func TestATryNamesItselfUnfinished(t *testing.T) {
	f := setup(t, "kitp_test_r8i_attempt")
	ctx := context.Background()
	prod := newPortal(t, f, fmt.Sprintf(`{"title":"Docs","root_page_id":"%d","host":"docs.example.test","public":true}`, f.home))
	if _, err := f.sp.P.Exec(ctx, `UPDATE portal_state SET last_error = 'theme, page "x": nope' WHERE portal_id = $1`, prod); err != nil {
		t.Fatal(err)
	}
	if err := f.builder.MarkAttemptForTest(ctx, prod); err != nil {
		t.Fatal(err)
	}
	var lastErr string
	if err := f.sp.P.QueryRow(ctx, `SELECT last_error FROM portal_state WHERE portal_id = $1`, prod).Scan(&lastErr); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(lastErr, "didn't finish") {
		t.Errorf("last_error %q, want the try named as unfinished", lastErr)
	}
}

// TestAFailedUnlockDropsTheConnection (review 2026-11-06 round 8 L18): a
// build lock whose unlock fails mustn't go back to the pool with the
// connection, where it would keep every later build of the portal away.
func TestAFailedUnlockDropsTheConnection(t *testing.T) {
	f := setup(t, "kitp_test_r8i_unlock")
	ctx := context.Background()
	const portalID = 424242
	defer portal.SetPortalUnlockSQLForTest(`SELECT 1 / (:portal::bigint - :portal::bigint)`)()
	release, ok, err := f.builder.LockPortalForTest(ctx, portalID)
	if err != nil || !ok {
		t.Fatalf("lock: ok %v err %v", ok, err)
	}
	release()
	// Another session (not the pool's) can take the lock now.
	conn, err := pgx.ConnectConfig(ctx, f.sp.P.Config().ConnConfig.Copy())
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := conn.Close(ctx); err != nil {
			t.Error(err)
		}
	}()
	var got bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtextextended('kitp.portal.build:' || $1::bigint::text, 0))`, int64(portalID)).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if !got {
		t.Error("the lock outlived a failed unlock")
	}
}
