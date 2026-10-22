package cas

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/named"
)

// Reaper periodically deletes CAS rows that are no longer referenced by
// any consumer table and have been around long enough that an upload-
// in-progress isn't the explanation.
//
// Two layers are swept on every pass, in this order:
//
//  1. file. Orphan when no live attachment (deleted_at IS NULL) points
//     at it through file_id or thumb_file_id. Files must go first; ON
//     DELETE CASCADE on file_chunk drops the chunk references, which lets
//     step 2 see them as orphans.
//  2. cas_blob. Orphan when no `file_chunk.cas_address` points at it.
//
// Each orphan is reaped in its own transaction, which locks the row and
// re-checks that nothing uses it, so one bad row never blocks the rest
// and a reference added since the scan keeps its row. Two kinds of
// reference would otherwise fail the delete on every pass:
//
//   - A consumer row its [ConsumerColumn.Filter] excludes (a soft-deleted
//     attachment) is a dead reference. It doesn't keep the parent alive,
//     and the reaper deletes it in the same transaction as the parent,
//     since its foreign key would otherwise refuse the delete.
//   - Every other foreign key into the parent table that the configured
//     consumers don't name (import_job.file_id) is read from the catalog
//     on each sweep and counts as a live reference, so a new table pins
//     the rows it uses instead of failing their delete forever.
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

// ConsumerColumn names a (table, column) that points at a CAS row.
type ConsumerColumn struct {
	Table  string
	Column string
	// Filter is an optional WHERE fragment over the consumer table that
	// selects the rows still using the parent (e.g. "deleted_at IS NULL").
	// A row it excludes is a dead reference: the reaper deletes it along
	// with the parent it points at.
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
		{Table: "attachment", Column: "thumb_file_id", Filter: "deleted_at IS NULL"},
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
// A row that can't be reaped is logged with its key and left for the
// next pass; the returned error counts them so the job shows as
// failing.
func (r *Reaper) RunOnce(ctx context.Context) error {
	r.applyDefaults()
	return errors.Join(
		sweep[int64](ctx, r, "file", "id", r.FileConsumers, nil),
		sweep(ctx, r, "cas_blob", "address", r.ChunkConsumers, r.dropBytes),
	)
}

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

// dropBytes deletes a blob's bytes from every backend (in case a blob
// was migrated and stale copies linger).
func (r *Reaper) dropBytes(ctx context.Context, addr string) error {
	for _, b := range r.Storage.Backends() {
		if err := b.Delete(ctx, addr); err != nil {
			return fmt.Errorf("delete bytes from %s: %w", b.Kind(), err)
		}
	}
	return nil
}

// sweep reaps every orphan row of one layer, keyed by `table.col`.
// dropBytes, when set, runs inside each row's transaction before the
// row is deleted.
func sweep[K any](
	ctx context.Context,
	r *Reaper,
	table, col string,
	configured []ConsumerColumn,
	dropBytes func(context.Context, K) error,
) error {
	consumers, err := r.consumers(ctx, table, col, configured)
	if err != nil {
		return fmt.Errorf("cas reaper: %s consumers: %w", table, err)
	}
	keys, err := findOrphans[K](ctx, r, table, col, consumers)
	if err != nil {
		return fmt.Errorf("cas reaper: find %s orphans: %w", table, err)
	}
	if len(keys) == 0 {
		return nil
	}
	reaped, failed := 0, 0
	for _, key := range keys {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("cas reaper: %s: %w", table, err)
		}
		ok, err := reapOne(ctx, r, table, col, consumers, key, dropBytes)
		if err != nil {
			failed++
			r.Logger.LogAttrs(ctx, slog.LevelWarn, "cas reaper delete",
				slog.String("table", table),
				slog.Any("key", key),
				slog.String("err", err.Error()))
			continue
		}
		if ok {
			reaped++
		}
	}
	r.Logger.LogAttrs(ctx, slog.LevelInfo, "cas reaper swept",
		slog.String("table", table),
		slog.Int("orphans", len(keys)),
		slog.Int("reaped", reaped),
		slog.Int("failed", failed))
	if failed > 0 {
		return fmt.Errorf("cas reaper: %d of %d %s orphans not reaped", failed, len(keys), table)
	}
	return nil
}

// consumers returns the configured consumers of `table.col` plus one
// unfiltered consumer for every other foreign key into it the list
// doesn't name. ON DELETE CASCADE keys (file_chunk.file_id,
// cas_blob_data.address) are the row's own parts, not consumers.
func (r *Reaper) consumers(
	ctx context.Context,
	table, col string,
	configured []ConsumerColumn,
) ([]ConsumerColumn, error) {
	if !validIdent(table) || !validIdent(col) {
		return nil, fmt.Errorf("invalid parent (table=%q col=%q)", table, col)
	}
	b := named.New()
	b.Set("parent", table)
	b.Set("col", col)
	q, args, err := b.Compile(`
		SELECT ct.relname::text, ca.attname::text
		FROM pg_constraint c
		JOIN pg_class ct ON ct.oid = c.conrelid
		JOIN pg_attribute ca ON ca.attrelid = c.conrelid AND ca.attnum = c.conkey[1]
		JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
		WHERE c.contype = 'f'
		  AND c.confrelid = CAST(:parent AS text)::regclass
		  AND cardinality(c.conkey) = 1
		  AND c.confdeltype <> 'c'
		  AND pa.attname::text = :col
		ORDER BY 1, 2
	`)
	if err != nil {
		return nil, fmt.Errorf("compile: %w", err)
	}
	rows, err := r.Pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := append([]ConsumerColumn(nil), configured...)
	for rows.Next() {
		var c ConsumerColumn
		if err := rows.Scan(&c.Table, &c.Column); err != nil {
			return nil, err
		}
		known := false
		for _, k := range configured {
			if k.Table == c.Table && k.Column == c.Column {
				known = true
				break
			}
		}
		if !known {
			out = append(out, c)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, errors.New("no consumer tables")
	}
	for _, c := range out {
		if !validIdent(c.Table) || !validIdent(c.Column) {
			return nil, fmt.Errorf("invalid consumer (table=%q column=%q)", c.Table, c.Column)
		}
	}
	return out, nil
}

// findOrphans returns the keys of `table` rows older than the grace
// period that no consumer uses.
func findOrphans[K any](
	ctx context.Context,
	r *Reaper,
	table, col string,
	consumers []ConsumerColumn,
) ([]K, error) {
	b := named.New()
	b.Set("cutoff", time.Now().Add(-r.GracePeriod))
	q, args, err := b.Compile(fmt.Sprintf(
		`SELECT p.%s FROM %s p WHERE p.created_at < :cutoff AND %s ORDER BY 1`,
		col, table, unused(col, consumers)))
	if err != nil {
		return nil, fmt.Errorf("compile: %w", err)
	}
	rows, err := r.Pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []K
	for rows.Next() {
		var k K
		if err := rows.Scan(&k); err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// reapOne deletes one orphan in its own transaction. It locks the row,
// skipping it (false) when a writer holds it (an insert referencing it
// is in flight) or a consumer has started using it since the scan, then
// deletes the consumers' dead references to it, drops its bytes, and
// deletes the row.
func reapOne[K any](
	ctx context.Context,
	r *Reaper,
	table, col string,
	consumers []ConsumerColumn,
	key K,
	dropBytes func(context.Context, K) error,
) (bool, error) {
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("begin: %w", err)
	}
	defer func() {
		// After Commit the tx is closed and Rollback reports ErrTxClosed.
		if err := tx.Rollback(ctx); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			r.Logger.LogAttrs(ctx, slog.LevelWarn, "cas reaper rollback",
				slog.String("table", table),
				slog.Any("key", key),
				slog.String("err", err.Error()))
		}
	}()

	exec := func(sql string) (int64, error) {
		b := named.New()
		b.Set("key", key)
		q, args, err := b.Compile(sql)
		if err != nil {
			return 0, fmt.Errorf("compile: %w", err)
		}
		tag, err := tx.Exec(ctx, q, args...)
		return tag.RowsAffected(), err
	}

	locked, err := exec(fmt.Sprintf(
		`SELECT FROM %s p WHERE p.%s = :key AND %s FOR UPDATE SKIP LOCKED`,
		table, col, unused(col, consumers)))
	if err != nil {
		return false, fmt.Errorf("lock: %w", err)
	}
	if locked == 0 {
		return false, nil
	}
	for _, c := range consumers {
		if c.Filter == "" {
			continue
		}
		if _, err := exec(fmt.Sprintf(
			`DELETE FROM %s WHERE %s = :key AND (%s) IS NOT TRUE`,
			c.Table, c.Column, c.Filter)); err != nil {
			return false, fmt.Errorf("delete dead %s.%s: %w", c.Table, c.Column, err)
		}
	}
	if dropBytes != nil {
		// Before the row: if this fails the row stays for the next pass
		// to retry. Backends delete through their own connection, so
		// the bytes must go before this tx locks them via the cascade.
		if err := dropBytes(ctx, key); err != nil {
			return false, err
		}
	}
	if _, err := exec(fmt.Sprintf(`DELETE FROM %s WHERE %s = :key`, table, col)); err != nil {
		return false, fmt.Errorf("delete: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit: %w", err)
	}
	return true, nil
}

// unused returns the WHERE fragment over parent alias `p` that holds
// when no consumer row uses p.<col>.
func unused(col string, consumers []ConsumerColumn) string {
	var b strings.Builder
	for i, c := range consumers {
		if i > 0 {
			b.WriteString(" AND ")
		}
		fmt.Fprintf(&b, "NOT EXISTS (SELECT FROM %s r WHERE r.%s = p.%s", c.Table, c.Column, col)
		if c.Filter != "" {
			fmt.Fprintf(&b, " AND (%s)", c.Filter)
		}
		b.WriteByte(')')
	}
	return b.String()
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
