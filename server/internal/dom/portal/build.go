package portal

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/cas"
	"github.com/kitp/kitp/server/internal/named"
)

// DefaultKeepBuilds is how many builds per portal survive pruning (the
// active one and the ones before it, for rollback).
const DefaultKeepBuilds = 5

// Builder renders dirty portals into CAS-backed static builds. Register
// RunOnce as the `portal.build` job: each tick it builds every portal whose
// portal_state.dirty_since is set (a publication changed, the portal was
// edited, or someone asked for a rebuild), flips the portal's
// active_build_id to the new build in one transaction, and prunes builds
// beyond Keep.
//
// Publishing is therefore atomic: a portal serves either the old build or
// the new one, never a half-written mix, and rolling back is pointing
// active_build_id at an older build. Unchanged files dedupe in CAS.
type Builder struct {
	Pool    *pgxpool.Pool
	Storage *cas.Storage
	Logger  *slog.Logger
	Keep    int // builds kept per portal; 0 = DefaultKeepBuilds
}

// RunOnce builds every dirty portal. A failure building one portal is
// logged and recorded on its portal_state.last_error (it stays dirty and is
// retried next tick) without failing the job; only failing to enumerate
// the dirty portals does.
func (b *Builder) RunOnce(ctx context.Context) error {
	rows, err := b.Pool.Query(ctx, `
		SELECT ps.portal_id, ps.dirty_since
		FROM portal_state ps
		JOIN card c ON c.id = ps.portal_id AND c.deleted_at IS NULL
		WHERE ps.dirty_since IS NOT NULL
		ORDER BY ps.dirty_since
		LIMIT 50`)
	if err != nil {
		return fmt.Errorf("portal.build: list dirty: %w", err)
	}
	type dirty struct {
		id    int64
		since time.Time
	}
	var todo []dirty
	for rows.Next() {
		var d dirty
		if err := rows.Scan(&d.id, &d.since); err != nil {
			rows.Close()
			return fmt.Errorf("portal.build: scan dirty: %w", err)
		}
		todo = append(todo, d)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("portal.build: list dirty: %w", err)
	}
	for _, d := range todo {
		if err := ctx.Err(); err != nil {
			return err
		}
		if _, err := b.Build(ctx, d.id, d.since); err != nil {
			b.logger().Warn("portal build failed", "portal_id", d.id, "err", err)
			if rerr := b.recordError(ctx, d.id, err); rerr != nil {
				b.logger().Warn("portal build: record error", "portal_id", d.id, "err", rerr)
			}
		}
	}
	return nil
}

func (b *Builder) logger() *slog.Logger {
	if b.Logger != nil {
		return b.Logger
	}
	return slog.Default()
}

// Build renders one portal and makes the result its active build. since is
// the dirty_since value read before building: the flag is cleared only if
// it is unchanged, so a change that lands mid-build triggers another build.
// Returns the new build id.
func (b *Builder) Build(ctx context.Context, portalID int64, since time.Time) (int64, error) {
	site, err := loadSite(ctx, b.Pool, portalID)
	if err != nil {
		return 0, err
	}
	res, err := Render(site)
	if err != nil {
		return 0, err
	}

	// Blobs first, outside the transaction: a failed build leaves only
	// unreferenced blobs, which the CAS reaper collects.
	addrs := make([]string, len(res.Files))
	for i, f := range res.Files {
		addr, err := b.Storage.Put(ctx, f.MIME, f.Data)
		if err != nil {
			return 0, fmt.Errorf("store %s: %w", f.Path, err)
		}
		addrs[i] = addr
	}

	tx, err := b.Pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("begin: %w", err)
	}
	defer func() {
		// Rollback after Commit is a no-op that reports ErrTxClosed.
		if rerr := tx.Rollback(ctx); rerr != nil && !errors.Is(rerr, pgx.ErrTxClosed) {
			b.logger().Warn("portal build: rollback", "portal_id", portalID, "err", rerr)
		}
	}()

	warnings := res.Warnings
	if warnings == nil {
		warnings = []string{}
	}
	var buildID int64
	{
		q := named.New()
		q.Set("portal", portalID)
		q.Set("pages", res.PageCount)
		q.Set("warnings", warnings)
		sql, args, err := q.Compile(`
			INSERT INTO portal_build (portal_id, page_count, warnings)
			VALUES (:portal, :pages, to_jsonb(:warnings::text[]))
			RETURNING id`)
		if err != nil {
			return 0, fmt.Errorf("compile build insert: %w", err)
		}
		if err := tx.QueryRow(ctx, sql, args...).Scan(&buildID); err != nil {
			return 0, fmt.Errorf("insert build: %w", err)
		}
	}
	{
		paths := make([]string, len(res.Files))
		mimes := make([]string, len(res.Files))
		sizes := make([]int64, len(res.Files))
		cards := make([]int64, len(res.Files))
		for i, f := range res.Files {
			paths[i], mimes[i], sizes[i], cards[i] = f.Path, f.MIME, int64(len(f.Data)), f.CardID
		}
		q := named.New()
		q.Set("build", buildID)
		q.Set("paths", paths)
		q.Set("addrs", addrs)
		q.Set("mimes", mimes)
		q.Set("sizes", sizes)
		q.Set("cards", cards)
		sql, args, err := q.Compile(`
			INSERT INTO portal_build_file (build_id, path, cas_address, mime_type, size_bytes, card_id)
			SELECT :build, f.path, f.addr, f.mime, f.size, NULLIF(f.card, 0)
			FROM unnest(:paths::text[], :addrs::text[], :mimes::text[], :sizes::bigint[], :cards::bigint[])
			     AS f(path, addr, mime, size, card)`)
		if err != nil {
			return 0, fmt.Errorf("compile file insert: %w", err)
		}
		if _, err := tx.Exec(ctx, sql, args...); err != nil {
			return 0, fmt.Errorf("insert files: %w", err)
		}
	}
	{
		keep := b.Keep
		if keep <= 0 {
			keep = DefaultKeepBuilds
		}
		q := named.New()
		q.Set("portal", portalID)
		q.Set("build", buildID)
		q.Set("since", since)
		q.Set("keep", keep)
		sql, args, err := q.Compile(`
			WITH flip AS (
				UPDATE portal_state
				SET active_build_id = :build,
				    built_at = now(),
				    last_error = NULL,
				    dirty_since = CASE WHEN dirty_since = :since THEN NULL ELSE dirty_since END
				WHERE portal_id = :portal
				RETURNING portal_id
			)
			DELETE FROM portal_build
			WHERE portal_id = :portal
			  AND id NOT IN (
			      SELECT id FROM portal_build WHERE portal_id = :portal
			      ORDER BY id DESC LIMIT :keep)`)
		if err != nil {
			return 0, fmt.Errorf("compile flip: %w", err)
		}
		if _, err := tx.Exec(ctx, sql, args...); err != nil {
			return 0, fmt.Errorf("flip active build: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit: %w", err)
	}
	b.logger().Info("portal built", "portal_id", portalID, "build_id", buildID,
		"pages", res.PageCount, "files", len(res.Files), "warnings", len(warnings))
	return buildID, nil
}

func (b *Builder) recordError(ctx context.Context, portalID int64, cause error) error {
	q := named.New()
	q.Set("portal", portalID)
	q.Set("msg", cause.Error())
	sql, args, err := q.Compile(`UPDATE portal_state SET last_error = :msg WHERE portal_id = :portal`)
	if err != nil {
		return fmt.Errorf("compile: %w", err)
	}
	if _, err := b.Pool.Exec(ctx, sql, args...); err != nil {
		return fmt.Errorf("record: %w", err)
	}
	return nil
}

// loadSite reads a portal's title, root page and publications.
func loadSite(ctx context.Context, pool *pgxpool.Pool, portalID int64) (Site, error) {
	var s Site
	{
		q := named.New()
		q.Set("portal", portalID)
		sql, args, err := q.Compile(`
			SELECT
			  COALESCE(max(av.value #>> '{}') FILTER (WHERE ad.name = 'title'), ''),
			  COALESCE(max(CASE
			    WHEN ad.name = 'portal_root' AND jsonb_typeof(av.value) = 'number' THEN (av.value)::text::bigint
			    WHEN ad.name = 'portal_root' AND (av.value #>> '{}') ~ '^\d+$' THEN (av.value #>> '{}')::bigint
			  END), 0)
			FROM attribute_value av
			JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE av.card_id = :portal`)
		if err != nil {
			return Site{}, fmt.Errorf("compile portal: %w", err)
		}
		if err := pool.QueryRow(ctx, sql, args...).Scan(&s.Title, &s.RootID); err != nil {
			return Site{}, fmt.Errorf("load portal %d: %w", portalID, err)
		}
	}
	q := named.New()
	q.Set("portal", portalID)
	sql, args, err := q.Compile(`
		SELECT p.card_id, COALESCE(p.parent_card_id, 0), p.title, p.slug, p.body,
		       p.sort_order, p.published_at
		FROM publication p
		JOIN card c ON c.id = p.card_id AND c.deleted_at IS NULL
		WHERE p.portal_id = :portal
		ORDER BY p.card_id`)
	if err != nil {
		return Site{}, fmt.Errorf("compile publications: %w", err)
	}
	rows, err := pool.Query(ctx, sql, args...)
	if err != nil {
		return Site{}, fmt.Errorf("load publications: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var p Page
		if err := rows.Scan(&p.ID, &p.ParentID, &p.Title, &p.Slug, &p.Body, &p.Sort, &p.PublishedAt); err != nil {
			return Site{}, fmt.Errorf("scan publication: %w", err)
		}
		s.Pages = append(s.Pages, p)
	}
	if err := rows.Err(); err != nil {
		return Site{}, fmt.Errorf("load publications: %w", err)
	}
	return s, nil
}
