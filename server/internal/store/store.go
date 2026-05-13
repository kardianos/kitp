// Package store wraps pgx access for kitp.
//
// Conventions:
//   - Every write is array-shaped (jsonb_to_recordset / unnest). Single-row
//     callers wrap their argument in a one-element slice.
//   - Writers are tagged with "// arrayPath" for grep-ability (N-SRV-4).
//   - For tests, Pool exposes a tiny LastWrites recorder that counts how
//     many writer calls have happened on the current process; tests can
//     diff before/after to assert coalescing.
package store

import (
	"context"
	"log"
	"os"
	"sync"
	"sync/atomic"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Pool is a thin wrapper around pgxpool.Pool. It exists so the rest of
// the server can depend on a single concrete type that we can extend
// with bookkeeping (e.g. write counters) without touching call sites.
type Pool struct {
	P          *pgxpool.Pool
	writeCount int64
	readCount  int64
}

func NewPool(p *pgxpool.Pool) *Pool { return &Pool{P: p} }

// NoteWrite is called by every "// arrayPath" writer once per SQL write
// statement-group in a Run, so tests can verify that a coalesced batch
// issued exactly one (or, for compound writers, a small constant number of)
// statement groups regardless of input length.
func (p *Pool) NoteWrite() {
	atomic.AddInt64(&p.writeCount, 1)
}

// LastWrites returns the cumulative number of writer statement groups noted.
func (p *Pool) LastWrites() int64 {
	return atomic.LoadInt64(&p.writeCount)
}

// ResetWrites zeroes the writer counter. Tests call this at the start of a case.
func (p *Pool) ResetWrites() {
	atomic.StoreInt64(&p.writeCount, 0)
}

// NoteRead is called once per top-level SELECT issued by a read-side
// handler so tests can assert the LATERAL read does not fall into N+1.
func (p *Pool) NoteRead() {
	atomic.AddInt64(&p.readCount, 1)
}

// LastReads returns the cumulative number of reads noted.
func (p *Pool) LastReads() int64 {
	return atomic.LoadInt64(&p.readCount)
}

// ResetReads zeroes the read counter.
func (p *Pool) ResetReads() {
	atomic.StoreInt64(&p.readCount, 0)
}

// BeginTx starts a transaction. Callers are expected to Commit or Rollback.
func (p *Pool) BeginTx(ctx context.Context) (pgx.Tx, error) {
	return p.P.Begin(ctx)
}

// commSecretKey returns the KITP_COMM_SECRET_KEY env var, falling back to
// a documented dev default when unset. The first call logs a one-shot
// warning when the default is in play so dev / test runs don't spam the
// log but operators can't accidentally ship the default to production.
//
// The default value MUST be different from anything the spec might suggest
// for production — operators who leave KITP_COMM_SECRET_KEY unset and
// store real channel passwords are storing them under a published key.
// Comm Gate 3 ships the encryption plumbing; production deployments are
// expected to set the env var as part of their secret-management story.
var (
	commSecretKeyOnce sync.Once
	commSecretKeyVal  string
)

// CommSecretKey returns the resolved key, logging the dev-default warning
// at first call. Exported for the comm package to pass to sym_encrypt /
// sym_decrypt SQL calls when not relying on the per-connection setting.
func CommSecretKey() string {
	commSecretKeyOnce.Do(func() {
		commSecretKeyVal = os.Getenv("KITP_COMM_SECRET_KEY")
		if commSecretKeyVal == "" {
			commSecretKeyVal = "dev-do-not-ship-this-key-in-prod"
			log.Printf("warning: KITP_COMM_SECRET_KEY unset; using dev default. " +
				"Comm channel passwords will be encrypted with a published key — " +
				"set KITP_COMM_SECRET_KEY before storing real credentials.")
		}
	})
	return commSecretKeyVal
}

// setCommSecretKey sets the per-connection app.comm_secret_key GUC so
// SQL using current_setting('app.comm_secret_key') (e.g. comm_channel.set
// in dom/comm) resolves to the configured value. Called from pgxpool
// AfterConnect hooks in main.go + testutil.go.
func setCommSecretKey(ctx context.Context, c *pgx.Conn) error {
	key := CommSecretKey()
	_, err := c.Exec(ctx, "SELECT set_config('app.comm_secret_key', $1, false)", key)
	return err
}
