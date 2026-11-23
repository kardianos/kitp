// Package oauth is kitp's OAuth 2.1 authorization server for remote MCP
// clients — what lets an organization add kitp to Claude as a custom
// connector where every member connects as one of their OWN agents
// (docs/MCP_OAUTH.md).
//
// The flow, end to end:
//
//  1. Claude POSTs /api/v1/mcp with no token. The 401's WWW-Authenticate
//     names this server's protected resource metadata (RFC 9728), which
//     names kitp as the authorization server, whose metadata (RFC 8414)
//     lists the endpoints below.
//  2. Claude sends the person's browser to GET /api/v1/oauth/authorize.
//     No session → the person signs in (SSO) and comes back. The client
//     is identified by a Client ID Metadata Document: the client_id is an
//     HTTPS URL kitp fetches — only for a client_id an admin trusts
//     (oauth_client, exactly or by a / prefix; Claude Code's is seeded) —
//     and the redirect URI must be one that document lists. Then a consent
//     page: pick one of your agents. For a client that isn't trusted the
//     member can ask an administrator, who allows it on the MCP apps
//     screen.
//  3. Allow → a one-time code to the client's redirect URI. Claude trades
//     it (with its PKCE verifier) at POST /api/v1/oauth/token for an
//     access token and a refresh token.
//  4. The access token is a user_token of the chosen agent with scope
//     mcp, so MCP calls run as that agent with that agent's roles (and
//     nothing else takes it), show in the agent's token list as
//     "<client> (OAuth …)", and stop when someone revokes it there. It
//     lasts an hour; each refresh swaps it and the refresh token for new
//     ones (oauth_grant, oauth_refresh_token).
//
// No dynamic client registration: kitp keeps no registered clients, only
// the client_ids it trusts.
package oauth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/api"
)

// Paths kitp serves. The MCP endpoint itself is mounted by internal/mcp.
const (
	MCPPath               = "/api/v1/mcp"
	AuthorizePath         = "/api/v1/oauth/authorize"
	TokenPath             = "/api/v1/oauth/token"
	stylesPath            = "/api/v1/oauth/consent.css"
	protectedResourcePath = "/.well-known/oauth-protected-resource"
	authServerPath        = "/.well-known/oauth-authorization-server"
)

// Lifetimes.
const (
	// AccessTokenTTL is how long an access token works; the client
	// refreshes before then (Claude: up to five minutes ahead).
	AccessTokenTTL = time.Hour
	// codeTTL is how long a code from the consent page can be traded.
	codeTTL = 5 * time.Minute
	// refreshGrace is how long a refresh token a refresh replaced is
	// still honoured — a client whose first refresh reply got lost retries
	// with it. Presented later than that, it is taken as stolen and the
	// connection is revoked.
	refreshGrace = 2 * time.Minute
	// refreshIdle ends a connection that hasn't been refreshed for this
	// long, whatever KITP_TOKEN_MAX_DAYS allows: a client that went away
	// shouldn't leave a working refresh token behind for ever.
	refreshIdle = 90 * 24 * time.Hour
	// clientCacheTTL is how long a fetched client metadata document is
	// reused.
	clientCacheTTL = 10 * time.Minute
)

// Scope is the one scope kitp grants: use the MCP server as the agent.
// offline_access is accepted (Claude asks for it to get a refresh token,
// which kitp issues anyway).
const Scope = "mcp"

// Config wires the server. PublicURL, Pool and Session are required.
type Config struct {
	// PublicURL is the install's external base URL (KITP_PUBLIC_URL),
	// scheme://host[:port] with no path. It is the issuer, and PublicURL
	// + /api/v1/mcp is the resource — the exact URL to give Claude.
	PublicURL string
	Pool      *pgxpool.Pool
	// Session resolves the browser's session cookie: the person on the
	// consent page. The same resolver the apiRouter's Authed routes use.
	Session api.Resolver
	// LoginPath, when set, is where a visitor with no session is sent to
	// sign in, with ?redirect=<the authorize request>: the OIDC start
	// endpoint. Empty (AUTH_MODE=off) shows a page asking them to sign in
	// to kitp first.
	LoginPath string
	// HTTPClient fetches client metadata documents. Nil: a client with a
	// 5 s timeout that follows no redirects.
	HTTPClient *http.Client
	// MaxDays bounds a connection's whole life, as KITP_TOKEN_MAX_DAYS
	// bounds a token's: past it the person connects again. 0: no bound.
	MaxDays int64
	Logger  *slog.Logger
}

// Server is the authorization server. Build it with New, then Mount.
type Server struct {
	cfg      Config
	issuer   string
	resource string
	http     *http.Client
	logger   *slog.Logger

	mu      sync.Mutex
	clients map[string]cachedClient
}

// New checks cfg and builds the server.
func New(cfg Config) (*Server, error) {
	if cfg.Pool == nil || cfg.Session == nil {
		return nil, errors.New("oauth: Pool and Session are required")
	}
	issuer, err := issuerOf(cfg.PublicURL)
	if err != nil {
		return nil, err
	}
	hc := cfg.HTTPClient
	if hc == nil {
		hc = &http.Client{
			Timeout: 5 * time.Second,
			// A document that moved is not the client_id it claims to be.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		}
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	if u, _ := url.Parse(issuer); u.Scheme == "http" && !isLoopback(u.Hostname()) {
		// OAuth 2.1 wants TLS everywhere but on this computer; the tokens
		// would cross the network in the clear.
		logger.Warn("oauth: KITP_PUBLIC_URL is plain http; MCP sign-in tokens travel unencrypted — serve kitp over https",
			"issuer", issuer)
	}
	return &Server{
		cfg:      cfg,
		issuer:   issuer,
		resource: issuer + MCPPath,
		http:     hc,
		logger:   logger,
		clients:  map[string]cachedClient{},
	}, nil
}

// issuerOf checks KITP_PUBLIC_URL and returns it without a trailing
// slash.
func issuerOf(raw string) (string, error) {
	raw = strings.TrimRight(strings.TrimSpace(raw), "/")
	if raw == "" {
		return "", errors.New("oauth: KITP_PUBLIC_URL is unset")
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" ||
		u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return "", fmt.Errorf("oauth: KITP_PUBLIC_URL %q: want scheme://host[:port]", raw)
	}
	return raw, nil
}

// Resource is the MCP server URL tokens are issued for — what an
// organization enters in Claude.
func (s *Server) Resource() string { return s.resource }

// ResourceMetadataURL is the protected resource metadata document for the
// MCP endpoint; internal/mcp names it in its 401s.
func (s *Server) ResourceMetadataURL() string {
	return s.issuer + protectedResourcePath + MCPPath
}

// Mount registers the routes. The two discovery documents live under
// /.well-known/, outside /api/, so top (the server's top-level mux) routes
// those paths into the apiRouter, where they are Public routes like the
// rest (panic recovery, one error shape).
func (s *Server) Mount(rt *api.Router, top *http.ServeMux) {
	for _, p := range []string{protectedResourcePath, protectedResourcePath + MCPPath} {
		rt.Public("GET "+p, s.protectedResource)
		top.Handle(p, rt.Mux())
	}
	rt.Public("GET "+authServerPath, s.authServerMetadata)
	top.Handle(authServerPath, rt.Mux())

	rt.Public("GET "+AuthorizePath, s.authorizeGet)
	// POST is the consent form: the router's cross-origin check refuses a
	// cross-site post, and the form also carries a value tied to the
	// session cookie (consentToken).
	rt.Public("POST "+AuthorizePath, s.authorizePost)
	// The token endpoint is called by the client's server (claude.ai) or
	// program (Claude Code), never a browser page, so the cross-origin
	// check passes it; it takes no cookie.
	rt.Public("POST "+TokenPath, s.token)
	rt.Public("GET "+stylesPath, serveStyles)
}

// protectedResource serves RFC 9728 metadata for the MCP endpoint.
func (s *Server) protectedResource(_ context.Context, w http.ResponseWriter, _ *http.Request) error {
	writeMetadata(w, struct {
		Resource               string   `json:"resource"`
		AuthorizationServers   []string `json:"authorization_servers"`
		ScopesSupported        []string `json:"scopes_supported"`
		BearerMethodsSupported []string `json:"bearer_methods_supported"`
		ResourceName           string   `json:"resource_name"`
	}{
		Resource:               s.resource,
		AuthorizationServers:   []string{s.issuer},
		ScopesSupported:        []string{Scope},
		BearerMethodsSupported: []string{"header"},
		ResourceName:           "kitp",
	})
	return nil
}

// authServerMetadata serves RFC 8414 metadata. Advertising
// client_id_metadata_document_supported together with "none" in
// token_endpoint_auth_methods_supported is what makes Claude identify
// itself with its published client metadata document; there is no
// registration_endpoint.
func (s *Server) authServerMetadata(_ context.Context, w http.ResponseWriter, _ *http.Request) error {
	writeMetadata(w, struct {
		Issuer                            string   `json:"issuer"`
		AuthorizationEndpoint             string   `json:"authorization_endpoint"`
		TokenEndpoint                     string   `json:"token_endpoint"`
		ResponseTypesSupported            []string `json:"response_types_supported"`
		GrantTypesSupported               []string `json:"grant_types_supported"`
		CodeChallengeMethodsSupported     []string `json:"code_challenge_methods_supported"`
		TokenEndpointAuthMethodsSupported []string `json:"token_endpoint_auth_methods_supported"`
		ClientIDMetadataDocumentSupported bool     `json:"client_id_metadata_document_supported"`
		ScopesSupported                   []string `json:"scopes_supported"`
		AuthorizationResponseISSSupported bool     `json:"authorization_response_iss_parameter_supported"`
	}{
		Issuer:                            s.issuer,
		AuthorizationEndpoint:             s.issuer + AuthorizePath,
		TokenEndpoint:                     s.issuer + TokenPath,
		ResponseTypesSupported:            []string{"code"},
		GrantTypesSupported:               []string{"authorization_code", "refresh_token"},
		CodeChallengeMethodsSupported:     []string{"S256"},
		TokenEndpointAuthMethodsSupported: []string{"none"},
		ClientIDMetadataDocumentSupported: true,
		ScopesSupported:                   []string{Scope, "offline_access"},
		AuthorizationResponseISSSupported: true,
	})
	return nil
}

// writeMetadata writes a public discovery document. Any origin may read
// it: browser-based MCP clients fetch it cross-origin.
func writeMetadata(w http.ResponseWriter, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		// The client went away; the status is already sent.
		slog.Default().Debug("oauth: write metadata", "err", err)
	}
}
