// Package config exposes server-driven configuration knobs the client
// needs to know about up front (e.g. the per-upload size cap so the UI
// can refuse oversize files before sending bytes over the wire).
//
// The endpoint is `config.get` on the JSON batch dispatcher. The values
// are populated by `cmd/kitpd` at startup via SetSnapshot — domain code
// stays decoupled from `os.Getenv` so tests can inject deterministic
// values.
package config

import (
	"context"
	"reflect"
	"sync/atomic"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/reg"
)

// Snapshot is the wire shape returned by config.get.
type Snapshot struct {
	AttachmentMaxBytes int64  `json:"attachment_max_bytes" mcp:"desc=whole-file upload cap, in bytes (UI enforces before chunking)"`
	ChunkMaxBytes      int64  `json:"chunk_max_bytes" mcp:"desc=per-chunk cap on POST /api/v1/cas/chunk, in bytes"`
	WorkspaceTitle     string `json:"workspace_title" mcp:"desc=operator-set workspace name shown in the web header + browser title"`
}

// GetInput is empty.
type GetInput struct{}

// GetOutput wraps the snapshot.
type GetOutput struct {
	Config Snapshot `json:"config" mcp:"desc=server-driven configuration values"`
}

// snapshot holds the values the dispatcher returns. cmd/kitpd writes
// once at startup; readers see a stable copy via atomic.Pointer.
var snapshot atomic.Pointer[Snapshot]

// SetSnapshot installs the live config values. Safe to call from main
// during startup; the runtime never reads it during a write because the
// dispatcher only fires after Mount has returned.
func SetSnapshot(s Snapshot) {
	cp := s
	snapshot.Store(&cp)
}

// Register installs the config.get endpoint.
func Register() {
	reg.Register(reg.Handler{
		Endpoint:     "config",
		Action:       "get",
		Doc:          "Return server-driven configuration values the client needs (e.g. attachment size caps).",
		InputType:    reflect.TypeFor[GetInput](),
		OutputType:   reflect.TypeFor[GetOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Run: func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
			cur := snapshot.Load()
			var s Snapshot
			if cur != nil {
				s = *cur
			}
			outs := make([]any, len(ins))
			for i := range ins {
				outs[i] = GetOutput{Config: s}
			}
			return outs, nil
		},
	})
}
