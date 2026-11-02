package store_test

import (
	"context"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/schema/hcsv"
	"github.com/kitp/kitp/server/internal/store"
)

// TestBundleTierRematerializes pins the bundle tier's contract: a boot with
// an unchanged bundle file keeps its source project; a changed checksum
// purges the old source and builds a fresh one with the same shape.
func TestBundleTierRematerializes(t *testing.T) {
	pool := store.TestPoolBare(t, "kitp_test_bundle_tier")
	ctx := context.Background()
	opts := hcsv.GenerateOptions{Demo: false}
	if err := store.ApplySchema(ctx, pool, opts); err != nil {
		t.Fatalf("first apply: %v", err)
	}
	source := func() (id int64, cards int64) {
		t.Helper()
		if err := pool.QueryRow(ctx,
			`SELECT source_project_id FROM bundle WHERE key = 'publishing'`).Scan(&id); err != nil {
			t.Fatalf("source lookup: %v", err)
		}
		if err := pool.QueryRow(ctx,
			`SELECT count(*) FROM card WHERE card_enclosing_project(id) = $1`, id).Scan(&cards); err != nil {
			t.Fatalf("source cards: %v", err)
		}
		return id, cards
	}
	first, firstCards := source()
	if firstCards != 8 {
		t.Fatalf("publishing source holds %d cards, want 8", firstCards)
	}

	if err := store.ApplySchema(ctx, pool, opts); err != nil {
		t.Fatalf("second apply: %v", err)
	}
	if again, _ := source(); again != first {
		t.Fatalf("unchanged bundle re-materialised: source %d → %d", first, again)
	}

	// A different checksum stands in for an edited bundle file.
	if _, err := pool.Exec(ctx, `UPDATE bundle SET checksum = 'stale' WHERE key = 'publishing'`); err != nil {
		t.Fatal(err)
	}
	if err := store.ApplySchema(ctx, pool, opts); err != nil {
		t.Fatalf("third apply: %v", err)
	}
	next, nextCards := source()
	if next == first {
		t.Fatalf("changed bundle kept its old source %d", first)
	}
	if nextCards != firstCards {
		t.Fatalf("re-materialised source holds %d cards, want %d", nextCards, firstCards)
	}
	var leftover int64
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM card WHERE id = $1`, first).Scan(&leftover); err != nil {
		t.Fatal(err)
	}
	if leftover != 0 {
		t.Fatalf("old source project %d survived the purge", first)
	}
	// The standard template is still the auto-stamp default, not a bundle.
	var defaultTemplate string
	if err := pool.QueryRow(ctx, `
		SELECT av_t.value #>> '{}'
		FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'is_template'
		JOIN attribute_value av_t ON av_t.card_id = av.card_id
		JOIN attribute_def ad_t ON ad_t.id = av_t.attribute_def_id AND ad_t.name = 'title'
		WHERE av.value = to_jsonb(true)
		ORDER BY av.card_id LIMIT 1`).Scan(&defaultTemplate); err != nil {
		t.Fatal(err)
	}
	if defaultTemplate != "Standard Project Template" {
		t.Fatalf("lowest-id template is %q", defaultTemplate)
	}
}

// TestForwardMigration0015BundlesPortals proves migration 0015 brings an
// already-seeded DB that predates bundles + publishing up to the fresh-seed
// shape: the page / portal card_types, their attribute_defs, edges and
// grants. Without it the bundle tier can't materialise (no bundle_key edge)
// and every page handler raises on the missing card_type.
func TestForwardMigration0015BundlesPortals(t *testing.T) {
	pool := store.TestPoolBare(t, "kitp_test_migration_0015")
	ctx := context.Background()
	if err := store.ApplySchema(ctx, pool, hcsv.GenerateOptions{Demo: false}); err != nil {
		t.Fatalf("initial apply: %v", err)
	}
	counts := []string{
		`SELECT count(*) FROM card_type`,
		`SELECT count(*) FROM attribute_def`,
		`SELECT count(*) FROM edge`,
		`SELECT count(*) FROM role_grant`,
	}
	readCounts := func() []int64 {
		out := make([]int64, len(counts))
		for i, q := range counts {
			if err := pool.QueryRow(ctx, q).Scan(&out[i]); err != nil {
				t.Fatalf("%s: %v", q, err)
			}
		}
		return out
	}
	fresh := readCounts()

	// Simulate a pre-0015 install: drop the bundle sources (they need the
	// bundle_key edge), every row 0015 adds, and its ledger row.
	for _, stmt := range []string{
		`SELECT bundle_source_purge(source_project_id) FROM bundle WHERE source_project_id IS NOT NULL`,
		`DELETE FROM bundle`,
		`DELETE FROM role_grant WHERE card_type_id IN (SELECT id FROM card_type WHERE name IN ('page','portal'))`,
		`DELETE FROM edge WHERE card_type_id IN (SELECT id FROM card_type WHERE name IN ('page','portal'))`,
		`DELETE FROM edge WHERE attribute_def_id IN (SELECT id FROM attribute_def WHERE name IN ('bundle_key','publishes_to'))`,
		`DELETE FROM attribute_def WHERE name IN ('bundle_key','publish_status','publishes_to','portal_host','portal_root','portal_public')`,
		`DELETE FROM card_type WHERE name IN ('page','portal')`,
		`DELETE FROM schema_version WHERE name = '0015_bundles_portals'`,
		// A pre-0015 install predates 0016 (themes) too.
		`DELETE FROM schema_version WHERE name = '0016_portal_themes'`,
	} {
		if _, err := pool.Exec(ctx, stmt); err != nil {
			t.Fatalf("simulate pre-0015 (%s): %v", stmt, err)
		}
	}

	if err := store.ApplySchema(ctx, pool, hcsv.GenerateOptions{Demo: false}); err != nil {
		t.Fatalf("re-apply: %v", err)
	}
	got := readCounts()
	for i, q := range counts {
		if got[i] != fresh[i] {
			t.Errorf("%s after 0015 = %d, want fresh-seed %d", q, got[i], fresh[i])
		}
	}
	var features int64
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM bundle WHERE kind = 'feature' AND source_project_id IS NOT NULL`).Scan(&features); err != nil {
		t.Fatal(err)
	}
	if features != 3 {
		t.Errorf("bundle tier materialised %d features after 0015, want 3", features)
	}
	if err := store.ApplySchema(ctx, pool, hcsv.GenerateOptions{Demo: false}); err != nil {
		t.Fatalf("third apply (idempotent): %v", err)
	}
}

// TestForwardMigration0016PortalThemes proves migration 0016 brings a
// pre-theme install up to the fresh-seed shape: the theme card_type, the
// portal / page / theme attribute_defs, edges and grants, and the
// publication snapshot's nav columns.
func TestForwardMigration0016PortalThemes(t *testing.T) {
	pool := store.TestPoolBare(t, "kitp_test_migration_0016")
	ctx := context.Background()
	if err := store.ApplySchema(ctx, pool, hcsv.GenerateOptions{Demo: false}); err != nil {
		t.Fatalf("initial apply: %v", err)
	}
	counts := []string{
		`SELECT count(*) FROM card_type`,
		`SELECT count(*) FROM attribute_def`,
		`SELECT count(*) FROM edge`,
		`SELECT count(*) FROM role_grant`,
		`SELECT count(*) FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'publication' AND column_name IN ('nav_hidden', 'nav_hide_children')`,
	}
	readCounts := func() []int64 {
		out := make([]int64, len(counts))
		for i, q := range counts {
			if err := pool.QueryRow(ctx, q).Scan(&out[i]); err != nil {
				t.Fatalf("%s: %v", q, err)
			}
		}
		return out
	}
	fresh := readCounts()
	if fresh[4] != 2 {
		t.Fatalf("fresh publication nav columns = %d, want 2", fresh[4])
	}

	// Simulate a pre-0016 install: drop every row and column 0016 adds,
	// and its ledger row.
	newAttrs := `('portal_theme','portal_internal','nav_hidden','nav_hide_children','theme_base','theme_nav','theme_accent','theme_footer')`
	for _, stmt := range []string{
		`DELETE FROM role_grant WHERE card_type_id = (SELECT id FROM card_type WHERE name = 'theme')`,
		`DELETE FROM edge WHERE card_type_id = (SELECT id FROM card_type WHERE name = 'theme')`,
		`DELETE FROM edge WHERE attribute_def_id IN (SELECT id FROM attribute_def WHERE name IN ` + newAttrs + `)`,
		`DELETE FROM attribute_def WHERE name IN ` + newAttrs,
		`DELETE FROM card_type WHERE name = 'theme'`,
		`ALTER TABLE publication DROP COLUMN nav_hidden, DROP COLUMN nav_hide_children`,
		`DELETE FROM schema_version WHERE name = '0016_portal_themes'`,
	} {
		if _, err := pool.Exec(ctx, stmt); err != nil {
			t.Fatalf("simulate pre-0016 (%s): %v", stmt, err)
		}
	}

	if err := store.ApplySchema(ctx, pool, hcsv.GenerateOptions{Demo: false}); err != nil {
		t.Fatalf("re-apply: %v", err)
	}
	got := readCounts()
	for i, q := range counts {
		if got[i] != fresh[i] {
			t.Errorf("%s after 0016 = %d, want fresh-seed %d", q, got[i], fresh[i])
		}
	}
}

// TestForwardMigration0017DraftUnpublishes: on a DB from before "Draft
// unpublishes", 0017 renames the flow's "Unpublish edits" step and takes a
// page that already sits in a Draft-phase status off the portals that
// status doesn't publish to (marking them for a rebuild).
func TestForwardMigration0017DraftUnpublishes(t *testing.T) {
	pool := store.TestPoolBare(t, "kitp_test_migration_0017")
	ctx := context.Background()
	if err := store.ApplySchema(ctx, pool, hcsv.GenerateOptions{Demo: false}); err != nil {
		t.Fatalf("initial apply: %v", err)
	}
	var page, portal int64
	if err := pool.QueryRow(ctx, `
		SELECT c.id
		FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'page'
		JOIN attribute_value sv ON sv.card_id = c.id
		JOIN attribute_def sd ON sd.id = sv.attribute_def_id AND sd.name = 'publish_status'
		JOIN card s ON s.id = CASE WHEN jsonb_typeof(sv.value) = 'number' THEN (sv.value)::text::bigint
		                           ELSE (sv.value #>> '{}')::bigint END
		WHERE s.phase = 'triage'
		ORDER BY c.id LIMIT 1`).Scan(&page); err != nil {
		t.Fatalf("a draft page: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO card (card_type_id) VALUES ((SELECT id FROM card_type WHERE name = 'portal')) RETURNING id`).Scan(&portal); err != nil {
		t.Fatal(err)
	}
	// Simulate a pre-0017 install: the old label, a draft page still live.
	for _, stmt := range []string{
		`UPDATE flow_step SET label = 'Unpublish edits' WHERE label = 'Unpublish'`,
		fmt.Sprintf(`INSERT INTO publication (portal_id, card_id, title) VALUES (%d, %d, 'Home')`, portal, page),
		`DELETE FROM schema_version WHERE name = '0017_draft_unpublishes'`,
	} {
		if _, err := pool.Exec(ctx, stmt); err != nil {
			t.Fatalf("simulate pre-0017 (%s): %v", stmt, err)
		}
	}
	if err := store.ApplySchema(ctx, pool, hcsv.GenerateOptions{Demo: false}); err != nil {
		t.Fatalf("re-apply: %v", err)
	}
	var old, renamed, pubs int64
	var dirty bool
	if err := pool.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM flow_step WHERE label = 'Unpublish edits'),
		       (SELECT count(*) FROM flow_step WHERE label = 'Unpublish'),
		       (SELECT count(*) FROM publication WHERE card_id = $1),
		       EXISTS (SELECT 1 FROM portal_state WHERE portal_id = $2 AND dirty_since IS NOT NULL)`,
		page, portal).Scan(&old, &renamed, &pubs, &dirty); err != nil {
		t.Fatal(err)
	}
	if old != 0 || renamed == 0 {
		t.Errorf("labels after 0017: %d 'Unpublish edits', %d 'Unpublish'", old, renamed)
	}
	if pubs != 0 || !dirty {
		t.Errorf("the draft page is still published (%d) or its portal isn't queued for a rebuild (%v)", pubs, dirty)
	}
}
