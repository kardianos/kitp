package store

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/named"
)

// schemaLockKey is the first key of the transaction-scoped advisory lock that
// serializes schema application into one schema ("kitp"); the second is a hash
// of that schema's name (lockSchema). Concurrent boots against one database
// (multiple replicas, a MIGRATE_ONLY job racing a serving pod) queue on it so
// only one applies at a time, while kitp schemas side by side in one database —
// every test package applies into a schema of its own — apply in parallel
// rather than one after another. It releases on commit or rollback.
const schemaLockKey int32 = 0x6b697470

// extensionLockKey is the database-wide advisory lock ensureExtensions holds
// while it creates the extensions, which live in public and so are shared by
// every kitp schema in the database. The one-key form, apart from
// schemaLockKey's two-key space.
const extensionLockKey int64 = 0x6b697470

// schemaLockWait is how long an applier waits for another one to finish.
// kitpd's pool sets lock_timeout=5s so a request gives up on a contended row; a
// boot queued behind another boot's apply is meant to wait it out, not fail.
const schemaLockWait = 10 * time.Minute

// lockSchema takes tx's schema lock: schemaLockKey and the hash of the schema
// its DDL lands in (current_schema(), the first on the search_path). A hash
// collision between two schemas only makes them take turns.
func lockSchema(ctx context.Context, tx pgx.Tx) error {
	b := named.New()
	b.Set("key", schemaLockKey)
	return advisoryWait(ctx, tx, b,
		`SELECT pg_advisory_xact_lock(CAST(:key AS int), hashtext(COALESCE(current_schema(), '')))`)
}

// ensureExtensions creates the schema's extensions (names) before the schema
// itself is applied, in a transaction of its own under extensionLockKey: two
// first boots on one database, each in its own schema, would otherwise both
// find an extension missing and collide on pg_extension's unique name. When
// they all exist — every boot after a database's first — it takes no lock.
func ensureExtensions(ctx context.Context, pool *pgxpool.Pool, names []string) error {
	if len(names) == 0 {
		return nil
	}
	b := named.New()
	b.Set("names", names)
	sql, args, err := b.Compile(`
		SELECT NOT EXISTS (
			SELECT 1 FROM unnest(CAST(:names AS text[])) AS want(name)
			WHERE want.name NOT IN (SELECT extname FROM pg_extension))`)
	if err != nil {
		return fmt.Errorf("extensions: compile: %w", err)
	}
	var have bool
	if err := pool.QueryRow(ctx, sql, args...).Scan(&have); err != nil {
		return fmt.Errorf("extensions: probe: %w", err)
	}
	if have {
		return nil
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("extensions: begin: %w", err)
	}
	defer tx.Rollback(ctx)
	lb := named.New()
	lb.Set("key", extensionLockKey)
	if err := advisoryWait(ctx, tx, lb, `SELECT pg_advisory_xact_lock(CAST(:key AS bigint))`); err != nil {
		return fmt.Errorf("extensions: acquire lock: %w", err)
	}
	for _, name := range names {
		if _, err := tx.Exec(ctx, "CREATE EXTENSION IF NOT EXISTS "+pgx.Identifier{name}.Sanitize()+" WITH SCHEMA public"); err != nil {
			return fmt.Errorf("extensions: create %s: %w", name, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("extensions: commit: %w", err)
	}
	return nil
}

// advisoryWait runs lockSQL (b's pg_advisory_xact_lock call) in tx with
// lock_timeout raised to schemaLockWait for that one statement, then puts the
// session's own back for the rest of the transaction.
func advisoryWait(ctx context.Context, tx pgx.Tx, b *named.Builder, lockSQL string) error {
	var prev string
	if err := tx.QueryRow(ctx, `SELECT current_setting('lock_timeout')`).Scan(&prev); err != nil {
		return fmt.Errorf("read lock_timeout: %w", err)
	}
	if err := setLockTimeout(ctx, tx, strconv.FormatInt(schemaLockWait.Milliseconds(), 10)); err != nil {
		return err
	}
	sql, args, err := b.Compile(lockSQL)
	if err != nil {
		return fmt.Errorf("lock: compile: %w", err)
	}
	if _, err := tx.Exec(ctx, sql, args...); err != nil {
		return err
	}
	return setLockTimeout(ctx, tx, prev)
}

// setLockTimeout sets lock_timeout for the rest of tx (set_config's is_local).
func setLockTimeout(ctx context.Context, tx pgx.Tx, value string) error {
	b := named.New()
	b.Set("value", value)
	sql, args, err := b.Compile(`SELECT set_config('lock_timeout', :value, true)`)
	if err != nil {
		return fmt.Errorf("lock_timeout: compile: %w", err)
	}
	if _, err := tx.Exec(ctx, sql, args...); err != nil {
		return fmt.Errorf("set lock_timeout: %w", err)
	}
	return nil
}
