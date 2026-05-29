package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/schema/hcsv"
)

// schemaAdvisoryLock is an arbitrary, stable key for the transaction-scoped
// advisory lock that serializes schema application. Concurrent boots (multiple
// replicas, or a MIGRATE_ONLY job racing a serving pod) block here so only one
// applies at a time; the lock releases automatically on commit/rollback.
const schemaAdvisoryLock int64 = 0x6b697470 // "kitp"

// ApplySchema brings a database up to the current schema, applied in one
// serialized transaction:
//
//   - The idempotent DDL (CREATE … IF NOT EXISTS) is applied on every boot, so
//     additive schema changes propagate to existing databases automatically.
//   - The install Seed is one-time bootstrap data. It is applied only when the
//     schema_version ledger has no baseline row AND the database is otherwise
//     uninitialized (no card_type rows). Either way a baseline row is then
//     recorded, so the seed never runs again. An already-initialized database
//     that predates the ledger is ADOPTED: the baseline is recorded without
//     re-running the seed.
//   - Demo fixtures (opts.Demo) carry their own DO-block guard and are applied
//     after the seed gate.
//
// This replaces the old "exec the whole script every boot" behavior, whose
// re-applied seed could break a live database (e.g. a seed lookup matching rows
// created after first init).
func ApplySchema(ctx context.Context, pool *pgxpool.Pool, opts hcsv.GenerateOptions) error {
	parts, err := hcsv.GenerateParts(opts)
	if err != nil {
		return fmt.Errorf("load schema: %w", err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin schema tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// Serialize concurrent appliers for the duration of this transaction.
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", schemaAdvisoryLock); err != nil {
		return fmt.Errorf("acquire schema lock: %w", err)
	}

	// Bootstrap the ledger itself before anything reads it.
	if _, err := tx.Exec(ctx, ledgerDDL); err != nil {
		return fmt.Errorf("create schema_version: %w", err)
	}

	// DDL is idempotent and additive — always apply.
	if parts.DDL != "" {
		if _, err := tx.Exec(ctx, parts.DDL); err != nil {
			return fmt.Errorf("apply ddl: %w", err)
		}
	}

	// Gate the one-time install seed on the baseline ledger row.
	var haveBaseline bool
	if err := tx.QueryRow(ctx,
		"SELECT EXISTS(SELECT 1 FROM schema_version WHERE name='baseline')").Scan(&haveBaseline); err != nil {
		return fmt.Errorf("read schema_version: %w", err)
	}
	if !haveBaseline {
		// After DDL the tables exist; an empty card_type means a genuinely
		// fresh database. A populated one is a pre-ledger install we adopt
		// without re-seeding.
		var initialized bool
		if err := tx.QueryRow(ctx,
			"SELECT EXISTS(SELECT 1 FROM card_type)").Scan(&initialized); err != nil {
			return fmt.Errorf("probe initialization: %w", err)
		}
		if !initialized && parts.Seed != "" {
			if _, err := tx.Exec(ctx, parts.Seed); err != nil {
				return fmt.Errorf("apply seed: %w", err)
			}
		}
		if _, err := tx.Exec(ctx,
			"INSERT INTO schema_version (name, version, kind, checksum) VALUES ('baseline', $1, 'baseline', $2)",
			hcsv.SchemaVersion, checksum(parts.Seed),
		); err != nil {
			return fmt.Errorf("record baseline: %w", err)
		}
	}

	// Demo fixtures self-guard (skipped once a real project exists); apply when
	// requested regardless of the seed gate so dev demo data can land on a
	// freshly seeded database.
	if parts.Demo != "" {
		if _, err := tx.Exec(ctx, parts.Demo); err != nil {
			return fmt.Errorf("apply demo: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit schema tx: %w", err)
	}
	return nil
}

// ledgerDDL creates the schema-version ledger. Kept here (not in the generated
// schema) because it must exist before the generated DDL/seed is gated on it.
const ledgerDDL = `
CREATE TABLE IF NOT EXISTS schema_version (
  name        text        PRIMARY KEY,
  version     int         NOT NULL,
  kind        text        NOT NULL,
  checksum    text        NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
);`

func checksum(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}
