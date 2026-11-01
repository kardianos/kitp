package store_test

import (
	"context"
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
