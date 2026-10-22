package cas_test

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/cas"
	"github.com/kitp/kitp/server/internal/store"
)

// TestPgRoundtrip exercises the basic path: Put, Has, GetAll back out.
func TestPgRoundtrip(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_cas_pg")
	ctx := context.Background()

	be := cas.NewPgBackend(pool)
	storage := cas.New(be)

	data := []byte("hello, kitp attachments")
	address := cas.AddressOf(data)

	if err := be.Put(ctx, address, "text/plain", int64(len(data)), data); err != nil {
		t.Fatalf("put: %v", err)
	}
	ok, err := storage.Has(ctx, address)
	if err != nil {
		t.Fatalf("has: %v", err)
	}
	if !ok {
		t.Fatalf("expected has=true after put")
	}
	var got bytes.Buffer
	if err := storage.GetAll(ctx, []string{address}, &got); err != nil {
		t.Fatalf("get_all: %v", err)
	}
	if !bytes.Equal(got.Bytes(), data) {
		t.Fatalf("get returned %q, want %q", got.Bytes(), data)
	}
}

// TestGetAll_StreamsInOrder verifies the multi-address path: bytes
// arrive in the order requested regardless of insert order, and a
// single GetAll call replaces N per-blob round-trips (S8).
func TestGetAll_StreamsInOrder(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_cas_getall_order")
	ctx := context.Background()
	be := cas.NewPgBackend(pool)
	storage := cas.New(be)

	chunks := [][]byte{
		[]byte("aaaaaa"),
		[]byte("bbbb"),
		[]byte("ccccccccc"),
	}
	addrs := make([]string, len(chunks))
	// Insert in reverse so address order != insertion order — the
	// `array_position` ORDER BY is what makes the test meaningful.
	for i := len(chunks) - 1; i >= 0; i-- {
		addrs[i] = cas.AddressOf(chunks[i])
		if err := be.Put(ctx, addrs[i], "application/octet-stream", int64(len(chunks[i])), chunks[i]); err != nil {
			t.Fatalf("put %d: %v", i, err)
		}
	}

	var buf bytes.Buffer
	if err := storage.GetAll(ctx, addrs, &buf); err != nil {
		t.Fatalf("get_all: %v", err)
	}
	want := append(append(append([]byte{}, chunks[0]...), chunks[1]...), chunks[2]...)
	if !bytes.Equal(buf.Bytes(), want) {
		t.Fatalf("concat = %q, want %q", buf.Bytes(), want)
	}
}

// TestGetAll_MissingAddressReturnsErrNotFound — a partial chunk set
// is treated as ErrNotFound. The PG backend's row-count check is
// what surfaces this; without it a corrupted file would silently
// download with missing bytes.
func TestGetAll_MissingAddressReturnsErrNotFound(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_cas_getall_miss")
	ctx := context.Background()
	be := cas.NewPgBackend(pool)
	storage := cas.New(be)

	good := []byte("present")
	goodAddr := cas.AddressOf(good)
	if err := be.Put(ctx, goodAddr, "text/plain", int64(len(good)), good); err != nil {
		t.Fatalf("put: %v", err)
	}

	var buf bytes.Buffer
	err := storage.GetAll(ctx, []string{goodAddr, "deadbeef"}, &buf)
	if err == nil {
		t.Fatalf("expected ErrNotFound for missing address; buf=%q", buf.Bytes())
	}
	if !errors.Is(err, cas.ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

// TestPutIdempotent shows that uploading the same content twice collapses
// to one cas_blob row and one cas_blob_data row.
func TestPutIdempotent(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_cas_idem")
	ctx := context.Background()

	be := cas.NewPgBackend(pool)
	data := []byte("idempotent")
	address := cas.AddressOf(data)

	for range 3 {
		if err := be.Put(ctx, address, "text/plain", int64(len(data)), data); err != nil {
			t.Fatalf("put: %v", err)
		}
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM cas_blob WHERE address = $1`, address).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected 1 cas_blob row, got %d", n)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM cas_blob_data WHERE address = $1`, address).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected 1 cas_blob_data row, got %d", n)
	}
}

// TestGetNotFound returns ErrNotFound for an unknown address.
func TestGetNotFound(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_cas_404")
	ctx := context.Background()
	storage := cas.New(cas.NewPgBackend(pool))
	var buf bytes.Buffer
	err := storage.GetAll(ctx, []string{"00ff"}, &buf)
	if err == nil {
		t.Fatalf("expected error")
	}
	if !errors.Is(err, cas.ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

// TestReaperOrphans creates two blobs, references one of them via a
// fake attachment row, advances time past the grace period, sweeps, and
// verifies only the orphan is removed.
func TestReaperOrphans(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_cas_reaper")
	ctx := context.Background()

	be := cas.NewPgBackend(pool)
	storage := cas.New(be)

	// Two blobs.
	keep := []byte("keep me")
	keepAddr := cas.AddressOf(keep)
	if err := be.Put(ctx, keepAddr, "text/plain", int64(len(keep)), keep); err != nil {
		t.Fatalf("put keep: %v", err)
	}
	orphan := []byte("delete me")
	orphanAddr := cas.AddressOf(orphan)
	if err := be.Put(ctx, orphanAddr, "text/plain", int64(len(orphan)), orphan); err != nil {
		t.Fatalf("put orphan: %v", err)
	}

	// Backdate both rows past the grace period so the sweep treats them
	// as eligible to consider.
	if _, err := pool.Exec(ctx, `UPDATE cas_blob SET created_at = now() - interval '2 hours'`); err != nil {
		t.Fatalf("backdate: %v", err)
	}

	// Stand up the reference chain that pins `keep` alive:
	//   file → file_chunk(cas_address=keep) ← live attachment row.
	// (orphan has no inbound references, so the reaper should drop it.)
	var projectCardTypeID int64
	if err := pool.QueryRow(ctx,
		`SELECT id FROM card_type WHERE name='project'`,
	).Scan(&projectCardTypeID); err != nil {
		t.Fatalf("card_type: %v", err)
	}
	var cardID int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO card (card_type_id) VALUES ($1) RETURNING id`,
		projectCardTypeID,
	).Scan(&cardID); err != nil {
		t.Fatalf("card insert: %v", err)
	}
	var userID int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO user_account (display_name) VALUES ('test') RETURNING id`,
	).Scan(&userID); err != nil {
		t.Fatalf("user insert: %v", err)
	}
	var fileID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO file (filename, size_bytes, mime_type, created_by)
		VALUES ('kept.txt', $1, 'text/plain', $2)
		RETURNING id
	`, int64(len(keep)), userID).Scan(&fileID); err != nil {
		t.Fatalf("file insert: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO file_chunk (file_id, seq, cas_address, chunk_size)
		VALUES ($1, 0, $2, $3)
	`, fileID, keepAddr, int64(len(keep))); err != nil {
		t.Fatalf("file_chunk insert: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO attachment (card_id, file_id) VALUES ($1, $2)
	`, cardID, fileID); err != nil {
		t.Fatalf("attachment insert: %v", err)
	}

	r := &cas.Reaper{
		Pool:        pool,
		Storage:     storage,
		GracePeriod: time.Hour,
	}
	if err := r.RunOnce(ctx); err != nil {
		t.Fatalf("sweep: %v", err)
	}

	// keep stays.
	ok, err := storage.Has(ctx, keepAddr)
	if err != nil {
		t.Fatalf("has keep: %v", err)
	}
	if !ok {
		t.Fatalf("reaper deleted referenced blob")
	}
	// orphan is gone.
	ok, err = storage.Has(ctx, orphanAddr)
	if err != nil {
		t.Fatalf("has orphan: %v", err)
	}
	if ok {
		t.Fatalf("reaper missed the orphan")
	}
	var n int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM cas_blob WHERE address = $1`, orphanAddr,
	).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Fatalf("orphan cas_blob row still present")
	}
}

// TestReaperGracePeriod ensures fresh orphans are skipped — without this
// guard, a Put-then-crash before the consumer row is inserted would lose
// the bytes immediately on the next sweep.
func TestReaperGracePeriod(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_cas_reaper_grace")
	ctx := context.Background()

	be := cas.NewPgBackend(pool)
	storage := cas.New(be)
	data := []byte("fresh")
	addr := cas.AddressOf(data)
	if err := be.Put(ctx, addr, "text/plain", int64(len(data)), data); err != nil {
		t.Fatalf("put: %v", err)
	}

	r := &cas.Reaper{
		Pool:        pool,
		Storage:     storage,
		GracePeriod: time.Hour,
	}
	if err := r.RunOnce(ctx); err != nil {
		t.Fatalf("sweep: %v", err)
	}

	ok, err := storage.Has(ctx, addr)
	if err != nil {
		t.Fatalf("has: %v", err)
	}
	if !ok {
		t.Fatalf("reaper deleted fresh blob inside the grace period")
	}
}

// TestReaperReleasesDeadReferences covers the rows that used to fail
// their delete on every pass. A file whose attachments are all
// soft-deleted is reaped along with those dead attachment rows (and its
// bytes, in the same pass). A file still used by a table the reaper
// isn't configured for (import_job) is kept, as is one a writer holds
// mid-insert, which the next pass reaps once the lock is gone.
func TestReaperReleasesDeadReferences(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_cas_reaper_dead")
	ctx := context.Background()
	storage := cas.New(cas.NewPgBackend(pool))
	mustExec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	var cardID, userID int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'project' RETURNING id`,
	).Scan(&cardID); err != nil {
		t.Fatalf("card insert: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO user_account (display_name) VALUES ('test') RETURNING id`,
	).Scan(&userID); err != nil {
		t.Fatalf("user insert: %v", err)
	}
	// seedFile stores name's bytes as a one-chunk file.
	seedFile := func(name string) (int64, string) {
		t.Helper()
		addr, err := storage.Put(ctx, "text/plain", []byte(name))
		if err != nil {
			t.Fatalf("put %s: %v", name, err)
		}
		var id int64
		if err := pool.QueryRow(ctx, `
			INSERT INTO file (filename, size_bytes, created_by) VALUES ($1, $2, $3)
			RETURNING id
		`, name, len(name), userID).Scan(&id); err != nil {
			t.Fatalf("file insert %s: %v", name, err)
		}
		mustExec(`INSERT INTO file_chunk (file_id, seq, cas_address, chunk_size) VALUES ($1, 0, $2, $3)`,
			id, addr, len(name))
		return id, addr
	}
	fileGone := func(id int64) bool {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM file WHERE id = $1`, id).Scan(&n); err != nil {
			t.Fatalf("count file: %v", err)
		}
		return n == 0
	}
	blobGone := func(addr string) bool {
		t.Helper()
		ok, err := storage.Has(ctx, addr)
		if err != nil {
			t.Fatalf("has: %v", err)
		}
		return !ok
	}

	deleted, deletedAddr := seedFile("deleted.xlsx")
	thumb, thumbAddr := seedFile("deleted-thumb.png")
	shared, sharedAddr := seedFile("shared.txt")
	imported, importedAddr := seedFile("import.csv")
	held, heldAddr := seedFile("held.txt")
	mustExec(`INSERT INTO attachment (card_id, file_id, thumb_file_id, deleted_at) VALUES ($1, $2, $3, now())`,
		cardID, deleted, thumb)
	mustExec(`INSERT INTO attachment (card_id, file_id) VALUES ($1, $2)`, cardID, shared)
	mustExec(`INSERT INTO attachment (card_id, file_id, deleted_at) VALUES ($1, $2, now())`, cardID, shared)
	mustExec(`INSERT INTO import_job (project_id, file_id, created_by) VALUES ($1, $2, $3)`,
		cardID, imported, userID)
	mustExec(`UPDATE file SET created_at = now() - interval '2 hours'`)
	mustExec(`UPDATE cas_blob SET created_at = now() - interval '2 hours'`)

	// The lock an attachment insert's foreign-key check takes on the file
	// it references, held until that insert commits.
	writer, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if _, err := writer.Exec(ctx, `SELECT FROM file WHERE id = $1 FOR KEY SHARE`, held); err != nil {
		t.Fatalf("lock: %v", err)
	}

	r := &cas.Reaper{Pool: pool, Storage: storage, GracePeriod: time.Hour}
	if err := r.RunOnce(ctx); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	for name, id := range map[string]int64{"deleted": deleted, "thumb": thumb} {
		if !fileGone(id) {
			t.Errorf("%s file kept; only a soft-deleted attachment uses it", name)
		}
	}
	for name, addr := range map[string]string{"deleted": deletedAddr, "thumb": thumbAddr} {
		if !blobGone(addr) {
			t.Errorf("%s bytes kept after their file was reaped", name)
		}
	}
	for name, id := range map[string]int64{"shared": shared, "imported": imported, "held": held} {
		if fileGone(id) {
			t.Errorf("%s file reaped while in use", name)
		}
	}
	for name, addr := range map[string]string{"shared": sharedAddr, "imported": importedAddr, "held": heldAddr} {
		if blobGone(addr) {
			t.Errorf("%s bytes reaped while in use", name)
		}
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM attachment WHERE file_id = $1`, shared).Scan(&n); err != nil {
		t.Fatalf("count attachments: %v", err)
	}
	if n != 2 {
		t.Errorf("shared file has %d attachments, want the live one and the soft-deleted one", n)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM attachment WHERE file_id = $1`, deleted).Scan(&n); err != nil {
		t.Fatalf("count attachments: %v", err)
	}
	if n != 0 {
		t.Errorf("soft-deleted attachment of a reaped file kept")
	}

	if err := writer.Rollback(ctx); err != nil {
		t.Fatalf("rollback: %v", err)
	}
	if err := r.RunOnce(ctx); err != nil {
		t.Fatalf("second sweep: %v", err)
	}
	if !fileGone(held) || !blobGone(heldAddr) {
		t.Errorf("held file not reaped once its writer let go")
	}
	if fileGone(imported) {
		t.Errorf("import_job file reaped on the second pass")
	}
}
