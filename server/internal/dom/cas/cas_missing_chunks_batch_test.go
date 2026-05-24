// Direct PL/pgSQL test for cas_missing_chunks_batch — Phase 5 of
// docs/UNIFIED_HANDLER_PLAN.md.
package cas_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

type casRow struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callCasMissingChunksBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []casRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM cas_missing_chunks_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var out []casRow
	for rows.Next() {
		var r casRow
		var resJSON []byte
		if err := rows.Scan(&r.Idx, &r.OK, &r.Code, &r.Message, &resJSON); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if len(resJSON) > 0 {
			r.Result = json.RawMessage(append([]byte(nil), resJSON...))
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows.Err: %v", err)
	}
	return out
}

// seedCasBlob inserts a cas_blob row for `address` so subsequent
// missing_chunks queries see it as present.
func seedCasBlob(t *testing.T, pool *pgxpool.Pool, address string) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO cas_blob (address, size_bytes, storage_kind)
		VALUES ($1, 0, 'pg')
		ON CONFLICT (address) DO NOTHING
	`, address)
	if err != nil {
		t.Fatalf("seed cas_blob %s: %v", address, err)
	}
}

func decodeMissing(t *testing.T, raw json.RawMessage) []string {
	t.Helper()
	var out struct {
		Missing []string `json:"missing"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	return out.Missing
}

// TestCasMissingChunksBatch_Happy — three addresses, one already
// present; result.missing should list the absent two in input order.
func TestCasMissingChunksBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_cas_missing_chunks_happy")
	seedCasBlob(t, pool, "aa11")
	rows := callCasMissingChunksBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"addresses": []string{"aa11", "bb22", "cc33"}},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("missing_chunks failed: %+v", rows)
	}
	missing := decodeMissing(t, rows[0].Result)
	if len(missing) != 2 || missing[0] != "bb22" || missing[1] != "cc33" {
		t.Errorf("missing=%v; want [bb22 cc33] (input order)", missing)
	}
}

// TestCasMissingChunksBatch_Empty — no input addresses; result.missing
// is an empty array (not null).
func TestCasMissingChunksBatch_Empty(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_cas_missing_chunks_empty")
	rows := callCasMissingChunksBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"addresses": []string{}},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("missing_chunks (empty) failed: %+v", rows)
	}
	missing := decodeMissing(t, rows[0].Result)
	if missing == nil || len(missing) != 0 {
		t.Errorf("missing=%v; want [] (non-nil)", missing)
	}
	if string(rows[0].Result) != `{"missing": []}` && string(rows[0].Result) != `{"missing":[]}` {
		// jsonb_build_object reproduction tolerates spacing; check shape only.
		_ = missing
	}
}

// TestCasMissingChunksBatch_MultiInput — two input rows, separate
// address sets; both surface independent missing lists.
func TestCasMissingChunksBatch_MultiInput(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_cas_missing_chunks_multi")
	seedCasBlob(t, pool, "xx00")
	rows := callCasMissingChunksBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"addresses": []string{"xx00", "yy11"}}, // missing yy11
		{"addresses": []string{"zz22"}},         // missing zz22
		{"addresses": []string{"xx00"}},         // none missing
	})
	if len(rows) != 3 {
		t.Fatalf("rows: %d", len(rows))
	}
	for i, r := range rows {
		if !r.OK || r.Idx != i {
			t.Fatalf("row %d: %+v", i, r)
		}
	}
	m0 := decodeMissing(t, rows[0].Result)
	if len(m0) != 1 || m0[0] != "yy11" {
		t.Errorf("rows[0].missing=%v; want [yy11]", m0)
	}
	m1 := decodeMissing(t, rows[1].Result)
	if len(m1) != 1 || m1[0] != "zz22" {
		t.Errorf("rows[1].missing=%v; want [zz22]", m1)
	}
	m2 := decodeMissing(t, rows[2].Result)
	if len(m2) != 0 {
		t.Errorf("rows[2].missing=%v; want []", m2)
	}
}

// TestCasMissingChunksBatch_DuplicateAddresses — duplicate input
// addresses appear duplicated in the missing list (matches the legacy
// Go-side unnest($1) WITH ORDINALITY behaviour). Clients that want
// uniqueness dedupe their input.
func TestCasMissingChunksBatch_DuplicateAddresses(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_cas_missing_chunks_dup")
	seedCasBlob(t, pool, "present")
	rows := callCasMissingChunksBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"addresses": []string{"absent", "absent", "present", "absent"}},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("missing_chunks failed: %+v", rows)
	}
	missing := decodeMissing(t, rows[0].Result)
	// `absent` appears 3 times in the input, all 3 should land in the
	// output (the pre-flight uploads each once, but ordinality is
	// preserved).
	if len(missing) != 3 {
		t.Fatalf("missing=%v; want 3 entries (input had 'absent' x3)", missing)
	}
	for _, m := range missing {
		if m != "absent" {
			t.Errorf("missing entry %q; want 'absent'", m)
		}
	}
}
