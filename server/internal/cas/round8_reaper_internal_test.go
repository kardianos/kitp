package cas

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/store"
)

// Review 2026-11-06 round 8 L17: a portal build (or a theme file) hands
// out the address of bytes already stored before it inserts the row that
// uses them, and Put restarts the bytes' clock for that. The reaper
// re-checked only "unused" when it locked a row it had found old, so bytes
// touched after its scan still went.

func oldBlob(t *testing.T, s *Storage, data []byte) string {
	t.Helper()
	ctx := context.Background()
	addr, err := s.Put(ctx, "text/plain", data)
	if err != nil {
		t.Fatal(err)
	}
	pg := s.Head().(*PgBackend)
	if _, err := pg.pool.Exec(ctx, `UPDATE cas_blob SET created_at = now() - interval '2 hours' WHERE address = $1`, addr); err != nil {
		t.Fatal(err)
	}
	return addr
}

// TestBytesTouchedAfterTheScanStay: found old and unused, then put again
// (touched) before the reaper locks it: kept.
func TestBytesTouchedAfterTheScanStay(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_r8i_cas_touch")
	ctx := context.Background()
	s := New(NewPgBackend(pool))
	addr := oldBlob(t, s, []byte("page bytes a build will use again"))
	r := &Reaper{Pool: pool, Storage: s, GracePeriod: time.Hour}
	r.applyDefaults()
	consumers, err := r.consumers(ctx, "cas_blob", "address", r.ChunkConsumers)
	if err != nil {
		t.Fatal(err)
	}
	cutoff := time.Now().Add(-r.GracePeriod)
	keys, err := findOrphans[string](ctx, r, "cas_blob", "address", consumers, cutoff)
	if err != nil {
		t.Fatal(err)
	}
	if len(keys) != 1 || keys[0] != addr {
		t.Fatalf("orphans %v, want [%s]", keys, addr)
	}
	// The build stores the same bytes again (Put → Touch) …
	if got, err := s.Put(ctx, "text/plain", []byte("page bytes a build will use again")); err != nil || got != addr {
		t.Fatalf("put again: %s %v", got, err)
	}
	// … before the reaper reaches it.
	reaped, err := reapOne(ctx, r, "cas_blob", "address", consumers, cutoff, addr, r.dropBytes)
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := s.Has(ctx, addr); reaped || err != nil || !ok {
		t.Errorf("reaped %v; still there %v (%v)", reaped, ok, err)
	}
}

// reapingBackend is a PgBackend whose Touch finds the reaper got there
// first: the row is deleted between Put's Has and its Touch.
type reapingBackend struct{ *PgBackend }

func (b reapingBackend) Touch(ctx context.Context, address string) (bool, error) {
	if _, err := b.pool.Exec(ctx, `DELETE FROM cas_blob WHERE address = $1`, address); err != nil {
		return false, err
	}
	return b.PgBackend.Touch(ctx, address)
}

// TestPutStoresAgainWhatTheReaperTook: Put saw the bytes, the reaper
// deleted them before Put could restart their clock: Put stores them
// again rather than hand out the address of nothing.
func TestPutStoresAgainWhatTheReaperTook(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_r8i_cas_retake")
	ctx := context.Background()
	data := []byte("bytes the reaper took")
	plain := New(NewPgBackend(pool))
	addr := oldBlob(t, plain, data)
	s := New(reapingBackend{NewPgBackend(pool)})
	if got, err := s.Put(ctx, "text/plain", data); err != nil || got != addr {
		t.Fatalf("put: %s %v", got, err)
	}
	if ok, err := plain.Has(ctx, addr); err != nil || !ok {
		t.Errorf("after Put the bytes are there: %v (%v)", ok, err)
	}
	var got bytes.Buffer
	if err := plain.GetAll(ctx, []string{addr}, &got); err != nil || got.String() != string(data) {
		t.Errorf("read back %q (%v)", got.String(), err)
	}
}
