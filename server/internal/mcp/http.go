// HTTP transport for the MCP server — implements the "Streamable HTTP"
// MCP variant (the current standard for remote MCP, deprecating the
// older SSE transport).
//
// Wire contract:
//
//   - POST  /api/v1/mcp
//       Body: one JSON-RPC 2.0 message
//       Auth: Authorization: Bearer <user_token value>
//       Resp: application/json with the matching JSON-RPC response, or
//             204 No Content for notifications (messages without `id`)
//
// Streaming: not implemented yet. The spec allows the server to upgrade
// a response to text/event-stream when it wants to push multiple
// messages back from one POST; kitp's tools/list and tools/call return
// a single response synchronously, so the JSON path is sufficient.
// Future server-initiated notifications would add an SSE branch here.
//
// Stateful sessions: not implemented. Each POST authenticates fresh via
// the bearer token; there is no server-side session id. This matches
// what every current MCP client needs from us (initialize is cheap to
// re-run) without the complexity of session lifecycles.
package mcp

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/auth/token"
)

// HTTPConfig wires the dependencies for an HTTP MCP endpoint.
type HTTPConfig struct {
	// Server is the MCP server whose tools we expose. Use the same
	// instance you'd hand to Run() — it carries the dispatcher.
	Server *Server
	// Tokens validates incoming bearer tokens. Required.
	Tokens *token.Manager
	// Logger is optional; nil disables structured logging.
	Logger *slog.Logger
}

// RegisterHTTP mounts the MCP HTTP handler on mux at /api/v1/mcp. Add
// the same path to the session-gate Exempt list so the bearer-token
// path doesn't bounce through the cookie middleware.
func RegisterHTTP(mux *http.ServeMux, cfg HTTPConfig) {
	mux.HandleFunc("POST /api/v1/mcp", newHandler(cfg))
}

// MaxRequestBytes caps the per-message body size to keep one client
// from spamming a huge JSON-RPC envelope. 4 MiB matches the bufio
// scanner cap on the stdio path.
const MaxRequestBytes = 4 * 1024 * 1024

func newHandler(cfg HTTPConfig) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if cfg.Server == nil || cfg.Tokens == nil {
			http.Error(w, "mcp: not configured", http.StatusInternalServerError)
			return
		}

		// 1. Bearer-token authentication. Bearer scheme only — no
		//    cookie path here. Missing / malformed → 401 with a
		//    WWW-Authenticate header so generic HTTP clients see why.
		tok := extractBearer(r.Header.Get("Authorization"))
		if tok == "" {
			w.Header().Set("WWW-Authenticate", `Bearer realm="kitp-mcp"`)
			http.Error(w, "mcp: missing or malformed Authorization header", http.StatusUnauthorized)
			return
		}
		user, err := cfg.Tokens.Lookup(r.Context(), tok)
		if err != nil {
			if errors.Is(err, token.ErrNotFound) || errors.Is(err, token.ErrExpired) {
				w.Header().Set("WWW-Authenticate", `Bearer realm="kitp-mcp" error="invalid_token"`)
				http.Error(w, "mcp: invalid or expired token", http.StatusUnauthorized)
				return
			}
			if cfg.Logger != nil {
				cfg.Logger.Error("mcp.http: token lookup", "err", err)
			}
			http.Error(w, "mcp: token lookup failed", http.StatusInternalServerError)
			return
		}

		// 2. Body read with a hard cap.
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxRequestBytes))
		if err != nil {
			http.Error(w, fmt.Sprintf("mcp: read body: %v", err), http.StatusBadRequest)
			return
		}
		if len(body) == 0 {
			http.Error(w, "mcp: empty body", http.StatusBadRequest)
			return
		}

		// 3. Build the per-request actor context. The MCP server's
		//    tools/call routes through the same dispatcher as the HTTP
		//    /api/v1/batch endpoint, so the actor flows through unchanged
		//    and per-handler authz hooks see the authenticated user.
		ctx := auth.WithUser(r.Context(), &auth.UserCtx{
			ID:          user.ID,
			DisplayName: user.DisplayName,
		})

		// 4. Process one message. nil response = notification, return 204.
		resp := cfg.Server.HandleSingle(ctx, body)
		if resp == nil {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(resp)
	}
}

// extractBearer pulls the bearer credential out of an Authorization
// header. Returns "" when the scheme is missing, wrong, or the value
// is empty. Comparison is case-insensitive per RFC 7235.
func extractBearer(header string) string {
	if header == "" {
		return ""
	}
	const prefix = "Bearer "
	if len(header) <= len(prefix) {
		return ""
	}
	if !strings.EqualFold(header[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(header[len(prefix):])
}
