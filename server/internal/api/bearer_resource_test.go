package api_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
)

// A BearerResource route's 401 names its OAuth metadata, and says
// invalid_token when a token was presented and refused; a plain Bearer
// route keeps the bare realm.
func TestRouter_BearerResourceChallenge(t *testing.T) {
	const meta = "https://kitp.example/.well-known/oauth-protected-resource/api/v1/mcp"
	ok := func(context.Context, http.ResponseWriter, *http.Request, *auth.UserCtx) error { return nil }
	cases := []struct {
		name     string
		resolver api.Resolver
		resource bool
		want     string
	}{
		{"no token, resource", resolverReturning(nil, nil), true,
			`Bearer realm="kitp", resource_metadata="` + meta + `"`},
		{"refused token, resource", resolverReturning(nil, errors.New("expired")), true,
			`Bearer realm="kitp", error="invalid_token", resource_metadata="` + meta + `"`},
		{"no token, plain", resolverReturning(nil, nil), false, `Bearer realm="kitp"`},
		{"refused token, plain", resolverReturning(nil, errors.New("expired")), false,
			`Bearer realm="kitp", error="invalid_token"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rt := newRouter(nil, tc.resolver)
			if tc.resource {
				rt.BearerResource("POST /api/v1/mcp", auth.TokenScopeMCP, meta, ok)
			} else {
				rt.Bearer("POST /api/v1/mcp", ok)
			}
			rec := doRequest(t, rt, http.MethodPost, "/api/v1/mcp")
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", rec.Code)
			}
			if got := rec.Header().Get("WWW-Authenticate"); got != tc.want {
				t.Fatalf("WWW-Authenticate = %q, want %q", got, tc.want)
			}
		})
	}
}

// AllowFormAction widens form-action on the policy the CSP middleware
// already set, under either header name, and ignores an origin that would
// smuggle in another directive.
func TestAllowFormAction(t *testing.T) {
	cases := []struct {
		name       string
		reportOnly bool
		origins    []string
		want       string
	}{
		{"one origin", false, []string{"https://claude.ai"}, "form-action 'self' https://claude.ai;"},
		{"report only", true, []string{"http://localhost:33418"}, "form-action 'self' http://localhost:33418;"},
		{"directive smuggling skipped", false, []string{"https://x.example; script-src *"}, "form-action 'self';"},
		{"wildcard skipped", false, []string{"https://*"}, "form-action 'self';"},
		{"IP skipped", false, []string{"https://10.0.0.5"}, "form-action 'self';"},
		{"IPv6 loopback skipped", false, []string{"http://[::1]:5000"}, "form-action 'self';"},
		{"loopback IP", false, []string{"http://127.0.0.1:5000"}, "form-action 'self' http://127.0.0.1:5000;"},
		{"nothing to add", false, nil, "form-action 'self';"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := api.CSP(api.CSPConfig{ReportOnly: tc.reportOnly})(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				api.AllowFormAction(w, tc.origins...)
			}))
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
			name := "Content-Security-Policy"
			if tc.reportOnly {
				name += "-Report-Only"
			}
			if got := rec.Header().Get(name); !strings.Contains(got, tc.want) {
				t.Fatalf("%s = %q, want it to contain %q", name, got, tc.want)
			}
		})
	}
}

// A token scoped to mcp (what OAuth issues) works on the MCP resource and
// nowhere else; a links token doesn't work there; a full token works on
// all of them.
func TestRouter_MCPScopedToken(t *testing.T) {
	ok := func(_ context.Context, w http.ResponseWriter, _ *http.Request, _ *auth.UserCtx) error {
		w.WriteHeader(http.StatusNoContent)
		return nil
	}
	cases := []struct {
		scope, route string
		want         int
	}{
		{auth.TokenScopeMCP, "mcp", http.StatusNoContent},
		{auth.TokenScopeMCP, "links", http.StatusForbidden},
		{auth.TokenScopeMCP, "plain", http.StatusForbidden},
		{auth.TokenScopeLinks, "mcp", http.StatusForbidden},
		{auth.TokenScopeFull, "mcp", http.StatusNoContent},
		{auth.TokenScopeFull, "plain", http.StatusNoContent},
	}
	for _, tc := range cases {
		rt := newRouter(nil, resolverReturning(&auth.UserCtx{ID: 7, TokenScope: tc.scope}, nil))
		rt.BearerResource("POST /mcp", auth.TokenScopeMCP, "", ok)
		rt.BearerScoped("POST /links", auth.TokenScopeLinks, ok)
		rt.Bearer("POST /plain", ok)
		if rec := doRequest(t, rt, http.MethodPost, "/"+tc.route); rec.Code != tc.want {
			t.Errorf("scope %q on %s: %d, want %d", tc.scope, tc.route, rec.Code, tc.want)
		}
	}
}
