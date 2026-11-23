package oauth

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestAllowsRedirect(t *testing.T) {
	c := &Client{RedirectURIs: []string{
		"https://claude.ai/api/mcp/auth_callback",
		"http://localhost/callback",
		"http://127.0.0.1/callback",
	}}
	cases := []struct {
		uri  string
		want bool
	}{
		{"https://claude.ai/api/mcp/auth_callback", true},
		{"https://claude.ai/api/mcp/auth_callback?x=1", false},
		{"https://claude.ai/api/mcp/other", false},
		{"https://evil.example/api/mcp/auth_callback", false},
		{"https://claude.ai:8443/api/mcp/auth_callback", false},
		{"http://localhost:33418/callback", true},
		{"http://localhost/callback", true},
		{"http://LOCALHOST:5000/callback", true},
		{"http://127.0.0.1:51234/callback", true},
		{"http://127.0.0.1:51234/other", false},
		{"http://localhost:abc/callback", false},
		{"http://[::1]:5000/callback", false}, // not listed
		{"http://evil.example:80/callback", false},
		{"https://localhost:5000/callback", false},
		{"http://localhost:5000/callback#frag", false},
		{"http://user@localhost:5000/callback", false},
		{"", false},
	}
	for _, tc := range cases {
		if got := c.allowsRedirect(tc.uri); got != tc.want {
			t.Errorf("allowsRedirect(%q) = %v, want %v", tc.uri, got, tc.want)
		}
	}
}

// normClientID accepts only an https client_id on a DNS host with a path
// and no query, fragment, user info or dot segments, and normalises the
// scheme and host. Whether it is trusted is oauth_client's call
// (flow_test).
func TestNormClientID(t *testing.T) {
	cases := []struct {
		id   string
		want string // "" = refused
	}{
		{"https://claude.ai/oauth/claude-code-client-metadata", "https://claude.ai/oauth/claude-code-client-metadata"},
		{"https://CLAUDE.AI/oauth/Client", "https://claude.ai/oauth/Client"},
		{"https://apps.example.com:8443/c.json", "https://apps.example.com:8443/c.json"},
		{"http://claude.ai/oauth/client", ""},
		{"https://claude.ai", ""},
		{"https://claude.ai/", ""},
		{"https://claude.ai/a/../b", ""},
		{"https://claude.ai/a/%2e%2e/b", ""},
		{"https://claude.ai/a/%2E/b", ""},
		{"https://claude.ai/oauth/client?x=1", ""},
		{"https://claude.ai/mcp/..;/evil.json", ""},
		{"https://claude.ai/a;b/c.json", ""},
		{"https://claude.ai//c.json", ""},
		{"https://claude.ai/a//c.json", ""},
		{"https://claude.ai/oauth/client?", ""},
		{"https://claude.ai/oauth/client#x", ""},
		{"https://u@claude.ai/oauth/client", ""},
		{"https://10.0.0.5/client.json", ""},
		{"https://127.0.0.1:8443/client.json", ""},
		{"https://localhost/client.json", ""},
		{"https://metadata/client.json", ""},
		{"https://[::1]/client.json", ""},
		{"https://*.example.com/c.json", ""},
		{"my-client-id", ""},
		{"https://claude.ai/" + strings.Repeat("a", 2100), ""},
	}
	for _, tc := range cases {
		got, _, err := normClientID(tc.id)
		switch {
		case tc.want == "" && (err == nil || !strings.Contains(err.Error(), "published client ID")):
			t.Errorf("normClientID(%q) = %q, %v; want the published-identity refusal", tc.id, got, err)
		case tc.want != "" && (err != nil || got != tc.want):
			t.Errorf("normClientID(%q) = %q, %v; want %q", tc.id, got, err, tc.want)
		}
	}
}

// dnsHost is the same rule oauth_client_set_batch applies.
func TestDNSHost(t *testing.T) {
	for host, want := range map[string]bool{
		"claude.ai": true, "mcp.example.com": true, "a-b.example:443": true, "x1.example.co": true,
		"127.0.0.1:8443": false, "10.0.0.5": false, "localhost": false, "metadata": false,
		"-bad.example": false, "bad-.example": false, "UPPER.example": false, "[::1]:8443": false,
		"a b.example": false, "": false, "host.example:123456": false, "*.example.com": false,
	} {
		if got := dnsHost.MatchString(host); got != want {
			t.Errorf("dnsHost(%q) = %v, want %v", host, got, want)
		}
	}
	if got := truncate("ab\u00e9cd", 3); got != "ab" {
		t.Errorf("truncate split a character: %q", got)
	}
}

// Request values that aren't text are refused before anything reads the
// database.
func TestParamsOK(t *testing.T) {
	ok := url.Values{"redirect_uri": {"https://claude.ai/cb"}, "state": {"é"}}
	if !paramsOK(ok) {
		t.Fatal("refused valid text")
	}
	for _, bad := range []string{"\xff", "a\x00b"} {
		if paramsOK(url.Values{"redirect_uri": {bad}}) {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestCheckClientDoc(t *testing.T) {
	const id = "https://claude.ai/oauth/client"
	good := clientDoc{ClientID: id, ClientName: "Claude", RedirectURIs: []string{"https://claude.ai/api/mcp/auth_callback"}}
	with := func(f func(*clientDoc)) clientDoc { d := good; f(&d); return d }
	cases := []struct {
		name    string
		doc     clientDoc
		wantErr string
	}{
		{"good", good, ""},
		{"public auth method", with(func(d *clientDoc) { d.TokenEndpointAuthMethod = "none" }), ""},
		{"grant and response types", with(func(d *clientDoc) {
			d.GrantTypes = []string{"authorization_code", "refresh_token"}
			d.ResponseTypes = []string{"code"}
		}), ""},
		{"client_id differs", with(func(d *clientDoc) { d.ClientID = id + "x" }), "not the address"},
		{"secret", with(func(d *clientDoc) { d.ClientSecret = "s" }), "client secret"},
		{"confidential", with(func(d *clientDoc) { d.TokenEndpointAuthMethod = "client_secret_basic" }), "public clients"},
		{"no code grant", with(func(d *clientDoc) { d.GrantTypes = []string{"client_credentials"} }), "authorization code"},
		{"no code response", with(func(d *clientDoc) { d.ResponseTypes = []string{"token"} }), "code response"},
		{"no redirects", with(func(d *clientDoc) { d.RedirectURIs = nil }), "no redirect URIs"},
		{"http redirect off this computer", with(func(d *clientDoc) {
			d.RedirectURIs = []string{"http://evil.example/cb"}
		}), "neither HTTPS"},
		{"custom scheme", with(func(d *clientDoc) { d.RedirectURIs = []string{"myapp://cb"} }), "neither HTTPS"},
		{"https to an IP", with(func(d *clientDoc) { d.RedirectURIs = []string{"https://10.0.0.5/cb"} }), "neither HTTPS"},
		{"https to a wildcard", with(func(d *clientDoc) { d.RedirectURIs = []string{"https://*/cb"} }), "neither HTTPS"},
		{"http to IPv6 loopback", with(func(d *clientDoc) { d.RedirectURIs = []string{"http://[::1]/cb"} }), "neither HTTPS"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, err := checkClientDoc(id, "claude.ai", tc.doc)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("err = %v", err)
				}
				if c.Name != "Claude" || c.ID != id {
					t.Fatalf("client = %+v", c)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("err = %v, want one containing %q", err, tc.wantErr)
			}
		})
	}
	// No name: the host stands in; control characters are dropped.
	c, err := checkClientDoc(id, "claude.ai", with(func(d *clientDoc) { d.ClientName = "" }))
	if err != nil || c.Name != "claude.ai" {
		t.Fatalf("nameless client = %+v, %v", c, err)
	}
	c, err = checkClientDoc(id, "claude.ai", with(func(d *clientDoc) { d.ClientName = "Cl\u0000au\nd\u202ee\u200b" }))
	if err != nil || c.Name != "Claude" {
		t.Fatalf("control characters: %+v, %v", c, err)
	}
}

func TestPKCE(t *testing.T) {
	// RFC 7636 appendix B.
	const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
	if !isS256Value(challenge) {
		t.Fatal("isS256Value refused the RFC 7636 challenge")
	}
	cases := []struct {
		verifier, challenge string
		want                bool
	}{
		{verifier, challenge, true},
		{verifier + "x", challenge, false},
		{verifier, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cN", false},
		{"short", challenge, false},
		{strings.Repeat("a", 129), challenge, false},
		{verifier[:42] + "!", challenge, false},
	}
	for _, tc := range cases {
		if got := pkceOK(tc.verifier, tc.challenge); got != tc.want {
			t.Errorf("pkceOK(%q) = %v, want %v", tc.verifier, got, tc.want)
		}
	}
}

func TestIssuerOf(t *testing.T) {
	cases := []struct {
		in, want string
		ok       bool
	}{
		{"https://kitp.example.com", "https://kitp.example.com", true},
		{"https://kitp.example.com/", "https://kitp.example.com", true},
		{"http://localhost:8080", "http://localhost:8080", true},
		{"https://kitp.example.com/app", "", false},
		{"kitp.example.com", "", false},
		{"", "", false},
	}
	for _, tc := range cases {
		got, err := issuerOf(tc.in)
		if (err == nil) != tc.ok || got != tc.want {
			t.Errorf("issuerOf(%q) = %q, %v; want %q ok=%v", tc.in, got, err, tc.want, tc.ok)
		}
	}
}

// A fetch outlives the request that started it: its result is cached for
// everyone, so a member cancelling mid-fetch mustn't leave a failure
// behind.
func TestFetchIgnoresCancelledRequest(t *testing.T) {
	var docURL string
	ts := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(50 * time.Millisecond)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"client_id":%q,"client_name":"T","redirect_uris":["https://claude.example/cb"]}`, docURL)
	}))
	defer ts.Close()
	docURL = ts.URL + "/c.json"
	s := &Server{http: ts.Client(), logger: slog.Default()}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if c, err := s.fetchClient(ctx, docURL, "example.com"); err != nil || c.Name != "T" {
		t.Fatalf("fetch with a cancelled request: %+v, %v", c, err)
	}
}
