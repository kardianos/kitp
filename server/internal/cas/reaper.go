package cas

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Reaper periodically deletes CAS rows that are no longer referenced by
// any consumer table and have been around long enough that an upload-
// in-progress isn't the explanation.
//
// Two layers are swept on every pass, in this order:
//
//  1. file. Orphan when no `attachment.file_id` (where deleted_at IS
//     NULL) points at it. Files must go first; ON DELETE CASCADE on
//     file_chunk drops the chunk references, which lets step 2 see them
//     as orphans.
//  2. cas_blob. Orphan when no `file_chunk.cas_address` points at it.
//     (Future per-chunk consumers can be added to ChunkConsumers.)
//
// The grace period guards against the race where bytes/file rows are
// committed but the consumer row hasn't been inserted yet — without it,
// a write-then-crash sequence could lose freshly-uploaded data.
type Reaper struct {
	Pool           *pgxpool.Pool
	Storage        *Storage
	Interval       time.Duration    // sweep cadence; default 1h
	GracePeriod    time.Duration    // skip rows newer than this; default 1h
	FileConsumers  []ConsumerColumn // tables that point at file.id
	ChunkConsumers []ConsumerColumn // tables that point at cas_blob.address
	Logger         *slog.Logger
}

// ConsumerColumn names a (table, column) that points at a CAS address.
// The reaper unions these to build the "still referenced" subquery for
// each layer's anti-join.
type ConsumerColumn struct {
	Table  string
	Column string
	// Filter is an optional extra WHERE fragment (e.g. "deleted_at IS NULL")
	// applied to the consumer table when collecting live references.
	Filter string
}

// DefaultFileConsumers returns the consumer-column list the reaper uses
// by default for file references. `attachment` consumes file rows
// twice: once for the source bytes (file_id) and once for the optional
// server-generated thumbnail (thumb_file_id). Both are gated on
// deleted_at IS NULL so soft-deleted attachments release both files.
func DefaultFileConsumers() []ConsumerColumn {
	return []ConsumerColumn{
		{Table: "attachment", Column: "file_id", Filter: "deleted_at IS NULL"},
		{Table: "attachment", Column: "thumb_file_id",
			Filter: "deleted_at IS NULL AND thumb_file_id IS NOT NULL"},
	}
}

// DefaultChunkConsumers returns the consumer-column list for cas_blob
// references. file_chunk is the only consumer today; future per-chunk-
// uploads-without-a-file could add more.
func DefaultChunkConsumers() []ConsumerColumn {
	return []ConsumerColumn{
		{Table: "file_chunk", Column: "cas_address"},
	}
}

// RunOnce runs one reaper pass synchronously. Designed for the
// [job.Scheduler]: register it as a periodic job in main with
// `OnStartup: true` so a freshly-restarted server cleans up
// abandoned uploads without waiting a full interval. The scheduler
// owns the ticker, logging, and metrics. Honours ctx via the inner
// pgx Query/Exec calls.
//
// Returns nil — individual sweep failures are logged via the
// reaper's own logger (per-row context — chunk address, file id —
// is more useful than a single rollup error). The scheduler still
// records the call in its success counter.
func (r *Reaper) RunOnce(ctx context.Context) error {
	r.applyDefaults()
	r.sweepFiles(ctx)
	r.sweepBlobs(ctx)
	return nil
}

// SweepOnce is the legacy alias kept so tests and any CLI tooling
// that called the old name keep working.
func (r *Reaper) SweepOnce(ctx context.Context) { _ = r.RunOnce(ctx) }

func (r *Reaper) applyDefaults() {
	if r.Interval <= 0 {
		r.Interval = time.Hour
	}
	if r.GracePeriod <= 0 {
		r.GracePeriod = time.Hour
	}
	if len(r.FileConsumers) == 0 {
		r.FileConsumers = DefaultFileConsumers()
	}
	if len(r.ChunkConsumers) == 0 {
		r.ChunkConsumers = DefaultChunkConsumers()
	}
	if r.Logger == nil {
		r.Logger = slog.Default()
	}
}

// sweepFiles deletes orphan file rows. ON DELETE CASCADE on file_chunk
// drops the chunk pointers automatically; sweepBlobs then sees those
// chunks as eligible for collection.
func (r *Reaper) sweepFiles(ctx context.Context) {
	ids, err := r.findOrphanIDs(ctx, "file", "id", r.FileConsumers)
	if err != nil {
		r.Logger.LogAttrs(ctx, slog.LevelError, "cas reaper find file orphans",
			slog.String("err", err.Error()))
		return
	}
	if len(ids) == 0 {
		return
	}
	r.Logger.LogAttrs(ctx, slog.LevelInfo, "cas reaper sweeping files",
		slog.Int("orphans", len(ids)))
	for _, id := range ids {
		if _, err := r.Pool.Exec(ctx,
			`DELETE FROM file WHERE id = $1`, id,
		); err != nil {
			r.Logger.LogAttrs(ctx, slog.LevelError, "cas reaper delete file",
				slog.Int64("file_id", id),
				slog.String("err", err.Error()))
		}
	}
}

// sweepBlobs deletes orphan cas_blob rows + the underlying bytes from
// every configured backend.
func (r *Reaper) sweepBlobs(ctx context.Context) {
	addrs, err := r.findOrphanAddresses(ctx, "cas_blob", r.ChunkConsumers)
	if err != nil {
		r.Logger.LogAttrs(ctx, slog.LevelError, "cas reaper find blob orphans",
			slog.String("err", err.Error()))
		return
	}
	if len(addrs) == 0 {
		return
	}
	r.Logger.LogAttrs(ctx, slog.LevelInfo, "cas reaper sweeping blobs",
		slog.Int("orphans", len(addrs)))
	for _, addr := range addrs {
		// Drop bytes from every backend (in case a blob was migrated and
		// stale copies linger).
		for _, b := range r.Storage.Backends() {
			if err := b.Delete(ctx, addr); err != nil {
				r.Logger.LogAttrs(ctx, slog.LevelError, "cas reaper delete bytes",
					slog.String("address", addr),
					slog.String("backend", b.Kind()),
					slog.String("err", err.Error()))
			}
		}
		// Drop the metadata row last — once it's gone the address is
		// fully recycleable.
		if _, err := r.Pool.Exec(ctx,
			`DELETE FROM cas_blob WHERE address = $1`, addr,
		); err != nil {
			r.Logger.LogAttrs(ctx, slog.LevelError, "cas reaper delete blob metadata",
				slog.String("address", addr),
				slog.String("err", err.Error()))
		}
	}
}

// findOrphanAddresses returns text-keyed addresses from `parentTable`
// that are older than the grace period and aren't referenced by any of
// `consumers`. Used for cas_blob (the parent column is `address`).
func (r *Reaper) findOrphanAddresses(
	ctx context.Context,
	parentTable string,
	consumers []ConsumerColumn,
) ([]string, error) {
	q, err := r.buildOrphanQuery(parentTable, "address", consumers)
	if err != nil {
		return nil, err
	}
	rows, err := r.Pool.Query(ctx, q, time.Now().Add(-r.GracePeriod))
	if err != nil {
		return nil, fmt.Errorf("cas reaper: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var addr string
		if err := rows.Scan(&addr); err != nil {
			return nil, err
		}
		out = append(out, addr)
	}
	return out, rows.Err()
}

// findOrphanIDs returns int64-keyed ids from `parentTable` that are
// older than the grace period and aren't referenced by any of
// `consumers`. Used for `file` (the parent column is `id`).
func (r *Reaper) findOrphanIDs(
	ctx context.Context,
	parentTable string,
	parentCol string,
	consumers []ConsumerColumn,
) ([]int64, error) {
	q, err := r.buildOrphanQuery(parentTable, parentCol, consumers)
	if err != nil {
		return nil, err
	}
	rows, err := r.Pool.Query(ctx, q, time.Now().Add(-r.GracePeriod))
	if err != nil {
		return nil, fmt.Errorf("cas reaper: %w", err)
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (r *Reaper) buildOrphanQuery(
	parentTable, parentCol string,
	consumers []ConsumerColumn,
) (string, error) {
	if len(consumers) == 0 {
		return "", fmt.Errorf("cas reaper: no consumer tables configured for %s", parentTable)
	}
	if !validIdent(parentTable) || !validIdent(parentCol) {
		return "", fmt.Errorf("cas reaper: invalid parent (table=%q col=%q)", parentTable, parentCol)
	}
	var b strings.Builder
	fmt.Fprintf(&b, `SELECT p.%s FROM %s p WHERE p.created_at < $1 AND p.%s NOT IN (`,
		parentCol, parentTable, parentCol)
	for i, c := range consumers {
		if !validIdent(c.Table) || !validIdent(c.Column) {
			return "", fmt.Errorf("cas reaper: invalid consumer (table=%q column=%q)", c.Table, c.Column)
		}
		if i > 0 {
			b.WriteString(" UNION ALL ")
		}
		fmt.Fprintf(&b, "SELECT %s FROM %s", c.Column, c.Table)
		if c.Filter != "" {
			b.WriteString(" WHERE ")
			b.WriteString(c.Filter)
		}
	}
	b.WriteByte(')')
	return b.String(), nil
}

// validIdent screens table/column names so a future caller can't smuggle
// SQL through ConsumerColumn. Only [A-Za-z_][A-Za-z0-9_]* allowed.
func validIdent(s string) bool {
	if s == "" {
		return false
	}
	for i, r := range s {
		ok := r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
		if i > 0 {
			ok = ok || (r >= '0' && r <= '9')
		}
		if !ok {
			return false
		}
	}
	return true
}
