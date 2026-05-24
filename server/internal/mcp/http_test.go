// Tests for the Streamable HTTP MCP transport. Mounts the handler on a
// httptest server, mints a real user_token, and exercises the three
// JSON-RPC methods the client cares about: initialize, tools/list,
// tools/call.
package mcp_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/auth/token"
	"github.com/kitp/kitp/server/internal/dom/activity"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/mcp"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

type httpFixture struct {
	ts      *httptest.Server
	bearer  string
	pool    *pgxpool.Pool
	agentID int64
}

// setupHTTPMCP boots an httptest.Server with the MCP HTTP transport
// mounted, a real Postgres-backed token manager, and the v1 dispatcher
// registry. The returned fixture carries the underlying pool so tests
// that need to mutate auth state (e.g. revoke a token mid-test) can
// reach the DB without a second TestPool call (which would DROP the
// schema and lose the seeded rows).
func setupHTTPMCP(t *testing.T, schemaName string) *httpFixture {
	t.Helper()
	reg.Reset()
	pool := store.TestPool(t, schemaName)
	sp := store.NewPool(pool)

	echo.Register()
	cardtype.Register()
	card.Register(sp)
	attribute.Register(sp)
	activity.Register(sp)

	srv := api.NewServer(sp)
	mcpSrv := mcp.NewServer(srv, nil, nil)

	tokenMgr := token.New(pool, token.Config{})

	// Seed a parent + an agent for the token to authenticate as.
	ctx := context.Background()
	var parent, agentID int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO user_account (display_name) VALUES ('parent-mcp-http') RETURNING id`,
	).Scan(&parent); err != nil {
		t.Fatalf("seed parent: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO user_account (display_name, parent_user_id, is_agent)
		VALUES ('agent-mcp-http', $1, TRUE) RETURNING id`, parent,
	).Scan(&agentID); err != nil {
		t.Fatalf("seed agent: %v", err)
	}
	tok, err := tokenMgr.Create(ctx, agentID, "test-token", nil)
	if err != nil {
		t.Fatalf("mint token: %v", err)
	}

	// Build an apiRouter with a bearer resolver that consults the
	// test's token manager — mirrors what main.go wires up in
	// production. The MCP handler itself doesn't see the token
	// anymore; the router resolves the user before the handler runs.
	rt := api.NewRouter(api.RouterConfig{
		BearerResolver: func(r *http.Request) (*auth.UserCtx, error) {
			h := r.Header.Get("Authorization")
			const prefix = "Bearer "
			if len(h) <= len(prefix) || !strings.EqualFold(h[:len(prefix)], prefix) {
				return nil, nil
			}
			u, err := tokenMgr.Lookup(r.Context(), strings.TrimSpace(h[len(prefix):]))
			if err != nil {
				return nil, err
			}
			return &auth.UserCtx{ID: u.ID, DisplayName: u.DisplayName}, nil
		},
	})
	mcp.Mount(rt, mcp.HTTPConfig{Server: mcpSrv})
	top := http.NewServeMux()
	top.Handle("/api/", rt.Mux())
	ts := httptest.NewServer(top)
	t.Cleanup(ts.Close)
	return &httpFixture{ts: ts, bearer: tok, pool: pool, agentID: agentID}
}

// post wraps a single JSON-RPC POST against the test server.
func post(t *testing.T, ts *httptest.Server, bearer string, body string) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/mcp", bytes.NewBufferString(body))
	if err != nil {
		t.Fatal(err)
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	buf, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	return resp, buf
}

func TestMCPHTTP_Initialize(t *testing.T) {
	f := setupHTTPMCP(t, "kitp_test_mcp_http_init")
	resp, body := post(t, f.ts, f.bearer,
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: got %d body=%s", resp.StatusCode, body)
	}
	var got struct {
		Result struct {
			ProtocolVersion string `json:"protocolVersion"`
			ServerInfo      struct {
				Name string `json:"name"`
			} `json:"serverInfo"`
		} `json:"result"`
		Error any `json:"error"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode: %v: %s", err, body)
	}
	if got.Error != nil {
		t.Fatalf("error: %v", got.Error)
	}
	if got.Result.ServerInfo.Name != "kitp" {
		t.Fatalf("serverInfo.name: %s", body)
	}
}

func TestMCPHTTP_ToolsListAndCall(t *testing.T) {
	f := setupHTTPMCP(t, "kitp_test_mcp_http_tools")

	// tools/list — must include echo__ping with the full toolset.
	resp, body := post(t, f.ts, f.bearer,
		`{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("tools/list status: %d body=%s", resp.StatusCode, body)
	}
	if !bytes.Contains(body, []byte(`"echo__ping"`)) {
		t.Fatalf("tools/list missing echo__ping: %s", body)
	}

	// tools/call echo__ping. The echo handler returns its input verbatim
	// in the `data` field; assert both halves of the input survived the
	// round-trip through HTTP → MCP → dispatcher → echo handler.
	resp, body = post(t, f.ts, f.bearer,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo__ping","arguments":{"x":7,"message":"hi"}}}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("tools/call status: %d body=%s", resp.StatusCode, body)
	}
	if !bytes.Contains(body, []byte(`"x":7`)) {
		t.Fatalf("tools/call response missing echoed x=7: %s", body)
	}
	if !bytes.Contains(body, []byte(`"message":"hi"`)) {
		t.Fatalf("tools/call response missing echoed message: %s", body)
	}
}

func TestMCPHTTP_MissingTokenIs401(t *testing.T) {
	f := setupHTTPMCP(t, "kitp_test_mcp_http_no_auth")
	resp, _ := post(t, f.ts, "",
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", resp.StatusCode)
	}
	if resp.Header.Get("WWW-Authenticate") == "" {
		t.Fatal("expected WWW-Authenticate header on 401")
	}
}

func TestMCPHTTP_InvalidTokenIs401(t *testing.T) {
	f := setupHTTPMCP(t, "kitp_test_mcp_http_bad_auth")
	resp, _ := post(t, f.ts, "not-a-real-token",
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", resp.StatusCode)
	}
}

func TestMCPHTTP_RevokedTokenIs401(t *testing.T) {
	f := setupHTTPMCP(t, "kitp_test_mcp_http_revoked")
	// 1. Initial call should pass.
	resp, _ := post(t, f.ts, f.bearer,
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("initial call should succeed, got %d", resp.StatusCode)
	}
	// 2. Revoke via the same pool the fixture is using (NOT a fresh
	//    TestPool call — that would DROP the schema and lose our row).
	if _, err := f.pool.Exec(context.Background(),
		`UPDATE user_token SET revoked_at = now() WHERE id = $1`, f.bearer,
	); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	// 3. Same bearer now rejected.
	resp, _ = post(t, f.ts, f.bearer,
		`{"jsonrpc":"2.0","id":2,"method":"initialize","params":{}}`)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 after revoke, got %d", resp.StatusCode)
	}
}

func TestMCPHTTP_NotificationIs204(t *testing.T) {
	f := setupHTTPMCP(t, "kitp_test_mcp_http_notify")
	// Notification: no `id` field. MCP server should silently swallow
	// it (per JSON-RPC) and the HTTP transport should return 204.
	resp, body := post(t, f.ts, f.bearer,
		`{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}`)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204, got %d body=%s", resp.StatusCode, body)
	}
	if len(body) != 0 {
		t.Fatalf("expected empty body on 204, got: %s", body)
	}
}
