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
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sync"

	"github.com/kitp/kitp/server/internal/api"
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

// Toolset selects which handlers `tools/list` advertises. Some MCP
// clients (notably LLMs) cap the number of tools they'll accept at
// session start; ToolsetMinimal exposes only `proc__search` so the
// model discovers + calls everything else on demand. ToolsetFull is
// the legacy "every endpoint is a tool" surface.
//
// Note: tools/call works for any registered handler regardless of
// the active toolset — the filter only narrows what's listed.
type Toolset string

const (
	ToolsetMinimal Toolset = "minimal"
	ToolsetFull    Toolset = "full"
)

// activeToolset is the package-level choice the server reads at
// tools/list time. Set by main.go before serving.
var activeToolset Toolset = ToolsetMinimal

// SetToolset chooses the tools/list filter. Safe to call once at
// startup; not thread-safe afterward (no real reason to flip it
// mid-stream, and tests use SetToolset in their setup helper).
func SetToolset(t Toolset) {
	switch t {
	case ToolsetFull, ToolsetMinimal:
		activeToolset = t
	default:
		activeToolset = ToolsetMinimal
	}
}

// Tools returns one Tool per registered handler, filtered by the
// active toolset. With ToolsetMinimal the result is just the
// proc__search descriptor — the model discovers + calls everything
// else on demand. With ToolsetFull every registered handler is
// listed.
func Tools() []Tool {
	hs := reg.All()
	switch activeToolset {
	case ToolsetMinimal:
		for _, h := range hs {
			if h.Endpoint == "proc" && h.Action == "search" {
				return []Tool{toolFromHandler(h)}
			}
		}
		// Fallback: if proc.search wasn't registered (a misconfigured
		// init in a test), surface the whole catalogue rather than an
		// empty list — an empty list would silently strand the client.
		fallthrough
	case ToolsetFull:
		fallthrough
	default:
		out := make([]Tool, 0, len(hs))
		for _, h := range hs {
			out = append(out, toolFromHandler(h))
		}
		return out
	}
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
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// jsonrpcResponse mirrors it on the way out.
type jsonrpcResponse struct {
	JSONRPC string         `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
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
		s.handleToolsList(req)
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

// initializeResult is the minimum shape MCP clients accept.
type initializeResult struct {
	ProtocolVersion string         `json:"protocolVersion"`
	Capabilities    map[string]any `json:"capabilities"`
	ServerInfo      map[string]any `json:"serverInfo"`
}

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
	}
	s.writeResult(req.ID, result)
}

func (s *Server) handleToolsList(req jsonrpcRequest) {
	type wireTool struct {
		Name        string  `json:"name"`
		Description string  `json:"description"`
		InputSchema *Schema `json:"inputSchema"`
	}
	tools := Tools()
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
		text := "(no error message)"
		code := "unknown"
		if sr.Error != nil {
			text = sr.Error.Message
			code = sr.Error.Code
		}
		s.writeResult(req.ID, map[string]any{
			"isError": true,
			"content": []any{
				map[string]any{"type": "text", "text": text},
			},
			"data": map[string]any{
				"code":    code,
				"message": text,
			},
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
