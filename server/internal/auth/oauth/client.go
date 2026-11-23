// client.go: who the OAuth client is. A client identifies itself with a
// Client ID Metadata Document — its client_id is an HTTPS URL that serves
// a JSON document naming the client and its redirect URIs (MCP
// authorization 2025-11-25; draft-ietf-oauth-client-id-metadata-document).
// kitp fetches it only for a client_id an admin trusts (oauth_client, the
// MCP apps screen): exactly, or under a prefix ending in /. Trusting by
// client_id rather than by host keeps anyone who can publish a file on a
// shared host from posing as "Claude" and sending agent tokens to their own
// site, and keeps the fetch from being pointed at an internal address.
package oauth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/textnorm"
)

const (
	// maxClientDoc caps a client metadata document's size.
	maxClientDoc = 64 << 10
	// maxClientID caps a client_id's length (oauth_client_set_batch has
	// the same limit).
	maxClientID = 2048
	// failCacheTTL is how long a client document that couldn't be read or
	// wasn't valid is remembered, so retries don't hammer its host.
	failCacheTTL = time.Minute
	// fetchTimeout bounds one client document fetch.
	fetchTimeout = 5 * time.Second
	// maxRequests and maxRequestsPerMember cap the requests for untrusted
	// clients that are recorded, so nobody can fill the admin's list.
	maxRequests          = 200
	maxRequestsPerMember = 10
)

// dnsHost is a lower-case DNS host name with an optional port: two or more
// labels, the last starting with a letter — so no IP literal, no localhost,
// no single-label name. oauth_client_set_batch applies the same rule.
var dnsHost = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]([a-z0-9-]*[a-z0-9])?(:[0-9]{1,5})?$`)

// Client is a client metadata document kitp has checked.
type Client struct {
	ID           string
	Name         string
	RedirectURIs []string
}

type cachedClient struct {
	client  *Client
	err     error
	fetched time.Time
}

// clientError says why a client_id was refused, in words for the person
// on the consent page — naming at most the client's host. It is never sent
// to the redirect URI: an unknown client's redirect URI is not to be
// trusted.
type clientError struct {
	msg string
	err error // logged, never shown
}

func (e *clientError) Error() string {
	if e.err != nil {
		return e.msg + ": " + e.err.Error()
	}
	return e.msg
}

func (e *clientError) Unwrap() error { return e.err }

// untrustedError says a well-formed client_id isn't one an admin trusts
// (yet). The member can ask an administrator to allow it.
type untrustedError struct {
	clientID string // normalised
	host     string
}

func (e *untrustedError) Error() string {
	return "oauth: client " + e.clientID + " is not trusted"
}

// normClientID checks a client_id's shape and returns it normalised: https,
// a DNS host name (lower-cased) with an optional port, a path with no dot
// segments (encoded or not), and no user info, query or fragment. That
// normal form is what oauth_client rows are matched against. It also
// returns the host, for messages.
func normClientID(clientID string) (norm, host string, err error) {
	notAnID := &clientError{msg: "kitp identifies an app by its published client ID, a web address. " +
		"In Claude's connector settings, choose “Use Claude's published identity” as the OAuth client."}
	if len(clientID) > maxClientID {
		return "", "", notAnID
	}
	u, perr := url.Parse(clientID)
	if perr != nil || u.Scheme != "https" || u.Opaque != "" || u.User != nil ||
		u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(clientID, "#") {
		return "", "", notAnID
	}
	host = strings.ToLower(u.Host)
	if !dnsHost.MatchString(host) {
		return "", "", notAnID
	}
	// No dot segments, no empty segments, no ";" (which some servers
	// read as a path parameter, so "..;" acts as ".."): under a trusted
	// prefix, a path must mean what it says.
	if u.Path == "" || u.Path == "/" || strings.ContainsAny(u.Path, "\\ \t;") ||
		strings.Contains(u.Path, "//") || hasDotSegment(u.Path) {
		return "", "", notAnID
	}
	return "https://" + host + u.EscapedPath(), host, nil
}

// hasDotSegment says whether a decoded path has a "." or ".." segment.
func hasDotSegment(p string) bool {
	for _, seg := range strings.Split(p, "/") {
		if seg == "." || seg == ".." {
			return true
		}
	}
	return false
}

// rowQuerier is a pool or a transaction.
type rowQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// trusted says whether an admin trusts a normalised client_id: a row with
// that exact client_id, or a prefix ending in / that it starts with.
func trusted(ctx context.Context, q rowQuerier, norm string) (bool, error) {
	b := named.New()
	b.Set("id", norm)
	sql, args, err := b.Compile(`
		SELECT EXISTS (
			SELECT 1 FROM oauth_client
			WHERE allowed
			  AND (client_id = :id OR (right(client_id, 1) = '/' AND starts_with(:id, client_id))))`)
	if err != nil {
		return false, fmt.Errorf("oauth: trust check: compile: %w", err)
	}
	var ok bool
	if err := q.QueryRow(ctx, sql, args...).Scan(&ok); err != nil {
		return false, fmt.Errorf("oauth: trust check: %w", err)
	}
	return ok, nil
}

// clientAllowed says whether a client_id kitp issued a code or a
// connection to is still trusted: disallowing a client ends its
// connections at their next refresh.
func clientAllowed(ctx context.Context, q rowQuerier, clientID string) (bool, error) {
	norm, _, err := normClientID(clientID)
	if err != nil {
		// Only a malformed client_id (a *clientError) gets here, and a
		// client_id kitp can't read is simply not trusted.
		return false, nil
	}
	return trusted(ctx, q, norm)
}

// client returns the checked metadata document for clientID. Trust is
// checked against oauth_client every time, so an admin's change applies at
// once; the document itself is cached (clientCacheTTL, or failCacheTTL
// when it couldn't be used).
func (s *Server) client(ctx context.Context, clientID string) (*Client, error) {
	norm, host, err := normClientID(clientID)
	if err != nil {
		return nil, err
	}
	ok, err := trusted(ctx, s.cfg.Pool, norm)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, &untrustedError{clientID: norm, host: host}
	}
	s.mu.Lock()
	c, hit := s.clients[clientID]
	s.mu.Unlock()
	if hit {
		ttl := clientCacheTTL
		if c.err != nil {
			ttl = failCacheTTL
		}
		if time.Since(c.fetched) < ttl {
			return c.client, c.err
		}
	}
	cl, err := s.fetchClient(ctx, clientID, host)
	var ce *clientError
	if err != nil && !errors.As(err, &ce) {
		return nil, err
	}
	s.mu.Lock()
	if len(s.clients) >= 64 {
		// A handful of clients is the expected set; more is someone
		// cycling client_ids, so start over rather than grow.
		s.clients = map[string]cachedClient{}
	}
	s.clients[clientID] = cachedClient{client: cl, err: err, fetched: time.Now()}
	s.mu.Unlock()
	return cl, err
}

// clientDoc is the part of a client metadata document kitp reads.
type clientDoc struct {
	ClientID                string   `json:"client_id"`
	ClientName              string   `json:"client_name"`
	RedirectURIs            []string `json:"redirect_uris"`
	GrantTypes              []string `json:"grant_types"`
	ResponseTypes           []string `json:"response_types"`
	TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method"`
	ClientSecret            string   `json:"client_secret"`
}

func (s *Server) fetchClient(ctx context.Context, clientID, host string) (*Client, error) {
	unreadable := func(err error) error {
		return &clientError{msg: fmt.Sprintf("kitp couldn't read the app's details from %s. Try again in a minute.", host), err: err}
	}
	// The fetch runs on its own deadline, not the member's request: what
	// it finds is cached for everyone, so a member who closes the tab
	// mid-fetch mustn't leave a failure behind for the next minute.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), fetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, clientID, nil)
	if err != nil {
		return nil, unreadable(err)
	}
	req.Header.Set("Accept", "application/json")
	resp, err := s.http.Do(req)
	if err != nil {
		return nil, unreadable(err)
	}
	defer func() {
		if err := resp.Body.Close(); err != nil {
			s.logger.Debug("oauth: close client document", "err", err)
		}
	}()
	if resp.StatusCode != http.StatusOK {
		return nil, unreadable(fmt.Errorf("status %d", resp.StatusCode))
	}
	if mt, _, err := mime.ParseMediaType(resp.Header.Get("Content-Type")); err != nil ||
		(mt != "application/json" && !strings.HasSuffix(mt, "+json")) {
		return nil, unreadable(fmt.Errorf("content type %q is not JSON", resp.Header.Get("Content-Type")))
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxClientDoc+1))
	if err != nil {
		return nil, unreadable(err)
	}
	if len(body) > maxClientDoc {
		return nil, unreadable(errors.New("document over 64 KB"))
	}
	var doc clientDoc
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, unreadable(err)
	}
	return checkClientDoc(clientID, host, doc)
}

// checkClientDoc applies the metadata document rules kitp relies on.
func checkClientDoc(clientID, host string, doc clientDoc) (*Client, error) {
	invalid := func(why string) error {
		return &clientError{msg: fmt.Sprintf("The app's details published on %s aren't valid: %s.", host, why)}
	}
	if doc.ClientID != clientID {
		return nil, invalid("its client_id is not the address it is published at")
	}
	// kitp's clients are public (PKCE, no secret): a document that wants
	// to authenticate at the token endpoint is one kitp can't serve.
	if doc.ClientSecret != "" {
		return nil, invalid("it carries a client secret")
	}
	if m := doc.TokenEndpointAuthMethod; m != "" && m != "none" {
		return nil, invalid("kitp accepts only public clients (token_endpoint_auth_method none)")
	}
	if len(doc.GrantTypes) > 0 && !contains(doc.GrantTypes, "authorization_code") {
		return nil, invalid("it doesn't use the authorization code grant")
	}
	if len(doc.ResponseTypes) > 0 && !contains(doc.ResponseTypes, "code") {
		return nil, invalid("it doesn't use the code response type")
	}
	if len(doc.RedirectURIs) == 0 {
		return nil, invalid("it lists no redirect URIs")
	}
	for _, r := range doc.RedirectURIs {
		if !redirectURIOK(r) {
			return nil, invalid("a redirect URI is neither HTTPS to a host name nor this computer")
		}
	}
	name := cleanName(doc.ClientName)
	if name == "" {
		name = host
	}
	return &Client{ID: clientID, Name: name, RedirectURIs: doc.RedirectURIs}, nil
}

// cleanName drops control and format characters (bidi overrides,
// zero-width ones) and trims a client name to 80 characters: it is shown
// on the consent page and in token labels.
func cleanName(s string) string {
	var b strings.Builder
	n := 0
	for _, r := range strings.TrimSpace(textnorm.Storable(s)) {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			continue
		}
		if n == 80 {
			break
		}
		b.WriteRune(r)
		n++
	}
	return strings.TrimSpace(b.String())
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// redirectURIOK says whether a redirect URI is one kitp will send a code
// to: HTTPS to a DNS host name, or plain HTTP to this computer as
// localhost or 127.0.0.1 (a native client's loopback listener, RFC 8252;
// an IPv6 literal can't be named in the consent page's CSP form-action),
// with no fragment or user info.
func redirectURIOK(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.Fragment != "" || u.User != nil || u.Opaque != "" {
		return false
	}
	switch u.Scheme {
	case "https":
		return dnsHost.MatchString(strings.ToLower(u.Host))
	case "http":
		if p := u.Port(); p != "" && !allDigits(p) {
			return false
		}
		return isLoopback(u.Hostname())
	}
	return false
}

func isLoopback(host string) bool {
	return strings.EqualFold(host, "localhost") || host == "127.0.0.1"
}

// allowsRedirect says whether uri is one of the client's redirect URIs.
// HTTPS URIs match exactly. A loopback one matches on any port: a native
// client (Claude Code) listens on whatever port is free and lists
// http://localhost/callback and http://127.0.0.1/callback, so the port is
// ignored for both (RFC 8252 §7.3; Claude's connector docs ask the same
// of localhost).
func (c *Client) allowsRedirect(uri string) bool {
	if !redirectURIOK(uri) {
		return false
	}
	for _, reg := range c.RedirectURIs {
		if reg == uri || loopbackMatch(reg, uri) {
			return true
		}
	}
	return false
}

func loopbackMatch(registered, requested string) bool {
	r, err := url.Parse(registered)
	if err != nil {
		return false
	}
	q, err := url.Parse(requested)
	if err != nil {
		return false
	}
	if r.Scheme != "http" || q.Scheme != "http" || !isLoopback(r.Hostname()) {
		return false
	}
	if !strings.EqualFold(r.Hostname(), q.Hostname()) {
		return false
	}
	if p := q.Port(); p != "" && !allDigits(p) {
		return false
	}
	return r.Path == q.Path && r.RawQuery == q.RawQuery
}

func allDigits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return s != ""
}

// redirectOrigin is scheme://host[:port] of a redirect URI, for the
// consent page's form-action.
func redirectOrigin(uri string) string {
	u, err := url.Parse(uri)
	if err != nil {
		return ""
	}
	return u.Scheme + "://" + strings.ToLower(u.Host)
}

// paramsOK says whether every value of a request is text kitp can show and
// store: valid UTF-8 with no NUL. A link that isn't is refused before
// anything reads the database.
func paramsOK(v url.Values) bool {
	for _, vals := range v {
		for _, s := range vals {
			if !utf8.ValidString(s) || strings.IndexByte(s, 0) >= 0 {
				return false
			}
		}
	}
	return true
}

// recordRequest notes on oauth_client that member asked for an untrusted
// client: the latest member, time and redirect URI, and a count. A client
// trusted meanwhile is left alone. recorded false means a cap was reached
// (maxRequests overall, maxRequestsPerMember each) and nothing was noted.
// The caps are counted under a transaction-level lock, so two requests
// can't both slip under one.
func (s *Server) recordRequest(ctx context.Context, norm, redirectURI string, member int64) (recorded bool, err error) {
	tx, err := s.cfg.Pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("oauth: record request: begin: %w", err)
	}
	defer rollback(ctx, tx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('kitp.oauth_client.request'))`); err != nil {
		return false, fmt.Errorf("oauth: record request: lock: %w", err)
	}
	b := named.New()
	b.Set("id", norm)
	b.Set("redirect", truncate(textnorm.Storable(redirectURI), maxClientID))
	b.Set("me", member)
	b.Set("cap", maxRequests)
	b.Set("member_cap", maxRequestsPerMember)
	sql, args, err := b.Compile(`
		WITH up AS (
			UPDATE oauth_client
			SET redirect_uri = :redirect, requested_by = :me,
			    requested_at = now(), request_count = request_count + 1
			WHERE client_id = :id AND NOT allowed
			RETURNING id
		), ins AS (
			INSERT INTO oauth_client (client_id, allowed, redirect_uri, requested_by, requested_at, request_count)
			SELECT :id, false, :redirect, :me, now(), 1
			WHERE NOT EXISTS (SELECT 1 FROM up)
			  AND NOT EXISTS (SELECT 1 FROM oauth_client WHERE client_id = :id)
			  AND (SELECT count(*) FROM oauth_client WHERE NOT allowed AND requested_at IS NOT NULL) < :cap::int
			  AND (SELECT count(*) FROM oauth_client WHERE NOT allowed AND requested_by = :me) < :member_cap::int
			ON CONFLICT (client_id) DO NOTHING
			RETURNING id
		)
		SELECT (SELECT count(*) FROM up) + (SELECT count(*) FROM ins)`)
	if err != nil {
		return false, fmt.Errorf("oauth: record request: compile: %w", err)
	}
	var n int
	if err := tx.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
		return false, fmt.Errorf("oauth: record request: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("oauth: record request: commit: %w", err)
	}
	return n > 0, nil
}

// truncate cuts s to at most n bytes without splitting a character.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return strings.ToValidUTF8(s[:n], "")
}
