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
	"sync/atomic"

	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
	"github.com/kitp/kitp/server/internal/textnorm"
)

// Chunk is one entry in CreateInput.Chunks.
type Chunk struct {
	Address string `json:"address" mcp:"required,desc=cas_blob address (SHA-256 hex)"`
	Size    int64  `json:"size_bytes" mcp:"required,desc=chunk size in bytes"`
}

// CreateInput inserts a new logical file from a previously-uploaded
// chunk list.
//
// A custom UnmarshalJSON runs textnorm.Filename on the incoming
// filename so the value the dispatcher hands the PL/pgSQL function is
// already NFC-normalised + sanitised (bidi/zero-width strip, path
// separator removal, trailing-dot trim, …). The richer Unicode work
// can't be ported to PL/pgSQL — keeping it on the Go side preserves
// the existing Filename guarantees while letting file_create_batch
// stay pure-DB. The SQL function reapplies the cheap presence/
// extension gates so a malformed payload that somehow bypasses this
// hook still gets caught.
type CreateInput struct {
	Filename string  `json:"filename" mcp:"required,desc=display filename"`
	MimeType string  `json:"mime_type,omitempty" mcp:"desc=MIME type; defaults to application/octet-stream"`
	Chunks   []Chunk `json:"chunks" mcp:"required,desc=ordered chunk list (each cas_blob row must already exist)"`
}

// createInputWire mirrors CreateInput field-for-field but without the
// custom UnmarshalJSON so we can decode the raw JSON into it without
// recursing into ourselves.
type createInputWire struct {
	Filename string  `json:"filename"`
	MimeType string  `json:"mime_type,omitempty"`
	Chunks   []Chunk `json:"chunks"`
}

// UnmarshalJSON normalises the Filename field via textnorm.Filename
// before populating the struct. Errors from the normaliser surface as
// JSON unmarshal errors, which the dispatcher maps to a
// `bad_input` HandlerError. Empty filenames also fail here rather
// than falling through to the SQL function's gate.
func (c *CreateInput) UnmarshalJSON(b []byte) error {
	var w createInputWire
	if err := json.Unmarshal(b, &w); err != nil {
		return err
	}
	clean, err := textnorm.Filename(w.Filename)
	if err != nil {
		return err
	}
	c.Filename = clean
	c.MimeType = w.MimeType
	c.Chunks = w.Chunks
	return nil
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
		// file rows have no project anchor — they're contentless
		// blobs until a downstream domain (attachment.create, future
		// avatar uploads, …) links them to a card. The downstream
		// link IS scope-checked. Marking GlobalScope here so the
		// register-time guard doesn't reject the handler.
		GlobalScope: true,
		// Sizes come from the stored chunks, not the request (review B5).
		PreRun: preRunCreate,
		// Unified handler — body lives in
		// db/schema/functions/file_create_batch.sql. See
		// docs/UNIFIED_HANDLER_PLAN.md Phase 2.
		SQLFunc: "file_create_batch",
	})
}

// maxFileBytes caps one file (ATTACHMENT_MAX_MB, set by kitpd through
// SetMaxBytes). The chunked upload path checks it here; the one-shot
// upload route checks the same limit on its own.
var maxFileBytes atomic.Int64

func init() { maxFileBytes.Store(250 << 20) }

// SetMaxBytes sets the largest file file.create accepts.
func SetMaxBytes(n int64) {
	if n > 0 {
		maxFileBytes.Store(n)
	}
}

// preRunCreate replaces each chunk's declared size with the stored
// chunk's real size, refuses a chunk that was never uploaded, and caps
// the file's total: the request's sizes are only a claim, and one
// uploaded chunk listed ten thousand times would otherwise make a file
// far past the limit — a thumbnail or a portal build then reads all of it
// into memory (review B5).
func preRunCreate(ctx context.Context, tx store.Querier, ins []any) ([]any, error) {
	limit := maxFileBytes.Load()
	for i, raw := range ins {
		in, ok := raw.(CreateInput)
		if !ok {
			return nil, fmt.Errorf("file.create: unexpected input %T", raw)
		}
		seen := map[string]int64{}
		var addrs []string
		for _, c := range in.Chunks {
			if _, dup := seen[c.Address]; !dup {
				seen[c.Address] = -1
				addrs = append(addrs, c.Address)
			}
		}
		b := named.New()
		b.Set("addrs", addrs)
		sql, args, err := b.Compile(`SELECT address, size_bytes FROM cas_blob WHERE address = ANY(:addrs::text[])`)
		if err != nil {
			return nil, fmt.Errorf("file.create: compile: %w", err)
		}
		rows, err := tx.Query(ctx, sql, args...)
		if err != nil {
			return nil, fmt.Errorf("file.create: chunk sizes: %w", err)
		}
		for rows.Next() {
			var a string
			var n int64
			if err := rows.Scan(&a, &n); err != nil {
				rows.Close()
				return nil, fmt.Errorf("file.create: chunk sizes: %w", err)
			}
			seen[a] = n
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("file.create: chunk sizes: %w", err)
		}
		var total int64
		chunks := make([]Chunk, len(in.Chunks))
		for j, c := range in.Chunks {
			size := seen[c.Address]
			if size < 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: fmt.Sprintf("file.create: chunk %d (%s) hasn't been uploaded", j, c.Address)}
			}
			total += size
			if total > limit {
				return nil, &reg.HandlerError{InputIndex: i, Code: "too_large",
					Message: fmt.Sprintf("file.create: a file can be at most %d MB", limit>>20)}
			}
			chunks[j] = Chunk{Address: c.Address, Size: size}
		}
		in.Chunks = chunks
		ins[i] = in
	}
	return ins, nil
}
