// Package cas (the dom-side facade) exposes JSON dispatcher endpoints
// that operate on the cas_blob layer without touching bytes.
//
// Today there's just one: cas.missing_chunks — the pre-flight a client
// uses before uploading a multi-chunk file to skip any chunks the server
// already holds. Unified-handler shape (Phase 5 of
// docs/UNIFIED_HANDLER_PLAN.md); function body lives in
// db/schema/functions/cas_missing_chunks_batch.sql.
package cas

import (
	"reflect"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// MissingChunksInput lists candidate cas_blob addresses.
type MissingChunksInput struct {
	Addresses []string `json:"addresses" mcp:"required,desc=candidate cas_blob addresses (SHA-256 hex)"`
}

// MissingChunksOutput is the subset of the input that's NOT already in
// cas_blob. The client uploads only these chunks; everything else dedups
// against the existing rows. Duplicated input addresses come back
// duplicated in the missing list when absent — clients that want
// uniqueness dedupe their input.
type MissingChunksOutput struct {
	Missing []string `json:"missing" mcp:"desc=addresses not currently in cas_blob"`
}

// Register installs cas.missing_chunks.
func Register(_ *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "cas",
		Action:       "missing_chunks",
		Doc:          "Given a list of cas_blob addresses, return the subset NOT currently stored. Used by the client as an upload pre-flight: bytes for the missing addresses are POSTed to /api/v1/cas/chunk; everything else is skipped.",
		InputType:    reflect.TypeFor[MissingChunksInput](),
		OutputType:   reflect.TypeFor[MissingChunksOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		// CAS addresses are content-addressed blobs with no project
		// anchor — the upload pre-flight check is necessarily global.
		// Per-row authz happens downstream at attachment.create /
		// file.create when the blob gets linked to a card.
		GlobalScope: true,
		SQLFunc:     "cas_missing_chunks_batch",
		IsRead:      true,
	})
}
