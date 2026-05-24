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
	"encoding/json"
	"reflect"

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
		// Unified handler — body lives in
		// db/schema/functions/file_create_batch.sql. See
		// docs/UNIFIED_HANDLER_PLAN.md Phase 2.
		SQLFunc: "file_create_batch",
	})
}
