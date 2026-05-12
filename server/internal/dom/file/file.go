// Package file exposes a generic "logical file" — name + size + mime +
// the ordered list of cas_blob chunks that compose its bytes. The
// attachment domain is the only consumer today; future consumers (avatar
// uploads, mailbox imports, etc.) link to the same file row.
//
// One JSON dispatcher endpoint:
//   - file.create — given a chunk list (already uploaded via POST
//     /api/v1/cas/chunk), insert the file row + the file_chunk list in
//     one tx and return the new file id.
//
// Reads + downloads live in the consumer domains (attachment.list etc.)
// so a `file` row by itself doesn't grow a download URL.
package file

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// Chunk is one entry in CreateInput.Chunks.
type Chunk struct {
	Address string `json:"address" mcp:"required,desc=cas_blob address (SHA-256 hex)"`
	Size    int64  `json:"size_bytes" mcp:"required,desc=chunk size in bytes"`
}

// CreateInput inserts a new logical file from a previously-uploaded
// chunk list.
type CreateInput struct {
	Filename string  `json:"filename" mcp:"required,desc=display filename"`
	MimeType string  `json:"mime_type,omitempty" mcp:"desc=MIME type; defaults to application/octet-stream"`
	Chunks   []Chunk `json:"chunks" mcp:"required,desc=ordered chunk list (each cas_blob row must already exist)"`
}

// CreateOutput surfaces the freshly-created file row's metadata.
type CreateOutput struct {
	ID        int64  `json:"id,string"`
	Filename  string `json:"filename"`
	MimeType  string `json:"mime_type"`
	SizeBytes int64  `json:"size_bytes"`
}

// Register installs the file.create endpoint.
func Register(p *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "file",
		Action:       "create",
		Doc:          "Insert a logical file (filename + size + mime + chunk list) from a chunk list previously uploaded via POST /api/v1/cas/chunk.",
		InputType:    reflect.TypeFor[CreateInput](),
		OutputType:   reflect.TypeFor[CreateOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		Run:          runCreate(p),
	})
}

func runCreate(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		actorID := auth.ActorOrSystem(ctx)
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(CreateInput)
			if in.Filename == "" {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "file.create: filename is required"}
			}
			if len(in.Chunks) == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "file.create: at least one chunk is required"}
			}
			var totalBytes int64
			for j, c := range in.Chunks {
				if c.Address == "" {
					return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
						Message: fmt.Sprintf("file.create: chunks[%d].address is required", j)}
				}
				if c.Size < 0 {
					return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
						Message: fmt.Sprintf("file.create: chunks[%d].size_bytes must be non-negative", j)}
				}
				totalBytes += c.Size
			}
			mime := in.MimeType
			if mime == "" {
				mime = "application/octet-stream"
			}

			// Insert the file row and the file_chunk list in a single CTE
			// so they land or fail together.
			//
			// The chunk list is fed via jsonb_to_recordset rather than
			// looping in Go — one round-trip per file regardless of how
			// many chunks. The FK on file_chunk.cas_address surfaces a
			// foreign_key_violation if the caller forgot to upload a
			// chunk first.
			type chunkRow struct {
				Seq        int    `json:"seq"`
				Address    string `json:"cas_address"`
				ChunkSize  int64  `json:"chunk_size"`
			}
			rows := make([]chunkRow, len(in.Chunks))
			for j, c := range in.Chunks {
				rows[j] = chunkRow{Seq: j, Address: c.Address, ChunkSize: c.Size}
			}
			buf, err := json.Marshal(rows)
			if err != nil {
				return nil, fmt.Errorf("file.create: marshal chunks: %w", err)
			}
			var id int64
			err = tx.QueryRow(ctx, `
				WITH ins_file AS (
					INSERT INTO file (filename, size_bytes, mime_type, created_by)
					VALUES ($1, $2, $3, $4)
					RETURNING id
				),
				ins_chunks AS (
					INSERT INTO file_chunk (file_id, seq, cas_address, chunk_size)
					SELECT (SELECT id FROM ins_file), seq, cas_address, chunk_size
					FROM jsonb_to_recordset($5::jsonb)
					AS x(seq int, cas_address text, chunk_size bigint)
					RETURNING file_id
				)
				SELECT id FROM ins_file
			`, in.Filename, totalBytes, mime, actorID, buf).Scan(&id)
			if err != nil {
				return nil, fmt.Errorf("file.create: %w", err)
			}

			outs[i] = CreateOutput{
				ID:        id,
				Filename:  in.Filename,
				MimeType:  mime,
				SizeBytes: totalBytes,
			}
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}
