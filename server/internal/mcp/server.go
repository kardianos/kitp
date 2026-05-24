// Package mcp publishes every registered API handler as an MCP tool over
// JSON-RPC 2.0 / stdio (the standard MCP transport). It implements the
// minimum subset of the MCP protocol the rest of the system needs:
// initialize, tools/list, tools/call.
//
// Tool names are "<endpoint>__<action>" (double underscore so
// dot-separated names in our domain stay readable on the MCP side).
//
// Handler input/output JSON Schemas are derived from struct tags via
// internal/mcp/schema.go (tag schema v1, locked in docs/mcp-tags.md).
package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sync"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/reg"
)

// Tool is the public per-handler descriptor; it doubles as both a
// proc.search row and the tools/list element.
type Tool struct {
	Name         string  `json:"name"`
	Description  string  `json:"description,omitempty"`
	InputSchema  *Schema `json:"input_schema,omitempty"`
	OutputSchema *Schema `json:"output_schema,omitempty"`
}

// ToolsFor returns every handler the actor on ctx is allowed to
// invoke. The filter mirrors api/role_gate.go's logic:
//
//   - `$public` handlers are always included.
//   - `$authenticated` handlers are included when the request carries
//     a resolved user.
//   - Any other AllowedRoles entry is included when the actor either
//     holds the named role or the seeded `system` wildcard.
//
// This drives `tools/list`: every Claude Code MCP client picks up the
// full catalogue at session start, so the model never has to
// "discover + call on demand" through a separate proc.search hop.
//
// `pool` may be nil when the caller has no DB handy (e.g. stdio mode
// tests that pre-resolved the actor's roles or don't gate by role).
// A nil pool means role-gated handlers are omitted for any
// non-`$public` / non-`$authenticated` tools.
func ToolsFor(ctx context.Context, pool auth.RolesPool) []Tool {
	hs := reg.All()
	user, signedIn := auth.FromContext(ctx)
	signedIn = signedIn && user != nil && user.ID != 0

	// Role lookup is lazy — a fully `$public` registry doesn't pay for
	// a DB round-trip.
	var (
		rolesLoaded bool
		rolesSet    map[string]struct{}
	)
	loadRoles := func() map[string]struct{} {
		if rolesLoaded {
			return rolesSet
		}
		rolesLoaded = true
		if !signedIn || pool == nil {
			rolesSet = map[string]struct{}{}
			return rolesSet
		}
		names, err := auth.LoadUserRoles(ctx, pool, user.ID)
		if err != nil {
			// Treat a transient lookup failure as "no roles" — we'd
			// rather omit role-gated tools than crash tools/list.
			rolesSet = map[string]struct{}{}
			return rolesSet
		}
		rolesSet = make(map[string]struct{}, len(names))
		for _, n := range names {
			rolesSet[n] = struct{}{}
		}
		return rolesSet
	}

	out := make([]Tool, 0, len(hs))
	for _, h := range hs {
		if allowedForActor(h, signedIn, loadRoles) {
			out = append(out, toolFromHandler(h))
		}
	}
	return out
}

func allowedForActor(h reg.Handler, signedIn bool, loadRoles func() map[string]struct{}) bool {
	hasPublic := false
	hasAuthed := false
	for _, r := range h.AllowedRoles {
		switch r {
		case reg.RolePublic:
			hasPublic = true
		case reg.RoleAuthenticated:
			hasAuthed = true
		}
	}
	if hasPublic {
		return true
	}
	if !signedIn {
		return false
	}
	if hasAuthed {
		return true
	}
	have := loadRoles()
	for _, r := range h.AllowedRoles {
		if r == reg.RolePublic || r == reg.RoleAuthenticated {
			continue
		}
		if _, ok := have[r]; ok {
			return true
		}
	}
	return false
}

func toolFromHandler(h reg.Handler) Tool {
	return Tool{
		Name:         h.Endpoint + "__" + h.Action,
		Description:  h.Doc,
		InputSchema:  SchemaForType(h.InputType, true),
		OutputSchema: SchemaForType(h.OutputType, false),
	}
}

// Server speaks MCP JSON-RPC 2.0 over an io.Reader / io.Writer pair
// (typically stdin / stdout when run as a child process). It is
// stateless across calls; each tools/call opens its own DB tx via the
// supplied dispatcher.
type Server struct {
	dispatcher *api.Server
	in         io.Reader
	out        io.Writer

	mu sync.Mutex // serialises writes to out
}

// NewServer constructs an MCP server. dispatcher is required so
// tools/call can synthesize a one-element batch and route it through
// the same code path as the HTTP API.
func NewServer(dispatcher *api.Server, in io.Reader, out io.Writer) *Server {
	return &Server{dispatcher: dispatcher, in: in, out: out}
}

// jsonrpcRequest is the wire shape for one inbound JSON-RPC message.
type jsonrpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,string,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// jsonrpcResponse mirrors it on the way out.
type jsonrpcResponse struct {
	JSONRPC string         `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,string,omitempty"`
	Result  any            `json:"result,omitempty"`
	Error   *jsonrpcError  `json:"error,omitempty"`
}

type jsonrpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

// Run reads one JSON-RPC message per line from in and writes one JSON-RPC
// response per line to out. Returns when in closes (EOF) or on a
// non-recoverable I/O error.
//
// Each MCP message must be a single JSON object on its own line — that
// is the simple "stdio + line-delimited JSON" transport variant. The
// header-framed transport (LSP-style) is not implemented here; it is
// not required for kitp's local-spawn use case.
func (s *Server) Run(ctx context.Context) error {
	scanner := bufio.NewScanner(s.in)
	// Allow large messages: 4 MiB is plenty for tool listings.
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var req jsonrpcRequest
		if err := json.Unmarshal(line, &req); err != nil {
			s.writeError(nil, -32700, "parse error: "+err.Error(), nil)
			continue
		}
		s.handle(ctx, req)
	}
	if err := scanner.Err(); err != nil && err != io.EOF {
		return fmt.Errorf("mcp: read: %w", err)
	}
	return nil
}

func (s *Server) handle(ctx context.Context, req jsonrpcRequest) {
	switch req.Method {
	case "initialize":
		s.handleInitialize(req)
	case "tools/list":
		s.handleToolsList(ctx, req)
	case "tools/call":
		s.handleToolsCall(ctx, req)
	default:
		// notifications (no id) are silently ignored.
		if len(req.ID) == 0 {
			return
		}
		s.writeError(req.ID, -32601, "method not found: "+req.Method, nil)
	}
}

// initializeResult is the minimum shape MCP clients accept. The
// optional `Instructions` field carries the server-authored guidance
// the MCP client surfaces to the LLM at session start; we use it to
// pin defaults that the handlers themselves don't enforce (e.g.
// "filter terminal-phase cards by default when reading tasks").
type initializeResult struct {
	ProtocolVersion string         `json:"protocolVersion"`
	Capabilities    map[string]any `json:"capabilities"`
	ServerInfo      map[string]any `json:"serverInfo"`
	Instructions    string         `json:"instructions,omitempty"`
}

// serverInstructions is the prose the LLM reads at session start.
// Soft conventions only — the handlers don't enforce these. Keep it
// short; MCP clients render this verbatim.
const serverInstructions = `kitp MCP conventions

Default filters for card reads (card.select_with_attributes, card.search):

- When listing task cards, default to active-phase rows only. Compose
  this via the predicate tree:
    tree: { connective: "and", children: [
      { attr: "status", op: "has_phase", values: ["active"] }
    ] }
  Add "triage" or "terminal" to the values array only when the user
  explicitly asks for inbox / closed / archived items. The handler
  does not apply this default itself — callers that omit a phase
  predicate get every phase back.

- routed_to_me=true returns cards routed to the calling agent via
  user_card_agent. Pair it with the active-only predicate above for
  the standard "my open work" view.

ID encoding: every bigint id (card_id, parent_card_id, etc.) crosses
the wire as a JSON string. Pass "114" not 114.`

func (s *Server) handleInitialize(req jsonrpcRequest) {
	result := initializeResult{
		ProtocolVersion: "2024-11-05",
		Capabilities: map[string]any{
			"tools": map[string]any{
				"listChanged": false,
			},
		},
		ServerInfo: map[string]any{
			"name":    "kitp",
			"version": "v1-phase19",
		},
		Instructions: serverInstructions,
	}
	s.writeResult(req.ID, result)
}

func (s *Server) handleToolsList(ctx context.Context, req jsonrpcRequest) {
	type wireTool struct {
		Name        string  `json:"name"`
		Description string  `json:"description"`
		InputSchema *Schema `json:"inputSchema"`
	}
	var pool auth.RolesPool
	if s.dispatcher != nil && s.dispatcher.Pool != nil {
		pool = s.dispatcher.Pool.P
	}
	tools := ToolsFor(ctx, pool)
	wire := make([]wireTool, 0, len(tools))
	for _, t := range tools {
		wire = append(wire, wireTool{
			Name:        t.Name,
			Description: t.Description,
			InputSchema: t.InputSchema,
		})
	}
	s.writeResult(req.ID, map[string]any{
		"tools": wire,
	})
}

// callParams is the wire shape for tools/call.
type callParams struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

func (s *Server) handleToolsCall(ctx context.Context, req jsonrpcRequest) {
	var p callParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		s.writeError(req.ID, -32602, "invalid params: "+err.Error(), nil)
		return
	}
	if p.Name == "" {
		s.writeError(req.ID, -32602, "tool name is required", nil)
		return
	}

	endpoint, action, ok := splitToolName(p.Name)
	if !ok {
		s.writeError(req.ID, -32602, "tool name must be <endpoint>__<action>: "+p.Name, nil)
		return
	}
	if _, ok := reg.Lookup(endpoint, action); !ok {
		s.writeError(req.ID, -32601, "no handler registered for "+endpoint+"."+action, nil)
		return
	}

	// Synthesize a one-element batch and dispatch it through the same
	// path the HTTP server uses. Errors and successes flow back as one
	// MCP tool result with isError set per the MCP spec.
	args := p.Arguments
	if len(args) == 0 {
		args = json.RawMessage(`{}`)
	}
	resp := s.dispatcher.Dispatch(ctx, api.BatchRequest{
		Subrequests: []api.SubRequest{{
			ID:       "mcp-1",
			Type:     "data",
			Endpoint: endpoint,
			Action:   action,
			Data:     args,
		}},
	})
	if len(resp.Subresponses) != 1 {
		s.writeError(req.ID, -32603, "internal: dispatcher returned wrong subresponse count", nil)
		return
	}
	sr := resp.Subresponses[0]
	if !sr.OK {
		// Surface as an MCP tool error: not a JSON-RPC error (which is
		// reserved for protocol-level failures), but a successful
		// response carrying isError=true and a textual content block.
		// Some MCP clients also read the data field; we include both.
		//
		// Gate 5 (FLOW_AND_SCREEN_KERNEL V13): when the rejection
		// carries a structured Detail payload (the flow-aware
		// attribute.update envelope's from / attempted_to / available[]),
		// pass it through verbatim on data.detail so the LLM client can
		// read the available transitions and surface them to the user.
		text := "(no error message)"
		code := "unknown"
		var detail any
		if sr.Error != nil {
			text = sr.Error.Message
			code = sr.Error.Code
			detail = sr.Error.Detail
		}
		data := map[string]any{
			"code":    code,
			"message": text,
		}
		if detail != nil {
			data["detail"] = detail
		}
		s.writeResult(req.ID, map[string]any{
			"isError": true,
			"content": []any{
				map[string]any{"type": "text", "text": text},
			},
			"data": data,
		})
		return
	}
	dataBuf, err := json.Marshal(sr.Data)
	if err != nil {
		s.writeError(req.ID, -32603, "internal: marshal subresponse: "+err.Error(), nil)
		return
	}
	s.writeResult(req.ID, map[string]any{
		"isError": false,
		"content": []any{
			map[string]any{"type": "text", "text": string(dataBuf)},
		},
		"data": json.RawMessage(dataBuf),
	})
}

// splitToolName parses "<endpoint>__<action>" into (endpoint, action, true).
func splitToolName(name string) (string, string, bool) {
	for i := 0; i+1 < len(name); i++ {
		if name[i] == '_' && name[i+1] == '_' {
			endpoint := name[:i]
			action := name[i+2:]
			if endpoint == "" || action == "" {
				return "", "", false
			}
			return endpoint, action, true
		}
	}
	return "", "", false
}

func (s *Server) writeResult(id json.RawMessage, result any) {
	resp := jsonrpcResponse{JSONRPC: "2.0", ID: id, Result: result}
	s.write(resp)
}

func (s *Server) writeError(id json.RawMessage, code int, msg string, data any) {
	resp := jsonrpcResponse{
		JSONRPC: "2.0",
		ID:      id,
		Error:   &jsonrpcError{Code: code, Message: msg, Data: data},
	}
	s.write(resp)
}

func (s *Server) write(resp jsonrpcResponse) {
	buf, err := json.Marshal(resp)
	if err != nil {
		// We can't encode our own response; nothing to do but drop it.
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, _ = s.out.Write(buf)
	_, _ = s.out.Write([]byte{'\n'})
}

// HandleSingle processes one inbound JSON-RPC message and returns the
// encoded response bytes (without trailing newline). Returns nil for
// notifications (messages without an id). Used by the Streamable HTTP
// transport — each POST body carries one message and the response body
// carries the matching reply.
//
// A fresh Server is constructed per call so the per-instance write lock
// never serialises concurrent HTTP requests; the underlying dispatcher
// is goroutine-safe and is the only shared state.
func (s *Server) HandleSingle(ctx context.Context, raw []byte) []byte {
	var buf bytes.Buffer
	fresh := &Server{dispatcher: s.dispatcher, out: &buf}
	var req jsonrpcRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		fresh.writeError(nil, -32700, "parse error: "+err.Error(), nil)
	} else {
		fresh.handle(ctx, req)
	}
	out := buf.Bytes()
	if len(out) > 0 && out[len(out)-1] == '\n' {
		out = out[:len(out)-1]
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
