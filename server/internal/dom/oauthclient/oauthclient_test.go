package oauthclient_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/oauthclient"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

const claudeCode = "https://claude.ai/oauth/claude-code-client-metadata"

type fixture struct {
	srv    *api.Server
	sp     *store.Pool
	admin  context.Context
	worker context.Context
	member int64
}

func setup(t *testing.T) *fixture {
	t.Helper()
	reg.Reset()
	pool := store.TestPool(t, "kitp_test_oauth_client")
	sp := store.NewPool(pool)
	oauthclient.Register(sp)
	f := &fixture{srv: api.NewServer(sp), sp: sp}
	user := func(name, role string) int64 {
		var id int64
		if err := pool.QueryRow(context.Background(),
			`INSERT INTO user_account (display_name) VALUES ($1) RETURNING id`, name).Scan(&id); err != nil {
			t.Fatalf("user: %v", err)
		}
		if _, err := pool.Exec(context.Background(),
			`INSERT INTO user_role (user_id, role_id) SELECT $1, id FROM role WHERE name = $2`, id, role); err != nil {
			t.Fatalf("grant: %v", err)
		}
		return id
	}
	adminID := user("Ada Admin", "admin")
	f.member = user("Wes Worker", "worker")
	f.admin = auth.WithUser(context.Background(), &auth.UserCtx{ID: adminID, DisplayName: "Ada Admin"})
	f.worker = auth.WithUser(context.Background(), &auth.UserCtx{ID: f.member, DisplayName: "Wes Worker"})
	return f
}

func (f *fixture) call(t *testing.T, ctx context.Context, action, data string) api.SubResponse {
	t.Helper()
	resp := f.srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "s", Endpoint: "oauth_client", Action: action, Data: json.RawMessage(data)},
	}})
	return resp.Subresponses[0]
}

func (f *fixture) list(t *testing.T) []oauthclient.ListRow {
	t.Helper()
	sr := f.call(t, f.admin, "list", `{}`)
	if !sr.OK {
		t.Fatalf("list: %+v", sr)
	}
	// Data is the handler's output value; round-trip it through JSON as
	// the wire would.
	raw, err := json.Marshal(sr.Data)
	if err != nil {
		t.Fatalf("encode list: %v", err)
	}
	var out oauthclient.ListOutput
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("decode list: %v (%s)", err, raw)
	}
	return out.Rows
}

func byClient(rows []oauthclient.ListRow, id string) *oauthclient.ListRow {
	for i := range rows {
		if rows[i].ClientID == id {
			return &rows[i]
		}
	}
	return nil
}

// The seeded client, a member's request, an admin allowing it, and the
// row's status through allow / disallow / ask-again.
func TestLifecycle(t *testing.T) {
	f := setup(t)
	ctx := context.Background()

	rows := f.list(t)
	if len(rows) != 1 {
		t.Fatalf("seed: want only Claude Code's client, got %+v", rows)
	}
	if r := rows[0]; r.ClientID != claudeCode || !r.Allowed || r.Status != "Allowed" || r.AllowedNote != "Allowed" ||
		r.RequestNote != "" || r.Covers != "This client only" {
		t.Fatalf("seeded row = %+v", r)
	}

	// What internal/auth/oauth records when a member asks.
	const asked = "https://apps.example/client.json"
	ask := func() {
		t.Helper()
		if _, err := f.sp.P.Exec(ctx, `
			INSERT INTO oauth_client (client_id, redirect_uri, requested_by, requested_at, request_count)
			VALUES ($1, 'https://apps.example/cb', $2, now(), 1)
			ON CONFLICT (client_id) DO UPDATE SET requested_by = EXCLUDED.requested_by,
				requested_at = now(), request_count = oauth_client.request_count + 1`, asked, f.member); err != nil {
			t.Fatal(err)
		}
	}
	ask()
	ask()
	rows = f.list(t)
	r := rows[0]
	if r.ClientID != asked {
		t.Fatalf("waiting requests come first: %+v", rows)
	}
	if r.Allowed || !r.Waiting || r.Status != "Waiting for an admin" || r.RequestedByName != "Wes Worker" ||
		r.RequestCount != 2 || r.RedirectURI != "https://apps.example/cb" || r.AllowedNote != "" ||
		r.RequestNote == "" || r.RequestedAt == nil {
		t.Fatalf("waiting row = %+v", r)
	}

	// Allow it by id (the screen's Allow button).
	if sr := f.call(t, f.admin, "set", `{"id":"`+itoa(r.ID)+`","allowed":true}`); !sr.OK {
		t.Fatalf("allow: %+v", sr)
	}
	r2 := byClient(f.list(t), asked)
	if !r2.Allowed || r2.Waiting || r2.DecidedByName != "Ada Admin" || r2.AllowedNote == "" || r2.RequestNote != "" {
		t.Fatalf("allowed row = %+v", r2)
	}

	// Stop allowing: not allowed, but not waiting — the decision is newer
	// than the request.
	if sr := f.call(t, f.admin, "set", `{"id":"`+itoa(r.ID)+`","allowed":false}`); !sr.OK {
		t.Fatalf("disallow: %+v", sr)
	}
	r3 := byClient(f.list(t), asked)
	if r3.Allowed || r3.Waiting || r3.Status != "Not allowed" || r3.RequestNote == "" {
		t.Fatalf("disallowed row = %+v", r3)
	}
	// A member asking again puts it back in front of the admin.
	ask()
	if r4 := byClient(f.list(t), asked); !r4.Waiting || r4.Status != "Waiting for an admin" {
		t.Fatalf("asked again = %+v", r4)
	}

	// Add by client_id (the screen's form): the scheme and host are
	// lower-cased, the path kept. A trailing / makes it a prefix.
	sr := f.call(t, f.admin, "set", `{"client_id":"  HTTPS://MCP.Example.com:8443/OAuth/client.json ","allowed":true}`)
	if !sr.OK {
		t.Fatalf("add: %+v", sr)
	}
	added := byClient(f.list(t), "https://mcp.example.com:8443/OAuth/client.json")
	if added == nil || !added.Allowed {
		t.Fatalf("added client missing: %+v", f.list(t))
	}
	if sr := f.call(t, f.admin, "set", `{"client_id":"https://mcp.example.com/","allowed":true}`); !sr.OK {
		t.Fatalf("add prefix: %+v", sr)
	}
	if p := byClient(f.list(t), "https://mcp.example.com/"); p == nil || p.Covers != "Every client published under this address" {
		t.Fatalf("prefix row = %+v", p)
	}

	// Delete.
	if sr := f.call(t, f.admin, "delete", `{"id":"`+itoa(added.ID)+`"}`); !sr.OK {
		t.Fatalf("delete: %+v", sr)
	}
	if byClient(f.list(t), "https://mcp.example.com:8443/OAuth/client.json") != nil {
		t.Fatal("deleted client still listed")
	}
}

func TestSetRefusals(t *testing.T) {
	f := setup(t)
	for name, id := range map[string]string{
		"http":              "http://claude.ai/oauth/x",
		"no path":           "https://claude.ai",
		"query":             "https://claude.ai/oauth/x?a=1",
		"fragment":          "https://claude.ai/oauth/x#a",
		"dot segment":       "https://claude.ai/oauth/../x",
		"encoded dot":       "https://claude.ai/oauth/%2e%2e/x",
		"current dir":       "https://claude.ai/./x",
		"IP":                "https://10.0.0.5/x",
		"loopback":          "https://127.0.0.1:8443/x",
		"localhost":         "https://localhost/x",
		"single label":      "https://metadata/x",
		"user info":         "https://u@claude.ai/x",
		"bare host":         "claude.ai",
		"space":             "https://claude.ai/a b",
		"backslash":         `https://claude.ai/a\\b`,
		"bad port":          "https://claude.ai:123456/x",
		"leading dot label": "https://.claude.ai/x",
		"semicolon":         "https://claude.ai/mcp/..;/x",
		"empty segment":     "https://claude.ai//x",
	} {
		if sr := f.call(t, f.admin, "set", `{"client_id":"`+id+`","allowed":true}`); sr.OK {
			t.Errorf("%s: set accepted %q", name, id)
		}
	}
	for name, data := range map[string]string{
		"no client":  `{"allowed":true}`,
		"unknown id": `{"id":"999999","allowed":true}`,
	} {
		if sr := f.call(t, f.admin, "set", data); sr.OK {
			t.Errorf("%s: set accepted %s", name, data)
		}
	}
}

// Members can't read who asked, or decide which apps may sign in.
func TestAdminsOnly(t *testing.T) {
	f := setup(t)
	for action, data := range map[string]string{
		"list":   `{}`,
		"set":    `{"client_id":"https://evil.example/c.json","allowed":true}`,
		"delete": `{"id":"1"}`,
	} {
		if sr := f.call(t, f.worker, action, data); sr.OK {
			t.Errorf("worker %s: allowed: %+v", action, sr)
		}
	}
	var n int
	if err := f.sp.P.QueryRow(context.Background(), `SELECT count(*) FROM oauth_client WHERE client_id LIKE 'https://evil.example/%'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatal("a worker added a client")
	}
}

func itoa(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}
