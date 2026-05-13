package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/schema/hcsv"
)

// ApplySchema renders db/schema/schema.hcsv + seed.hcsv (+ demo.hcsv
// when opts.Demo is true) and executes the combined script against
// pool. The generated SQL uses CREATE … IF NOT EXISTS and ON CONFLICT
// DO NOTHING throughout; the demo block guards itself on the card
// table being empty. Re-applying on an already-bootstrapped DB is a
// no-op.
func ApplySchema(ctx context.Context, pool *pgxpool.Pool, opts hcsv.GenerateOptions) error {
	sql, err := hcsv.GenerateAll(opts)
	if err != nil {
		return fmt.Errorf("load schema: %w", err)
	}
	if _, err := pool.Exec(ctx, sql); err != nil {
		return fmt.Errorf("apply schema: %w", err)
	}
	return nil
}
