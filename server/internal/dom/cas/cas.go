// Package cas (the dom-side facade) exposes JSON dispatcher endpoints
// that operate on the cas_blob layer without touching bytes.
//
// Today there's just one: cas.missing_chunks — the pre-flight a client
// uses before uploading a multi-chunk file to skip any chunks the server
// already holds.
package cas

import (
	"context"
	"fmt"
	"reflect"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// MissingChunksInput lists candidate cas_blob addresses.
type MissingChunksInput struct {
	Addresses []string `json:"addresses" mcp:"required,desc=candidate cas_blob addresses (SHA-256 hex)"`
}

// MissingChunksOutput is the subset of the input that's NOT already in
// cas_blob. The client uploads only these chunks; everything else dedups
// against the existing rows.
type MissingChunksOutput struct {
	Missing []string `json:"missing" mcp:"desc=addresses not currently in cas_blob"`
}

// Register installs cas.missing_chunks.
func Register(p *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "cas",
		Action:       "missing_chunks",
		Doc:          "Given a list of cas_blob addresses, return the subset NOT currently stored. Used by the client as an upload pre-flight: bytes for the missing addresses are POSTed to /api/v1/cas/chunk; everything else is skipped.",
		InputType:    reflect.TypeFor[MissingChunksInput](),
		OutputType:   reflect.TypeFor[MissingChunksOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		Run:          runMissingChunks(p),
	})
}

func runMissingChunks(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(MissingChunksInput)
			if len(in.Addresses) == 0 {
				outs[i] = MissingChunksOutput{Missing: []string{}}
				continue
			}
			// Anti-join unnest($1) against cas_blob — the missing set is
			// "addresses we asked about that aren't in the table". One
			// round-trip regardless of the input length.
			rows, err := tx.Query(ctx, `
				SELECT a.address
				FROM unnest($1::text[]) AS a(address)
				WHERE NOT EXISTS (
					SELECT 1 FROM cas_blob WHERE address = a.address
				)
			`, in.Addresses)
			if err != nil {
				return nil, fmt.Errorf("cas.missing_chunks: %w", err)
			}
			missing := []string{}
			for rows.Next() {
				var a string
				if err := rows.Scan(&a); err != nil {
					rows.Close()
					return nil, err
				}
				missing = append(missing, a)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return nil, err
			}
			if p != nil {
				p.NoteRead()
			}
			outs[i] = MissingChunksOutput{Missing: missing}
		}
		return outs, nil
	}
}
