package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/schema/declarative"
)

// ApplySchema renders db/schema/declarative.toml and executes it
// against pool. Seeds are always applied; demo data is included when
// opts.Demo is true. The generated SQL uses CREATE … IF NOT EXISTS
// and ON CONFLICT DO NOTHING throughout, so calling this on an
// already-bootstrapped DB is a no-op.
func ApplySchema(ctx context.Context, pool *pgxpool.Pool, opts declarative.Options) error {
	doc, err := declarative.Load("")
	if err != nil {
		return fmt.Errorf("load declarative schema: %w", err)
	}
	sql := declarative.GenerateSQL(doc, opts)
	if _, err := pool.Exec(ctx, sql); err != nil {
		return fmt.Errorf("apply declarative schema: %w", err)
	}
	return nil
}
