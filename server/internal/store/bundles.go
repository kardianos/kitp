package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/schema/hcsv"
)

// applyBundles is ApplySchema's bundle tier: it reconciles the `bundle`
// catalog with db/schema/bundles/ on every boot.
//
// A feature bundle's SOURCE project is code-owned, like DDL: when the
// bundle's rendered SQL checksum differs from the catalog row (or the
// source is missing), the old source is purged (bundle_source_purge) and
// the file's SQL re-creates it. Projects that already applied the bundle
// are untouched — they hold independent copies keyed by card_origin — so
// a bundle edit reaches existing projects only when someone re-applies it
// (bundle.apply), which adds just the new items. This is what lets a
// built-in bundle change without a forward migration per edit (contrast
// the install seed, which never re-runs).
//
// Presets are plain catalog rows, upserted every boot. A bundle or preset
// no longer shipped is dropped from the catalog (its source purged); the
// card_origin rows in projects that used it stay as history.
func applyBundles(ctx context.Context, tx pgx.Tx, cat hcsv.Catalog) error {
	shipped := make([]string, 0, len(cat.Features)+len(cat.Presets))
	for _, b := range cat.Features {
		shipped = append(shipped, b.Key)
		if err := materializeBundle(ctx, tx, b); err != nil {
			return fmt.Errorf("bundle %s: %w", b.Key, err)
		}
	}
	for _, p := range cat.Presets {
		shipped = append(shipped, p.Key)
		features, err := json.Marshal(p.Features)
		if err != nil {
			return fmt.Errorf("preset %s: encode features: %w", p.Key, err)
		}
		b := named.New()
		b.Set("key", p.Key)
		b.Set("title", p.Title)
		b.Set("doc", p.Doc)
		b.Set("sort", p.Sort)
		b.Set("features", string(features))
		sql, args, err := b.Compile(`
			INSERT INTO bundle (key, kind, title, doc, features, sort_order, source_project_id, checksum, updated_at)
			VALUES (:key, 'preset', :title, :doc, :features::jsonb, :sort, NULL, '', now())
			ON CONFLICT (key) DO UPDATE SET
				kind = 'preset', title = EXCLUDED.title, doc = EXCLUDED.doc,
				features = EXCLUDED.features, sort_order = EXCLUDED.sort_order,
				source_project_id = NULL, checksum = '', updated_at = now()
			WHERE bundle.title IS DISTINCT FROM EXCLUDED.title
			   OR bundle.doc IS DISTINCT FROM EXCLUDED.doc
			   OR bundle.features IS DISTINCT FROM EXCLUDED.features
			   OR bundle.sort_order IS DISTINCT FROM EXCLUDED.sort_order
			   OR bundle.kind <> 'preset'`)
		if err != nil {
			return fmt.Errorf("preset %s: compile: %w", p.Key, err)
		}
		if _, err := tx.Exec(ctx, sql, args...); err != nil {
			return fmt.Errorf("preset %s: upsert: %w", p.Key, err)
		}
	}

	// Drop catalog rows for bundles no longer shipped, purging their
	// sources first.
	b := named.New()
	b.Set("shipped", shipped)
	sql, args, err := b.Compile(`
		SELECT key, source_project_id FROM bundle WHERE NOT (key = ANY(:shipped::text[]))`)
	if err != nil {
		return fmt.Errorf("stale bundles: compile: %w", err)
	}
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return fmt.Errorf("stale bundles: query: %w", err)
	}
	type stale struct {
		key    string
		source *int64
	}
	var gone []stale
	for rows.Next() {
		var s stale
		if err := rows.Scan(&s.key, &s.source); err != nil {
			rows.Close()
			return fmt.Errorf("stale bundles: scan: %w", err)
		}
		gone = append(gone, s)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("stale bundles: rows: %w", err)
	}
	for _, s := range gone {
		if s.source != nil {
			if err := purgeBundleSources(ctx, tx, s.key); err != nil {
				return fmt.Errorf("bundle %s: %w", s.key, err)
			}
		}
		b := named.New()
		b.Set("key", s.key)
		sql, args, err := b.Compile(`DELETE FROM bundle WHERE key = :key`)
		if err != nil {
			return fmt.Errorf("bundle %s: compile delete: %w", s.key, err)
		}
		if _, err := tx.Exec(ctx, sql, args...); err != nil {
			return fmt.Errorf("bundle %s: delete: %w", s.key, err)
		}
	}
	return applyAreas(ctx, tx, cat.Areas)
}

// applyAreas upserts the area catalog (areas.hcsv) and drops areas no
// longer shipped. Projects' switch rows (project_area) for a dropped area
// stay, harmlessly: nothing maps an item type to it any more.
func applyAreas(ctx context.Context, tx pgx.Tx, areas []hcsv.Area) error {
	keys := make([]string, 0, len(areas))
	for _, a := range areas {
		keys = append(keys, a.Key)
		lists := map[string][]string{"card_types": a.CardTypes, "depends_on": a.DependsOn, "starts": a.Starts}
		enc := map[string]string{}
		for k, v := range lists {
			if v == nil {
				v = []string{}
			}
			j, err := json.Marshal(v)
			if err != nil {
				return fmt.Errorf("area %s: encode %s: %w", a.Key, k, err)
			}
			enc[k] = string(j)
		}
		b := named.New()
		b.Set("key", a.Key)
		b.Set("title", a.Title)
		b.Set("doc", a.Doc)
		b.Set("scope", a.Scope)
		b.Set("sort", a.Sort)
		b.Set("card_types", enc["card_types"])
		b.Set("depends_on", enc["depends_on"])
		b.Set("starts", enc["starts"])
		sql, args, err := b.Compile(`
			INSERT INTO area (key, title, doc, scope, sort_order, card_types, depends_on, starts)
			VALUES (:key, :title, :doc, :scope, :sort, :card_types::jsonb, :depends_on::jsonb, :starts::jsonb)
			ON CONFLICT (key) DO UPDATE SET
				title = EXCLUDED.title, doc = EXCLUDED.doc, scope = EXCLUDED.scope,
				sort_order = EXCLUDED.sort_order, card_types = EXCLUDED.card_types,
				depends_on = EXCLUDED.depends_on, starts = EXCLUDED.starts
			WHERE (area.title, area.doc, area.scope, area.sort_order, area.card_types, area.depends_on, area.starts)
			      IS DISTINCT FROM
			      (EXCLUDED.title, EXCLUDED.doc, EXCLUDED.scope, EXCLUDED.sort_order,
			       EXCLUDED.card_types, EXCLUDED.depends_on, EXCLUDED.starts)`)
		if err != nil {
			return fmt.Errorf("area %s: compile: %w", a.Key, err)
		}
		if _, err := tx.Exec(ctx, sql, args...); err != nil {
			return fmt.Errorf("area %s: upsert: %w", a.Key, err)
		}
	}
	b := named.New()
	b.Set("keys", keys)
	sql, args, err := b.Compile(`DELETE FROM area WHERE NOT (key = ANY(:keys::text[]))`)
	if err != nil {
		return fmt.Errorf("stale areas: compile: %w", err)
	}
	if _, err := tx.Exec(ctx, sql, args...); err != nil {
		return fmt.Errorf("stale areas: delete: %w", err)
	}
	return nil
}

// materializeBundle (re)creates one feature bundle's source project when
// its checksum changed, then upserts the catalog row.
func materializeBundle(ctx context.Context, tx pgx.Tx, bun hcsv.Bundle) error {
	var (
		haveSum string
		haveSrc *int64
	)
	{
		b := named.New()
		b.Set("key", bun.Key)
		sql, args, err := b.Compile(`
			SELECT b.checksum,
			       (SELECT c.id FROM card c
			         WHERE c.id = b.source_project_id AND c.deleted_at IS NULL)
			FROM bundle b
			WHERE b.key = :key AND b.kind = 'feature'`)
		if err != nil {
			return fmt.Errorf("compile lookup: %w", err)
		}
		err = tx.QueryRow(ctx, sql, args...).Scan(&haveSum, &haveSrc)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("lookup: %w", err)
		}
	}

	src := haveSrc
	if haveSum != bun.Checksum || haveSrc == nil {
		// Purge every project carrying this bundle_key — the catalog's
		// source and any leftover from an interrupted earlier boot — so
		// the bundle SQL's title-based parent lookups can't resolve into a
		// stale copy.
		if err := purgeBundleSources(ctx, tx, bun.Key); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, bun.SQL); err != nil {
			return fmt.Errorf("materialise: %w", err)
		}
		ids, err := bundleSourceIDs(ctx, tx, bun.Key)
		if err != nil {
			return err
		}
		if len(ids) != 1 {
			return fmt.Errorf("materialise: want 1 source project with bundle_key %q, found %d", bun.Key, len(ids))
		}
		src = &ids[0]
	}

	b := named.New()
	b.Set("key", bun.Key)
	b.Set("title", bun.Title)
	b.Set("doc", bun.Doc)
	b.Set("sort", bun.Sort)
	b.Set("src", *src)
	b.Set("sum", bun.Checksum)
	sql, args, err := b.Compile(`
		INSERT INTO bundle (key, kind, title, doc, features, sort_order, source_project_id, checksum, updated_at)
		VALUES (:key, 'feature', :title, :doc, '[]'::jsonb, :sort, :src, :sum, now())
		ON CONFLICT (key) DO UPDATE SET
			kind = 'feature', title = EXCLUDED.title, doc = EXCLUDED.doc,
			features = '[]'::jsonb, sort_order = EXCLUDED.sort_order,
			source_project_id = EXCLUDED.source_project_id,
			checksum = EXCLUDED.checksum, updated_at = now()
		WHERE bundle.title IS DISTINCT FROM EXCLUDED.title
		   OR bundle.doc IS DISTINCT FROM EXCLUDED.doc
		   OR bundle.sort_order IS DISTINCT FROM EXCLUDED.sort_order
		   OR bundle.source_project_id IS DISTINCT FROM EXCLUDED.source_project_id
		   OR bundle.checksum IS DISTINCT FROM EXCLUDED.checksum
		   OR bundle.kind <> 'feature'`)
	if err != nil {
		return fmt.Errorf("compile upsert: %w", err)
	}
	if _, err := tx.Exec(ctx, sql, args...); err != nil {
		return fmt.Errorf("upsert: %w", err)
	}
	return nil
}

// bundleSourceIDs lists the project cards flagged bundle_key = key.
func bundleSourceIDs(ctx context.Context, tx pgx.Tx, key string) ([]int64, error) {
	b := named.New()
	b.Set("key", key)
	sql, args, err := b.Compile(`
		SELECT c.id
		FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'project'
		JOIN attribute_value av ON av.card_id = c.id
		JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'bundle_key'
		WHERE av.value = to_jsonb(:key::text)
		ORDER BY c.id`)
	if err != nil {
		return nil, fmt.Errorf("compile source lookup: %w", err)
	}
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("source lookup: %w", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return nil, fmt.Errorf("source lookup: %w", err)
	}
	return ids, nil
}

// purgeBundleSources hard-deletes every source project of one bundle.
func purgeBundleSources(ctx context.Context, tx pgx.Tx, key string) error {
	ids, err := bundleSourceIDs(ctx, tx, key)
	if err != nil {
		return err
	}
	for _, id := range ids {
		b := named.New()
		b.Set("id", id)
		sql, args, err := b.Compile(`SELECT bundle_source_purge(:id)`)
		if err != nil {
			return fmt.Errorf("compile purge: %w", err)
		}
		if _, err := tx.Exec(ctx, sql, args...); err != nil {
			return fmt.Errorf("purge source %d: %w", id, err)
		}
	}
	return nil
}
