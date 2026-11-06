package portal

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/cas"
	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/store"
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
	// Sites switched off (docs/AREAS.md): build nothing; the portals stay
	// dirty and build when Sites is back on.
	var sitesOff bool
	if err := b.Pool.QueryRow(ctx, `SELECT workspace_area_off('sites')`).Scan(&sitesOff); err != nil {
		return fmt.Errorf("portal.build: areas: %w", err)
	}
	if sitesOff {
		return nil
	}
	// A portal whose last build failed waits 5 s × 2^fail_count (capped
	// at an hour) before the next try, instead of rebuilding every tick
	// (review A7).
	rows, err := b.Pool.Query(ctx, `
		SELECT ps.portal_id, ps.dirty_since
		FROM portal_state ps
		JOIN card c ON c.id = ps.portal_id AND c.deleted_at IS NULL
		WHERE ps.dirty_since IS NOT NULL
		  AND (ps.failed_at IS NULL
		       OR ps.failed_at + LEAST(interval '1 hour',
		                               interval '5 seconds' * power(2, LEAST(ps.fail_count, 10))) <= now())
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
		// One builder per portal across replicas (review A28): another
		// kitpd building it already wins; it stays dirty if that one fails.
		release, ok, err := b.lockPortal(ctx, d.id)
		if err != nil {
			return fmt.Errorf("portal.build: lock %d: %w", d.id, err)
		}
		if !ok {
			continue
		}
		// The try counts before it starts: a build that never finishes —
		// past the tick's deadline, or kitpd killed for its memory — then
		// backs off like a failed one instead of starting again at every
		// tick and every boot (review 2026-11-06 #6). Success clears it.
		if err := b.markAttempt(ctx, d.id); err != nil {
			release()
			return fmt.Errorf("portal.build: mark %d: %w", d.id, err)
		}
		if _, err := b.Build(ctx, d.id, d.since); err != nil {
			b.logger().Warn("portal build failed", "portal_id", d.id, "err", err)
			// On its own context: the tick's may be what ran out.
			rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
			if rerr := b.recordError(rctx, d.id, err); rerr != nil {
				b.logger().Warn("portal build: record error", "portal_id", d.id, "err", rerr)
			}
			cancel()
		}
		release()
	}
	return nil
}

// lockPortal takes the session-level advisory lock that makes one kitpd
// build a portal at a time. ok is false when another holds it. The lock
// lives on a pooled connection kept until release.
func (b *Builder) lockPortal(ctx context.Context, portalID int64) (release func(), ok bool, err error) {
	conn, err := b.Pool.Acquire(ctx)
	if err != nil {
		return nil, false, err
	}
	q := named.New()
	q.Set("portal", portalID)
	lockSQL, args, err := q.Compile(`SELECT pg_try_advisory_lock(hashtextextended('kitp.portal.build:' || (:portal::bigint)::text, 0))`)
	if err != nil {
		conn.Release()
		return nil, false, fmt.Errorf("compile: %w", err)
	}
	if err := conn.QueryRow(ctx, lockSQL, args...).Scan(&ok); err != nil {
		conn.Release()
		return nil, false, err
	}
	if !ok {
		conn.Release()
		return nil, false, nil
	}
	unlockSQL, uargs, err := q.Compile(portalUnlockSQL)
	if err != nil {
		conn.Release()
		return nil, false, fmt.Errorf("compile: %w", err)
	}
	return func() {
		// A fresh context: the tick's may be done, and the lock must go.
		uctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := conn.Exec(uctx, unlockSQL, uargs...); err != nil {
			// The lock would stay on the pooled connection, and the
			// portal's builds be skipped until it is recycled: close it,
			// which ends the session and its lock (as job.Exclusive does).
			b.logger().Warn("portal build: unlock", "portal_id", portalID, "err", err)
			if cerr := conn.Conn().Close(context.Background()); cerr != nil {
				b.logger().Warn("portal build: close after failed unlock", "portal_id", portalID, "err", cerr)
			}
		}
		conn.Release()
	}, true, nil
}

// portalUnlockSQL releases lockPortal's lock; a var so a test can make it
// fail.
var portalUnlockSQL = `SELECT pg_advisory_unlock(hashtextextended('kitp.portal.build:' || (:portal::bigint)::text, 0))`

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
	site, err := loadSite(ctx, b.Pool, b.Storage, portalID)
	if err != nil {
		return 0, err
	}
	res, err := Render(ctx, site)
	if err != nil {
		if cerr := ctx.Err(); cerr != nil && errors.Is(err, cerr) {
			return 0, fmt.Errorf("render: %w", err)
		}
		return 0, &TemplateProblem{err}
	}
	// The attachments page bodies show: read each file's chunks and store
	// it as one blob (identical bytes collapse to one) right away, so the
	// build holds one attachment in memory at a time, not all of them. One
	// that can't be read leaves the site without that file, with a
	// warning, rather than failing the whole build (review A7).
	for _, a := range res.Attachments {
		data, err := readAttachment(ctx, b.Pool, b.Storage, a.ID)
		if err != nil {
			b.logger().Warn("portal build: attachment", "portal_id", portalID, "attachment_id", a.ID, "err", err)
			res.Warnings = append(res.Warnings, fmt.Sprintf("%s couldn't be read and wasn't published.", a.Path))
			continue
		}
		mime := PublishedMIME(a.MIME)
		addr, err := b.Storage.Put(ctx, mime, data)
		if err != nil {
			return 0, fmt.Errorf("store %s: %w", a.Path, err)
		}
		res.Files = append(res.Files, File{Path: a.Path, MIME: mime, Addr: addr, Size: int64(len(data)), CardID: a.CardID})
	}

	// Blobs first, outside the transaction: a failed build leaves only
	// unreferenced blobs, which the CAS reaper collects. A theme card's
	// own files are blobs already.
	addrs := make([]string, len(res.Files))
	sizes := make([]int64, len(res.Files))
	for i, f := range res.Files {
		if f.Addr != "" {
			addrs[i] = f.Addr
			sizes[i] = f.Size
			continue
		}
		addr, err := b.Storage.Put(ctx, f.MIME, f.Data)
		if err != nil {
			return 0, fmt.Errorf("store %s: %w", f.Path, err)
		}
		addrs[i] = addr
		sizes[i] = int64(len(f.Data))
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
		cards := make([]int64, len(res.Files))
		for i, f := range res.Files {
			paths[i], mimes[i], cards[i] = f.Path, f.MIME, f.CardID
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
				    fail_count = 0,
				    failed_at = NULL,
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

// markAttempt counts a build try as failed before it starts (RunOnce); a
// build that finishes clears it, one that fails names its error.
func (b *Builder) markAttempt(ctx context.Context, portalID int64) error {
	q := named.New()
	q.Set("portal", portalID)
	sql, args, err := q.Compile(`
		UPDATE portal_state
		SET fail_count = fail_count + 1, failed_at = now(),
		    last_error = 'The last build didn''t finish; the server log has the details.'
		WHERE portal_id = :portal`)
	if err != nil {
		return fmt.Errorf("compile: %w", err)
	}
	if _, err := b.Pool.Exec(ctx, sql, args...); err != nil {
		return fmt.Errorf("mark: %w", err)
	}
	return nil
}

// recordError names a failed build's error; markAttempt already counted it.
func (b *Builder) recordError(ctx context.Context, portalID int64, cause error) error {
	// portal.list shows last_error to admins: a theme's own template
	// problem as it is (they fix it), anything else as a pointer to the
	// server log, which has the whole chain (review A17).
	msg := "The build failed; the server log has the details."
	var tp *TemplateProblem
	if errors.As(cause, &tp) {
		msg = tp.Error()
	}
	q := named.New()
	q.Set("portal", portalID)
	q.Set("msg", msg)
	sql, args, err := q.Compile(`
		UPDATE portal_state
		SET last_error = :msg
		WHERE portal_id = :portal`)
	if err != nil {
		return fmt.Errorf("compile: %w", err)
	}
	if _, err := b.Pool.Exec(ctx, sql, args...); err != nil {
		return fmt.Errorf("record: %w", err)
	}
	return nil
}

// loadSite reads a portal's title, root page, theme, publications and the
// attachments on the published pages.
func loadSite(ctx context.Context, pool *pgxpool.Pool, storage *cas.Storage, portalID int64) (Site, error) {
	var s Site
	var themeID int64
	{
		q := named.New()
		q.Set("portal", portalID)
		sql, args, err := q.Compile(`
			SELECT
			  COALESCE(max(av.value #>> '{}') FILTER (WHERE ad.name = 'title'), ''),
			  COALESCE(max(CASE
			    WHEN ad.name = 'portal_root' AND jsonb_typeof(av.value) = 'number' THEN (av.value)::text::bigint
			    WHEN ad.name = 'portal_root' AND (av.value #>> '{}') ~ '^\d+$' THEN (av.value #>> '{}')::bigint
			  END), 0),
			  COALESCE(max(CASE
			    WHEN ad.name = 'portal_theme' AND jsonb_typeof(av.value) = 'number' THEN (av.value)::text::bigint
			    WHEN ad.name = 'portal_theme' AND (av.value #>> '{}') ~ '^\d+$' THEN (av.value #>> '{}')::bigint
			  END), 0)
			FROM attribute_value av
			JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE av.card_id = :portal`)
		if err != nil {
			return Site{}, fmt.Errorf("compile portal: %w", err)
		}
		if err := pool.QueryRow(ctx, sql, args...).Scan(&s.Title, &s.RootID, &themeID); err != nil {
			return Site{}, fmt.Errorf("load portal %d: %w", portalID, err)
		}
	}
	if s.RootID != 0 {
		// The root's live title and project, published or not, so a build
		// warning can say which page the portal is waiting on.
		q := named.New()
		q.Set("root", s.RootID)
		sql, args, err := q.Compile(`
			SELECT
			  COALESCE((SELECT av.value #>> '{}' FROM attribute_value av
			            JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'title'
			            WHERE av.card_id = :root), ''),
			  COALESCE((SELECT av.value #>> '{}' FROM attribute_value av
			            JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'title'
			            WHERE av.card_id = card_enclosing_project(:root)), '')`)
		if err != nil {
			return Site{}, fmt.Errorf("compile root: %w", err)
		}
		if err := pool.QueryRow(ctx, sql, args...).Scan(&s.RootTitle, &s.RootProject); err != nil {
			return Site{}, fmt.Errorf("load root of portal %d: %w", portalID, err)
		}
	}
	if themeID != 0 {
		theme, note, err := loadTheme(ctx, pool, storage, themeID)
		if err != nil {
			return Site{}, fmt.Errorf("portal %d: %w", portalID, err)
		}
		s.Theme = theme
		if note != "" {
			s.Notes = append(s.Notes, note)
		}
	}
	q := named.New()
	q.Set("portal", portalID)
	q.Set("root", s.RootID)
	sql, args, err := q.Compile(`
		SELECT p.card_id, COALESCE(p.parent_card_id, 0), p.title, p.slug, p.body,
		       p.sort_order, p.published_at, p.nav_hidden, p.nav_hide_children,
		       -- Whether the page is under the portal's root in its live tree,
		       -- not only its snapshot's (Page.Moved; round 4 #14).
		       (:root::bigint = 0 OR EXISTS (SELECT 1 FROM card_ancestors(c.id) up WHERE up.id = :root::bigint))
		FROM publication p
		JOIN card c ON c.id = p.card_id
		WHERE p.portal_id = :portal
		  -- A page under a deleted card (its project, a parent page) is gone
		  -- with it (review 2026-11-03 #17).
		  AND NOT EXISTS (SELECT 1 FROM card_ancestors(c.id) up JOIN card x ON x.id = up.id
		                  WHERE x.deleted_at IS NOT NULL)
		  -- A page of a project whose Content area is off isn't built; its
		  -- snapshot stays, so switching Content back on restores it.
		  AND NOT card_in_off_area(p.card_id)
		ORDER BY p.card_id`)
	if err != nil {
		return Site{}, fmt.Errorf("compile publications: %w", err)
	}
	rows, err := pool.Query(ctx, sql, args...)
	if err != nil {
		return Site{}, fmt.Errorf("load publications: %w", err)
	}
	defer rows.Close()
	var pageIDs []int64
	for rows.Next() {
		var p Page
		var underRoot bool
		if err := rows.Scan(&p.ID, &p.ParentID, &p.Title, &p.Slug, &p.Body, &p.Sort, &p.PublishedAt,
			&p.NavHidden, &p.NavHideChildren, &underRoot); err != nil {
			return Site{}, fmt.Errorf("scan publication: %w", err)
		}
		p.Moved = !underRoot && p.ID != s.RootID
		s.Pages = append(s.Pages, p)
		pageIDs = append(pageIDs, p.ID)
	}
	if err := rows.Err(); err != nil {
		return Site{}, fmt.Errorf("load publications: %w", err)
	}
	rows.Close()
	files, err := loadSiteFiles(ctx, pool, pageIDs)
	if err != nil {
		return Site{}, err
	}
	s.Files = files
	return s, nil
}

// loadSiteFiles lists the live attachments on the published pages.
func loadSiteFiles(ctx context.Context, pool *pgxpool.Pool, pageIDs []int64) (map[int64]SiteFile, error) {
	out := map[int64]SiteFile{}
	if len(pageIDs) == 0 {
		return out, nil
	}
	q := named.New()
	q.Set("pages", pageIDs)
	sql, args, err := q.Compile(`
		SELECT a.id, a.card_id, f.filename, f.mime_type, f.size_bytes
		FROM attachment a
		JOIN file f ON f.id = a.file_id
		WHERE a.card_id = ANY(:pages::bigint[]) AND a.deleted_at IS NULL`)
	if err != nil {
		return nil, fmt.Errorf("compile attachments: %w", err)
	}
	rows, err := pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("load attachments: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var f SiteFile
		if err := rows.Scan(&f.ID, &f.CardID, &f.Name, &f.MIME, &f.Size); err != nil {
			return nil, fmt.Errorf("scan attachment: %w", err)
		}
		out[f.ID] = f
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("load attachments: %w", err)
	}
	return out, nil
}

// readAttachment reads an attachment's bytes (its file's chunks, in order).
func readAttachment(ctx context.Context, pool *pgxpool.Pool, storage *cas.Storage, id int64) ([]byte, error) {
	q := named.New()
	q.Set("id", id)
	sql, args, err := q.Compile(`
		SELECT fc.cas_address
		FROM attachment a
		JOIN file_chunk fc ON fc.file_id = a.file_id
		WHERE a.id = :id
		ORDER BY fc.seq`)
	if err != nil {
		return nil, fmt.Errorf("compile chunks: %w", err)
	}
	rows, err := pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("load chunks: %w", err)
	}
	addrs, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, fmt.Errorf("load chunks: %w", err)
	}
	var buf bytes.Buffer
	if err := storage.GetAll(ctx, addrs, &buf); err != nil {
		return nil, fmt.Errorf("read chunks: %w", err)
	}
	return buf.Bytes(), nil
}

// loadTheme resolves a theme card: its settings, its own files (reading
// the ones the renderer needs: templates, theme.json, custom.css) and its
// base. A deleted theme card, or an unknown base, falls back to the
// default theme with a note for the build warnings; a theme whose
// templates don't parse is an error (the portal keeps its last build).
func loadTheme(ctx context.Context, q store.Querier, storage *cas.Storage, themeID int64) (*Theme, string, error) {
	set, own, found, err := loadThemeCard(ctx, q, storage, themeID)
	if err != nil {
		return nil, "", err
	}
	if !found {
		t, err := ResolveTheme(ThemeSettings{Base: DefaultThemeKey}, nil)
		return t, "This portal's theme was deleted; the site uses the Side menu theme. Choose a theme in Admin → Portals.", err
	}
	t, err := ResolveTheme(set, own)
	if err != nil {
		if t != nil {
			return t, err.Error() + ".", nil
		}
		return nil, "", &TemplateProblem{fmt.Errorf("theme %d: %w", themeID, err)}
	}
	return t, "", nil
}

// loadThemeCard reads a live theme card's settings and files; found is
// false for a missing or deleted card. File bytes are read for the files
// the renderer reads (see needsData).
func loadThemeCard(ctx context.Context, q store.Querier, storage *cas.Storage, themeID int64) (ThemeSettings, []ThemeFile, bool, error) {
	var set ThemeSettings
	b := named.New()
	b.Set("theme", themeID)
	sql, args, err := b.Compile(`
		SELECT
		  COALESCE(max(av.value #>> '{}') FILTER (WHERE ad.name = 'theme_base'), ''),
		  COALESCE(max(av.value #>> '{}') FILTER (WHERE ad.name = 'theme_nav'), ''),
		  COALESCE(max(av.value #>> '{}') FILTER (WHERE ad.name = 'theme_accent'), ''),
		  COALESCE(max(av.value #>> '{}') FILTER (WHERE ad.name = 'theme_footer'), '')
		FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'theme'
		LEFT JOIN attribute_value av ON av.card_id = c.id
		LEFT JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE c.id = :theme AND c.deleted_at IS NULL
		GROUP BY c.id`)
	if err != nil {
		return set, nil, false, fmt.Errorf("compile theme: %w", err)
	}
	if err := q.QueryRow(ctx, sql, args...).Scan(&set.Base, &set.Nav, &set.Accent, &set.Footer); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return set, nil, false, nil
		}
		return set, nil, false, fmt.Errorf("load theme %d: %w", themeID, err)
	}
	b = named.New()
	b.Set("theme", themeID)
	sql, args, err = b.Compile(`
		SELECT path, mime_type, cas_address, size_bytes
		FROM theme_file WHERE theme_id = :theme ORDER BY path`)
	if err != nil {
		return set, nil, false, fmt.Errorf("compile theme files: %w", err)
	}
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return set, nil, false, fmt.Errorf("load theme files: %w", err)
	}
	var files []ThemeFile
	for rows.Next() {
		var f ThemeFile
		if err := rows.Scan(&f.Path, &f.MIME, &f.Addr, &f.Size); err != nil {
			rows.Close()
			return set, nil, false, fmt.Errorf("scan theme file: %w", err)
		}
		files = append(files, f)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return set, nil, false, fmt.Errorf("load theme files: %w", err)
	}
	for i := range files {
		if !needsData(files[i].Path) {
			continue
		}
		var buf bytes.Buffer
		if err := storage.GetAll(ctx, []string{files[i].Addr}, &buf); err != nil {
			return set, nil, false, fmt.Errorf("read theme file %s: %w", files[i].Path, err)
		}
		files[i].Data = buf.Bytes()
	}
	return set, files, true, nil
}

// needsData reports whether the renderer reads a theme file's bytes (the
// rest are published by CAS address).
func needsData(p string) bool {
	return p == "theme.json" || p == "custom.css" || strings.HasSuffix(p, ".html")
}

// publishedTypes are the attachment types a build serves as what they are:
// pictures, PDFs and fonts. Anything else — HTML, SVG (which can carry
// script), archives — is published as application/octet-stream and served
// as a download, so an uploaded page can't pose as part of the site
// (review A19).
var publishedTypes = map[string]bool{
	"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true, "image/avif": true,
	"application/pdf": true,
	"font/woff":       true, "font/woff2": true, "font/ttf": true, "font/otf": true,
	"text/plain": true,
}

// PublishedMIME is the type a build publishes an attachment with.
func PublishedMIME(mime string) string {
	base := strings.ToLower(strings.TrimSpace(strings.SplitN(mime, ";", 2)[0]))
	if publishedTypes[base] {
		return base
	}
	return "application/octet-stream"
}
