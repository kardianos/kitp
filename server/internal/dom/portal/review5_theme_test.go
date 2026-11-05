package portal_test

// Regression test for the fifth 2026-11-03 review (files, smaller items).

import (
	"context"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/store"
)

// TestThemeChangesRebuildPortals: deleting, bringing back or merging a
// theme rebuilds the portals built with it; merging portals rebuilds the
// survivor.
func TestThemeChangesRebuildPortals(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_r5_theme_dirty")
	ctx := context.Background()
	id := func(sql string, args ...any) int64 {
		t.Helper()
		var v int64
		if err := pool.QueryRow(ctx, sql, args...).Scan(&v); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
		return v
	}
	mk := func(ct string) int64 {
		return id(`INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = $1 RETURNING id`, ct)
	}
	theme, other := mk("theme"), mk("theme")
	portal, spare := mk("portal"), mk("portal")
	if _, err := pool.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		SELECT p, ad.id, to_jsonb($2::bigint) FROM unnest($1::bigint[]) AS p, attribute_def ad WHERE ad.name = 'portal_theme'`,
		[]int64{portal}, theme); err != nil {
		t.Fatal(err)
	}
	dirty := func(p int64) bool {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM portal_state WHERE portal_id = $1 AND dirty_since IS NOT NULL`, p).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n > 0
	}
	clean := func() {
		t.Helper()
		if _, err := pool.Exec(ctx, `DELETE FROM portal_state`); err != nil {
			t.Fatal(err)
		}
	}
	call := func(fn, input string) {
		t.Helper()
		var ok bool
		var code string
		if err := pool.QueryRow(ctx, `SELECT ok, code FROM `+fn+`(1, $1::jsonb)`, input).Scan(&ok, &code); err != nil {
			t.Fatalf("%s: %v", fn, err)
		}
		if !ok {
			t.Fatalf("%s %s: %s", fn, input, code)
		}
	}
	clean()
	call("card_delete_batch", fmt.Sprintf(`[{"card_id":"%d"}]`, theme))
	if !dirty(portal) {
		t.Error("deleting the theme didn't rebuild its portal")
	}
	clean()
	call("card_undelete_batch", fmt.Sprintf(`[{"card_id":"%d"}]`, theme))
	if !dirty(portal) {
		t.Error("bringing the theme back didn't rebuild its portal")
	}
	clean()
	call("card_merge_batch", fmt.Sprintf(`[{"survivor_id":"%d","loser_ids":["%d"]}]`, other, theme))
	if !dirty(portal) {
		t.Error("merging the theme away didn't rebuild its portal")
	}
	clean()
	call("card_merge_batch", fmt.Sprintf(`[{"survivor_id":"%d","loser_ids":["%d"]}]`, portal, spare))
	if !dirty(portal) {
		t.Error("merging portals didn't rebuild the survivor")
	}
}
