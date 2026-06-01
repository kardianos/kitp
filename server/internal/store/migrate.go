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
//   - Forward migrations (the `migrations` list) are run-once, idempotent DATA
//     reconciliations gated per-step by their own schema_version row. They are
//     the one path that reaches ALREADY-seeded databases (the one-time seed
//     above never re-runs there), so a change to seeded data — flipping a
//     built-in attribute_def flag, resyncing a sequence, adding a role_grant —
//     lands on existing installs on the next boot. They are NOT for structural
//     schema (tables/columns/indexes/functions), which stays declarative and
//     reapplies via the idempotent DDL.
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

	// Forward migrations: run-once, idempotent DATA reconciliation that must
	// reach already-seeded databases (the one-time seed above never re-runs on an
	// existing install). Each step is gated by its own schema_version row, so it
	// applies once per DB and is skipped thereafter; on a fresh DB the seed
	// already reflects it, so the step is a harmless no-op that just records its
	// row. Ordered + serialized by the advisory lock; a failure rolls back the
	// whole boot tx.
	for _, m := range migrations {
		var applied bool
		if err := tx.QueryRow(ctx,
			"SELECT EXISTS(SELECT 1 FROM schema_version WHERE name=$1)", m.id).Scan(&applied); err != nil {
			return fmt.Errorf("read migration %s: %w", m.id, err)
		}
		if applied {
			continue
		}
		if _, err := tx.Exec(ctx, m.sql); err != nil {
			return fmt.Errorf("apply migration %s: %w", m.id, err)
		}
		if _, err := tx.Exec(ctx,
			"INSERT INTO schema_version (name, version, kind, checksum) VALUES ($1, $2, 'migration', $3)",
			m.id, hcsv.SchemaVersion, checksum(m.sql),
		); err != nil {
			return fmt.Errorf("record migration %s: %w", m.id, err)
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

// migration is one run-once, idempotent DATA fix-up applied on boot and recorded
// in the schema_version ledger by its id. See ApplySchema for the contract.
//
// Rules for this list:
//   - DATA only — flipping a built-in attribute_def flag, resyncing a sequence,
//     adding a role_grant, backfilling a column value. NEVER tables / columns /
//     indexes / functions (those stay declarative in db/schema and reapply via
//     the idempotent DDL on every boot).
//   - Each `sql` MUST be idempotent: it also runs (as a no-op) on a fresh DB,
//     whose current seed already reflects the change.
//   - APPEND ONLY. Never reorder, renumber, or edit a shipped migration's sql —
//     a row already recorded by id will be skipped forever, so a change to its
//     sql would silently never apply. Need a correction? add a NEW migration.
type migration struct {
	id  string
	sql string
}

// migrations is the ordered, append-only forward-migration list (see migration).
var migrations = []migration{
	{
		// `status` became enum_managed (Manage Values now curates status values).
		// The install seed won't re-run on an existing install, so flip the flag
		// here too. Idempotent — a fresh seed already sets it true.
		id:  "0001_status_enum_managed",
		sql: `UPDATE attribute_def SET enum_managed = true WHERE name = 'status'`,
	},
	{
		// Pre-fix seeds left card_id_seq behind the explicit template card ids, so
		// the first runtime card insert collided on card_pkey ("conflicts with an
		// existing record" on project create). Resync the sequence past MAX(id).
		// Idempotent — setval to the current max is always safe.
		id:  "0002_card_seq_resync",
		sql: `SELECT setval('card_id_seq', GREATEST((SELECT COALESCE(MAX(id), 0) FROM card), 1))`,
	},
	{
		// The Comms screen now lists comm cards directly (layout 'comms' → the
		// CommsList body) instead of tasks-with-comms (layout 'list' → Inbox),
		// so its comm_status phase filter actually scopes comm cards. Flip the
		// layout on every existing comms-slug screen (template + stamped). And
		// drop any task-only `default_filter` ("Comms attached") wired onto a
		// comms screen — it would clobber the comm query when applied as a
		// preset. Idempotent: a fresh seed already ships layout 'comms' and no
		// default_filter, so both statements are no-ops there.
		id: "0003_comms_screen_layout",
		sql: `
DO $$
DECLARE
  _layout_def bigint := (SELECT id FROM attribute_def WHERE name = 'layout');
  _slug_def   bigint := (SELECT id FROM attribute_def WHERE name = 'slug');
  _filter_def bigint := (SELECT id FROM attribute_def WHERE name = 'default_filter');
  _screen_ct  bigint := (SELECT id FROM card_type WHERE name = 'screen');
BEGIN
  IF _layout_def IS NULL OR _slug_def IS NULL OR _screen_ct IS NULL THEN
    RETURN;
  END IF;
  UPDATE attribute_value av
  SET value = to_jsonb('comms'::text)
  WHERE av.attribute_def_id = _layout_def
    AND av.value #>> '{}' = 'list'
    AND EXISTS (
      SELECT 1 FROM card c
      WHERE c.id = av.card_id AND c.card_type_id = _screen_ct
        AND EXISTS (
          SELECT 1 FROM attribute_value sv
          WHERE sv.card_id = c.id AND sv.attribute_def_id = _slug_def
            AND sv.value #>> '{}' = 'comms'
        )
    );
  IF _filter_def IS NOT NULL THEN
    DELETE FROM attribute_value av
    WHERE av.attribute_def_id = _filter_def
      AND EXISTS (
        SELECT 1 FROM card c
        WHERE c.id = av.card_id AND c.card_type_id = _screen_ct
          AND EXISTS (
            SELECT 1 FROM attribute_value sv
            WHERE sv.card_id = c.id AND sv.attribute_def_id = _slug_def
              AND sv.value #>> '{}' = 'comms'
          )
      );
  END IF;
END $$;`,
	},
	{
		// Per-thread comm ACK + manager hard-delete. These rows live in
		// seed.hcsv (so fresh installs get them), but the one-time seed never
		// re-runs on an existing DB — so add them here too:
		//   1. the `acked` bool attribute_def + its comm edge (the per-thread
		//      "handled" flag; comm.set_ack raises if the attribute is absent),
		//   2. the (manager, task, card.delete) role_grant so a manager can
		//      "Delete forever" via task.purge.
		// Idempotent — ON CONFLICT DO NOTHING makes it a no-op on a fresh DB
		// whose seed already carries all three.
		id: "0004_comm_acked_and_manager_purge",
		sql: `
DO $$
DECLARE
  _acked_def bigint;
  _comm_ct   bigint := (SELECT id FROM card_type WHERE name = 'comm');
  _task_ct   bigint := (SELECT id FROM card_type WHERE name = 'task');
  _mgr       bigint := (SELECT id FROM role WHERE name = 'manager');
  _del       bigint := (SELECT id FROM process WHERE name = 'card.delete');
BEGIN
  -- 1. comm acked attribute_def.
  INSERT INTO attribute_def (name, value_type, target_card_type_id, is_built_in, enum_managed)
  VALUES ('acked', 'bool', NULL, true, false)
  ON CONFLICT (name) DO NOTHING;
  SELECT id INTO _acked_def FROM attribute_def WHERE name = 'acked';

  -- 2. Bind acked to the comm card_type.
  IF _comm_ct IS NOT NULL AND _acked_def IS NOT NULL THEN
    INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
    VALUES (_comm_ct, _acked_def, false, 6)
    ON CONFLICT (card_type_id, attribute_def_id) DO NOTHING;
  END IF;

  -- 3. Manager card.delete on task (task.purge / "Delete forever").
  IF _mgr IS NOT NULL AND _task_ct IS NOT NULL AND _del IS NOT NULL THEN
    INSERT INTO role_grant (role_id, card_type_id, process_id)
    VALUES (_mgr, _task_ct, _del)
    ON CONFLICT (role_id, card_type_id, process_id) DO NOTHING;
  END IF;
END $$;`,
	},
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
