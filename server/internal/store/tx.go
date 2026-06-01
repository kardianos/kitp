package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// This file defines a small composable-transaction layer over pgx. The three
// interfaces separate the two axes that matter:
//
//   - Querier — the minimal "run a statement" surface (Exec/Query/QueryRow).
//     pgx.Tx, *pgxpool.Pool, *Conn and *Tx all satisfy it, so a helper typed
//     to Querier accepts any of them. Begin is deliberately NOT here: pgx.Tx's
//     own Begin has a different shape, and keeping Begin off the base is what
//     lets raw pgx.Tx still satisfy Querier during an incremental migration.
//
//   - SingleConn — a single, *sequential* connection or transaction you can
//     Begin a (possibly nested) transaction from. *Conn and *Tx implement it.
//     Because exactly one goroutine drives such a thing for its lifetime, the
//     nesting id is a plain int — no atomic, no global counter.
//
//   - ConnPool — a pool that can hand out many connections, usable from many
//     goroutines concurrently. *Pool implements it; Acquire distinguishes it
//     from SingleConn. Each Begin/Acquire on the pool is an independent root.
//
// Composition model: a transaction is a chain of *Tx handles over ONE
// underlying pgx.Tx. The root handle (the one Pool/Conn.Begin returns, id ==
// rootTxID) is the only one that actually commits or rolls back; a nested
// handle (Tx.Begin, id > rootTxID) reuses the same underlying tx and its
// Commit/Rollback are no-ops. So a function can `defer tx.Rollback(ctx)` then
// `return tx.Commit(ctx)` and be correct whether it owns the transaction or
// merely joined one — and a buggy nested frame cannot finalize the parent,
// because it holds neither the root id nor any handle to the raw pgx.Tx.
type Querier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// SingleConn is a single sequential connection or transaction.
type SingleConn interface {
	Querier
	// Begin opens a transaction: a root tx from a *Conn, or a nested handle
	// from a *Tx (reusing the same underlying transaction).
	Begin(ctx context.Context) (*Tx, error)
	// ID is the handle's transaction id — rootTxID for the owner, higher for
	// each nesting level. Mainly useful for logging/tracing.
	ID() int
}

// ConnPool draws connections from a pool and may be used concurrently.
type ConnPool interface {
	Querier
	// Begin acquires a connection and opens a root transaction on it.
	Begin(ctx context.Context) (*Tx, error)
	// Acquire checks out a dedicated single connection (e.g. for session-scoped
	// settings). The caller must Release it.
	Acquire(ctx context.Context) (*Conn, error)
}

// rootTxID is the id of the owning handle — the only one whose Commit/Rollback
// touch the underlying transaction. Pool/Conn.Begin seed it; Tx.Begin only ever
// increments past it.
const rootTxID = 1

// Tx is one handle onto a transaction. It does NOT embed pgx.Tx — the raw tx is
// an unexported field — so the only finalization surface is Tx.Commit /
// Tx.Rollback, both id-gated. Every handle for one transaction shares the same
// q; only the root handle finalizes it.
type Tx struct {
	q  pgx.Tx
	id int
}

// Begin nests: a new handle over the SAME underlying transaction, id one higher
// than this handle's. It never opens a real transaction, so the returned
// handle's Commit/Rollback are no-ops — the root still owns finalization.
func (t *Tx) Begin(context.Context) (*Tx, error) {
	return &Tx{q: t.q, id: t.id + 1}, nil
}

// Commit finalizes the transaction only from the root handle; nested handles
// are no-ops (the root commits once, at the top).
func (t *Tx) Commit(ctx context.Context) error {
	if t.id != rootTxID {
		return nil
	}
	return t.q.Commit(ctx)
}

// Rollback aborts the transaction only from the root handle; nested handles are
// no-ops. Safe to defer unconditionally: after a successful root Commit the tx
// is already closed, so the deferred root Rollback sees ErrTxClosed, which is
// the expected "already committed" signal and is swallowed.
func (t *Tx) Rollback(ctx context.Context) error {
	if t.id != rootTxID {
		return nil
	}
	if err := t.q.Rollback(ctx); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
		return err
	}
	return nil
}

func (t *Tx) Exec(ctx context.Context, sql string, a ...any) (pgconn.CommandTag, error) {
	return t.q.Exec(ctx, sql, a...)
}
func (t *Tx) Query(ctx context.Context, sql string, a ...any) (pgx.Rows, error) {
	return t.q.Query(ctx, sql, a...)
}
func (t *Tx) QueryRow(ctx context.Context, sql string, a ...any) pgx.Row {
	return t.q.QueryRow(ctx, sql, a...)
}

// ID returns this handle's transaction id (rootTxID for the owner).
func (t *Tx) ID() int { return t.id }

// Conn is a dedicated single connection checked out of a Pool. Begin opens a
// root transaction on it; the caller must Release it when done.
type Conn struct {
	c  *pgxpool.Conn
	id int
}

// Begin opens a root transaction on this connection.
func (c *Conn) Begin(ctx context.Context) (*Tx, error) {
	raw, err := c.c.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return &Tx{q: raw, id: rootTxID}, nil
}

func (c *Conn) Exec(ctx context.Context, sql string, a ...any) (pgconn.CommandTag, error) {
	return c.c.Exec(ctx, sql, a...)
}
func (c *Conn) Query(ctx context.Context, sql string, a ...any) (pgx.Rows, error) {
	return c.c.Query(ctx, sql, a...)
}
func (c *Conn) QueryRow(ctx context.Context, sql string, a ...any) pgx.Row {
	return c.c.QueryRow(ctx, sql, a...)
}

// ID returns the connection's id (0 — a bare connection isn't a transaction;
// its Begin mints the rootTxID handle).
func (c *Conn) ID() int { return c.id }

// Release returns the connection to the pool.
func (c *Conn) Release() { c.c.Release() }

// ---- Pool: the ConnPool implementation ----

// Begin acquires a connection from the pool and opens a root transaction.
func (p *Pool) Begin(ctx context.Context) (*Tx, error) {
	raw, err := p.P.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return &Tx{q: raw, id: rootTxID}, nil
}

// Acquire checks out a dedicated single connection. The caller must Release it.
func (p *Pool) Acquire(ctx context.Context) (*Conn, error) {
	c, err := p.P.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	return &Conn{c: c, id: 0}, nil
}

func (p *Pool) Exec(ctx context.Context, sql string, a ...any) (pgconn.CommandTag, error) {
	return p.P.Exec(ctx, sql, a...)
}
func (p *Pool) Query(ctx context.Context, sql string, a ...any) (pgx.Rows, error) {
	return p.P.Query(ctx, sql, a...)
}
func (p *Pool) QueryRow(ctx context.Context, sql string, a ...any) pgx.Row {
	return p.P.QueryRow(ctx, sql, a...)
}

// Compile-time interface checks.
var (
	_ Querier    = (*Tx)(nil)
	_ Querier    = (*Conn)(nil)
	_ Querier    = (*Pool)(nil)
	_ SingleConn = (*Tx)(nil)
	_ SingleConn = (*Conn)(nil)
	_ ConnPool   = (*Pool)(nil)
)
