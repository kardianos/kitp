// HTTP transport for the MCP server — implements the "Streamable HTTP"
// MCP variant (the current standard for remote MCP, deprecating the
// older SSE transport).
//
// Wire contract:
//
//   - POST  /api/v1/mcp
//       Body: one JSON-RPC 2.0 message
//       Auth: Authorization: Bearer <user_token value>  (resolved by
//             the apiRouter's BearerResolver before this handler runs)
//       Resp: application/json with the matching JSON-RPC response, or
//             204 No Content for notifications (messages without `id`)
//
// Streaming: not implemented yet. The spec allows the server to upgrade
// a response to text/event-stream when it wants to push multiple
// messages back from one POST; kitp's tools/list and tools/call return
// a single response synchronously, so the JSON path is sufficient.
// Future server-initiated notifications would add an SSE branch here.
//
// Stateful sessions: not implemented. Each POST is authenticated fresh
// via the bearer token; there is no server-side session id. This
// matches what every current MCP client needs from us (initialize is
// cheap to re-run) without the complexity of session lifecycles.
package mcp

import (
	"context"
	"io"
	"net/http"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
)

// HTTPConfig wires the dependencies for an HTTP MCP endpoint.
type HTTPConfig struct {
	// Server is the MCP server whose tools we expose. Use the same
	// instance you'd hand to Run() — it carries the dispatcher.
	Server *Server
}

// Mount registers POST /api/v1/mcp on the apiRouter via Bearer (the
// router's BearerResolver, configured in main.go, owns the
// Authorization header lookup against the token Manager). Once the
// handler runs the user is already resolved and attached to the
// context, so the dispatcher's per-handler authz hooks see the
// authenticated actor unchanged.
func Mount(rt *api.Router, cfg HTTPConfig) {
	rt.Bearer("POST /api/v1/mcp", func(ctx context.Context, w http.ResponseWriter, r *http.Request, _ *auth.UserCtx) error {
		return handle(ctx, w, r, cfg)
	})
}

// MaxRequestBytes caps the per-message body size to keep one client
// from spamming a huge JSON-RPC envelope. 4 MiB matches the bufio
// scanner cap on the stdio path.
const MaxRequestBytes = 4 * 1024 * 1024

func handle(ctx context.Context, w http.ResponseWriter, r *http.Request, cfg HTTPConfig) error {
	if cfg.Server == nil {
		return api.Internal(nil)
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxRequestBytes))
	if err != nil {
		return api.BadRequest("read_body", err.Error())
	}
	if len(body) == 0 {
		return api.BadRequest("empty_body", "empty body")
	}
	// HandleSingle runs the requested MCP tool through the dispatcher;
	// the user is already on `ctx` so per-handler authz hooks see the
	// authenticated actor.
	resp := cfg.Server.HandleSingle(ctx, body)
	if resp == nil {
		// nil response = notification per JSON-RPC; tell the client.
		w.WriteHeader(http.StatusNoContent)
		return nil
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(resp)
	return nil
}
