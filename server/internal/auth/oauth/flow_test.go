// End-to-end tests for MCP OAuth sign-in: discovery, the consent page, the
// code and refresh grants, trust in clients, and that the token Claude ends
// up with works on /api/v1/mcp as the chosen agent. The client metadata
// document is published at https://example.com/client.json, served by a TLS
// test server (its certificate covers example.com) that the fetcher dials
// whatever the address.
package oauth_test

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/auth/oauth"
	"github.com/kitp/kitp/server/internal/auth/session"
	"github.com/kitp/kitp/server/internal/auth/token"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/mcp"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

const (
	clientID       = "https://example.com/client.json"
	otherClientID  = "https://other.example/client.json"
	clientRedirect = "https://claude.example/api/mcp/auth_callback"
	loginPath      = "/api/v1/auth/oidc/start"
)

type fixture struct {
	t        *testing.T
	pool     *pgxpool.Pool
	kitp     *httptest.Server
	cookie   string
	human    int64
	agent    int64
	idle     int64 // the human's second agent, with no roles
	stranger int64 // someone else's agent
	fetches  int   // client documents served
	http     *http.Client
	srv      *oauth.Server
}

func setup(t *testing.T) *fixture {
	t.Helper()
	reg.Reset()
	pool := store.TestPool(t, "kitp_test_oauth")
	ctx := context.Background()
	f := &fixture{t: t, pool: pool}

	// The client's published metadata document.
	docs := http.NewServeMux()
	clientTS := httptest.NewTLSServer(docs)
	t.Cleanup(clientTS.Close)
	docs.HandleFunc("GET /client.json", func(w http.ResponseWriter, _ *http.Request) {
		f.fetches++
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(map[string]any{
			"client_id":                  clientID,
			"client_name":                "Test Claude",
			"redirect_uris":              []string{clientRedirect, "http://localhost/callback"},
			"grant_types":                []string{"authorization_code", "refresh_token"},
			"response_types":             []string{"code"},
			"token_endpoint_auth_method": "none",
		}); err != nil {
			t.Errorf("serve client document: %v", err)
		}
	})
	tr := clientTS.Client().Transport.(*http.Transport).Clone()
	addr := clientTS.Listener.Addr().String()
	tr.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, network, addr)
	}
	fetcher := &http.Client{
		Transport:     tr,
		Timeout:       5 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}

	// People: a human with two agents, and another human's agent.
	var stranger int64
	for _, q := range []struct {
		sql string
		out *int64
	}{
		{`INSERT INTO user_account (display_name) VALUES ('Ada') RETURNING id`, &f.human},
		{`INSERT INTO user_account (display_name) VALUES ('Bea') RETURNING id`, &stranger},
	} {
		if err := pool.QueryRow(ctx, q.sql).Scan(q.out); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	for _, a := range []struct {
		name  string
		owner int64
		out   *int64
	}{
		{"Ada's Claude", f.human, &f.agent},
		{"Ada's spare", f.human, &f.idle},
		{"Bea's bot", stranger, &f.stranger},
	} {
		if err := pool.QueryRow(ctx, `INSERT INTO user_account (display_name, parent_user_id, is_agent)
			VALUES ($1, $2, TRUE) RETURNING id`, a.name, a.owner).Scan(a.out); err != nil {
			t.Fatalf("seed agent: %v", err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO user_role (user_id, role_id)
		SELECT $1, id FROM role WHERE name = 'worker'`, f.agent); err != nil {
		t.Fatalf("grant role: %v", err)
	}
	// The test client is trusted the way an admin trusts one.
	if _, err := pool.Exec(ctx, `INSERT INTO oauth_client (client_id, allowed) VALUES ($1, true)`, clientID); err != nil {
		t.Fatalf("trust client: %v", err)
	}

	sessions := session.New(pool, session.Config{})
	sid, err := sessions.Create(ctx, f.human, "")
	if err != nil {
		t.Fatalf("session: %v", err)
	}
	f.cookie = sid
	tokens := token.New(pool, token.Config{})

	sessionResolver := func(r *http.Request) (*auth.UserCtx, error) {
		id := session.Read(r)
		if id == "" {
			return nil, nil
		}
		u, err := sessions.Lookup(r.Context(), id)
		if err != nil {
			return nil, err
		}
		return &auth.UserCtx{ID: u.ID, DisplayName: u.DisplayName}, nil
	}
	rt := api.NewRouter(api.RouterConfig{
		SessionResolver: sessionResolver,
		BearerResolver: func(r *http.Request) (*auth.UserCtx, error) {
			h := r.Header.Get("Authorization")
			if !strings.HasPrefix(h, "Bearer ") {
				return nil, nil
			}
			u, err := tokens.Lookup(r.Context(), strings.TrimPrefix(h, "Bearer "))
			if err != nil {
				return nil, err
			}
			return &auth.UserCtx{ID: u.ID, DisplayName: u.DisplayName, TokenScope: u.Scope}, nil
		},
	})
	top := http.NewServeMux()
	var handler http.Handler = api.CSP(api.CSPConfig{})(top)
	f.kitp = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handler.ServeHTTP(w, r) }))
	t.Cleanup(f.kitp.Close)

	srv, err := oauth.New(oauth.Config{
		PublicURL:  f.kitp.URL,
		Pool:       pool,
		Session:    sessionResolver,
		LoginPath:  loginPath,
		HTTPClient: fetcher,
		MaxDays:    365,
	})
	if err != nil {
		t.Fatalf("oauth.New: %v", err)
	}
	f.srv = srv
	srv.Mount(rt, top)
	echo.Register()
	mcp.Mount(rt, mcp.HTTPConfig{
		Server:              mcp.NewServer(api.NewServer(store.NewPool(pool)), nil, nil),
		ResourceMetadataURL: srv.ResourceMetadataURL(),
	})
	rt.BearerScoped("POST /api/v1/links", auth.TokenScopeLinks, func(_ context.Context, w http.ResponseWriter, _ *http.Request, _ *auth.UserCtx) error {
		w.WriteHeader(http.StatusNoContent)
		return nil
	})
	top.Handle("/api/", rt.Mux())

	f.http = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return f
}

func (f *fixture) do(req *http.Request) (*http.Response, string) {
	f.t.Helper()
	resp, err := f.http.Do(req)
	if err != nil {
		f.t.Fatalf("%s %s: %v", req.Method, req.URL, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		f.t.Fatalf("read body: %v", err)
	}
	return resp, string(body)
}

func (f *fixture) get(path string, withCookie bool) (*http.Response, string) {
	f.t.Helper()
	req, _ := http.NewRequest(http.MethodGet, f.kitp.URL+path, nil)
	if withCookie {
		req.AddCookie(&http.Cookie{Name: session.CookieName, Value: f.cookie})
	}
	return f.do(req)
}

func (f *fixture) postForm(path string, form url.Values, withCookie bool) (*http.Response, string) {
	f.t.Helper()
	req, _ := http.NewRequest(http.MethodPost, f.kitp.URL+path, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if withCookie {
		req.AddCookie(&http.Cookie{Name: session.CookieName, Value: f.cookie})
	}
	return f.do(req)
}

func (f *fixture) bearer(path, access string) int {
	f.t.Helper()
	req, _ := http.NewRequest(http.MethodPost, f.kitp.URL+path,
		strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}`))
	if access != "" {
		req.Header.Set("Authorization", "Bearer "+access)
	}
	resp, _ := f.do(req)
	return resp.StatusCode
}

func (f *fixture) mcp(access string) int { return f.bearer(oauth.MCPPath, access) }

type pkce struct{ verifier, challenge string }

func newPKCE(t *testing.T) pkce {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	v := base64.RawURLEncoding.EncodeToString(b)
	sum := sha256.Sum256([]byte(v))
	return pkce{v, base64.RawURLEncoding.EncodeToString(sum[:])}
}

// authParams is an authorization request as Claude sends it.
func (f *fixture) authParams(p pkce, client, redirect string) url.Values {
	return url.Values{
		"response_type":         {"code"},
		"client_id":             {client},
		"redirect_uri":          {redirect},
		"state":                 {"st-123"},
		"code_challenge":        {p.challenge},
		"code_challenge_method": {"S256"},
		"resource":              {f.kitp.URL + oauth.MCPPath},
		"scope":                 {"mcp offline_access"},
	}
}

var consentTokenRE = regexp.MustCompile(`name="consent_token" value="([^"]+)"`)

func consentTokenOf(t *testing.T, body string) string {
	t.Helper()
	m := consentTokenRE.FindStringSubmatch(body)
	if m == nil {
		t.Fatalf("no consent token on the page: %s", body)
	}
	return m[1]
}

// approve walks the consent page for agentID and returns the code.
func (f *fixture) approve(p pkce, agentID int64) string {
	f.t.Helper()
	q := f.authParams(p, clientID, clientRedirect)
	resp, body := f.get(oauth.AuthorizePath+"?"+q.Encode(), true)
	if resp.StatusCode != http.StatusOK {
		f.t.Fatalf("consent page: %d %s", resp.StatusCode, body)
	}
	form := f.authParams(p, clientID, clientRedirect)
	form.Set("consent_token", consentTokenOf(f.t, body))
	form.Set("decision", "allow")
	form.Set("agent_id", itoa(agentID))
	resp, body = f.postForm(oauth.AuthorizePath, form, true)
	if resp.StatusCode != http.StatusSeeOther {
		f.t.Fatalf("allow: %d %s", resp.StatusCode, body)
	}
	loc, err := url.Parse(resp.Header.Get("Location"))
	if err != nil {
		f.t.Fatal(err)
	}
	if got := loc.Scheme + "://" + loc.Host + loc.Path; got != clientRedirect {
		f.t.Fatalf("redirected to %s", got)
	}
	if loc.Query().Get("state") != "st-123" || loc.Query().Get("iss") != f.kitp.URL {
		f.t.Fatalf("redirect query %v", loc.Query())
	}
	return loc.Query().Get("code")
}

type tokens struct {
	AccessToken  string `json:"access_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int64  `json:"expires_in"`
	RefreshToken string `json:"refresh_token"`
	Scope        string `json:"scope"`
	Error        string `json:"error"`
}

func (f *fixture) token(form url.Values) (int, tokens) {
	f.t.Helper()
	resp, body := f.postForm(oauth.TokenPath, form, false)
	var out tokens
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		f.t.Fatalf("token reply %d: %s", resp.StatusCode, body)
	}
	if resp.Header.Get("Cache-Control") != "no-store" {
		f.t.Errorf("token reply Cache-Control = %q", resp.Header.Get("Cache-Control"))
	}
	return resp.StatusCode, out
}

func (f *fixture) exchange(code string, p pkce) (int, tokens) {
	return f.token(url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"client_id":     {clientID},
		"redirect_uri":  {clientRedirect},
		"code_verifier": {p.verifier},
		"resource":      {f.kitp.URL + oauth.MCPPath},
	})
}

func (f *fixture) refresh(rt string) (int, tokens) {
	return f.token(url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {rt},
		"client_id":     {clientID},
	})
}

// connect runs the whole sign-in for the human's working agent.
func (f *fixture) connect() tokens {
	f.t.Helper()
	p := newPKCE(f.t)
	status, tok := f.exchange(f.approve(p, f.agent), p)
	if status != http.StatusOK {
		f.t.Fatalf("exchange: %d %+v", status, tok)
	}
	return tok
}

func (f *fixture) liveGrants() int {
	f.t.Helper()
	var n int
	if err := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM oauth_grant WHERE revoked_at IS NULL`).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}

func itoa(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func TestDiscovery(t *testing.T) {
	f := setup(t)

	// An MCP call without a token points at the resource metadata.
	req, _ := http.NewRequest(http.MethodPost, f.kitp.URL+oauth.MCPPath, strings.NewReader(`{}`))
	resp, _ := f.do(req)
	want := `resource_metadata="` + f.srv.ResourceMetadataURL() + `"`
	if resp.StatusCode != http.StatusUnauthorized || !strings.Contains(resp.Header.Get("WWW-Authenticate"), want) {
		t.Fatalf("unauthenticated MCP: %d %q", resp.StatusCode, resp.Header.Get("WWW-Authenticate"))
	}

	for _, path := range []string{"/.well-known/oauth-protected-resource/api/v1/mcp", "/.well-known/oauth-protected-resource"} {
		resp, body := f.get(path, false)
		var prm struct {
			Resource             string   `json:"resource"`
			AuthorizationServers []string `json:"authorization_servers"`
		}
		if err := json.Unmarshal([]byte(body), &prm); err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("%s: %d %s", path, resp.StatusCode, body)
		}
		if prm.Resource != f.kitp.URL+oauth.MCPPath || len(prm.AuthorizationServers) != 1 || prm.AuthorizationServers[0] != f.kitp.URL {
			t.Fatalf("%s = %+v", path, prm)
		}
	}

	resp, body := f.get("/.well-known/oauth-authorization-server", false)
	var as map[string]any
	if err := json.Unmarshal([]byte(body), &as); err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("AS metadata: %d %s", resp.StatusCode, body)
	}
	for key, want := range map[string]any{
		"issuer":                                f.kitp.URL,
		"authorization_endpoint":                f.kitp.URL + oauth.AuthorizePath,
		"token_endpoint":                        f.kitp.URL + oauth.TokenPath,
		"client_id_metadata_document_supported": true,
	} {
		if as[key] != want {
			t.Errorf("AS metadata %s = %v, want %v", key, as[key], want)
		}
	}
	for key, want := range map[string]string{
		"code_challenge_methods_supported":      "S256",
		"token_endpoint_auth_methods_supported": "none",
	} {
		list, _ := as[key].([]any)
		if len(list) != 1 || list[0] != want {
			t.Errorf("AS metadata %s = %v, want [%s]", key, as[key], want)
		}
	}
	if _, ok := as["registration_endpoint"]; ok {
		t.Error("AS metadata advertises registration_endpoint; kitp has no DCR")
	}
}

func TestConsentPage(t *testing.T) {
	f := setup(t)
	p := newPKCE(t)
	q := f.authParams(p, clientID, clientRedirect)

	// Not signed in: off to the SSO start, coming back here — and nothing
	// fetched for a visitor kitp doesn't know.
	resp, _ := f.get(oauth.AuthorizePath+"?"+q.Encode(), false)
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("no session: %d", resp.StatusCode)
	}
	loc, _ := url.Parse(resp.Header.Get("Location"))
	if loc.Path != loginPath || !strings.HasPrefix(loc.Query().Get("redirect"), oauth.AuthorizePath+"?") {
		t.Fatalf("no session: Location %s", resp.Header.Get("Location"))
	}
	if f.fetches != 0 {
		t.Fatalf("fetched the client document for a visitor with no session (%d)", f.fetches)
	}

	resp, body := f.get(oauth.AuthorizePath+"?"+q.Encode(), true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("consent: %d %s", resp.StatusCode, body)
	}
	for _, want := range []string{"Connect Test Claude", "Ada&#39;s Claude", "Ada&#39;s spare", "No roles yet", "claude.example", "Signed in as Ada"} {
		if !strings.Contains(body, want) {
			t.Errorf("consent page lacks %q", want)
		}
	}
	if strings.Contains(body, "Bea&#39;s bot") {
		t.Error("consent page offers someone else's agent")
	}
	if csp := resp.Header.Get("Content-Security-Policy"); !strings.Contains(csp, "form-action 'self' https://claude.example;") {
		t.Errorf("CSP form-action not widened to the redirect origin: %s", csp)
	}

	// A loopback redirect (Claude Code) works on any port and warns.
	resp, body = f.get(oauth.AuthorizePath+"?"+f.authParams(p, clientID, "http://localhost:43123/callback").Encode(), true)
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, "a program on this computer (localhost:43123)") {
		t.Fatalf("loopback consent: %d %s", resp.StatusCode, body)
	}

	// The stylesheet the page links.
	if resp, _ := f.get("/api/v1/oauth/consent.css", false); resp.StatusCode != http.StatusOK ||
		!strings.HasPrefix(resp.Header.Get("Content-Type"), "text/css") {
		t.Fatalf("consent.css: %d %s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
}

func TestAuthorizeRefusals(t *testing.T) {
	f := setup(t)
	p := newPKCE(t)
	with := func(mut func(url.Values)) string {
		q := f.authParams(p, clientID, clientRedirect)
		mut(q)
		return oauth.AuthorizePath + "?" + q.Encode()
	}

	// Shown on kitp, never sent to an unverified redirect URI, and never
	// echoing what the link carried.
	for name, c := range map[string]struct {
		path string
		want string
	}{
		"plain client id":       {with(func(q url.Values) { q.Set("client_id", "abc123") }), "Use Claude&#39;s published identity"},
		"client id with query":  {with(func(q url.Values) { q.Set("client_id", clientID+"?x=1") }), "Use Claude&#39;s published identity"},
		"unregistered redirect": {with(func(q url.Values) { q.Set("redirect_uri", "https://evil.example/CALL-555") }), "isn&#39;t one of its published addresses"},
		"no redirect":           {with(func(q url.Values) { q.Del("redirect_uri") }), "isn&#39;t one of its published addresses"},
		"not UTF-8":             {strings.Replace(with(func(url.Values) {}), "state=st-123", "state=%FF", 1), "malformed"},
		"NUL":                   {strings.Replace(with(func(url.Values) {}), "state=st-123", "state=a%00b", 1), "malformed"},
	} {
		resp, body := f.get(c.path, true)
		if resp.StatusCode != http.StatusBadRequest || resp.Header.Get("Location") != "" || !strings.Contains(body, c.want) {
			t.Errorf("%s: %d Location=%q body lacks %q: %s", name, resp.StatusCode, resp.Header.Get("Location"), c.want, body)
		}
		if strings.Contains(body, "CALL-555") {
			t.Errorf("%s: the page echoes the link's redirect URI", name)
		}
	}

	// Sent back to the client's redirect URI.
	for name, c := range map[string]struct {
		path string
		code string
	}{
		"no PKCE":        {with(func(q url.Values) { q.Del("code_challenge") }), "invalid_request"},
		"plain PKCE":     {with(func(q url.Values) { q.Set("code_challenge_method", "plain") }), "invalid_request"},
		"token response": {with(func(q url.Values) { q.Set("response_type", "token") }), "unsupported_response_type"},
		"other resource": {with(func(q url.Values) { q.Set("resource", "https://elsewhere.example/mcp") }), "invalid_target"},
	} {
		resp, _ := f.get(c.path, true)
		loc, _ := url.Parse(resp.Header.Get("Location"))
		if resp.StatusCode != http.StatusFound || loc == nil || loc.Query().Get("error") != c.code || loc.Query().Get("state") != "st-123" {
			t.Errorf("%s: %d Location=%q, want error=%s", name, resp.StatusCode, resp.Header.Get("Location"), c.code)
		}
	}

	page := func() string {
		_, body := f.get(oauth.AuthorizePath+"?"+f.authParams(p, clientID, clientRedirect).Encode(), true)
		return consentTokenOf(t, body)
	}
	post := func(mut func(url.Values)) (*http.Response, string) {
		form := f.authParams(p, clientID, clientRedirect)
		form.Set("consent_token", page())
		form.Set("decision", "allow")
		form.Set("agent_id", itoa(f.agent))
		mut(form)
		return f.postForm(oauth.AuthorizePath, form, true)
	}
	if resp, _ := post(func(v url.Values) { v.Set("decision", "deny") }); resp.StatusCode != http.StatusSeeOther ||
		!strings.Contains(resp.Header.Get("Location"), "error=access_denied") {
		t.Errorf("deny: %d %s", resp.StatusCode, resp.Header.Get("Location"))
	}
	if resp, _ := post(func(v url.Values) { v.Set("agent_id", itoa(f.stranger)) }); resp.StatusCode != http.StatusBadRequest {
		t.Errorf("someone else's agent: %d", resp.StatusCode)
	}
	if resp, _ := post(func(v url.Values) { v.Set("agent_id", itoa(f.human)) }); resp.StatusCode != http.StatusBadRequest {
		t.Errorf("the person themselves: %d", resp.StatusCode)
	}
	if resp, _ := post(func(v url.Values) { v.Set("consent_token", "forged") }); resp.StatusCode != http.StatusForbidden {
		t.Errorf("forged consent token: %d", resp.StatusCode)
	}
}

func TestCodeGrant(t *testing.T) {
	f := setup(t)
	ctx := context.Background()

	tok := f.connect()
	if tok.TokenType != "Bearer" || tok.Scope != oauth.Scope || tok.RefreshToken == "" ||
		tok.ExpiresIn < 3500 || tok.ExpiresIn > 3600 {
		t.Fatalf("token reply = %+v", tok)
	}
	if got := f.mcp(tok.AccessToken); got != http.StatusOK {
		t.Fatalf("MCP with the access token: %d", got)
	}
	// It works for MCP only: not on another bearer route.
	if got := f.bearer("/api/v1/links", tok.AccessToken); got != http.StatusForbidden {
		t.Fatalf("the OAuth token on /api/v1/links: %d, want 403", got)
	}
	// It is a token of the agent, labelled for the person to find.
	var label, scope string
	if err := f.pool.QueryRow(ctx, `SELECT label, scope FROM user_token WHERE user_id = $1 AND revoked_at IS NULL`, f.agent).Scan(&label, &scope); err != nil {
		t.Fatalf("agent token: %v", err)
	}
	if !regexp.MustCompile(`^Test Claude \(OAuth, connected \d{4}-\d{2}-\d{2}, #\d+\)$`).MatchString(label) || scope != "mcp" {
		t.Fatalf("token label = %q, scope = %q", label, scope)
	}

	// Wrong verifier, client, redirect or resource: refused.
	for name, mut := range map[string]func(url.Values){
		"verifier": func(v url.Values) { v.Set("code_verifier", newPKCE(t).verifier) },
		"client":   func(v url.Values) { v.Set("client_id", otherClientID) },
		"redirect": func(v url.Values) { v.Set("redirect_uri", "http://localhost:1/callback") },
		"resource": func(v url.Values) { v.Set("resource", "https://elsewhere.example/mcp") },
	} {
		p := newPKCE(t)
		form := url.Values{
			"grant_type": {"authorization_code"}, "code": {f.approve(p, f.agent)}, "client_id": {clientID},
			"redirect_uri": {clientRedirect}, "code_verifier": {p.verifier},
		}
		mut(form)
		status, out := f.token(form)
		if status != http.StatusBadRequest || (out.Error != "invalid_grant" && out.Error != "invalid_target") {
			t.Errorf("wrong %s: %d %+v", name, status, out)
		}
	}

	// A stray copy of a spent code (no verifier) is just refused; a full
	// replay of it ends the connection it made.
	p := newPKCE(t)
	code := f.approve(p, f.agent)
	if status, _ := f.exchange(code, p); status != http.StatusOK {
		t.Fatalf("first exchange: %d", status)
	}
	before := f.liveGrants()
	if status, out := f.exchange(code, newPKCE(t)); status != http.StatusBadRequest || out.Error != "invalid_grant" {
		t.Fatalf("stray copy: %d %+v", status, out)
	}
	if f.liveGrants() != before {
		t.Fatal("a stray copy of a spent code revoked a connection")
	}
	if status, out := f.exchange(code, p); status != http.StatusBadRequest || out.Error != "invalid_grant" {
		t.Fatalf("replay: %d %+v", status, out)
	}
	if f.liveGrants() != before-1 {
		t.Fatal("a replayed code didn't revoke the connection it made")
	}

	// Unknown grant type and a JSON body are refused the OAuth way.
	if status, out := f.token(url.Values{"grant_type": {"client_credentials"}}); status != http.StatusBadRequest || out.Error != "unsupported_grant_type" {
		t.Errorf("client_credentials: %d %+v", status, out)
	}
	req, _ := http.NewRequest(http.MethodPost, f.kitp.URL+oauth.TokenPath, strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	if resp, body := f.do(req); resp.StatusCode != http.StatusBadRequest || !strings.Contains(body, "invalid_request") {
		t.Errorf("JSON body: %d %s", resp.StatusCode, body)
	}
}

func TestRefresh(t *testing.T) {
	f := setup(t)

	// A chain of refreshes: each replaces both tokens.
	r0 := f.connect()
	status, r1 := f.refresh(r0.RefreshToken)
	if status != http.StatusOK || r1.AccessToken == r0.AccessToken || r1.RefreshToken == r0.RefreshToken {
		t.Fatalf("refresh: %d %+v", status, r1)
	}
	if f.mcp(r1.AccessToken) != http.StatusOK || f.mcp(r0.AccessToken) != http.StatusUnauthorized {
		t.Fatal("after a refresh the new access token should work and the old one not")
	}
	status, r2 := f.refresh(r1.RefreshToken)
	if status != http.StatusOK || f.mcp(r2.AccessToken) != http.StatusOK {
		t.Fatalf("second refresh: %d", status)
	}

	// A lost reply: the client retries the token it just spent, within the
	// grace, before it ever used what came back. It gets new tokens, and
	// the ones it never saw are dead.
	status, r3lost := f.refresh(r2.RefreshToken)
	if status != http.StatusOK {
		t.Fatalf("refresh: %d", status)
	}
	status, r3 := f.refresh(r2.RefreshToken)
	if status != http.StatusOK {
		t.Fatalf("retry within grace: %d %+v", status, r3)
	}
	if f.mcp(r3.AccessToken) != http.StatusOK || f.mcp(r3lost.AccessToken) != http.StatusUnauthorized {
		t.Fatal("after a retry the retry's access token should work and the lost one not")
	}
	if status, _ := f.refresh(r3.RefreshToken); status != http.StatusOK {
		t.Fatal("the connection doesn't refresh on after a retry")
	}
}

// A thief replays a token the real client just spent. They get in once,
// but the real client — told 401, it refreshes at once with the token it
// holds — presents the orphaned token, and the connection ends for both.
func TestRefreshTheftWithinGrace(t *testing.T) {
	f := setup(t)
	stolen := f.connect()
	_, real1 := f.refresh(stolen.RefreshToken) // the real client refreshes

	status, thief := f.refresh(stolen.RefreshToken) // the thief replays R0 within the grace
	if status != http.StatusOK {
		t.Fatalf("thief's replay: %d", status)
	}
	if f.mcp(real1.AccessToken) != http.StatusUnauthorized {
		t.Fatal("the real client's access token survived the thief's refresh")
	}
	// The real client refreshes at once with R1 — orphaned.
	if status, out := f.refresh(real1.RefreshToken); status != http.StatusBadRequest || out.Error != "invalid_grant" {
		t.Fatalf("real client's refresh: %d %+v", status, out)
	}
	if f.mcp(thief.AccessToken) != http.StatusUnauthorized {
		t.Fatal("the thief's access token still works")
	}
	if status, _ := f.refresh(thief.RefreshToken); status != http.StatusBadRequest {
		t.Fatal("the thief's refresh token still works")
	}
	if f.liveGrants() != 0 {
		t.Fatal("the connection wasn't revoked")
	}
}

// A spent token presented after the grace, or after its successor was used,
// ends the connection.
func TestRefreshReuse(t *testing.T) {
	for _, late := range []bool{false, true} {
		f := setup(t)
		ctx := context.Background()
		r0 := f.connect()
		_, r1 := f.refresh(r0.RefreshToken)
		if late {
			if _, err := f.pool.Exec(ctx, `UPDATE oauth_refresh_token SET spent_at = now() - interval '10 minutes' WHERE spent_at IS NOT NULL`); err != nil {
				t.Fatal(err)
			}
		} else if status, _ := f.refresh(r1.RefreshToken); status != http.StatusOK { // successor used
			t.Fatalf("refresh r1: %d", status)
		}
		if status, out := f.refresh(r0.RefreshToken); status != http.StatusBadRequest || out.Error != "invalid_grant" {
			t.Fatalf("late=%v reuse: %d %+v", late, status, out)
		}
		if f.liveGrants() != 0 {
			t.Fatalf("late=%v: the connection wasn't revoked", late)
		}
	}
}

func TestRevokedInKitp(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	tok := f.connect()

	// The person revokes the connection's token on the agent's page.
	if _, err := f.pool.Exec(ctx, `UPDATE user_token SET revoked_at = now() WHERE user_id = $1`, f.agent); err != nil {
		t.Fatal(err)
	}
	if f.mcp(tok.AccessToken) != http.StatusUnauthorized {
		t.Fatal("revoked access token still works")
	}
	if status, out := f.refresh(tok.RefreshToken); status != http.StatusBadRequest || out.Error != "invalid_grant" {
		t.Fatalf("refresh after revoke: %d %+v", status, out)
	}

	// A deleted agent can't be refreshed into either.
	tok = f.connect()
	if _, err := f.pool.Exec(ctx, `UPDATE user_account SET deleted_at = now() WHERE id = $1`, f.agent); err != nil {
		t.Fatal(err)
	}
	if status, out := f.refresh(tok.RefreshToken); status != http.StatusBadRequest || out.Error != "invalid_grant" {
		t.Fatalf("refresh for a deleted agent: %d %+v", status, out)
	}
}

// A connection not refreshed for 90 days ends, whatever its expiry.
func TestRefreshIdle(t *testing.T) {
	f := setup(t)
	tok := f.connect()
	if _, err := f.pool.Exec(context.Background(), `UPDATE oauth_grant SET created_at = now() - interval '91 days'`); err != nil {
		t.Fatal(err)
	}
	if status, out := f.refresh(tok.RefreshToken); status != http.StatusBadRequest || out.Error != "invalid_grant" {
		t.Fatalf("idle refresh: %d %+v", status, out)
	}
}

// A client kitp doesn't trust: the member is told so and can ask an
// administrator — a post, so loading the link records nothing. Once an
// admin allows it the member connects; disallowing it again ends the
// connection at its next refresh.
func TestUntrustedClient(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	if _, err := f.pool.Exec(ctx, `UPDATE oauth_client SET allowed = false WHERE client_id = $1`, clientID); err != nil {
		t.Fatal(err)
	}
	p := newPKCE(t)
	path := oauth.AuthorizePath + "?" + f.authParams(p, clientID, clientRedirect).Encode()

	resp, body := f.get(path, true)
	if resp.StatusCode != http.StatusForbidden || resp.Header.Get("Location") != "" ||
		!strings.Contains(body, "isn&#39;t allowed yet") || !strings.Contains(body, "example.com") ||
		!strings.Contains(body, `value="request"`) {
		t.Fatalf("untrusted page: %d %s", resp.StatusCode, body)
	}
	if f.fetches != 0 {
		t.Fatal("fetched an untrusted client's document")
	}
	request := func(token string) (int, string) {
		resp, body := f.postForm(oauth.AuthorizePath, url.Values{
			"decision": {"request"}, "consent_token": {token},
			"client_id": {clientID}, "redirect_uri": {clientRedirect},
		}, true)
		return resp.StatusCode, body
	}
	countOf := func() (int, *int64) {
		var n int
		var who *int64
		if err := f.pool.QueryRow(ctx, `SELECT request_count, requested_by FROM oauth_client WHERE client_id = $1`, clientID).Scan(&n, &who); err != nil {
			t.Fatal(err)
		}
		return n, who
	}
	if n, who := countOf(); n != 0 || who != nil {
		t.Fatalf("loading the link recorded a request: %d %v", n, who)
	}
	if status, _ := request("forged"); status != http.StatusForbidden {
		t.Fatalf("forged request: %d", status)
	}
	if n, _ := countOf(); n != 0 {
		t.Fatal("a forged post recorded a request")
	}
	status, body := request(consentTokenOf(t, body))
	if status != http.StatusOK || !strings.Contains(body, "Request sent") {
		t.Fatalf("ask: %d %s", status, body)
	}
	if n, who := countOf(); n != 1 || who == nil || *who != f.human {
		t.Fatalf("recorded request = %d %v", n, who)
	}

	// A client nobody listed is added as a request.
	if resp, _ := f.postForm(oauth.AuthorizePath, url.Values{
		"decision": {"request"}, "consent_token": {consentTokenOf(t, body0(f, path))},
		"client_id": {otherClientID}, "redirect_uri": {clientRedirect},
	}, true); resp.StatusCode != http.StatusOK {
		t.Fatalf("ask for another client: %d", resp.StatusCode)
	}
	var allowed bool
	if err := f.pool.QueryRow(ctx, `SELECT allowed FROM oauth_client WHERE client_id = $1`, otherClientID).Scan(&allowed); err != nil || allowed {
		t.Fatalf("other client recorded = %v, %v", allowed, err)
	}

	// An admin allows it (the screen's Allow button runs this function).
	setClient := func(allowed bool) {
		t.Helper()
		var ok bool
		var msg string
		if err := f.pool.QueryRow(ctx, `SELECT ok, message FROM oauth_client_set_batch(1,
			jsonb_build_array(jsonb_build_object('client_id', $1::text, 'allowed', $2::boolean)))`,
			clientID, allowed).Scan(&ok, &msg); err != nil || !ok {
			t.Fatalf("set client allowed=%v: %v %s", allowed, err, msg)
		}
	}
	setClient(true)
	tok := f.connect()
	if f.mcp(tok.AccessToken) != http.StatusOK {
		t.Fatal("connection after the admin allowed the client doesn't work")
	}

	// Disallowing it ends the connection at its next refresh.
	setClient(false)
	if status, out := f.refresh(tok.RefreshToken); status != http.StatusBadRequest || out.Error != "invalid_grant" {
		t.Fatalf("refresh after disallow: %d %+v", status, out)
	}
	if f.mcp(tok.AccessToken) != http.StatusUnauthorized {
		t.Fatal("access token still works after the client was disallowed and refresh refused")
	}

	// A prefix ending in / trusts every client under it.
	if _, err := f.pool.Exec(ctx, `DELETE FROM oauth_client WHERE client_id = $1`, clientID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `INSERT INTO oauth_client (client_id, allowed) VALUES ('https://example.com/', true)`); err != nil {
		t.Fatal(err)
	}
	if resp, _ := f.get(path, true); resp.StatusCode != http.StatusOK {
		t.Fatalf("client under a trusted prefix: %d", resp.StatusCode)
	}
}

// body0 loads a page that carries a consent token (any untrusted-client or
// consent page) and returns it.
func body0(f *fixture, path string) string {
	f.t.Helper()
	_, body := f.get(path, true)
	return body
}

// A member can't fill the admin's list: past the per-member or overall
// cap, new requests aren't recorded.
func TestRequestCaps(t *testing.T) {
	for _, overall := range []bool{false, true} {
		f := setup(t)
		ctx := context.Background()
		if _, err := f.pool.Exec(ctx, `UPDATE oauth_client SET allowed = false WHERE client_id = $1`, clientID); err != nil {
			t.Fatal(err)
		}
		who, n := f.human, 10
		if overall {
			who, n = 1, 200 // System's requests count against everyone
		}
		if _, err := f.pool.Exec(ctx, `INSERT INTO oauth_client (client_id, allowed, requested_by, requested_at)
			SELECT 'https://h' || g || '.example/c.json', false, $1, now() FROM generate_series(1, $2::int) g`, who, n); err != nil {
			t.Fatal(err)
		}
		path := oauth.AuthorizePath + "?" + f.authParams(newPKCE(t), clientID, clientRedirect).Encode()
		resp, _ := f.postForm(oauth.AuthorizePath, url.Values{
			"decision": {"request"}, "consent_token": {consentTokenOf(t, body0(f, path))},
			"client_id": {"https://one-too-many.example/c.json"}, "redirect_uri": {clientRedirect},
		}, true)
		if resp.StatusCode != http.StatusTooManyRequests {
			t.Fatalf("overall=%v: %d", overall, resp.StatusCode)
		}
		var c int
		if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM oauth_client WHERE client_id = 'https://one-too-many.example/c.json'`).Scan(&c); err != nil || c != 0 {
			t.Fatalf("overall=%v: recorded past the cap: %d %v", overall, c, err)
		}
	}
}

func TestReap(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	tok := f.connect()
	if status, _ := f.refresh(tok.RefreshToken); status != http.StatusOK { // one spent token
		t.Fatalf("refresh: %d", status)
	}
	p := newPKCE(t)
	f.approve(p, f.agent) // a code never traded
	if _, err := f.pool.Exec(ctx, `
		UPDATE oauth_code SET expires_at = now() - interval '2 hours';
		UPDATE oauth_refresh_token SET spent_at = now() - interval '31 days' WHERE spent_at IS NOT NULL;`); err != nil {
		t.Fatal(err)
	}
	if err := f.srv.Reap(ctx); err != nil {
		t.Fatalf("Reap: %v", err)
	}
	count := func(sql string) int {
		var n int
		if err := f.pool.QueryRow(ctx, sql).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if n := count(`SELECT count(*) FROM oauth_code`); n != 0 {
		t.Fatalf("codes after Reap: %d", n)
	}
	if n := count(`SELECT count(*) FROM oauth_refresh_token`); n != 1 {
		t.Fatalf("refresh tokens after Reap: %d, want the current one", n)
	}
	// A revoked connection goes a day later, with its token row.
	if _, err := f.pool.Exec(ctx, `UPDATE oauth_grant SET revoked_at = now() - interval '2 days'`); err != nil {
		t.Fatal(err)
	}
	if err := f.srv.Reap(ctx); err != nil {
		t.Fatalf("Reap: %v", err)
	}
	if n := count(`SELECT count(*) FROM oauth_grant`); n != 0 {
		t.Fatalf("grants after Reap: %d", n)
	}
	if n := count(`SELECT count(*) FROM user_token WHERE scope = 'mcp'`); n != 0 {
		t.Fatalf("OAuth token rows after Reap: %d", n)
	}
}
