package store

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// fakeTx is a no-op pgx.Tx that records Commit/Rollback so the tests can prove
// that only the root handle reaches the underlying transaction.
type fakeTx struct {
	commits   int
	rollbacks int
}

func (f *fakeTx) Commit(context.Context) error   { f.commits++; return nil }
func (f *fakeTx) Rollback(context.Context) error { f.rollbacks++; return nil }
func (f *fakeTx) Begin(context.Context) (pgx.Tx, error) {
	return nil, nil
}
func (f *fakeTx) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, nil
}
func (f *fakeTx) Query(context.Context, string, ...any) (pgx.Rows, error) { return nil, nil }
func (f *fakeTx) QueryRow(context.Context, string, ...any) pgx.Row        { return nil }
func (f *fakeTx) Prepare(context.Context, string, string) (*pgconn.StatementDescription, error) {
	return nil, nil
}
func (f *fakeTx) CopyFrom(context.Context, pgx.Identifier, []string, pgx.CopyFromSource) (int64, error) {
	return 0, nil
}
func (f *fakeTx) SendBatch(context.Context, *pgx.Batch) pgx.BatchResults { return nil }
func (f *fakeTx) LargeObjects() pgx.LargeObjects                         { return pgx.LargeObjects{} }
func (f *fakeTx) Conn() *pgx.Conn                                        { return nil }

// TestTxNesting covers the id math: the root is rootTxID and each Begin nests
// one level deeper over the same underlying tx.
func TestTxNesting(t *testing.T) {
	ft := &fakeTx{}
	root := &Tx{q: ft, id: rootTxID}
	if root.ID() != rootTxID {
		t.Fatalf("root id = %d, want %d", root.ID(), rootTxID)
	}
	child, _ := root.Begin(context.Background())
	if child.ID() != rootTxID+1 {
		t.Fatalf("child id = %d, want %d", child.ID(), rootTxID+1)
	}
	grand, _ := child.Begin(context.Background())
	if grand.ID() != rootTxID+2 {
		t.Fatalf("grandchild id = %d, want %d", grand.ID(), rootTxID+2)
	}
	// All handles share the one underlying tx.
	if child.q != root.q || grand.q != root.q {
		t.Fatal("nested handles must share the root's underlying tx")
	}
}

// TestTxFinalizeGating is the safety property: only the root handle's
// Commit/Rollback reach the underlying transaction; nested handles are no-ops,
// so a buggy nested frame cannot finalize the parent.
func TestTxFinalizeGating(t *testing.T) {
	ctx := context.Background()

	// Nested Commit/Rollback must NOT touch the underlying tx.
	ft := &fakeTx{}
	root := &Tx{q: ft, id: rootTxID}
	child, _ := root.Begin(ctx)
	if err := child.Commit(ctx); err != nil {
		t.Fatalf("child Commit err: %v", err)
	}
	if err := child.Rollback(ctx); err != nil {
		t.Fatalf("child Rollback err: %v", err)
	}
	if ft.commits != 0 || ft.rollbacks != 0 {
		t.Fatalf("nested finalize leaked: commits=%d rollbacks=%d, want 0/0", ft.commits, ft.rollbacks)
	}

	// Root Commit reaches the underlying tx exactly once.
	if err := root.Commit(ctx); err != nil {
		t.Fatalf("root Commit err: %v", err)
	}
	if ft.commits != 1 {
		t.Fatalf("root commits = %d, want 1", ft.commits)
	}

	// Root Rollback reaches the underlying tx (separate handle to keep counts clean).
	ft2 := &fakeTx{}
	root2 := &Tx{q: ft2, id: rootTxID}
	if err := root2.Rollback(ctx); err != nil {
		t.Fatalf("root Rollback err: %v", err)
	}
	if ft2.rollbacks != 1 {
		t.Fatalf("root rollbacks = %d, want 1", ft2.rollbacks)
	}
}
