package cas

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Compile-time interface assertion.
var _ Backend = (*PgBackend)(nil)

// PgBackend stores blob bytes in cas_blob_data alongside metadata in
// cas_blob. Suitable as the head backend in v1; later we'll prepend an S3
// backend and let the reaper sweep this table over time.
type PgBackend struct {
	pool *pgxpool.Pool
}

// NewPgBackend wraps a pool for use as a CAS backend.
func NewPgBackend(pool *pgxpool.Pool) *PgBackend {
	return &PgBackend{pool: pool}
}

// Kind implements Backend.
func (p *PgBackend) Kind() string { return "pg" }

// Has implements Backend by point-querying cas_blob.
func (p *PgBackend) Has(ctx context.Context, address string) (bool, error) {
	var n int
	err := p.pool.QueryRow(ctx,
		`SELECT count(*) FROM cas_blob WHERE address = $1 AND storage_kind = 'pg'`,
		address,
	).Scan(&n)
	if err != nil {
		return false, fmt.Errorf("cas/pg: has: %w", err)
	}
	return n > 0, nil
}

// Put inserts the cas_blob metadata row and the cas_blob_data row in one
// tx. ON CONFLICT keeps the call idempotent — duplicate uploads of
// identical bytes collapse into a single row.
//
// `data` is consumed once. We don't re-buffer here (the upload handler
// already holds the bytes from `io.ReadAll` on the multipart part); pgx
// will allocate its own wire buffer when serialising the bytea, so peak
// memory during a write is roughly 2× file size, not 3×.
func (p *PgBackend) Put(
	ctx context.Context,
	address string,
	mimeType string,
	sizeBytes int64,
	data []byte,
) error {
	if int64(len(data)) != sizeBytes {
		return fmt.Errorf("cas/pg: size mismatch: declared=%d, got=%d", sizeBytes, len(data))
	}
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	tx, err := p.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("cas/pg: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
		INSERT INTO cas_blob (address, size_bytes, mime_type, storage_kind)
		VALUES ($1, $2, $3, 'pg')
		ON CONFLICT (address) DO NOTHING
	`, address, sizeBytes, mimeType); err != nil {
		return fmt.Errorf("cas/pg: insert metadata: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO cas_blob_data (address, data)
		VALUES ($1, $2)
		ON CONFLICT (address) DO NOTHING
	`, address, data); err != nil {
		return fmt.Errorf("cas/pg: insert data: %w", err)
	}
	return tx.Commit(ctx)
}

// Get returns a ReadCloser over the bytes for address. We materialise the
// row into memory and hand back an in-memory reader — fine for v1 with
// a 250 MB cap; switch to a streaming pgx large-object path later if we
// raise the cap.
func (p *PgBackend) Get(ctx context.Context, address string) (io.ReadCloser, error) {
	var data []byte
	err := p.pool.QueryRow(ctx,
		`SELECT data FROM cas_blob_data WHERE address = $1`,
		address,
	).Scan(&data)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("cas/pg: get: %w", err)
	}
	return io.NopCloser(bytes.NewReader(data)), nil
}

// Delete removes the row from cas_blob_data. Idempotent. Note we leave
// cas_blob in place — the reaper deletes the metadata row only after
// confirming no consumer table still references it; this method is for
// the reaper's "now drop the bytes" step (or a future migration moving
// the blob to s3).
func (p *PgBackend) Delete(ctx context.Context, address string) error {
	if _, err := p.pool.Exec(ctx,
		`DELETE FROM cas_blob_data WHERE address = $1`,
		address,
	); err != nil {
		return fmt.Errorf("cas/pg: delete: %w", err)
	}
	return nil
}
