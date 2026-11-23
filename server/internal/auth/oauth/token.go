// token.go: POST /api/v1/oauth/token — trade a code for tokens, refresh
// them, and the reaper for spent rows.
package oauth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"mime"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/named"
)

// tokenErr is an OAuth error reply from the token endpoint (RFC 6749
// §5.2).
type tokenErr struct {
	status int
	code   string
	desc   string
}

func (e *tokenErr) Error() string { return e.code + ": " + e.desc }

func invalidGrant(desc string) *tokenErr {
	return &tokenErr{http.StatusBadRequest, "invalid_grant", desc}
}

// tokenReply is the token endpoint's success body (RFC 6749 §5.1).
type tokenReply struct {
	AccessToken  string `json:"access_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int64  `json:"expires_in"`
	RefreshToken string `json:"refresh_token"`
	Scope        string `json:"scope"`
}

func (s *Server) token(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	var reply *tokenReply
	var err error
	if mt, _, perr := mime.ParseMediaType(r.Header.Get("Content-Type")); perr != nil || mt != "application/x-www-form-urlencoded" {
		err = &tokenErr{http.StatusBadRequest, "invalid_request", "send the request as application/x-www-form-urlencoded"}
	} else if perr := r.ParseForm(); perr != nil {
		err = &tokenErr{http.StatusBadRequest, "invalid_request", "couldn't read the form"}
	} else {
		switch gt := r.PostForm.Get("grant_type"); gt {
		case "authorization_code":
			reply, err = s.exchangeCode(ctx, r)
		case "refresh_token":
			reply, err = s.refresh(ctx, r)
		default:
			err = &tokenErr{http.StatusBadRequest, "unsupported_grant_type", "kitp supports authorization_code and refresh_token"}
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	var te *tokenErr
	if errors.As(err, &te) {
		s.logger.InfoContext(ctx, "oauth: token refused", "code", te.code, "why", te.desc)
		writeJSON(w, te.status, struct {
			Error            string `json:"error"`
			ErrorDescription string `json:"error_description"`
		}{te.code, te.desc})
		return nil
	}
	if err != nil {
		return api.Internal(err)
	}
	writeJSON(w, http.StatusOK, reply)
	return nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		// The client went away; the status is already sent and there is
		// no one left to tell.
		slog.Default().Debug("oauth: write reply", "err", err)
	}
}

// checkResource refuses a token request for another resource (RFC 8707).
func (s *Server) checkResource(r *http.Request) error {
	for _, res := range r.PostForm["resource"] {
		if !s.isResource(res) {
			return &tokenErr{http.StatusBadRequest, "invalid_target", "kitp issues tokens only for " + s.resource}
		}
	}
	return nil
}

// exchangeCode trades a code from the consent page, with its PKCE
// verifier, for an access token and a refresh token. It makes the grant
// and the agent's user_token in one transaction.
func (s *Server) exchangeCode(ctx context.Context, r *http.Request) (*tokenReply, error) {
	f := r.PostForm
	code, clientID, redirectURI, verifier := f.Get("code"), f.Get("client_id"), f.Get("redirect_uri"), f.Get("code_verifier")
	if code == "" || clientID == "" || verifier == "" {
		return nil, &tokenErr{http.StatusBadRequest, "invalid_request", "code, client_id and code_verifier are required"}
	}
	if err := s.checkResource(r); err != nil {
		return nil, err
	}
	tx, err := s.cfg.Pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("oauth: exchange: begin: %w", err)
	}
	defer rollback(ctx, tx)

	b := named.New()
	b.Set("id", auth.HashSecret(code))
	sql, args, err := b.Compile(`
		SELECT user_id, approved_by, client_id, client_name, redirect_uri, code_challenge,
		       used_at IS NOT NULL, expires_at <= now(), grant_id
		FROM oauth_code WHERE id = :id FOR UPDATE`)
	if err != nil {
		return nil, fmt.Errorf("oauth: exchange: compile: %w", err)
	}
	var (
		agentID, approver                    int64
		codeClient, clientName, codeRedirect string
		challenge                            string
		used, expired                        bool
		usedGrant                            *int64
	)
	if err := tx.QueryRow(ctx, sql, args...).Scan(&agentID, &approver, &codeClient, &clientName,
		&codeRedirect, &challenge, &used, &expired, &usedGrant); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, invalidGrant("unknown code")
		}
		return nil, fmt.Errorf("oauth: exchange: %w", err)
	}
	// Client, redirect URI and PKCE are checked first, so a stray copy of a
	// spent code (from a log, say) is just refused: only a complete replay
	// — which the code's PKCE verifier makes — counts as one below.
	if clientID != codeClient || redirectURI != codeRedirect {
		return nil, invalidGrant("code was issued to another client or redirect URI")
	}
	if !pkceOK(verifier, challenge) {
		return nil, invalidGrant("code_verifier doesn't match the code_challenge")
	}
	if used {
		// A code traded twice: whoever has it now may not be who traded it
		// first, so the connection it made ends (RFC 6749 §4.1.2).
		if usedGrant != nil {
			if err := revokeGrant(ctx, tx, *usedGrant); err != nil {
				return nil, err
			}
			if err := tx.Commit(ctx); err != nil {
				return nil, fmt.Errorf("oauth: exchange: commit: %w", err)
			}
			s.logger.WarnContext(ctx, "oauth: code reused; connection revoked", "grant_id", *usedGrant)
		}
		return nil, invalidGrant("code already used")
	}
	if expired {
		return nil, invalidGrant("code expired")
	}
	if ok, err := clientAllowed(ctx, tx, codeClient); err != nil {
		return nil, err
	} else if !ok {
		return nil, invalidGrant("kitp no longer allows this app")
	}
	if ok, err := agentUsable(ctx, tx, agentID, approver); err != nil {
		return nil, err
	} else if !ok {
		return nil, invalidGrant("the agent or the person who approved it can no longer connect")
	}

	access, refresh, err := newPair()
	if err != nil {
		return nil, err
	}
	b = named.New()
	b.Set("agent", agentID)
	b.Set("me", approver)
	b.Set("client", clientID)
	b.Set("refresh", auth.HashSecret(refresh))
	b.Set("max_days", s.cfg.MaxDays)
	b.Set("name", clientName)
	// The label carries the grant's id, which makes it unique among the
	// agent's tokens ((user_id, label) is unique), so the id is drawn
	// first. The first refresh token starts the grant's chain.
	sql, args, err = b.Compile(`
		WITH n AS (SELECT nextval(pg_get_serial_sequence('oauth_grant', 'id')) AS id),
		g AS (
			INSERT INTO oauth_grant (id, user_id, approved_by, client_id, token_label, expires_at)
			SELECT n.id, :agent, :me, :client,
			       format('%s (OAuth, connected %s, #%s)', :name::text,
			              to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'), n.id),
			       CASE WHEN :max_days::bigint > 0 THEN now() + :max_days::bigint * interval '1 day' END
			FROM n
			RETURNING id, token_label, expires_at
		), rt AS (
			INSERT INTO oauth_refresh_token (hash, grant_id) SELECT :refresh, id FROM g
		)
		SELECT id, token_label, expires_at FROM g`)
	if err != nil {
		return nil, fmt.Errorf("oauth: exchange: grant: compile: %w", err)
	}
	var grantID int64
	var label string
	var grantExpires *time.Time
	if err := tx.QueryRow(ctx, sql, args...).Scan(&grantID, &label, &grantExpires); err != nil {
		return nil, fmt.Errorf("oauth: exchange: grant: %w", err)
	}
	expires := accessExpiry(grantExpires)
	b = named.New()
	b.Set("id", auth.HashSecret(access))
	b.Set("agent", agentID)
	b.Set("label", label)
	b.Set("expires", expires)
	b.Set("scope", auth.TokenScopeMCP)
	// Scope mcp: the token works on /api/v1/mcp only, the resource it was
	// issued for (RFC 8707), not on kitp's other bearer routes.
	sql, args, err = b.Compile(`
		INSERT INTO user_token (id, user_id, label, expires_at, scope)
		VALUES (:id, :agent, :label, :expires, :scope)`)
	if err != nil {
		return nil, fmt.Errorf("oauth: exchange: token: compile: %w", err)
	}
	if _, err := tx.Exec(ctx, sql, args...); err != nil {
		return nil, fmt.Errorf("oauth: exchange: token: %w", err)
	}
	b = named.New()
	b.Set("id", auth.HashSecret(code))
	b.Set("grant", grantID)
	sql, args, err = b.Compile(`UPDATE oauth_code SET used_at = now(), grant_id = :grant WHERE id = :id`)
	if err != nil {
		return nil, fmt.Errorf("oauth: exchange: spend code: compile: %w", err)
	}
	if _, err := tx.Exec(ctx, sql, args...); err != nil {
		return nil, fmt.Errorf("oauth: exchange: spend code: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("oauth: exchange: commit: %w", err)
	}
	s.logger.InfoContext(ctx, "oauth: connected", "grant_id", grantID, "agent_id", agentID, "client_id", clientID)
	return &tokenReply{
		AccessToken:  access,
		TokenType:    "Bearer",
		ExpiresIn:    int64(time.Until(expires).Seconds()),
		RefreshToken: refresh,
		Scope:        Scope,
	}, nil
}

// refresh trades a refresh token for a new access token and a new
// refresh token. The access token is the grant's user_token row, whose
// id becomes the new token's hash — so a token revoked in kitp ends the
// connection here too.
//
// The grant's refresh tokens form a chain (oauth_refresh_token): one
// current, the rest spent or orphaned. A spent one presented again within
// refreshGrace, while the token issued for it was never presented, is a
// client retrying after a lost reply: the token issued in between is
// orphaned and new ones go out. Any other reuse — later, after the
// successor was used, or an orphaned token at any time — means two parties
// hold the connection's tokens (OAuth 2.1 §4.3.1), and the connection is
// revoked. A thief who replays a just-spent token gets in once, but the
// real client's next refresh presents the orphaned token and ends it.
func (s *Server) refresh(ctx context.Context, r *http.Request) (*tokenReply, error) {
	f := r.PostForm
	presented, clientID := f.Get("refresh_token"), f.Get("client_id")
	if presented == "" || clientID == "" {
		return nil, &tokenErr{http.StatusBadRequest, "invalid_request", "refresh_token and client_id are required"}
	}
	if err := s.checkResource(r); err != nil {
		return nil, err
	}
	tx, err := s.cfg.Pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("oauth: refresh: begin: %w", err)
	}
	defer rollback(ctx, tx)

	hash := auth.HashSecret(presented)
	// Which connection the token belongs to; then lock that connection and
	// read the token's state under the lock, so two refreshes at once see
	// each other's writes.
	b := named.New()
	b.Set("h", hash)
	sql, args, err := b.Compile(`SELECT grant_id FROM oauth_refresh_token WHERE hash = :h`)
	if err != nil {
		return nil, fmt.Errorf("oauth: refresh: compile: %w", err)
	}
	var grantID int64
	if err := tx.QueryRow(ctx, sql, args...).Scan(&grantID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, invalidGrant("unknown refresh token")
		}
		return nil, fmt.Errorf("oauth: refresh: %w", err)
	}
	b = named.New()
	b.Set("g", grantID)
	b.Set("idle", int(refreshIdle.Hours()/24))
	sql, args, err = b.Compile(`
		SELECT user_id, approved_by, client_id, token_label, expires_at,
		       revoked_at IS NOT NULL
		         OR (expires_at IS NOT NULL AND expires_at <= now())
		         OR COALESCE(refreshed_at, created_at) <= now() - make_interval(days => :idle::int)
		FROM oauth_grant WHERE id = :g FOR UPDATE`)
	if err != nil {
		return nil, fmt.Errorf("oauth: refresh: grant: compile: %w", err)
	}
	var (
		agentID, approver  int64
		grantClient, label string
		grantExpires       *time.Time
		over               bool
	)
	if err := tx.QueryRow(ctx, sql, args...).Scan(&agentID, &approver, &grantClient, &label, &grantExpires, &over); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, invalidGrant("unknown refresh token")
		}
		return nil, fmt.Errorf("oauth: refresh: grant: %w", err)
	}
	b = named.New()
	b.Set("h", hash)
	b.Set("grace", int(refreshGrace.Seconds()))
	sql, args, err = b.Compile(`
		SELECT t.spent_at IS NULL AND t.orphaned_at IS NULL,
		       COALESCE(t.spent_at > now() - make_interval(secs => :grace::int), false) AND t.orphaned_at IS NULL,
		       COALESCE(t.successor, ''),
		       COALESCE((SELECT n.spent_at IS NULL AND n.orphaned_at IS NULL
		                 FROM oauth_refresh_token n WHERE n.hash = t.successor), false)
		FROM oauth_refresh_token t WHERE t.hash = :h`)
	if err != nil {
		return nil, fmt.Errorf("oauth: refresh: token state: compile: %w", err)
	}
	var (
		current, recent bool
		successor       string
		successorUnused bool
	)
	if err := tx.QueryRow(ctx, sql, args...).Scan(&current, &recent, &successor, &successorUnused); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Reaped between the two reads.
			return nil, invalidGrant("unknown refresh token")
		}
		return nil, fmt.Errorf("oauth: refresh: token state: %w", err)
	}
	if over {
		return nil, invalidGrant("this connection has ended; connect again")
	}
	if clientID != grantClient {
		return nil, invalidGrant("refresh token was issued to another client")
	}
	// endGrant revokes the connection for good and says why.
	endGrant := func(why string, warn bool) (*tokenReply, error) {
		if err := revokeGrant(ctx, tx, grantID); err != nil {
			return nil, err
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, fmt.Errorf("oauth: refresh: commit: %w", err)
		}
		if warn {
			s.logger.WarnContext(ctx, "oauth: connection revoked", "grant_id", grantID, "why", why)
		}
		return nil, invalidGrant(why)
	}
	// A spent token is honoured once more only as a retry: within the
	// grace, while the token issued for it is still current and so was
	// never presented. Anything else — later, after its successor was used,
	// or an orphaned token at all — means two parties hold this
	// connection's tokens.
	retry := !current && recent && successorUnused
	if !current && !retry {
		return endGrant("refresh token already used; connect again", true)
	}
	if ok, err := agentUsable(ctx, tx, agentID, approver); err != nil {
		return nil, err
	} else if !ok {
		return endGrant("the agent or the person who approved it can no longer connect", false)
	}
	// An admin who stops trusting the app ends its connections here.
	if ok, err := clientAllowed(ctx, tx, grantClient); err != nil {
		return nil, err
	} else if !ok {
		return endGrant("kitp no longer allows this app; an admin can allow it again on the MCP apps screen", false)
	}

	access, refresh, err := newPair()
	if err != nil {
		return nil, err
	}
	expires := accessExpiry(grantExpires)
	b = named.New()
	b.Set("id", auth.HashSecret(access))
	b.Set("agent", agentID)
	b.Set("label", label)
	b.Set("expires", expires)
	sql, args, err = b.Compile(`
		UPDATE user_token SET id = :id, expires_at = :expires
		WHERE user_id = :agent AND label = :label AND revoked_at IS NULL`)
	if err != nil {
		return nil, fmt.Errorf("oauth: refresh: token: compile: %w", err)
	}
	tag, err := tx.Exec(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("oauth: refresh: token: %w", err)
	}
	if tag.RowsAffected() == 0 {
		// Someone revoked (or deleted) the connection's token in kitp.
		return endGrant("this connection was revoked in kitp; connect again", false)
	}
	// Move the chain on. Normally the presented token is spent, with the
	// new one as its successor. On a retry the token issued for it is
	// orphaned instead — it was never presented, and presenting it now
	// would mean someone else has it — and the new one becomes the
	// presented token's successor. The old current token is retired before
	// the new one goes in (one current token per grant).
	newHash := auth.HashSecret(refresh)
	steps := []struct {
		name string
		sql  string
	}{
		{"spend", `UPDATE oauth_refresh_token SET spent_at = now(), successor = :new WHERE hash = :h`},
	}
	if retry {
		steps = []struct {
			name string
			sql  string
		}{
			{"orphan", `UPDATE oauth_refresh_token SET orphaned_at = now() WHERE hash = :succ`},
			{"relink", `UPDATE oauth_refresh_token SET successor = :new WHERE hash = :h`},
		}
	}
	for _, st := range steps {
		b = named.New()
		b.Set("h", hash)
		b.Set("succ", successor)
		b.Set("new", newHash)
		sql, args, err = b.Compile(st.sql)
		if err != nil {
			return nil, fmt.Errorf("oauth: refresh: %s: compile: %w", st.name, err)
		}
		if _, err := tx.Exec(ctx, sql, args...); err != nil {
			return nil, fmt.Errorf("oauth: refresh: %s: %w", st.name, err)
		}
	}
	b = named.New()
	b.Set("g", grantID)
	b.Set("new", newHash)
	sql, args, err = b.Compile(`
		WITH rt AS (INSERT INTO oauth_refresh_token (hash, grant_id) VALUES (:new, :g))
		UPDATE oauth_grant SET refreshed_at = now() WHERE id = :g`)
	if err != nil {
		return nil, fmt.Errorf("oauth: refresh: rotate: compile: %w", err)
	}
	if _, err := tx.Exec(ctx, sql, args...); err != nil {
		return nil, fmt.Errorf("oauth: refresh: rotate: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("oauth: refresh: commit: %w", err)
	}
	return &tokenReply{
		AccessToken:  access,
		TokenType:    "Bearer",
		ExpiresIn:    int64(time.Until(expires).Seconds()),
		RefreshToken: refresh,
		Scope:        Scope,
	}, nil
}

// accessExpiry is when a new access token stops: an hour from now, or
// the connection's end if that is sooner.
func accessExpiry(grantExpires *time.Time) time.Time {
	t := time.Now().Add(AccessTokenTTL)
	if grantExpires != nil && grantExpires.Before(t) {
		t = *grantExpires
	}
	return t
}

func newPair() (access, refresh string, err error) {
	if access, err = newSecret(); err != nil {
		return "", "", err
	}
	if refresh, err = newSecret(); err != nil {
		return "", "", err
	}
	return access, refresh, nil
}

// pkceOK checks an S256 verifier (RFC 7636 §4.6): 43-128 unreserved
// characters whose SHA-256, base64url-encoded, is the challenge.
func pkceOK(verifier, challenge string) bool {
	if len(verifier) < 43 || len(verifier) > 128 {
		return false
	}
	for _, r := range verifier {
		if !(r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' ||
			r == '-' || r == '.' || r == '_' || r == '~') {
			return false
		}
	}
	sum := sha256.Sum256([]byte(verifier))
	got := base64.RawURLEncoding.EncodeToString(sum[:])
	return subtle.ConstantTimeCompare([]byte(got), []byte(challenge)) == 1
}

// agentUsable says whether the agent can still be connected for the
// person who approved it: a live agent they still own, and neither login
// revoked.
func agentUsable(ctx context.Context, tx pgx.Tx, agentID, approver int64) (bool, error) {
	b := named.New()
	b.Set("agent", agentID)
	b.Set("me", approver)
	sql, args, err := b.Compile(`
		SELECT EXISTS (
			SELECT 1
			FROM user_account a
			JOIN user_account o ON o.id = a.parent_user_id
			WHERE a.id = :agent AND a.is_agent
			  AND a.deleted_at IS NULL AND a.login_revoked_at IS NULL
			  AND o.id = :me AND o.login_revoked_at IS NULL)`)
	if err != nil {
		return false, fmt.Errorf("oauth: agent check: compile: %w", err)
	}
	var ok bool
	if err := tx.QueryRow(ctx, sql, args...).Scan(&ok); err != nil {
		return false, fmt.Errorf("oauth: agent check: %w", err)
	}
	return ok, nil
}

// revokeGrant ends a connection: the grant and its access token.
func revokeGrant(ctx context.Context, tx pgx.Tx, grantID int64) error {
	b := named.New()
	b.Set("id", grantID)
	sql, args, err := b.Compile(`
		WITH g AS (
			UPDATE oauth_grant SET revoked_at = now()
			WHERE id = :id AND revoked_at IS NULL
			RETURNING user_id, token_label
		)
		UPDATE user_token t SET revoked_at = now()
		FROM g WHERE t.user_id = g.user_id AND t.label = g.token_label AND t.revoked_at IS NULL`)
	if err != nil {
		return fmt.Errorf("oauth: revoke: compile: %w", err)
	}
	if _, err := tx.Exec(ctx, sql, args...); err != nil {
		return fmt.Errorf("oauth: revoke: %w", err)
	}
	return nil
}

// rollback ends a transaction that wasn't committed. ErrTxClosed is the
// committed case; any other failure leaves a connection the pool drops,
// so it is only logged.
func rollback(ctx context.Context, tx pgx.Tx) {
	if err := tx.Rollback(ctx); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
		slog.Default().WarnContext(ctx, "oauth: rollback", "err", err)
	}
}

// Reap deletes spent OAuth rows: codes an hour past their expiry, spent
// refresh tokens after 30 days, and connections a day past their end —
// revoked, expired, idle, or whose access token someone revoked in kitp —
// together with that access token's user_token row, so an agent's token
// list doesn't fill with every connection it ever had. Run by the
// oauth.reap job.
func (s *Server) Reap(ctx context.Context) error {
	if _, err := s.cfg.Pool.Exec(ctx, `DELETE FROM oauth_code WHERE expires_at < now() - interval '1 hour'`); err != nil {
		return fmt.Errorf("oauth: reap codes: %w", err)
	}
	if _, err := s.cfg.Pool.Exec(ctx, `
		DELETE FROM oauth_refresh_token
		WHERE spent_at < now() - interval '30 days' OR orphaned_at < now() - interval '30 days'`); err != nil {
		return fmt.Errorf("oauth: reap spent refresh tokens: %w", err)
	}
	b := named.New()
	b.Set("idle", int(refreshIdle.Hours()/24))
	sql, args, err := b.Compile(`
		WITH g AS (
			DELETE FROM oauth_grant g
			WHERE g.revoked_at < now() - interval '1 day'
			   OR g.expires_at < now() - interval '1 day'
			   OR COALESCE(g.refreshed_at, g.created_at) < now() - make_interval(days => :idle::int) - interval '1 day'
			   OR (g.created_at < now() - interval '1 day' AND NOT EXISTS (
			         SELECT 1 FROM user_token t
			         WHERE t.user_id = g.user_id AND t.label = g.token_label AND t.revoked_at IS NULL))
			RETURNING g.user_id, g.token_label
		)
		DELETE FROM user_token t USING g WHERE t.user_id = g.user_id AND t.label = g.token_label`)
	if err != nil {
		return fmt.Errorf("oauth: reap connections: compile: %w", err)
	}
	if _, err := s.cfg.Pool.Exec(ctx, sql, args...); err != nil {
		return fmt.Errorf("oauth: reap connections: %w", err)
	}
	return nil
}
