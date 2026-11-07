package store

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/schema/hcsv"
)

// lockTestTimeout is the lock_timeout lockTestPool's sessions run with, as
// kitpd's run with 5s: a lock wait that inherits it gives up after a second.
const lockTestTimeout = time.Second

// lockTestPool is a pool on a fresh schema (made, and dropped after the test,
// by TestPoolBare) whose sessions carry lockTestTimeout, as kitpd's pool
// carries its own.
func lockTestPool(t *testing.T, schema string) *pgxpool.Pool {
	t.Helper()
	TestPoolBare(t, schema)
	cfg, err := pgxpool.ParseConfig(testDSN())
	if err != nil {
		t.Fatalf("parse pool config: %v", err)
	}
	cfg.ConnConfig.RuntimeParams["lock_timeout"] = fmt.Sprint(lockTestTimeout.Milliseconds())
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error {
		if _, err := c.Exec(ctx, "SET search_path = "+pgx.Identifier{schema}.Sanitize()+", public"); err != nil {
			return err
		}
		return setCommSecretKey(ctx, c)
	}
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close) // before TestPoolBare's cleanup drops the schema
	return pool
}

// holdSchemaLock begins a transaction on pool that holds its schema's lock, as
// an applier part-way through does; the returned func ends it (and may be
// called again).
func holdSchemaLock(t *testing.T, pool *pgxpool.Pool) (pgx.Tx, func()) {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if err := lockSchema(ctx, tx); err != nil {
		t.Fatalf("hold the schema lock: %v", err)
	}
	return tx, func() {
		if err := tx.Rollback(ctx); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			t.Errorf("release the schema lock: %v", err)
		}
	}
}

// Every test package applies the schema into a schema of its own in one
// database. One schema's apply mustn't wait for another's: they used to share
// one lock, so a whole `go test ./...` applied one schema at a time, and a
// kitpd (lock_timeout 5s) started by a test gave up in the queue.
func TestASchemaAppliesWhileAnothersApplyIsUnderway(t *testing.T) {
	held := lockTestPool(t, "kitp_test_lock_held")
	tx, release := holdSchemaLock(t, held)
	defer release()

	// What follows the lock in the holder's transaction runs under the
	// session's own lock_timeout again, not the applier's long wait.
	var got string
	if err := tx.QueryRow(context.Background(), `SELECT current_setting('lock_timeout')`).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if want := "1s"; got != want {
		t.Errorf("lock_timeout after the schema lock = %q, want the session's %q", got, want)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	other := lockTestPool(t, "kitp_test_lock_free")
	if err := ApplySchema(ctx, other, hcsv.GenerateOptions{}); err != nil {
		t.Fatalf("apply another schema while the first's lock is held: %v", err)
	}
}

// A boot that finds another applying its schema waits for it to finish, even
// past its session's lock_timeout, rather than failing to start.
func TestABootWaitsOutAnotherApplyOfItsSchema(t *testing.T) {
	pool := lockTestPool(t, "kitp_test_lock_same")
	_, release := holdSchemaLock(t, pool)
	defer release() // a failure below mustn't leave the pool unable to close

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- ApplySchema(ctx, pool, hcsv.GenerateOptions{}) }()

	// Once the boot is queued on the lock, keep it waiting past the timeout it
	// would otherwise have inherited.
	waitForSchemaLockWaiter(ctx, t, pool, "kitp_test_lock_same", done)
	select {
	case err := <-done:
		t.Fatalf("the boot didn't wait for the lock: %v", err)
	case <-time.After(lockTestTimeout + time.Second):
	}
	release()
	if err := <-done; err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "55P03" {
			t.Fatalf("the boot gave up at its lock_timeout: %v", err)
		}
		t.Fatalf("apply: %v", err)
	}
}

// waitForSchemaLockWaiter waits until a session is queued on schema's lock.
func waitForSchemaLockWaiter(ctx context.Context, t *testing.T, pool *pgxpool.Pool, schema string, done <-chan error) {
	t.Helper()
	b := named.New()
	b.Set("key", schemaLockKey)
	b.Set("schema", schema)
	sql, args, err := b.Compile(`
		SELECT EXISTS (SELECT 1 FROM pg_locks
		               WHERE locktype = 'advisory' AND NOT granted AND objsubid = 2
		                 AND classid = CAST(CAST(:key AS int) AS oid)
		                 AND objid = CAST(hashtext(CAST(:schema AS text)) AS oid))`)
	if err != nil {
		t.Fatal(err)
	}
	for {
		var waiting bool
		if err := pool.QueryRow(ctx, sql, args...).Scan(&waiting); err != nil {
			t.Fatalf("pg_locks: %v", err)
		}
		if waiting {
			return
		}
		select {
		case err := <-done:
			t.Fatalf("the boot finished before it queued on the lock: %v", err)
		case <-time.After(20 * time.Millisecond):
		}
	}
}

// Once the extensions exist, making sure of them takes no lock: a boot isn't
// held up by another database-wide applier.
func TestExtensionsThatExistTakeNoLock(t *testing.T) {
	pool := lockTestPool(t, "kitp_test_lock_ext")
	ctx := context.Background()
	parts, err := hcsv.GenerateParts(hcsv.GenerateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(parts.Extensions) == 0 {
		t.Fatal("the schema names no extensions")
	}
	// Make them first, should this be the database's first apply.
	if err := ensureExtensions(ctx, pool, parts.Extensions); err != nil {
		t.Fatalf("ensure extensions: %v", err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	b := named.New()
	b.Set("key", extensionLockKey)
	if err := advisoryWait(ctx, tx, b, `SELECT pg_advisory_xact_lock(CAST(:key AS bigint))`); err != nil {
		t.Fatalf("hold the extension lock: %v", err)
	}
	quick, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := ensureExtensions(quick, pool, parts.Extensions); err != nil {
		t.Fatalf("ensure existing extensions while the extension lock is held: %v", err)
	}
}
