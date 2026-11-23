// authorize.go: GET/POST /api/v1/oauth/authorize — sign the person in,
// show the consent page, and on Allow send a one-time code back to the
// client.
package oauth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/auth/session"
	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/textnorm"
)

// maxLoginRedirect matches the OIDC start endpoint's cap on the deep link
// it returns to (oidc.maxRedirectLen).
const maxLoginRedirect = 2048

// authRequest is a checked authorization request.
type authRequest struct {
	client        *Client
	redirectURI   string
	state         string
	codeChallenge string
}

// requestParams are the authorization request's parameters, carried
// through the consent form as hidden fields.
var requestParams = []string{"response_type", "client_id", "redirect_uri", "state",
	"code_challenge", "code_challenge_method", "resource", "scope"}

// redirectErr is an error the client is told about at its redirect URI
// (RFC 6749 §4.1.2.1): the request came from a known client to one of its
// own redirect URIs, so it is safe to send there.
type redirectErr struct {
	code, desc string
}

func (e *redirectErr) Error() string { return e.code + ": " + e.desc }

// parseRequest checks an authorization request. A bad client or redirect
// URI is a *clientError, shown on kitp; the rest is a *redirectErr for the
// client.
func (s *Server) parseRequest(ctx context.Context, v url.Values) (*authRequest, error) {
	clientID := v.Get("client_id")
	if clientID == "" {
		return nil, &clientError{msg: "This sign-in link doesn't say which app is asking (no client_id)."}
	}
	client, err := s.client(ctx, clientID)
	if err != nil {
		return nil, err
	}
	redirectURI := v.Get("redirect_uri")
	if redirectURI == "" || !client.allowsRedirect(redirectURI) {
		// The address itself isn't shown: it came from the link, not from
		// anything kitp trusts.
		return nil, &clientError{msg: fmt.Sprintf("%s asked to send you back somewhere that isn't one of its published addresses.",
			client.Name)}
	}
	req := &authRequest{client: client, redirectURI: redirectURI, state: v.Get("state")}
	if len(req.state) > 1024 {
		req.state = ""
		return req, &redirectErr{"invalid_request", "state is over 1024 characters"}
	}
	if rt := v.Get("response_type"); rt != "code" {
		return req, &redirectErr{"unsupported_response_type", "kitp issues authorization codes only"}
	}
	if m := v.Get("code_challenge_method"); m != "S256" {
		return req, &redirectErr{"invalid_request", "PKCE is required, with code_challenge_method S256"}
	}
	req.codeChallenge = v.Get("code_challenge")
	if !isS256Value(req.codeChallenge) {
		return req, &redirectErr{"invalid_request", "code_challenge is not an S256 challenge"}
	}
	for _, res := range v["resource"] {
		if !s.isResource(res) {
			return req, &redirectErr{"invalid_target", "kitp issues tokens only for " + s.resource}
		}
	}
	return req, nil
}

// isResource says whether an RFC 8707 resource names kitp's MCP endpoint.
// A trailing slash is the same URL as far as a person typing it is
// concerned.
func (s *Server) isResource(res string) bool {
	return strings.TrimRight(res, "/") == s.resource
}

// isS256Value says whether v has the shape of a base64url SHA-256 digest
// with no padding: 43 characters of the URL-safe alphabet.
func isS256Value(v string) bool {
	if len(v) != 43 {
		return false
	}
	for _, r := range v {
		if !(r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

// person is the signed-in human on the consent page.
type person struct {
	id   int64
	name string
}

// signedIn resolves the session to a person who may connect agents. ok
// false: no usable session. A session that is an agent's (dev
// impersonation) is refused with a page.
func (s *Server) signedIn(ctx context.Context, r *http.Request) (*person, error) {
	u, err := s.cfg.Session(r)
	if errors.Is(err, session.ErrNotFound) || errors.Is(err, session.ErrExpired) {
		// A stale cookie is no session: the person signs in again.
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("oauth: session: %w", err)
	}
	if u == nil {
		return nil, nil
	}
	b := named.New()
	b.Set("me", u.ID)
	sql, args, err := b.Compile(`
		SELECT display_name, is_agent FROM user_account
		WHERE id = :me AND deleted_at IS NULL AND login_revoked_at IS NULL`)
	if err != nil {
		return nil, fmt.Errorf("oauth: person: compile: %w", err)
	}
	var p person
	var isAgent bool
	if err := s.cfg.Pool.QueryRow(ctx, sql, args...).Scan(&p.name, &isAgent); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("oauth: person: %w", err)
	}
	if isAgent {
		return nil, errAgentSession
	}
	p.id = u.ID
	return &p, nil
}

var errAgentSession = errors.New("oauth: session is an agent's")

// agentChoice is one agent on the consent page.
type agentChoice struct {
	ID      int64
	Name    string
	NoRoles bool
	Checked bool
}

// agentsOf lists the person's live agents; only, when set, narrows it to
// that one agent (the POST's check that the chosen agent is theirs).
func (s *Server) agentsOf(ctx context.Context, owner int64, only int64) ([]agentChoice, error) {
	b := named.New()
	b.Set("me", owner)
	b.Set("only", only)
	sql, args, err := b.Compile(`
		SELECT a.id, a.display_name,
		       NOT EXISTS (SELECT 1 FROM user_role ur WHERE ur.user_id = a.id)
		FROM user_account a
		WHERE a.parent_user_id = :me AND a.is_agent
		  AND a.deleted_at IS NULL AND a.login_revoked_at IS NULL
		  AND (:only::bigint = 0 OR a.id = :only::bigint)
		ORDER BY lower(a.display_name), a.id`)
	if err != nil {
		return nil, fmt.Errorf("oauth: agents: compile: %w", err)
	}
	rows, err := s.cfg.Pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("oauth: agents: %w", err)
	}
	defer rows.Close()
	var out []agentChoice
	for rows.Next() {
		var a agentChoice
		if err := rows.Scan(&a.ID, &a.Name, &a.NoRoles); err != nil {
			return nil, fmt.Errorf("oauth: agents: scan: %w", err)
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("oauth: agents: %w", err)
	}
	return out, nil
}

// authorizeGet shows the consent page. The person signs in first: no
// client document is fetched, and nothing is looked up, for a visitor kitp
// doesn't know.
func (s *Server) authorizeGet(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	q := r.URL.Query()
	if !paramsOK(q) {
		return malformedPage(w)
	}
	p, err := s.signedIn(ctx, r)
	if errors.Is(err, errAgentSession) {
		return s.agentSessionPage(w)
	}
	if err != nil {
		return api.Internal(err)
	}
	if p == nil {
		return s.toLogin(w, r)
	}
	req, err := s.parseRequest(ctx, q)
	if ue := (*untrustedError)(nil); errors.As(err, &ue) {
		return s.untrustedPage(w, r, ue, q.Get("redirect_uri"))
	}
	if done, rerr := s.requestFailed(w, r, req, err, http.StatusFound); done {
		return rerr
	}
	agents, err := s.agentsOf(ctx, p.id, 0)
	if err != nil {
		return api.Internal(err)
	}
	for i := range agents {
		if !agents[i].NoRoles {
			agents[i].Checked = true
			break
		}
	}
	if len(agents) > 0 && !anyChecked(agents) {
		agents[0].Checked = true
	}
	hidden := make([]hiddenField, 0, len(requestParams))
	for _, name := range requestParams {
		for _, v := range q[name] {
			hidden = append(hidden, hiddenField{Name: name, Value: v})
		}
	}
	u, _ := url.Parse(req.redirectURI) // checked by allowsRedirect
	loopback := isLoopback(u.Hostname())
	// The Allow / Cancel post is answered with a redirect to the client;
	// browsers hold that redirect to this page's form-action.
	api.AllowFormAction(w, redirectOrigin(req.redirectURI))
	return renderPage(w, http.StatusOK, pageData{
		Title: "Connect " + req.client.Name + " to kitp",
		Consent: &consentData{
			ClientName:   req.client.Name,
			RedirectHost: u.Host,
			Loopback:     loopback,
			Person:       p.name,
			Agents:       agents,
			Hidden:       hidden,
			Token:        consentToken(r),
			Action:       AuthorizePath,
		},
	})
}

func anyChecked(agents []agentChoice) bool {
	for _, a := range agents {
		if a.Checked {
			return true
		}
	}
	return false
}

// authorizePost handles the consent page's Allow / Cancel, and the
// untrusted-client page's "Ask an administrator" (decision=request). The
// session and the form's consent token are checked before anything else,
// so nothing is decided or recorded for a post kitp didn't serve.
func (s *Server) authorizePost(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := r.ParseForm(); err != nil {
		return malformedPage(w)
	}
	form := r.PostForm
	if !paramsOK(form) {
		return malformedPage(w)
	}
	p, err := s.signedIn(ctx, r)
	if errors.Is(err, errAgentSession) {
		return s.agentSessionPage(w)
	}
	if err != nil {
		return api.Internal(err)
	}
	tok := consentToken(r)
	if p == nil || tok == "" || subtle.ConstantTimeCompare([]byte(form.Get("consent_token")), []byte(tok)) != 1 {
		return renderPage(w, http.StatusForbidden, pageData{
			Title:   "Start again",
			Message: "Your kitp sign-in changed while this page was open.",
			Detail:  "Go back to the app and connect again.",
		})
	}
	if form.Get("decision") == "request" {
		return s.askAdmin(ctx, w, p, form)
	}
	req, err := s.parseRequest(ctx, form)
	if ue := (*untrustedError)(nil); errors.As(err, &ue) {
		// No longer trusted while the consent page was open.
		return s.untrustedPage(w, r, ue, form.Get("redirect_uri"))
	}
	if done, rerr := s.requestFailed(w, r, req, err, http.StatusSeeOther); done {
		return rerr
	}
	if form.Get("decision") != "allow" {
		s.redirectError(w, r, req, &redirectErr{"access_denied", "the person declined"}, http.StatusSeeOther)
		return nil
	}
	agentID, err := strconv.ParseInt(form.Get("agent_id"), 10, 64)
	var agents []agentChoice
	if err == nil && agentID > 0 {
		if agents, err = s.agentsOf(ctx, p.id, agentID); err != nil {
			return api.Internal(err)
		}
	}
	if len(agents) != 1 {
		return renderPage(w, http.StatusBadRequest, pageData{
			Title:   "Choose one of your agents",
			Message: "That isn't one of your agents.",
			Detail:  "Go back to " + req.client.Name + " and connect again.",
		})
	}
	code, err := s.issueCode(ctx, req, p.id, agentID)
	if err != nil {
		return api.Internal(err)
	}
	s.logger.InfoContext(ctx, "oauth: connection approved",
		"client_id", req.client.ID, "agent_id", agentID, "approved_by", p.id)
	ru, _ := url.Parse(req.redirectURI) // checked by allowsRedirect
	rq := ru.Query()
	rq.Set("code", code)
	if req.state != "" {
		rq.Set("state", req.state)
	}
	rq.Set("iss", s.issuer)
	ru.RawQuery = rq.Encode()
	http.Redirect(w, r, ru.String(), http.StatusSeeOther)
	return nil
}

// requestFailed handles a parseRequest error: a page for a bad client or
// redirect URI, a redirect for the rest. done true means the response is
// written (or rerr is to be returned).
func (s *Server) requestFailed(w http.ResponseWriter, r *http.Request, req *authRequest, err error, status int) (done bool, rerr error) {
	if err == nil {
		return false, nil
	}
	var ce *clientError
	if errors.As(err, &ce) {
		// Logged so an operator can see what the app sent. client_id and
		// redirect_uri are public.
		level := slog.LevelInfo
		if ce.err != nil {
			level = slog.LevelWarn
		}
		s.logger.Log(r.Context(), level, "oauth: client refused",
			"client_id", textnorm.Storable(r.FormValue("client_id")), "why", ce.Error())
		return true, renderPage(w, http.StatusBadRequest, pageData{
			Title:   "Can't connect",
			Message: ce.msg,
		})
	}
	var re *redirectErr
	if errors.As(err, &re) {
		s.redirectError(w, r, req, re, status)
		return true, nil
	}
	return true, api.Internal(err)
}

// redirectError sends an authorization error to the client's redirect URI.
func (s *Server) redirectError(w http.ResponseWriter, r *http.Request, req *authRequest, re *redirectErr, status int) {
	ru, _ := url.Parse(req.redirectURI) // checked by allowsRedirect
	rq := ru.Query()
	rq.Set("error", re.code)
	rq.Set("error_description", re.desc)
	if req.state != "" {
		rq.Set("state", req.state)
	}
	rq.Set("iss", s.issuer)
	ru.RawQuery = rq.Encode()
	http.Redirect(w, r, ru.String(), status)
}

// untrustedPage tells a signed-in member that kitp doesn't trust the
// client yet, with a button to ask an administrator — a post, so nothing
// is recorded by merely loading a link.
func (s *Server) untrustedPage(w http.ResponseWriter, r *http.Request, ue *untrustedError, redirectURI string) error {
	s.logger.InfoContext(r.Context(), "oauth: client not trusted", "client_id", ue.clientID)
	return renderPage(w, http.StatusForbidden, pageData{
		Title:   "This app isn't allowed yet",
		Message: fmt.Sprintf("kitp doesn't trust this app, published on %s, yet.", ue.host),
		Detail:  "A kitp administrator can allow it. Ask one, and they'll see your request on the MCP apps screen.",
		Request: &requestData{
			Action: AuthorizePath,
			Token:  consentToken(r),
			Hidden: []hiddenField{
				{Name: "client_id", Value: ue.clientID},
				{Name: "redirect_uri", Value: redirectURI},
			},
		},
	})
}

// askAdmin records a member's request for an untrusted client on
// oauth_client, for an admin to allow on the MCP apps screen.
func (s *Server) askAdmin(ctx context.Context, w http.ResponseWriter, p *person, form url.Values) error {
	norm, host, err := normClientID(form.Get("client_id"))
	var ce *clientError
	if errors.As(err, &ce) {
		return renderPage(w, http.StatusBadRequest, pageData{Title: "Can't connect", Message: ce.msg})
	}
	if err != nil {
		return api.Internal(err)
	}
	ok, err := trusted(ctx, s.cfg.Pool, norm)
	if err != nil {
		return api.Internal(err)
	}
	if ok {
		return renderPage(w, http.StatusOK, pageData{
			Title:   "Already allowed",
			Message: fmt.Sprintf("kitp now trusts this app, published on %s.", host),
			Detail:  "Go back to the app and connect again.",
		})
	}
	recorded, err := s.recordRequest(ctx, norm, form.Get("redirect_uri"), p.id)
	if err != nil {
		return api.Internal(err)
	}
	if !recorded {
		return renderPage(w, http.StatusTooManyRequests, pageData{
			Title:   "Too many open requests",
			Message: "kitp is holding as many requests for apps as it takes.",
			Detail:  "Ask a kitp administrator directly; they can clear old requests on the MCP apps screen.",
		})
	}
	s.logger.InfoContext(ctx, "oauth: member asked to allow a client", "client_id", norm, "member", p.id)
	return renderPage(w, http.StatusOK, pageData{
		Title:   "Request sent",
		Message: fmt.Sprintf("Your request to allow this app, published on %s, is on the MCP apps screen.", host),
		Detail:  "Once a kitp administrator allows it, go back to the app and connect again.",
	})
}

// malformedPage answers a request whose values aren't text (invalid UTF-8,
// NUL) — never a real client's.
func malformedPage(w http.ResponseWriter) error {
	return renderPage(w, http.StatusBadRequest, pageData{
		Title:   "Can't connect",
		Message: "This sign-in link is malformed.",
		Detail:  "Go back to the app and connect again.",
	})
}

// toLogin sends a visitor with no session to sign in, coming back to this
// same request.
func (s *Server) toLogin(w http.ResponseWriter, r *http.Request) error {
	back := r.URL.RequestURI()
	if s.cfg.LoginPath == "" || len(back) > maxLoginRedirect {
		return renderPage(w, http.StatusUnauthorized, pageData{
			Title:    "Sign in to kitp",
			Message:  "Sign in to kitp in this browser first.",
			Detail:   "Then go back to the app and connect again.",
			LinkHref: "/",
			LinkText: "Open kitp",
		})
	}
	http.Redirect(w, r, s.cfg.LoginPath+"?redirect="+url.QueryEscape(back), http.StatusFound)
	return nil
}

func (s *Server) agentSessionPage(w http.ResponseWriter) error {
	return renderPage(w, http.StatusForbidden, pageData{
		Title:   "Sign in as yourself",
		Message: "You're signed in to kitp as an agent.",
		Detail:  "Sign in as yourself to connect an app to one of your agents.",
	})
}

// consentToken ties the consent form to the browser's session: the form
// carries it and the post must match it. The router already refuses a
// cross-site post; this also holds where that check is off (dev CORS).
func consentToken(r *http.Request) string {
	sid := session.Read(r)
	if sid == "" {
		return ""
	}
	return auth.HashSecret("oauth-consent\x00" + sid)
}

// issueCode stores a one-time code for the approved request and returns
// it.
func (s *Server) issueCode(ctx context.Context, req *authRequest, approver, agentID int64) (string, error) {
	code, err := newSecret()
	if err != nil {
		return "", err
	}
	b := named.New()
	b.Set("id", auth.HashSecret(code))
	b.Set("agent", agentID)
	b.Set("me", approver)
	b.Set("client", req.client.ID)
	b.Set("name", req.client.Name)
	b.Set("redirect", req.redirectURI)
	b.Set("challenge", req.codeChallenge)
	b.Set("resource", s.resource)
	b.Set("ttl", int(codeTTL.Seconds()))
	sql, args, err := b.Compile(`
		INSERT INTO oauth_code (id, user_id, approved_by, client_id, client_name,
		                        redirect_uri, code_challenge, resource, expires_at)
		VALUES (:id, :agent, :me, :client, :name, :redirect, :challenge, :resource,
		        now() + make_interval(secs => :ttl::int))`)
	if err != nil {
		return "", fmt.Errorf("oauth: code: compile: %w", err)
	}
	if _, err := s.cfg.Pool.Exec(ctx, sql, args...); err != nil {
		return "", fmt.Errorf("oauth: code: %w", err)
	}
	return code, nil
}

// newSecret returns 32 random bytes base64url-encoded: a code, an access
// token or a refresh token. Only its hash (auth.HashSecret) is stored.
func newSecret() (string, error) {
	var buf [32]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", fmt.Errorf("oauth: random: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf[:]), nil
}
