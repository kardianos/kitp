package cas_test

import (
	"bytes"
	"context"
	"io"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/cas"
	"github.com/kitp/kitp/server/internal/store"
)

// TestPgRoundtrip exercises the basic path: Put, Has, Get back out.
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
	rc, err := storage.Get(ctx, address)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer rc.Close()
	got, err := io.ReadAll(rc)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !bytes.Equal(got, data) {
		t.Fatalf("get returned %q, want %q", got, data)
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
	_, err := storage.Get(ctx, "00ff")
	if err == nil {
		t.Fatalf("expected error")
	}
	if err != cas.ErrNotFound {
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
	var projectCardTypeID int32
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
	r.SweepOnce(ctx)

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
	r.SweepOnce(ctx)

	ok, err := storage.Has(ctx, addr)
	if err != nil {
		t.Fatalf("has: %v", err)
	}
	if !ok {
		t.Fatalf("reaper deleted fresh blob inside the grace period")
	}
}
