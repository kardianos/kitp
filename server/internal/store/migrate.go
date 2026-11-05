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
//   - Feature bundles (db/schema/bundles/*.hcsv) are re-materialised into
//     their hidden source projects whenever a bundle file's rendered SQL
//     changes, and presets are upserted — see applyBundles. Bundle content is
//     code-owned like DDL, so it needs no forward migration.
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

	// Pre-DDL column bootstrap. The generated index DDL (re-applied every boot)
	// references attribute_value.value_type_id in its partial predicates, but
	// CREATE TABLE IF NOT EXISTS can't add that column to an already-initialised
	// DB — and CREATE INDEX IF NOT EXISTS parses (and fails on) a predicate's
	// column even when the index already exists. So ensure the column is present
	// BEFORE the generated DDL runs. Idempotent: a no-op on a fresh DB (the table
	// doesn't exist yet → the DDL below creates it WITH the column) and on an
	// already-migrated DB (column present). The 0008 migration backfills it and
	// sets NOT NULL.
	if _, err := tx.Exec(ctx, preDDL); err != nil {
		return fmt.Errorf("apply pre-ddl: %w", err)
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

	// Bundle tier: (re)materialise each feature bundle's hidden source project
	// whose file changed, and upsert the presets (see applyBundles). After the
	// migrations, so the card_types / attribute_defs a bundle references exist
	// on an upgraded install; before the demo, which may apply bundles.
	if err := applyBundles(ctx, tx, parts.Bundles); err != nil {
		return fmt.Errorf("apply bundles: %w", err)
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
//   - DATA reconciliation is the primary use — flipping a built-in
//     attribute_def flag, resyncing a sequence, adding a role_grant, backfilling
//     a column value.
//   - ADDITIVE column DDL is the one structural exception: `ALTER TABLE …
//     ADD COLUMN IF NOT EXISTS …`. The declarative DDL only emits
//     `CREATE TABLE IF NOT EXISTS`, which CANNOT add a column to an existing
//     table — so a new column reaches already-initialised DBs ONLY via a
//     migration here. Still NEVER put a CREATE/DROP/RENAME of tables / indexes /
//     functions here (those stay declarative and reapply on every boot); and
//     never a destructive column change (DROP / RENAME / type-narrowing).
//     ONE narrow index exception: replacing an existing index's PREDICATE (e.g.
//     making it partial) can't be done declaratively — CREATE INDEX IF NOT
//     EXISTS skips an already-named index — so a guarded DROP/CREATE of that
//     index may live here (see 0008). Guard it on pg_indexes.indexdef so it's a
//     no-op once the new form is in place.
//   - Each `sql` MUST be idempotent: it also runs (as a no-op) on a fresh DB,
//     whose current seed already reflects the change. `ADD COLUMN IF NOT EXISTS`
//     satisfies this — the column is already present from the fresh DB's
//     CREATE TABLE, so the ALTER is a no-op there.
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
		// generic CardListBody) instead of tasks-with-comms (layout 'list' → Inbox),
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
	{
		// flow_step.standalone — the per-transition "render as its own button vs
		// fold into the overflow dropdown" bit the TransitionBar now reads (task +
		// comm status alike). It's declared in db/schema/schema.hcsv, so fresh DBs
		// get it via CREATE TABLE — but CREATE TABLE IF NOT EXISTS can't add it to
		// an existing flow_step, and every flow_step handler now references the
		// column, so an existing install would hard-fail without this. Additive +
		// idempotent: a no-op on any DB that already has the column.
		//
		// Existing rows default to false (everything in the dropdown); admins set
		// the bit per transition via the Workflows editor. Fresh/reset DBs instead
		// get the curated seed values that reproduce the previous look.
		id:  "0005_flow_step_standalone",
		sql: `ALTER TABLE flow_step ADD COLUMN IF NOT EXISTS standalone boolean NOT NULL DEFAULT false`,
	},
	{
		// Migration 0003 flipped the comms screen to list comm cards directly and
		// dropped the task-only "Comms attached" default_filter WIRING, but the
		// filter CARD itself (predicate `comms exists`) was left parented to the
		// comms screen — so it still surfaces as a selectable preset and, applied
		// to comm cards (which carry no `comms` attribute), matches NOTHING. Drop
		// the orphaned filter card + its attribute_value / activity rows. Scoped
		// to filter cards under a comms-slug screen whose predicate is EXACTLY the
		// seeded `comms exists` snippet, so a user's own comms-screen filter is
		// untouched. Idempotent: fresh seeds no longer ship the card (nothing to
		// match) and a re-run finds the row already gone.
		id: "0006_drop_comms_attached_filter",
		sql: `
DO $$
DECLARE
  _slug_def  bigint := (SELECT id FROM attribute_def WHERE name = 'slug');
  _pred_def  bigint := (SELECT id FROM attribute_def WHERE name = 'predicate');
  _screen_ct bigint := (SELECT id FROM card_type WHERE name = 'screen');
  _filter_ct bigint := (SELECT id FROM card_type WHERE name = 'filter');
  _dead bigint[];
BEGIN
  IF _slug_def IS NULL OR _pred_def IS NULL OR _screen_ct IS NULL OR _filter_ct IS NULL THEN
    RETURN;
  END IF;
  SELECT array_agg(f.id) INTO _dead
  FROM card f
  JOIN card s ON s.id = f.parent_card_id AND s.card_type_id = _screen_ct
  WHERE f.card_type_id = _filter_ct
    AND EXISTS (
      SELECT 1 FROM attribute_value sv
      WHERE sv.card_id = s.id AND sv.attribute_def_id = _slug_def
        AND sv.value #>> '{}' = 'comms'
    )
    AND EXISTS (
      SELECT 1 FROM attribute_value pv
      WHERE pv.card_id = f.id AND pv.attribute_def_id = _pred_def
        AND pv.value #>> '{}' = '{"attr":"comms","op":"exists"}'
    );
  IF _dead IS NULL THEN
    RETURN;
  END IF;
  -- attribute_value first (its last_activity_id FKs activity), then activity,
  -- then the card row itself.
  DELETE FROM attribute_value WHERE card_id = ANY(_dead);
  DELETE FROM activity        WHERE card_id = ANY(_dead);
  DELETE FROM card            WHERE id      = ANY(_dead);
END $$;`,
	},
	{
		// Migration 0003 flipped comms screens list→comms by SLUG, gated once.
		// A project stamped AFTER 0003 ran (from a pre-comms-layout template, or
		// any legacy straggler) can still carry a comms screen at layout 'list'
		// — which renders the task Inbox while the filter bar scopes to `comm`,
		// the exact body/filter mismatch that returns zero rows. Re-assert the
		// invariant FLOW-DRIVEN (not by slug, so a renamed comms screen is also
		// caught): any `screen` at layout 'list' whose `flow_ref` governs the
		// `comm_status` attribute lists comms, so its body MUST be the CardListBody
		// (layout 'comms'). Idempotent: fresh seeds already ship layout 'comms'
		// (no 'list' row matches) and a re-run finds nothing left to flip.
		id: "0007_comms_screen_layout_by_flow",
		sql: `
DO $$
DECLARE
  _layout_def   bigint := (SELECT id FROM attribute_def WHERE name = 'layout');
  _flow_ref_def bigint := (SELECT id FROM attribute_def WHERE name = 'flow_ref');
  _comm_status  bigint := (SELECT id FROM attribute_def WHERE name = 'comm_status');
  _screen_ct    bigint := (SELECT id FROM card_type WHERE name = 'screen');
BEGIN
  IF _layout_def IS NULL OR _flow_ref_def IS NULL OR _comm_status IS NULL OR _screen_ct IS NULL THEN
    RETURN;
  END IF;
  UPDATE attribute_value lav
  SET value = to_jsonb('comms'::text)
  WHERE lav.attribute_def_id = _layout_def
    AND lav.value #>> '{}' = 'list'
    AND EXISTS (
      SELECT 1
      FROM card c
      JOIN attribute_value fv ON fv.card_id = c.id
        AND fv.attribute_def_id = _flow_ref_def
        AND jsonb_typeof(fv.value) = 'number'
      JOIN flow f ON f.id = (fv.value)::text::bigint
      WHERE c.id = lav.card_id
        AND c.card_type_id = _screen_ct
        AND f.attribute_def_id = _comm_status
    );
END $$;`,
	},
	{
		// attribute_value.value_type_id — denormalized storage-class id so the
		// value indexes can partition structured (JSONB → (attribute_def_id,
		// value) btree, <1000) from text (→ trigram, >=1000). Without it a large
		// markdown `description` overflows the 2704-byte btree tuple cap and the
		// write fails with an opaque "internal error". The column is bootstrapped
		// before the generated DDL (see preDDL) and kept correct on new rows by
		// the attribute_value_set_type_id trigger; here we backfill existing rows,
		// enforce NOT NULL, and swap both indexes to their partitioned form.
		//
		// The index DROP/CREATE below is the deliberate, narrow exception to the
		// "no index DDL in migrations" rule (see the type doc): replacing an index
		// PREDICATE is impossible via the declarative CREATE INDEX IF NOT EXISTS
		// (it skips an already-named index), so the swap must run once here. Each
		// swap is guarded on pg_indexes.indexdef, so it's a no-op once the partial
		// form is present (every fresh DB, and re-runs).
		// Plain top-level statements (no DO block): index DROP/CREATE inside a
		// plpgsql block with an intervening pg_indexes scan can reference a
		// just-dropped index via a cached plan ("could not open relation with
		// OID"). The swaps are unconditional but idempotent — DROP IF EXISTS
		// then CREATE always lands on the partitioned form; on a fresh DB this
		// rebuilds the (small, just-seeded) index once, which is harmless.
		id: "0008_attribute_value_type_id",
		sql: `
UPDATE attribute_value av
   SET value_type_id = av_value_type_id(ad.value_type)
  FROM attribute_def ad
 WHERE ad.id = av.attribute_def_id
   AND av.value_type_id IS NULL;

ALTER TABLE attribute_value ALTER COLUMN value_type_id SET NOT NULL;

DROP INDEX IF EXISTS attribute_value_def_value;
CREATE INDEX attribute_value_def_value
  ON attribute_value (attribute_def_id, value)
  WHERE value_type_id < 1000;

DROP INDEX IF EXISTS attribute_value_trgm;
CREATE INDEX attribute_value_trgm
  ON attribute_value USING gin ((value::text) gin_trgm_ops)
  WHERE value_type_id >= 1000;`,
	},
	{
		// Personal notification subscriptions (email activity sinks). The
		// seed.hcsv rows reach fresh installs only, so add them here too:
		//   1. activity_sink_state.pending_since — the per-unit rollup clock
		//      (additive column; the pump reads it every tick),
		//   2. the activity_subscription card_type (parent: activity_sink),
		//   3. the subscriber / rollup_minutes attribute_defs,
		//   4. edges: channel_ref / rollup_minutes / predicate on
		//      activity_sink, and the seven subscription edges,
		//   5. the activity_subscription.set / .delete processes + steps,
		//   6. grants: every tier on the two subscription processes, and
		//      admin card.* on the new card_type.
		// Idempotent — ADD COLUMN IF NOT EXISTS + ON CONFLICT DO NOTHING make
		// it a no-op on a fresh DB whose seed already carries every row.
		id: "0009_activity_subscriptions",
		sql: `
ALTER TABLE activity_sink_state ADD COLUMN IF NOT EXISTS pending_since timestamptz;

DO $$
DECLARE
  _sink_ct   bigint := (SELECT id FROM card_type WHERE name = 'activity_sink');
  _person_ct bigint := (SELECT id FROM card_type WHERE name = 'person');
  _sub_ct    bigint;
  _set_proc  bigint;
  _del_proc  bigint;
BEGIN
  IF _sink_ct IS NULL OR _person_ct IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO card_type (name, parent_card_type_id, allow_self_parent, is_built_in, uses_phase)
  VALUES ('activity_subscription', _sink_ct, false, true, false)
  ON CONFLICT (name) DO NOTHING;
  SELECT id INTO _sub_ct FROM card_type WHERE name = 'activity_subscription';

  INSERT INTO attribute_def (name, value_type, target_card_type_id, is_built_in, enum_managed)
  VALUES ('subscriber', 'card_ref', _person_ct, true, false),
         ('rollup_minutes', 'number', NULL, true, false)
  ON CONFLICT (name) DO NOTHING;

  INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
  SELECT e.ct, ad.id, e.req, e.ord
  FROM (VALUES
    (_sink_ct, 'channel_ref',          false, 9),
    (_sink_ct, 'rollup_minutes',       false, 10),
    (_sink_ct, 'predicate',            false, 11),
    (_sub_ct,  'title',                true,  0),
    (_sub_ct,  'subscriber',           true,  1),
    (_sub_ct,  'activity_filter',      false, 2),
    (_sub_ct,  'predicate',            false, 3),
    (_sub_ct,  'rollup_minutes',       false, 4),
    (_sub_ct,  'channel_status',       false, 5),
    (_sub_ct,  'channel_fault_reason', false, 6)
  ) AS e(ct, attr, req, ord)
  JOIN attribute_def ad ON ad.name = e.attr
  ON CONFLICT (card_type_id, attribute_def_id) DO NOTHING;

  INSERT INTO process (name)
  VALUES ('activity_subscription.set'), ('activity_subscription.delete')
  ON CONFLICT (name) DO NOTHING;
  SELECT id INTO _set_proc FROM process WHERE name = 'activity_subscription.set';
  SELECT id INTO _del_proc FROM process WHERE name = 'activity_subscription.delete';

  INSERT INTO process_step (process_id, ordinal, endpoint, action)
  VALUES (_set_proc, 1, 'activity_subscription', 'set'),
         (_del_proc, 1, 'activity_subscription', 'delete')
  ON CONFLICT (process_id, ordinal) DO NOTHING;

  INSERT INTO role_grant (role_id, card_type_id, process_id)
  SELECT r.id, _sub_ct, p.id
  FROM role r
  CROSS JOIN process p
  WHERE r.name IN ('viewer', 'commenter', 'worker', 'manager', 'admin')
    AND p.id IN (_set_proc, _del_proc)
  ON CONFLICT (role_id, card_type_id, process_id) DO NOTHING;

  INSERT INTO role_grant (role_id, card_type_id, process_id)
  SELECT r.id, _sub_ct, p.id
  FROM role r
  CROSS JOIN process p
  WHERE r.name = 'admin'
    AND p.name IN ('card.create', 'card.update', 'card.delete', 'comment.post', 'user_card_sort.set')
  ON CONFLICT (role_id, card_type_id, process_id) DO NOTHING;
END $$;`,
	},
	{
		// attribute_def.target_filter — the per-attribute "which cards may be
		// chosen" predicate (card_filter_ids). Additive column + the assignee
		// rule from seed.hcsv: no contact and no disabled person can be
		// newly assigned. Idempotent — ADD COLUMN IF NOT EXISTS, and the
		// UPDATE only fills a NULL filter (a fresh seed already set it).
		id: "0010_attribute_target_filter",
		sql: `
ALTER TABLE attribute_def ADD COLUMN IF NOT EXISTS target_filter jsonb;

UPDATE attribute_def
   SET target_filter = '{"connective":"and","children":[{"attr":"person_kind","op":"!=","values":["contact"]},{"attr":"is_active","op":"!=","values":[false]}]}'::jsonb
 WHERE name = 'assignee' AND target_filter IS NULL;`,
	},
	{
		// Task links (code changes / issues / any URL hung off a task; written
		// by link.set from the UI, MCP, or a forge such as Gerrit). The
		// seed.hcsv rows reach fresh installs only, so add them here too:
		//   1. the link card_type (parent: task),
		//   2. the link_url / link_kind / link_state attribute_defs,
		//   3. the four link edges (title / link_url required),
		//   4. admin card.* on link (link.set / link.delete themselves gate on
		//      card.update of the parent task, so no new process or grant).
		// Idempotent — ON CONFLICT DO NOTHING makes it a no-op on a fresh DB
		// whose seed already carries every row.
		id: "0011_task_links",
		sql: `
DO $$
DECLARE
  _task_ct bigint := (SELECT id FROM card_type WHERE name = 'task');
  _link_ct bigint;
BEGIN
  IF _task_ct IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO card_type (name, parent_card_type_id, allow_self_parent, is_built_in, uses_phase)
  VALUES ('link', _task_ct, false, true, false)
  ON CONFLICT (name) DO NOTHING;
  SELECT id INTO _link_ct FROM card_type WHERE name = 'link';

  INSERT INTO attribute_def (name, value_type, target_card_type_id, is_built_in, enum_managed)
  VALUES ('link_url', 'text', NULL, true, false),
         ('link_kind', 'text', NULL, true, false),
         ('link_state', 'text', NULL, true, false)
  ON CONFLICT (name) DO NOTHING;

  INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
  SELECT _link_ct, ad.id, e.req, e.ord
  FROM (VALUES
    ('title',      true,  0),
    ('link_url',   true,  1),
    ('link_kind',  false, 2),
    ('link_state', false, 3)
  ) AS e(attr, req, ord)
  JOIN attribute_def ad ON ad.name = e.attr
  ON CONFLICT (card_type_id, attribute_def_id) DO NOTHING;

  INSERT INTO role_grant (role_id, card_type_id, process_id)
  SELECT r.id, _link_ct, p.id
  FROM role r
  CROSS JOIN process p
  WHERE r.name = 'admin'
    AND p.name IN ('card.create', 'card.update', 'card.delete', 'comment.post', 'user_card_sort.set')
  ON CONFLICT (role_id, card_type_id, process_id) DO NOTHING;
END $$;`,
	},
	{
		// user_token.scope — '' (unrestricted) or 'links' (forge link hook
		// only). Additive column: the declarative CREATE TABLE can't add it
		// to an existing user_token, and the token lookup reads it on every
		// bearer request. Existing tokens default to '' (unchanged power).
		id:  "0012_user_token_scope",
		sql: `ALTER TABLE user_token ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT ''`,
	},
	{
		// Task approval requests (documentation, not a gate: a request names
		// people to vote approve or reject on one of the task's status
		// steps; votes are approval_decision activity rows on the task). The
		// seed.hcsv rows reach fresh installs only, so add them here too:
		//   1. the approval card_type (parent: task),
		//   2. its attribute_defs (approvers carries assignee's target_filter:
		//      no contacts, no inactive people) and edges,
		//   3. admin card.* on approval (approval.set / .remove / .decide gate
		//      on the parent task, so no new process or grant),
		//   4. on every live Inbox screen: the Approvals column (extra_columns
		//      gains "approvals") and a "Waiting on my vote" view (a filter
		//      card, not the screen's default).
		// Idempotent — ON CONFLICT / NOT EXISTS make it a no-op on a fresh DB
		// whose seed already carries every row.
		id: "0013_task_approvals",
		sql: `
DO $$
DECLARE
  _task_ct bigint := (SELECT id FROM card_type WHERE name = 'task');
  _screen_ct bigint := (SELECT id FROM card_type WHERE name = 'screen');
  _filter_ct bigint := (SELECT id FROM card_type WHERE name = 'filter');
  _status_ct bigint := (SELECT id FROM card_type WHERE name = 'status');
  _person_ct bigint := (SELECT id FROM card_type WHERE name = 'person');
  _title_def bigint := (SELECT id FROM attribute_def WHERE name = 'title');
  _slug_def bigint := (SELECT id FROM attribute_def WHERE name = 'slug');
  _predicate_def bigint := (SELECT id FROM attribute_def WHERE name = 'predicate');
  _sort_def bigint := (SELECT id FROM attribute_def WHERE name = 'sort');
  _extra_def bigint := (SELECT id FROM attribute_def WHERE name = 'extra_columns');
  _approval_ct bigint;
  _inbox record;
  _cols jsonb;
  _view bigint;
BEGIN
  IF _task_ct IS NULL OR _screen_ct IS NULL OR _filter_ct IS NULL OR _status_ct IS NULL
     OR _person_ct IS NULL OR _title_def IS NULL OR _slug_def IS NULL
     OR _predicate_def IS NULL OR _sort_def IS NULL OR _extra_def IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO card_type (name, parent_card_type_id, allow_self_parent, is_built_in, uses_phase)
  VALUES ('approval', _task_ct, false, true, false)
  ON CONFLICT (name) DO NOTHING;
  SELECT id INTO _approval_ct FROM card_type WHERE name = 'approval';

  INSERT INTO attribute_def (name, value_type, target_card_type_id, is_built_in, enum_managed, target_filter)
  VALUES ('approval_from',   'card_ref',   _status_ct, true, false, NULL),
         ('approval_to',     'card_ref',   _status_ct, true, false, NULL),
         ('approval_action', 'text',       NULL,       true, false, NULL),
         ('approvers',       'card_ref[]', _person_ct, true, false,
          '{"connective":"and","children":[{"attr":"person_kind","op":"!=","values":["contact"]},{"attr":"is_active","op":"!=","values":[false]}]}'::jsonb),
         ('approval_note',   'text',       NULL,       true, false, NULL)
  ON CONFLICT (name) DO NOTHING;

  INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
  SELECT _approval_ct, ad.id, e.req, e.ord
  FROM (VALUES
    ('title',           true,  0),
    ('approval_from',   true,  1),
    ('approval_to',     true,  2),
    ('approval_action', true,  3),
    ('approvers',       true,  4),
    ('approval_note',   false, 5)
  ) AS e(attr, req, ord)
  JOIN attribute_def ad ON ad.name = e.attr
  ON CONFLICT (card_type_id, attribute_def_id) DO NOTHING;

  INSERT INTO role_grant (role_id, card_type_id, process_id)
  SELECT r.id, _approval_ct, p.id
  FROM role r
  CROSS JOIN process p
  WHERE r.name = 'admin'
    AND p.name IN ('card.create', 'card.update', 'card.delete', 'comment.post', 'user_card_sort.set')
  ON CONFLICT (role_id, card_type_id, process_id) DO NOTHING;

  FOR _inbox IN
    SELECT c.id, ec.value AS extra
    FROM card c
    JOIN attribute_value slug ON slug.card_id = c.id AND slug.attribute_def_id = _slug_def
    LEFT JOIN attribute_value ec ON ec.card_id = c.id AND ec.attribute_def_id = _extra_def
    WHERE c.card_type_id = _screen_ct
      AND c.deleted_at IS NULL
      AND slug.value = to_jsonb('inbox'::text)
  LOOP
    -- The Approvals column: extra_columns is a JSON list stored as text. A
    -- value that isn't a JSON list is left alone.
    IF _inbox.extra IS NULL THEN
      INSERT INTO attribute_value (card_id, attribute_def_id, value)
      VALUES (_inbox.id, _extra_def, to_jsonb('["approvals"]'::text));
    ELSE
      BEGIN
        _cols := (_inbox.extra #>> '{}')::jsonb;
      EXCEPTION WHEN invalid_text_representation THEN
        _cols := NULL;
      END;
      IF jsonb_typeof(_cols) = 'array' AND NOT _cols ? 'approvals' THEN
        UPDATE attribute_value
        SET value = to_jsonb((_cols || '["approvals"]'::jsonb)::text)
        WHERE card_id = _inbox.id AND attribute_def_id = _extra_def;
      END IF;
    END IF;

    -- The "Waiting on my vote" view, unless the screen already has one.
    IF NOT EXISTS (
      SELECT 1
      FROM card f
      JOIN attribute_value ft ON ft.card_id = f.id AND ft.attribute_def_id = _title_def
      WHERE f.parent_card_id = _inbox.id
        AND f.card_type_id = _filter_ct
        AND f.deleted_at IS NULL
        AND ft.value = to_jsonb('Waiting on my vote'::text)
    ) THEN
      INSERT INTO card (card_type_id, parent_card_id)
      VALUES (_filter_ct, _inbox.id)
      RETURNING id INTO _view;
      INSERT INTO attribute_value (card_id, attribute_def_id, value)
      VALUES (_view, _title_def, to_jsonb('Waiting on my vote'::text)),
             (_view, _predicate_def,
              to_jsonb('{"attr":"approval_waiting_on","op":"in","values":["@me"]}'::text)),
             (_view, _sort_def, to_jsonb('[{"attr":"approval_asked_at","dir":"asc"}]'::text));
    END IF;
  END LOOP;
END $$;`,
	},
	{
		// approval_comm — the email thread (a comm card on the same task)
		// that approval.set started when the asker chose to email the
		// people asked. A link only: the thread and the request live on
		// separately. The seed.hcsv rows reach fresh installs only, so add
		// the attribute_def and its edge here too. Idempotent — ON CONFLICT
		// DO NOTHING makes it a no-op on a fresh DB whose seed has them.
		id: "0014_approval_comm",
		sql: `
DO $$
DECLARE
  _approval_ct bigint := (SELECT id FROM card_type WHERE name = 'approval');
  _comm_ct bigint := (SELECT id FROM card_type WHERE name = 'comm');
BEGIN
  IF _approval_ct IS NULL OR _comm_ct IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO attribute_def (name, value_type, target_card_type_id, is_built_in, enum_managed)
  VALUES ('approval_comm', 'card_ref', _comm_ct, true, false)
  ON CONFLICT (name) DO NOTHING;

  INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
  SELECT _approval_ct, ad.id, false, 6
  FROM attribute_def ad
  WHERE ad.name = 'approval_comm'
  ON CONFLICT (card_type_id, attribute_def_id) DO NOTHING;
END $$;`,
	},
	{
		// Feature bundles + publishing. The seed.hcsv rows reach fresh
		// installs only, so add them here too:
		//   1. the page card_type (parent: project, self-parenting so a
		//      page's children are its section) and the global portal
		//      card_type,
		//   2. bundle_key (marks a bundle's hidden source project),
		//      publish_status (a page's flow-bound status), publishes_to (the
		//      portals a status publishes to), portal_host / portal_root /
		//      portal_public, and their edges (pages reuse title,
		//      description, slug and sort_order),
		//   3. grants: worker / manager write pages, a manager deletes them,
		//      admins get card.* on page and portal.
		// The bundle / publication / portal tables are declarative DDL, and
		// the bundles themselves are materialised by ApplySchema's bundle
		// tier — neither needs a migration. Idempotent — ON CONFLICT DO
		// NOTHING makes it a no-op on a fresh DB whose seed has every row.
		id: "0015_bundles_portals",
		sql: `
DO $$
DECLARE
  _project_ct bigint := (SELECT id FROM card_type WHERE name = 'project');
  _status_ct bigint := (SELECT id FROM card_type WHERE name = 'status');
  _page_ct bigint;
  _portal_ct bigint;
BEGIN
  IF _project_ct IS NULL OR _status_ct IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO card_type (name, parent_card_type_id, allow_self_parent, is_built_in, uses_phase)
  VALUES ('page', _project_ct, true, true, false),
         ('portal', NULL, false, true, false)
  ON CONFLICT (name) DO NOTHING;
  _page_ct := (SELECT id FROM card_type WHERE name = 'page');
  _portal_ct := (SELECT id FROM card_type WHERE name = 'portal');

  INSERT INTO attribute_def (name, value_type, target_card_type_id, is_built_in, enum_managed)
  VALUES ('bundle_key',     'text',       NULL,       true, false),
         ('publish_status', 'card_ref',   _status_ct, true, false),
         ('publishes_to',   'card_ref[]', _portal_ct, true, false),
         ('portal_host',    'text',       NULL,       true, false),
         ('portal_root',    'card_ref',   _page_ct,   true, false),
         ('portal_public',  'bool',       NULL,       true, false)
  ON CONFLICT (name) DO NOTHING;

  INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
  SELECT ct.id, ad.id, v.req, v.ord
  FROM (VALUES
    ('project', 'bundle_key',     false, 7),
    ('status',  'publishes_to',   false, 2),
    ('page',    'title',          true,  0),
    ('page',    'publish_status', true,  1),
    ('page',    'slug',           false, 2),
    ('page',    'sort_order',     false, 3),
    ('page',    'description',    false, 4),
    ('portal',  'title',          true,  0),
    ('portal',  'portal_root',    false, 1),
    ('portal',  'portal_host',    false, 2),
    ('portal',  'portal_public',  false, 3)
  ) AS v(ct, attr, req, ord)
  JOIN card_type ct ON ct.name = v.ct
  JOIN attribute_def ad ON ad.name = v.attr
  ON CONFLICT (card_type_id, attribute_def_id) DO NOTHING;

  INSERT INTO role_grant (role_id, card_type_id, process_id)
  SELECT r.id, ct.id, p.id
  FROM (VALUES
    ('worker',  'page',   'card.create'),
    ('worker',  'page',   'card.update'),
    ('worker',  'page',   'comment.post'),
    ('worker',  'page',   'user_card_sort.set'),
    ('manager', 'page',   'card.create'),
    ('manager', 'page',   'card.update'),
    ('manager', 'page',   'comment.post'),
    ('manager', 'page',   'user_card_sort.set'),
    ('manager', 'page',   'card.delete'),
    ('admin',   'page',   'card.create'),
    ('admin',   'page',   'card.update'),
    ('admin',   'page',   'card.delete'),
    ('admin',   'page',   'comment.post'),
    ('admin',   'page',   'user_card_sort.set'),
    ('admin',   'portal', 'card.create'),
    ('admin',   'portal', 'card.update'),
    ('admin',   'portal', 'card.delete'),
    ('admin',   'portal', 'comment.post'),
    ('admin',   'portal', 'user_card_sort.set')
  ) AS v(role, ct, proc)
  JOIN role r ON r.name = v.role
  JOIN card_type ct ON ct.name = v.ct
  JOIN process p ON p.name = v.proc
  ON CONFLICT (role_id, card_type_id, process_id) DO NOTHING;
END $$;`,
	},
	{
		// Portal themes, navigation and in-kitp sites. The seed.hcsv rows
		// reach fresh installs only, so add them here too:
		//   1. the global theme card_type (a site's look: a built-in base
		//      theme plus settings; its files live in theme_file),
		//   2. portal_theme / portal_internal (a portal's theme and its
		//      "Show in kitp" switch), nav_hidden / nav_hide_children (a
		//      page left out of a site's navigation, or its children),
		//      theme_base / theme_nav / theme_accent / theme_footer, and
		//      their edges,
		//   3. admin card.* on theme (like portal),
		//   4. the publication snapshot's nav_hidden / nav_hide_children
		//      columns (additive; CREATE TABLE IF NOT EXISTS can't add them).
		// theme_file is declarative DDL. Idempotent — ON CONFLICT DO NOTHING
		// and ADD COLUMN IF NOT EXISTS make it a no-op on a fresh DB.
		id: "0016_portal_themes",
		sql: `
ALTER TABLE publication ADD COLUMN IF NOT EXISTS nav_hidden boolean NOT NULL DEFAULT false;
ALTER TABLE publication ADD COLUMN IF NOT EXISTS nav_hide_children boolean NOT NULL DEFAULT false;
DO $$
DECLARE
  _theme_ct bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM card_type WHERE name = 'portal') THEN
    RETURN;
  END IF;

  INSERT INTO card_type (name, parent_card_type_id, allow_self_parent, is_built_in, uses_phase)
  VALUES ('theme', NULL, false, true, false)
  ON CONFLICT (name) DO NOTHING;
  _theme_ct := (SELECT id FROM card_type WHERE name = 'theme');

  INSERT INTO attribute_def (name, value_type, target_card_type_id, is_built_in, enum_managed)
  VALUES ('portal_theme',      'card_ref', _theme_ct, true, false),
         ('portal_internal',   'bool',     NULL,      true, false),
         ('nav_hidden',        'bool',     NULL,      true, false),
         ('nav_hide_children', 'bool',     NULL,      true, false),
         ('theme_base',        'text',     NULL,      true, false),
         ('theme_nav',         'text',     NULL,      true, false),
         ('theme_accent',      'text',     NULL,      true, false),
         ('theme_footer',      'text',     NULL,      true, false)
  ON CONFLICT (name) DO NOTHING;

  INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
  SELECT ct.id, ad.id, v.req, v.ord
  FROM (VALUES
    ('page',   'nav_hidden',        false, 5),
    ('page',   'nav_hide_children', false, 6),
    ('portal', 'portal_theme',      false, 4),
    ('portal', 'portal_internal',   false, 5),
    ('theme',  'title',             true,  0),
    ('theme',  'theme_base',        true,  1),
    ('theme',  'theme_nav',         false, 2),
    ('theme',  'theme_accent',      false, 3),
    ('theme',  'theme_footer',      false, 4)
  ) AS v(ct, attr, req, ord)
  JOIN card_type ct ON ct.name = v.ct
  JOIN attribute_def ad ON ad.name = v.attr
  ON CONFLICT (card_type_id, attribute_def_id) DO NOTHING;

  INSERT INTO role_grant (role_id, card_type_id, process_id)
  SELECT r.id, _theme_ct, p.id
  FROM role r
  CROSS JOIN process p
  WHERE r.name = 'admin'
    AND p.name IN ('card.create', 'card.update', 'card.delete', 'comment.post', 'user_card_sort.set')
  ON CONFLICT (role_id, card_type_id, process_id) DO NOTHING;
END $$;`,
	},
	{
		// "Unpublish" means unpublish. A page that enters a Draft-phase
		// (triage) status now leaves every portal that status doesn't
		// publish to (publication_sync). Bring existing data in line:
		//   1. the publishing flow's Published → Draft step was labelled
		//      "Unpublish edits" (it used to keep the live copy); rename it
		//      wherever a bundle copied it,
		//   2. pages already sitting in a triage-phase status come off the
		//      portals that status doesn't publish to (those portals rebuild).
		// Idempotent — the rename finds nothing a second time, and a fresh
		// DB has no publications.
		id: "0017_draft_unpublishes",
		sql: `
UPDATE flow_step fs
SET label = 'Unpublish'
WHERE fs.label = 'Unpublish edits'
  AND EXISTS (SELECT 1 FROM card s WHERE s.id = fs.to_card_id AND s.phase = 'triage');
DO $$
DECLARE
  _r record;
BEGIN
  FOR _r IN
    SELECT p.portal_id, p.card_id
    FROM publication p
    JOIN attribute_value sv ON sv.card_id = p.card_id
    JOIN attribute_def sd ON sd.id = sv.attribute_def_id AND sd.name = 'publish_status'
    JOIN card s ON s.id = CASE
                            WHEN jsonb_typeof(sv.value) = 'number' THEN (sv.value)::text::bigint
                            WHEN (sv.value #>> '{}') ~ '^\d+$' THEN (sv.value #>> '{}')::bigint
                          END
    WHERE s.phase = 'triage'
      AND NOT EXISTS (
        SELECT 1
        FROM attribute_value pv
        JOIN attribute_def pd ON pd.id = pv.attribute_def_id AND pd.name = 'publishes_to'
        WHERE pv.card_id = s.id
          AND jsonb_typeof(pv.value) = 'array'
          AND (pv.value @> jsonb_build_array(p.portal_id::text) OR pv.value @> jsonb_build_array(p.portal_id)))
  LOOP
    DELETE FROM publication WHERE portal_id = _r.portal_id AND card_id = _r.card_id;
    PERFORM portal_mark_dirty(_r.portal_id);
  END LOOP;
END $$;`,
	},
	{
		// Mail account settings (docs/CONVERSATIONS.md): intake_mode — what
		// new mail does (task | thread | ignore) — and reply_quote — whether
		// replies quote the conversation (off | last | all). The seed.hcsv
		// rows reach fresh installs only, so add the attribute_defs and
		// their comm_channel edges here too. Existing accounts keep their
		// behaviour: no intake_mode reads as before (task with an intake
		// status, else ignore). Idempotent — ON CONFLICT DO NOTHING.
		id: "0018_comm_channel_modes",
		sql: `
INSERT INTO attribute_def (name, value_type, target_card_type_id, is_built_in, enum_managed)
VALUES ('intake_mode', 'text', NULL, true, false),
       ('reply_quote', 'text', NULL, true, false)
ON CONFLICT (name) DO NOTHING;
INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
SELECT ct.id, ad.id, false, v.ord
FROM (VALUES ('intake_mode', 13), ('reply_quote', 14)) AS v(attr, ord)
JOIN card_type ct ON ct.name = 'comm_channel'
JOIN attribute_def ad ON ad.name = v.attr
ON CONFLICT (card_type_id, attribute_def_id) DO NOTHING;`,
	},
	{
		// bundle_key is server-owned (review A2): only the bundle files set
		// it, on the source projects the catalog records, and boot trusts
		// it. attribute.update and card.insert now refuse it; this drops
		// any bundle_key a handler wrote before that onto a project that
		// isn't a recorded source, so nothing else looks like one. Runs
		// before the bundle tier; on a fresh DB nothing carries it yet.
		// Idempotent — a second run finds nothing.
		id: "0019_bundle_key_server_owned",
		sql: `
DELETE FROM attribute_value av
USING attribute_def ad
WHERE ad.id = av.attribute_def_id AND ad.name = 'bundle_key'
  AND NOT EXISTS (SELECT 1 FROM bundle b WHERE b.source_project_id = av.card_id);`,
	},
	{
		// Portal builds back off after a failure (review A7): a portal that
		// keeps failing was rebuilt every tick, each time reading all its
		// attachments. portal_state gains fail_count / failed_at; the
		// builder waits 5 s × 2^fail_count (capped at an hour) after a
		// failure. CREATE TABLE IF NOT EXISTS can't add columns to an
		// existing table, hence this; ADD COLUMN IF NOT EXISTS makes it a
		// no-op on a fresh DB.
		id: "0020_portal_build_backoff",
		sql: `
ALTER TABLE portal_state ADD COLUMN IF NOT EXISTS fail_count int NOT NULL DEFAULT 0;
ALTER TABLE portal_state ADD COLUMN IF NOT EXISTS failed_at timestamptz;`,
	},
	{
		// Review B10: session.id and user_token.id held the bearer secrets
		// themselves, so anyone who could read those tables could sign in
		// as their users. They now hold auth.HashSecret of the secret; this
		// hashes the rows already there in place, so nobody is signed out
		// and every token keeps working. A value that is already a hash
		// (64 hex digits — the raw secrets are 43-character base64url) is
		// left alone, so the statement is safe to run again.
		id: "0021_hash_session_token_ids",
		sql: `
UPDATE session SET id = encode(sha256(convert_to(id, 'UTF8')), 'hex')
WHERE id !~ '^[0-9a-f]{64}$';
UPDATE user_token SET id = encode(sha256(convert_to(id, 'UTF8')), 'hex')
WHERE id !~ '^[0-9a-f]{64}$';`,
	},
	{
		// Review B8: the OIDC callback checks the id_token's nonce against
		// the one its start sent. A sign-in already under way when this
		// runs has '' and is let through on state alone (for the ten
		// minutes such a row lives).
		id:  "0022_oidc_state_nonce",
		sql: `ALTER TABLE oidc_state ADD COLUMN IF NOT EXISTS nonce text NOT NULL DEFAULT '';`,
	},
	{
		// Dates are YYYY-MM-DD and nothing else (docs/MAIL_INTAKE_AND_CALENDARS.md
		// §1): attribute.update and card.insert now refuse anything else, but
		// nothing checked before, so the API or MCP could store any string in
		// due_date — and Overdue / Due soon / calendar feeds compare the ISO
		// text. A timestamp keeps its date part; anything else is cleared
		// (stored as JSON null, as attribute.update removes a value). Each
		// change writes an attr_update activity row by the System User, so
		// the old value stays in the task's history. Idempotent — a second
		// run finds only valid dates.
		id: "0023_due_date_iso",
		sql: `
DO $$
DECLARE
  _def bigint := (SELECT id FROM attribute_def WHERE name = 'due_date');
  _r   record;
  _new jsonb;
  _act bigint;
BEGIN
  IF _def IS NULL THEN
    RETURN;
  END IF;
  FOR _r IN
    SELECT av.card_id, av.value FROM attribute_value av
    WHERE av.attribute_def_id = _def
      AND jsonb_typeof(av.value) <> 'null'
      AND NOT (jsonb_typeof(av.value) = 'string' AND iso_date_ok(av.value #>> '{}'))
  LOOP
    _new := 'null'::jsonb;
    IF jsonb_typeof(_r.value) = 'string'
       AND (_r.value #>> '{}') ~ '^\d{4}-\d{2}-\d{2}[Tt ]'
       AND iso_date_ok(substr(_r.value #>> '{}', 1, 10)) THEN
      _new := to_jsonb(substr(_r.value #>> '{}', 1, 10));
    END IF;
    INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
    VALUES (_r.card_id, 'attr_update', _def, _r.value, _new, 1)
    RETURNING id INTO _act;
    UPDATE attribute_value SET value = _new, last_activity_id = _act
    WHERE card_id = _r.card_id AND attribute_def_id = _def;
  END LOOP;
END $$;`,
	},
	{
		// Calendar feeds (docs/MAIL_INTAKE_AND_CALENDARS.md §8). The seed rows
		// reach fresh installs only, so add them here too: the global
		// calendar card_type, the past_days / future_days attribute_defs,
		// its five edges (title, subscriber = the owner, predicate = the
		// card filter, the two windows) and admin card.* for clean-up (the
		// owner writes through calendar.set / .delete, which check it).
		// Idempotent — ON CONFLICT DO NOTHING throughout.
		id: "0024_calendars",
		sql: `
DO $$
DECLARE
  _cal bigint;
BEGIN
  INSERT INTO card_type (name, parent_card_type_id, allow_self_parent, is_built_in, uses_phase)
  VALUES ('calendar', NULL, false, true, false)
  ON CONFLICT (name) DO NOTHING;
  SELECT id INTO _cal FROM card_type WHERE name = 'calendar';

  INSERT INTO attribute_def (name, value_type, target_card_type_id, is_built_in, enum_managed)
  VALUES ('past_days', 'number', NULL, true, false),
         ('future_days', 'number', NULL, true, false)
  ON CONFLICT (name) DO NOTHING;

  INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
  SELECT _cal, ad.id, e.req, e.ord
  FROM (VALUES ('title', true, 0), ('subscriber', true, 1), ('predicate', false, 2),
               ('past_days', false, 3), ('future_days', false, 4)) AS e(attr, req, ord)
  JOIN attribute_def ad ON ad.name = e.attr
  ON CONFLICT (card_type_id, attribute_def_id) DO NOTHING;

  INSERT INTO role_grant (role_id, card_type_id, process_id)
  SELECT r.id, _cal, p.id
  FROM role r CROSS JOIN process p
  WHERE r.name = 'admin'
    AND p.name IN ('card.create', 'card.update', 'card.delete', 'comment.post', 'user_card_sort.set')
  ON CONFLICT (role_id, card_type_id, process_id) DO NOTHING;
END $$;`,
	},
	{
		// Two mail account settings and two message fields
		// (docs/MAIL_INTAKE_AND_CALENDARS.md, "Sending replies on" and
		// "Attachments from email"): relay_replies (on | off) sends an
		// emailed reply on to the rest of the thread; email_attachments
		// (keep | drop) keeps or drops files on incoming mail. A message
		// copy names its original in relay_of; attachments_left_off counts
		// the files a "drop" account didn't keep. The seed rows reach fresh
		// installs only. Existing accounts get no value, which reads as
		// off / keep: nothing they do changes until an admin switches it.
		// Idempotent — ON CONFLICT DO NOTHING.
		id: "0025_relay_and_email_attachments",
		sql: `
INSERT INTO attribute_def (name, value_type, target_card_type_id, is_built_in, enum_managed)
VALUES ('relay_replies', 'text', NULL, true, false),
       ('email_attachments', 'text', NULL, true, false),
       ('relay_of', 'number', NULL, true, false),
       ('attachments_left_off', 'number', NULL, true, false)
ON CONFLICT (name) DO NOTHING;
INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
SELECT ct.id, ad.id, false, v.ord
FROM (VALUES ('comm_channel', 'relay_replies', 15), ('comm_channel', 'email_attachments', 16),
             ('reply_body', 'relay_of', 6), ('reply_body', 'attachments_left_off', 7)) AS v(ct, attr, ord)
JOIN card_type ct ON ct.name = v.ct
JOIN attribute_def ad ON ad.name = v.attr
ON CONFLICT (card_type_id, attribute_def_id) DO NOTHING;`,
	},
	{
		// Watch lists (docs/WATCH_LISTS.md): an account's bookmark lists of
		// tasks and threads. The watch_list card_type (global, owned through
		// subscriber), its symbol attribute_def, its four edges and the
		// admin card.* grant reach fresh installs through the seed; this adds
		// them to existing ones. The watch_entry table is DDL. Each account's
		// Stars list is made the first time it lists its watch lists.
		// Idempotent — ON CONFLICT DO NOTHING throughout.
		id: "0026_watch_lists",
		sql: `
DO $$
DECLARE
  _wl bigint;
BEGIN
  INSERT INTO card_type (name, parent_card_type_id, allow_self_parent, is_built_in, uses_phase)
  VALUES ('watch_list', NULL, false, true, false)
  ON CONFLICT (name) DO NOTHING;
  SELECT id INTO _wl FROM card_type WHERE name = 'watch_list';

  INSERT INTO attribute_def (name, value_type, target_card_type_id, is_built_in, enum_managed)
  VALUES ('symbol', 'text', NULL, true, false)
  ON CONFLICT (name) DO NOTHING;

  INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
  SELECT _wl, ad.id, e.req, e.ord
  FROM (VALUES ('title', true, 0), ('subscriber', true, 1), ('symbol', false, 2),
               ('description', false, 3)) AS e(attr, req, ord)
  JOIN attribute_def ad ON ad.name = e.attr
  ON CONFLICT (card_type_id, attribute_def_id) DO NOTHING;

  INSERT INTO role_grant (role_id, card_type_id, process_id)
  SELECT r.id, _wl, p.id
  FROM role r CROSS JOIN process p
  WHERE r.name = 'admin'
    AND p.name IN ('card.create', 'card.update', 'card.delete', 'comment.post', 'user_card_sort.set')
  ON CONFLICT (role_id, card_type_id, process_id) DO NOTHING;
END $$;`,
	},
	{
		// Role ranks (role_covers): the built-in roles' grants nest, viewer <
		// commenter < worker < manager < admin, so an agent may use a role its
		// owner holds or ranks above — an admin-only owner's agent can work as
		// a worker. preDDL added the column (default 0); this sets the ranks
		// of the built-in roles on an existing install. Idempotent.
		id: "0027_role_rank",
		sql: `
UPDATE role r SET rank = v.rank
FROM (VALUES ('viewer', 1), ('commenter', 2), ('worker', 3), ('manager', 4), ('admin', 5)) AS v(name, rank)
WHERE r.name = v.name AND r.rank <> v.rank;`,
	},
	{
		// Personal screens and views (docs/PERSONAL_SCREENS.md): the
		// list_card_type (task | comm) and my_default attribute_defs, the
		// screen's list_card_type and predicate edges and the filter's
		// my_default edge reach existing installs; watch lists made before
		// cards could be private become private to their subscriber; and the
		// function account_person replaced (watch_owner) goes. preDDL added
		// card.private_to. Idempotent.
		id: "0028_personal_screens",
		sql: `
INSERT INTO attribute_def (name, value_type, target_card_type_id, is_built_in, enum_managed)
VALUES ('list_card_type', 'text', NULL, true, false),
       ('my_default', 'bool', NULL, true, false)
ON CONFLICT (name) DO NOTHING;
INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
SELECT ct.id, ad.id, false, v.ord
FROM (VALUES ('screen', 'list_card_type', 13), ('screen', 'predicate', 14),
             ('filter', 'my_default', 7)) AS v(ct, attr, ord)
JOIN card_type ct ON ct.name = v.ct
JOIN attribute_def ad ON ad.name = v.attr
ON CONFLICT (card_type_id, attribute_def_id) DO NOTHING;
UPDATE card c SET private_to = (av.value)::text::bigint
FROM attribute_value av, attribute_def ad, card_type ct
WHERE ct.id = c.card_type_id AND ct.name = 'watch_list'
  AND av.card_id = c.id AND av.attribute_def_id = ad.id AND ad.name = 'subscriber'
  AND jsonb_typeof(av.value) = 'number' AND c.private_to IS NULL;
DROP FUNCTION IF EXISTS watch_owner(bigint);`,
	},
	{
		// The first-admin marker (DI-2): an install that already has an admin
		// is past its bootstrap, so record it — otherwise, if every admin
		// later lost the role, the next sign-in would be made admin.
		// Idempotent.
		id: "0029_admin_bootstrap",
		sql: `
INSERT INTO admin_bootstrap (singleton, user_id)
SELECT true, (SELECT min(ur.user_id) FROM user_role ur JOIN role r ON r.id = ur.role_id
              WHERE r.name = 'admin' AND ur.user_id <> 1)
WHERE EXISTS (SELECT 1 FROM user_role ur JOIN role r ON r.id = ur.role_id
              WHERE r.name = 'admin' AND ur.user_id <> 1)
ON CONFLICT (singleton) DO NOTHING;`,
	},
	{
		// The filter compilers learned who a tree is evaluated for
		// (card_compile_predicate's and watched_on's viewer person, review
		// 2026-11-03 #8, #15). The DDL creates the new signatures; the old
		// ones go, so nothing can call a watch-list check that ignores
		// whose lists they are. Idempotent.
		id: "0030_viewer_aware_filters",
		sql: `
DROP FUNCTION IF EXISTS watched_on(bigint, bigint[]);
DROP FUNCTION IF EXISTS card_compile_predicate(jsonb, jsonb, bigint[]);`,
	},
	{
		// A received message's Cc (reply_cc), kept like its To (reply_to):
		// the relay tells an address a message only named in To / Cc from
		// one that wrote or was written to (review 2026-11-03 #3). Messages
		// filed before keep no Cc. Idempotent — ON CONFLICT DO NOTHING.
		id: "0031_reply_cc",
		sql: `
INSERT INTO attribute_def (name, value_type, target_card_type_id, is_built_in, enum_managed)
VALUES ('reply_cc', 'text', NULL, true, false)
ON CONFLICT (name) DO NOTHING;
INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
SELECT ct.id, ad.id, false, 8
FROM card_type ct, attribute_def ad
WHERE ct.name = 'reply_body' AND ad.name = 'reply_cc'
ON CONFLICT (card_type_id, attribute_def_id) DO NOTHING;`,
	},
	{
		// The thread's people kitp itself confirmed for the relay (person
		// ids): those a person in kitp added and the person who started the
		// thread by mail (comm_confirm). Nothing a received message says
		// confirms anyone any more (review 2026-11-03 round 2 #1). Threads
		// filed before have none: their people get copies once someone
		// writes to them from kitp or adds them again. Idempotent.
		id: "0032_comm_confirmed",
		sql: `
INSERT INTO attribute_def (name, value_type, target_card_type_id, is_built_in, enum_managed)
SELECT 'comm_confirmed', 'card_ref[]', ct.id, true, false
FROM card_type ct WHERE ct.name = 'person'
ON CONFLICT (name) DO NOTHING;
INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
SELECT ct.id, ad.id, false, 7
FROM card_type ct, attribute_def ad
WHERE ct.name = 'comm' AND ad.name = 'comm_confirmed'
ON CONFLICT (card_type_id, attribute_def_id) DO NOTHING;`,
	},
	{
		// The people a person in kitp took off a thread (person ids,
		// comm_remove): mail they send later doesn't put them back on its
		// recipients (review 2026-11-03 round 3 #8). Idempotent.
		id: "0033_comm_removed",
		sql: `
INSERT INTO attribute_def (name, value_type, target_card_type_id, is_built_in, enum_managed)
SELECT 'comm_removed', 'card_ref[]', ct.id, true, false
FROM card_type ct WHERE ct.name = 'person'
ON CONFLICT (name) DO NOTHING;
INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
SELECT ct.id, ad.id, false, 8
FROM card_type ct, attribute_def ad
WHERE ct.name = 'comm' AND ad.name = 'comm_removed'
ON CONFLICT (card_type_id, attribute_def_id) DO NOTHING;`,
	},
	{
		// The (attribute_def_id, value) btree holds scalars only
		// (value_type_id < 50). card_ref[] lists (a thread's replies and
		// recipients) were in it too, and past about 700 ids one no longer
		// fit its 2704-byte entry: the thread stopped taking mail (review
		// 2026-11-03 round 3 #6). Lists are matched by containment
		// (attribute_value_refs GIN), never through this btree. Like 0008,
		// a predicate can only change by rebuilding the index, so this is
		// the narrow exception to "no index DDL in migrations"; DROP IF
		// EXISTS + CREATE lands on the new form whatever was there (a fresh
		// DB rebuilds its small index once).
		id: "0034_attribute_value_btree_scalars",
		sql: `
DROP INDEX IF EXISTS attribute_value_def_value;
CREATE INDEX attribute_value_def_value
  ON attribute_value (attribute_def_id, value)
  WHERE value_type_id < 50;`,
	},
	{
		// Threads whose task moved to another project before task.move
		// repointed them still send from the old project's account, and
		// reply.post now refuses them (no_mail_account). Repoint each to
		// its project's account (project_mail_account); with none there,
		// drop the link and fail the mail queued on it, as task.move does
		// (review 2026-11-03 round 3 #10). Idempotent: once repointed, a
		// thread's account is in its own project.
		id: "0035_moved_threads_mail_account",
		sql: `
CREATE TEMP TABLE moved_thread ON COMMIT DROP AS
SELECT cm.id AS comm_id, project_mail_account(card_enclosing_project(cm.id)) AS dest
FROM card cm
JOIN card_type ct ON ct.id = cm.card_type_id AND ct.name = 'comm'
JOIN attribute_value cr ON cr.card_id = cm.id
 AND cr.attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'channel_ref')
 AND jsonb_typeof(cr.value) = 'number'
JOIN card ch ON ch.id = (cr.value)::text::bigint
WHERE cm.deleted_at IS NULL
  AND ch.parent_card_id IS DISTINCT FROM card_enclosing_project(cm.id);
UPDATE attribute_value av SET value = to_jsonb(m.dest)
FROM moved_thread m
WHERE m.dest IS NOT NULL AND av.card_id = m.comm_id
  AND av.attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'channel_ref');
UPDATE attribute_value ds SET value = to_jsonb('failed'::text)
FROM moved_thread m, attribute_value rep
WHERE m.dest IS NULL AND rep.card_id = m.comm_id
  AND rep.attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'replies')
  AND jsonb_typeof(rep.value) = 'array'
  AND rep.value @> to_jsonb(ds.card_id)
  AND ds.attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'delivery_status')
  AND ds.value = to_jsonb('pending'::text);
DELETE FROM attribute_value av
USING moved_thread m
WHERE m.dest IS NULL AND av.card_id = m.comm_id
  AND av.attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'channel_ref');`,
	},
	{
		// activity_hidden learned the row's value_new, to hide an edit of a
		// vote's reason with the vote (review 2026-11-03 round 3 #14). The
		// DDL creates the new signature; the old one goes, so nothing can
		// call a check that shows those edits. Idempotent.
		id:  "0036_activity_hidden_edits",
		sql: `DROP FUNCTION IF EXISTS activity_hidden(text, bigint);`,
	},
	{
		// cas_held_by reads only cas_blob_holder now: its second branch
		// (bytes in a file the account may read) cost a check per file
		// sharing the bytes and timed common uploads out (review 2026-11-03
		// round 3 #7). Each file's creator holds its bytes, so record that
		// for files made before holders were kept. Idempotent.
		id: "0037_cas_holders_from_files",
		sql: `
INSERT INTO cas_blob_holder (address, user_id)
SELECT DISTINCT fc.cas_address, f.created_by
FROM file_chunk fc
JOIN file f ON f.id = fc.file_id
JOIN cas_blob cb ON cb.address = fc.cas_address
JOIN user_account ua ON ua.id = f.created_by
ON CONFLICT (address, user_id) DO NOTHING;`,
	},
	{
		// Threads filed before 0032 have no comm_confirmed, so since the
		// relay reads only it they relay nothing (review 2026-11-03 round 4
		// #7). Confirm, among the people on such a thread now, those a person
		// in kitp added (a comm_recipients change by anyone but System — the
		// recipient sync writes as System) and the person who started it by
		// mail (its first message's From, received). Staff replies confirm
		// nobody, as at runtime. Idempotent: only threads with no
		// comm_confirmed row.
		id: "0038_comm_confirmed_backfill",
		sql: `
WITH rdef AS (SELECT id FROM attribute_def WHERE name = 'comm_recipients'),
cdef AS (SELECT id FROM attribute_def WHERE name = 'comm_confirmed'),
legacy AS (
  SELECT c.id AS comm_id
  FROM card c
  JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'comm'
  WHERE c.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM attribute_value av
                    WHERE av.card_id = c.id AND av.attribute_def_id = (SELECT id FROM cdef))
),
on_now AS (
  SELECT l.comm_id, (e.v #>> '{}')::bigint AS person, e.ord
  FROM legacy l
  JOIN attribute_value av ON av.card_id = l.comm_id AND av.attribute_def_id = (SELECT id FROM rdef)
  CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(av.value) = 'array' THEN av.value ELSE '[]'::jsonb END) WITH ORDINALITY AS e(v, ord)
  WHERE (e.v #>> '{}') ~ '^[0-9]{1,18}$'
),
steps AS (
  SELECT a.card_id AS comm_id, a.actor_id, a.value_new,
         lag(a.value_new) OVER (PARTITION BY a.card_id ORDER BY a.id) AS prev
  FROM activity a
  JOIN legacy l ON l.comm_id = a.card_id
  WHERE a.kind = 'attr_update' AND a.attribute_def_id = (SELECT id FROM rdef)
),
added AS (
  SELECT DISTINCT s.comm_id, (e.v #>> '{}')::bigint AS person
  FROM steps s
  CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(s.value_new) = 'array' THEN s.value_new ELSE '[]'::jsonb END) AS e(v)
  WHERE s.actor_id <> 1
    AND (e.v #>> '{}') ~ '^[0-9]{1,18}$'
    AND NOT (CASE WHEN jsonb_typeof(s.prev) = 'array' THEN s.prev ELSE '[]'::jsonb END) @> jsonb_build_array(e.v)
),
starter AS (
  SELECT l.comm_id, pc.id AS person
  FROM legacy l
  JOIN attribute_value rep ON rep.card_id = l.comm_id
   AND rep.attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'replies')
   AND jsonb_typeof(rep.value) = 'array'
  JOIN attribute_value rf ON rf.card_id = CASE WHEN (rep.value->0 #>> '{}') ~ '^[0-9]{1,18}$'
                                               THEN (rep.value->0 #>> '{}')::bigint END
   AND rf.attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'reply_from')
  JOIN attribute_value ds ON ds.card_id = rf.card_id
   AND ds.attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'delivery_status')
   AND ds.value = to_jsonb('received'::text)
  JOIN attribute_value pav ON pav.attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'email')
   AND lower(btrim(pav.value #>> '{}')) = lower(btrim(COALESCE(
         substring(rf.value #>> '{}' from '<([^<>]+)>\s*$'), rf.value #>> '{}')))
  JOIN card pc ON pc.id = pav.card_id AND pc.deleted_at IS NULL
   AND pc.card_type_id = (SELECT id FROM card_type WHERE name = 'person')
),
confirm AS (
  SELECT n.comm_id, n.person, min(n.ord) AS ord
  FROM on_now n
  WHERE EXISTS (SELECT 1 FROM added a WHERE a.comm_id = n.comm_id AND a.person = n.person)
     OR EXISTS (SELECT 1 FROM starter s WHERE s.comm_id = n.comm_id AND s.person = n.person)
  GROUP BY n.comm_id, n.person
)
INSERT INTO attribute_value (card_id, attribute_def_id, value)
SELECT comm_id, (SELECT id FROM cdef), jsonb_agg(to_jsonb(person) ORDER BY ord)
FROM confirm
GROUP BY comm_id
ON CONFLICT (card_id, attribute_def_id) DO NOTHING;`,
	},
	{
		// A shared card someone moved under another person's private card
		// before card.move refused it (review 2026-11-03 round 5 #16) stayed
		// shared: every workspace role holder saw it while writes treated it
		// as the owner's. It becomes private to its nearest private
		// ancestor's person, as a card inserted there is (card.insert). The
		// walk goes down from the private cards, which are few; a no-op on a
		// database without such cards.
		id: "0039_private_under_private",
		sql: `
WITH RECURSIVE down(id, owner, depth) AS (
  SELECT c.id, c.private_to, 0 FROM card c WHERE c.private_to IS NOT NULL
  UNION ALL
  SELECT ch.id, COALESCE(ch.private_to, d.owner), d.depth + 1
  FROM card ch JOIN down d ON ch.parent_card_id = d.id
  WHERE d.depth < 16
)
UPDATE card c SET private_to = d.owner
FROM down d
WHERE d.id = c.id AND c.private_to IS NULL;`,
	},
	{
		// A message's own Message-ID (docs/MAIL_INTAKE_AND_CALENDARS.md,
		// "Threading"): reply_message_id on reply_body, written by intake for
		// mail that comes in and by the sender for mail kitp sends, so a
		// reply carries In-Reply-To and References and lands in the
		// recipient's thread. Kitp sets it, never a hand edit. The seed rows
		// reach fresh installs only; earlier messages keep no id.
		// Idempotent — ON CONFLICT DO NOTHING.
		id: "0040_reply_message_id",
		sql: `
INSERT INTO attribute_def (name, value_type, target_card_type_id, is_built_in, enum_managed)
VALUES ('reply_message_id', 'text', NULL, true, false)
ON CONFLICT (name) DO NOTHING;
INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
SELECT ct.id, ad.id, false, 9
FROM card_type ct, attribute_def ad
WHERE ct.name = 'reply_body' AND ad.name = 'reply_message_id'
ON CONFLICT (card_type_id, attribute_def_id) DO NOTHING;`,
	},
	{
		// A person's email addresses (docs/EMAIL_ADDRESSES.md): every login
		// that has signed in gets the email it holds on its person's list,
		// verified (source signin), as its next sign-in would add it. The
		// person_email table is DDL. A verified address belongs to one
		// person, so of two logins with one email the older keeps it.
		// Idempotent — ON CONFLICT DO NOTHING.
		id: "0041_person_email_backfill",
		sql: `
INSERT INTO person_email (person_card_id, email, source, verified_at)
SELECT DISTINCT ON (lower(btrim(ua.email))) uap.person_card_id, lower(btrim(ua.email)), 'signin', now()
FROM user_account ua
JOIN user_account_person uap ON uap.user_account_id = ua.id
JOIN card p ON p.id = uap.person_card_id AND p.deleted_at IS NULL
WHERE ua.oidc_sub IS NOT NULL AND NOT ua.is_agent
  AND COALESCE(btrim(ua.email), '') <> '' AND email_plain(lower(btrim(ua.email)))
ORDER BY lower(btrim(ua.email)), ua.id
ON CONFLICT DO NOTHING;`,
	},
	{
		// Who the outgoing server refused when it took a message for the
		// rest (a 5xx at RCPT TO): reply_refused on reply_body, which the
		// sender writes and the thread shows next to "sent" (review
		// 2026-11-05 round 6 #4). Kitp sets it, never a hand edit. The seed
		// rows reach fresh installs only. Idempotent — ON CONFLICT DO
		// NOTHING.
		id: "0042_reply_refused",
		sql: `
INSERT INTO attribute_def (name, value_type, target_card_type_id, is_built_in, enum_managed)
VALUES ('reply_refused', 'text', NULL, true, false)
ON CONFLICT (name) DO NOTHING;
INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
SELECT ct.id, ad.id, false, 10
FROM card_type ct, attribute_def ad
WHERE ct.name = 'reply_body' AND ad.name = 'reply_refused'
ON CONFLICT (card_type_id, attribute_def_id) DO NOTHING;`,
	},
}

// preDDL bootstraps columns that the generated index DDL references but that
// CREATE TABLE IF NOT EXISTS can't add to an already-initialised DB. Applied
// before the generated DDL (see ApplySchema). Must stay idempotent and use
// IF EXISTS / IF NOT EXISTS so it's a no-op on both fresh and migrated DBs.
// comm_log.route_id is the inbound route an event came through, indexed for
// the Comm log's route filter (docs/MAIL_INTAKE_AND_CALENDARS.md).
// role.rank orders the built-in roles for role_covers, which
// user_role_effective (a SQL function, checked when it is created) reads.
// card.private_to marks a private card (docs/PERSONAL_SCREENS.md); its
// partial index and card_private_ok need it before the DDL runs.
// user_account.deleted_at marks a deleted agent (agent.delete), and
// login_revoked_at a login an admin took away (user.revoke_login), with
// revoked_person_card_id the person it was; functions read them.
// activity.actor_admin is set by the activity_set_actor_admin trigger.
// session.oidc_sid is the IdP session a kitp session came from (front- and
// back-channel logout); its index needs it before the DDL runs.
// comm_imap_file_failure.path is the filing path a message failed on.
const preDDL = `ALTER TABLE IF EXISTS attribute_value ADD COLUMN IF NOT EXISTS value_type_id int;
ALTER TABLE IF EXISTS comm_log ADD COLUMN IF NOT EXISTS route_id bigint;
ALTER TABLE IF EXISTS role ADD COLUMN IF NOT EXISTS rank int NOT NULL DEFAULT 0;
ALTER TABLE IF EXISTS card ADD COLUMN IF NOT EXISTS private_to bigint REFERENCES card(id);
ALTER TABLE IF EXISTS user_account ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE IF EXISTS user_account ADD COLUMN IF NOT EXISTS login_revoked_at timestamptz;
ALTER TABLE IF EXISTS user_account ADD COLUMN IF NOT EXISTS revoked_person_card_id bigint;
ALTER TABLE IF EXISTS activity ADD COLUMN IF NOT EXISTS actor_admin boolean;
ALTER TABLE IF EXISTS session ADD COLUMN IF NOT EXISTS oidc_sid text;
ALTER TABLE IF EXISTS comm_imap_file_failure ADD COLUMN IF NOT EXISTS path text NOT NULL DEFAULT '';`

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
