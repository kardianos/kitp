package store_test

import (
	"context"
	"testing"

	"github.com/kitp/kitp/server/internal/store"
)

// TestLargeTextAttributeValueWrite is the regression for the opaque
// "internal error" on a large `description`: a text attribute_value whose
// rendered bytes exceed the 2704-byte btree tuple cap used to fail the write
// because attribute_value_def_value indexed the full jsonb value. Now text is
// classified value_type_id >= 1000 and kept OUT of that btree (trigram only),
// so the write succeeds at any size.
func TestLargeTextAttributeValueWrite(t *testing.T) {
	pool := store.TestPool(t, "kitp_large_text")
	ctx := context.Background()

	if _, err := pool.Exec(ctx, `
		INSERT INTO card_type(name) VALUES ('bigct') ON CONFLICT DO NOTHING;
		INSERT INTO attribute_def(name, value_type) VALUES ('bigdesc','text') ON CONFLICT DO NOTHING;
	`); err != nil {
		t.Fatalf("seed: %v", err)
	}
	var ctID, defID, cardID int64
	pool.QueryRow(ctx, `SELECT id FROM card_type WHERE name='bigct'`).Scan(&ctID)
	pool.QueryRow(ctx, `SELECT id FROM attribute_def WHERE name='bigdesc'`).Scan(&defID)
	if err := pool.QueryRow(ctx,
		`INSERT INTO card(card_type_id) VALUES ($1) RETURNING id`, ctID).Scan(&cardID); err != nil {
		t.Fatalf("card: %v", err)
	}

	// ~6 KB of incompressible text (concatenated distinct md5 hex) — well over
	// the 2704-byte cap that used to make this INSERT fail with a btree error.
	if _, err := pool.Exec(ctx, `
		INSERT INTO attribute_value(card_id, attribute_def_id, value)
		VALUES ($1, $2, to_jsonb((SELECT string_agg(md5(g::text), '') FROM generate_series(1,200) g)))
	`, cardID, defID); err != nil {
		t.Fatalf("large text write failed (btree-overflow regression): %v", err)
	}

	var vtid, nbytes int
	if err := pool.QueryRow(ctx, `
		SELECT value_type_id, octet_length(value::text)
		FROM attribute_value WHERE card_id = $1 AND attribute_def_id = $2
	`, cardID, defID).Scan(&vtid, &nbytes); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if vtid < 1000 {
		t.Errorf("text value classified structured (value_type_id=%d) — it would be in the btree", vtid)
	}
	if nbytes < 2704 {
		t.Errorf("test value only %d bytes — too small to exercise the 2704-byte cap", nbytes)
	}
}
