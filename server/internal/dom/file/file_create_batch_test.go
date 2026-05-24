// Direct PL/pgSQL test for file_create_batch — Phase 2 of
// docs/UNIFIED_HANDLER_PLAN.md. Tests call the function over
// `pool.Query` and assert per-row outputs, separate from the
// dispatcher-driven integration tests in
// internal/dom/attachment/attachment_test.go.
package file_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

// resultRow mirrors the function's RETURNS TABLE shape.
type resultRow struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callFileCreateBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []resultRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM file_create_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var out []resultRow
	for rows.Next() {
		var r resultRow
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

// seedChunk inserts a cas_blob row (and cas_blob_data) for `body`,
// returning the SHA-256 hex address. The file_chunk FK on cas_address
// means file_create_batch can't insert chunks pointing at addresses
// that don't yet exist.
func seedChunk(t *testing.T, pool *pgxpool.Pool, body []byte) (string, int64) {
	t.Helper()
	sum := sha256.Sum256(body)
	addr := hex.EncodeToString(sum[:])
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO cas_blob (address, size_bytes, mime_type, storage_kind)
		VALUES ($1, $2, 'application/octet-stream', 'pg')
		ON CONFLICT (address) DO NOTHING
	`, addr, int64(len(body))); err != nil {
		t.Fatalf("seed cas_blob: %v", err)
	}
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO cas_blob_data (address, data) VALUES ($1, $2)
		ON CONFLICT (address) DO NOTHING
	`, addr, body); err != nil {
		t.Fatalf("seed cas_blob_data: %v", err)
	}
	return addr, int64(len(body))
}

// TestFileCreateBatch_Happy — single happy path: one input, one ok
// row, result JSON carries id + filename + mime_type + size_bytes;
// file row + file_chunk row landed.
func TestFileCreateBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_file_create_batch_happy")
	addr, size := seedChunk(t, pool, []byte("hello-file"))
	rows := callFileCreateBatch(t, pool, auth.SystemUserID, []map[string]any{
		{
			"filename":  "hello.txt",
			"mime_type": "text/plain",
			"chunks": []map[string]any{
				{"address": addr, "size_bytes": size},
			},
		},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(rows))
	}
	r := rows[0]
	if !r.OK || r.Code != "" {
		t.Fatalf("want ok=true code=''; got ok=%v code=%q msg=%q", r.OK, r.Code, r.Message)
	}
	var got struct {
		ID        string `json:"id"`
		Filename  string `json:"filename"`
		MimeType  string `json:"mime_type"`
		SizeBytes int64  `json:"size_bytes"`
	}
	if err := json.Unmarshal(r.Result, &got); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	if got.Filename != "hello.txt" || got.MimeType != "text/plain" || got.SizeBytes != size {
		t.Errorf("result fields wrong: %+v", got)
	}
	if got.ID == "" {
		t.Errorf("result.id is empty")
	}
	// One file_chunk row landed at seq 0.
	var nChunks int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM file_chunk WHERE cas_address = $1 AND seq = 0`, addr,
	).Scan(&nChunks); err != nil {
		t.Fatalf("count chunks: %v", err)
	}
	if nChunks != 1 {
		t.Errorf("file_chunk rows = %d, want 1", nChunks)
	}
	// sha256 is populated for a single-chunk file.
	var sha *string
	if err := pool.QueryRow(context.Background(),
		`SELECT sha256 FROM file WHERE filename = 'hello.txt'`,
	).Scan(&sha); err != nil {
		t.Fatalf("read sha256: %v", err)
	}
	if sha == nil || *sha != addr {
		t.Errorf("sha256 = %v, want %q", sha, addr)
	}
}

// TestFileCreateBatch_MultiChunk — a 2-chunk file: size_bytes sums,
// both file_chunk rows present, sha256 is NULL (multi-chunk policy).
func TestFileCreateBatch_MultiChunk(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_file_create_batch_multichunk")
	a1, s1 := seedChunk(t, pool, []byte("chunk-one"))
	a2, s2 := seedChunk(t, pool, []byte("chunk-two-bigger"))
	rows := callFileCreateBatch(t, pool, auth.SystemUserID, []map[string]any{
		{
			"filename": "two.bin",
			"chunks": []map[string]any{
				{"address": a1, "size_bytes": s1},
				{"address": a2, "size_bytes": s2},
			},
		},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("want one ok row: %+v", rows)
	}
	var got struct {
		ID        string `json:"id"`
		MimeType  string `json:"mime_type"`
		SizeBytes int64  `json:"size_bytes"`
	}
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.SizeBytes != s1+s2 {
		t.Errorf("size = %d, want %d", got.SizeBytes, s1+s2)
	}
	if got.MimeType != "application/octet-stream" {
		t.Errorf("default mime = %q, want application/octet-stream", got.MimeType)
	}
	// Both chunks present in seq order.
	var addrs []string
	r2, err := pool.Query(context.Background(), `
		SELECT cas_address FROM file_chunk
		WHERE file_id = (SELECT id FROM file WHERE filename = 'two.bin')
		ORDER BY seq
	`)
	if err != nil {
		t.Fatalf("query chunks: %v", err)
	}
	for r2.Next() {
		var a string
		_ = r2.Scan(&a)
		addrs = append(addrs, a)
	}
	r2.Close()
	if len(addrs) != 2 || addrs[0] != a1 || addrs[1] != a2 {
		t.Errorf("chunks = %v, want [%q %q]", addrs, a1, a2)
	}
	// sha256 is NULL on multi-chunk files.
	var sha *string
	if err := pool.QueryRow(context.Background(),
		`SELECT sha256 FROM file WHERE filename = 'two.bin'`,
	).Scan(&sha); err != nil {
		t.Fatalf("read sha256: %v", err)
	}
	if sha != nil {
		t.Errorf("sha256 = %v, want NULL on multi-chunk file", *sha)
	}
}

// TestFileCreateBatch_MultiRow — N independent file inputs all
// succeed; idx order matches input order.
func TestFileCreateBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_file_create_batch_multirow")
	a1, s1 := seedChunk(t, pool, []byte("a"))
	a2, s2 := seedChunk(t, pool, []byte("bb"))
	a3, s3 := seedChunk(t, pool, []byte("ccc"))
	rows := callFileCreateBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"filename": "a.txt", "chunks": []map[string]any{{"address": a1, "size_bytes": s1}}},
		{"filename": "b.txt", "chunks": []map[string]any{{"address": a2, "size_bytes": s2}}},
		{"filename": "c.txt", "chunks": []map[string]any{{"address": a3, "size_bytes": s3}}},
	})
	if len(rows) != 3 {
		t.Fatalf("rows: got %d, want 3", len(rows))
	}
	seen := map[string]bool{}
	for i, r := range rows {
		if r.Idx != i {
			t.Errorf("row %d: idx=%d, want %d", i, r.Idx, i)
		}
		if !r.OK {
			t.Errorf("row %d: ok=false code=%q msg=%q", i, r.Code, r.Message)
			continue
		}
		var got struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(r.Result, &got); err != nil {
			t.Fatalf("row %d: unmarshal: %v", i, err)
		}
		if seen[got.ID] {
			t.Errorf("row %d: duplicate id %s", i, got.ID)
		}
		seen[got.ID] = true
	}
}

// TestFileCreateBatch_ValidationFilename — empty filename and
// extension-less filename both fail with code='validation'. (The
// richer Unicode rules are tested in textnorm; this only exercises
// the in-function fallback gate.)
func TestFileCreateBatch_ValidationFilename(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_file_create_batch_filename")
	addr, size := seedChunk(t, pool, []byte("x"))
	cases := []struct {
		label string
		name  string
	}{
		{"empty", ""},
		{"no extension", "readme"},
		{"trailing dot", "report."},
		{"leading dot", ".pdf"},
	}
	for _, c := range cases {
		t.Run(c.label, func(t *testing.T) {
			rows := callFileCreateBatch(t, pool, auth.SystemUserID, []map[string]any{
				{"filename": c.name, "chunks": []map[string]any{{"address": addr, "size_bytes": size}}},
			})
			if len(rows) != 1 {
				t.Fatalf("rows: got %d, want 1", len(rows))
			}
			if rows[0].OK {
				t.Fatalf("row should fail: %+v", rows[0])
			}
			if rows[0].Code != "validation" {
				t.Errorf("code=%q, want 'validation'", rows[0].Code)
			}
		})
	}
}

// TestFileCreateBatch_ValidationChunks — empty chunk list / missing
// address / negative size all fail with code='validation'.
func TestFileCreateBatch_ValidationChunks(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_file_create_batch_chunks")
	addr, size := seedChunk(t, pool, []byte("xyz"))
	cases := []struct {
		label   string
		input   map[string]any
		errFrag string
	}{
		{
			"no chunks",
			map[string]any{"filename": "a.txt", "chunks": []map[string]any{}},
			"at least one chunk",
		},
		{
			"missing address",
			map[string]any{"filename": "a.txt", "chunks": []map[string]any{
				{"address": "", "size_bytes": 5},
			}},
			"address is required",
		},
		{
			"negative size",
			map[string]any{"filename": "a.txt", "chunks": []map[string]any{
				{"address": addr, "size_bytes": -1},
			}},
			"non-negative",
		},
		{
			"address ok at idx 1, address blank at idx 2",
			map[string]any{"filename": "a.txt", "chunks": []map[string]any{
				{"address": addr, "size_bytes": size},
				{"address": "", "size_bytes": 1},
			}},
			"chunks[1].address",
		},
	}
	for _, c := range cases {
		t.Run(c.label, func(t *testing.T) {
			rows := callFileCreateBatch(t, pool, auth.SystemUserID, []map[string]any{c.input})
			if len(rows) != 1 {
				t.Fatalf("rows: got %d, want 1", len(rows))
			}
			if rows[0].OK {
				t.Fatalf("row should fail: %+v", rows[0])
			}
			if rows[0].Code != "validation" {
				t.Errorf("code=%q, want 'validation'", rows[0].Code)
			}
			if !strings.Contains(rows[0].Message, c.errFrag) {
				t.Errorf("message=%q, want contains %q", rows[0].Message, c.errFrag)
			}
		})
	}
}

// TestFileCreateBatch_PerRowFailure — one input fails validation in
// a multi-row batch; sibling rows still emit ok=true and write file
// rows (dispatcher first-error semantics live above this function).
func TestFileCreateBatch_PerRowFailure(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_file_create_batch_perrow")
	addr, size := seedChunk(t, pool, []byte("x"))
	rows := callFileCreateBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"filename": "ok1.txt", "chunks": []map[string]any{{"address": addr, "size_bytes": size}}},
		{"filename": "", "chunks": []map[string]any{{"address": addr, "size_bytes": size}}},
		{"filename": "ok2.txt", "chunks": []map[string]any{{"address": addr, "size_bytes": size}}},
	})
	if len(rows) != 3 {
		t.Fatalf("rows: got %d, want 3", len(rows))
	}
	if !rows[0].OK || !rows[2].OK {
		t.Errorf("rows 0 and 2 should be ok; got [0]=%+v [2]=%+v", rows[0], rows[2])
	}
	if rows[1].OK {
		t.Fatalf("row 1 should fail: %+v", rows[1])
	}
	if rows[1].Code != "validation" {
		t.Errorf("row 1: code=%q, want 'validation'", rows[1].Code)
	}
}
