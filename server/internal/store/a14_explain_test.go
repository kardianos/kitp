package store_test

import (
	"context"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/store"
)

// TestA14_ExplainValueFirstFilter is a throwaway diagnostic (A14): seed a
// few thousand attribute_value rows and confirm a value-first
// `attribute_def_id = X AND value = Y` filter on a STRUCTURED attribute
// takes an index path (the partitioned attribute_value_def_value btree),
// not a seq scan. The btree is now partial (value_type_id < 1000), so the
// query carries the same class guard the predicate compiler appends — that's
// what lets the planner use the partial index (proven: dropping the guard
// falls back to a seq scan). Text attributes intentionally live outside this
// btree (trigram only). Run with -v to see the plan.
func TestA14_ExplainValueFirstFilter(t *testing.T) {
	pool := store.TestPool(t, "kitp_a14_explain")
	ctx := context.Background()

	// Two structured (number) attribute_defs; many value-cards under them.
	_, err := pool.Exec(ctx, `
		INSERT INTO card_type(name) VALUES ('a14ct') ON CONFLICT DO NOTHING;
		INSERT INTO attribute_def(name, value_type) VALUES ('a14_status','number') ON CONFLICT DO NOTHING;
		INSERT INTO attribute_def(name, value_type) VALUES ('a14_other','number') ON CONFLICT DO NOTHING;
	`)
	if err != nil { t.Fatalf("seed defs: %v", err) }

	var ctID, defStatus, defOther int64
	pool.QueryRow(ctx, `SELECT id FROM card_type WHERE name='a14ct'`).Scan(&ctID)
	pool.QueryRow(ctx, `SELECT id FROM attribute_def WHERE name='a14_status'`).Scan(&defStatus)
	pool.QueryRow(ctx, `SELECT id FROM attribute_def WHERE name='a14_other'`).Scan(&defOther)

	if _, err := pool.Exec(ctx, `
		INSERT INTO card(card_type_id) SELECT $1 FROM generate_series(1,4000)
	`, ctID); err != nil { t.Fatalf("seed cards: %v", err) }

	if _, err := pool.Exec(ctx, `
		INSERT INTO attribute_value(card_id, attribute_def_id, value)
		SELECT c.id, $1, to_jsonb(c.id % 20)
		FROM card c WHERE c.card_type_id = $2
	`, defStatus, ctID); err != nil { t.Fatalf("seed status values: %v", err) }
	if _, err := pool.Exec(ctx, `
		INSERT INTO attribute_value(card_id, attribute_def_id, value)
		SELECT c.id, $1, to_jsonb(c.id % 50)
		FROM card c WHERE c.card_type_id = $2
	`, defOther, ctID); err != nil { t.Fatalf("seed other values: %v", err) }

	if _, err := pool.Exec(ctx, `ANALYZE attribute_value`); err != nil { t.Fatalf("analyze: %v", err) }

	rows, err := pool.Query(ctx, `
		EXPLAIN (FORMAT TEXT)
		SELECT card_id FROM attribute_value
		WHERE attribute_def_id = $1 AND value = to_jsonb(7) AND value_type_id < 1000
	`, defStatus)
	if err != nil { t.Fatalf("explain: %v", err) }
	defer rows.Close()
	var plan strings.Builder
	for rows.Next() {
		var line string
		rows.Scan(&line)
		plan.WriteString(line + "\n")
	}
	t.Logf("EXPLAIN value-first filter:\n%s", plan.String())
	if strings.Contains(plan.String(), "Seq Scan") {
		t.Errorf("expected an index path for value-first filter, got a Seq Scan:\n%s", plan.String())
	}
}
