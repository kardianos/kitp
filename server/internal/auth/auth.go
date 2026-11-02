// Package auth resolves the acting user for every batch.
//
// Phase 4 only implements the "off" mode — the System User row is loaded
// once at startup and injected into every request's context. OIDC arrives
// in phase 20.
package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sort"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/named"
)

// Mode chooses the authentication strategy.
type Mode string

const (
	ModeOff  Mode = "off"
	ModeOIDC Mode = "oidc"
)

// UserCtx is what the dispatcher and handlers see on ctx.
type UserCtx struct {
	ID          int64
	DisplayName string
	// TokenScope is the scope of the bearer token that authenticated
	// the request: TokenScopeFull for sessions and unrestricted tokens.
	// The api.Router admits a scoped token only on routes registered
	// for that scope (Router.BearerScoped).
	TokenScope string
}

// Bearer-token scopes (user_token.scope). The closed set is restated in
// db/schema/functions/user_token_create_batch.sql, which rejects any
// other value at mint time.
const (
	// TokenScopeFull is an unrestricted token: MCP and every bearer route.
	TokenScopeFull = ""
	// TokenScopeLinks limits a token to the forge link hook
	// (POST /api/v1/links) — a code forge's credential that can link
	// changes to tasks and nothing else.
	TokenScopeLinks = "links"
)

type ctxKey struct{}

// FromContext returns the user attached to ctx, if any.
func FromContext(ctx context.Context) (*UserCtx, bool) {
	u, ok := ctx.Value(ctxKey{}).(*UserCtx)
	return u, ok
}

// WithUser returns a derived context carrying u. Tests use it to bypass
// the HTTP middleware.
func WithUser(ctx context.Context, u *UserCtx) context.Context {
	return context.WithValue(ctx, ctxKey{}, u)
}

// WithSystemUser returns a derived context carrying a synthetic System
// User identity (id=1, name="System"). Mirrors what auth.Middleware
// installs in dev mode (AUTH_MODE=off) so tests that drive the
// dispatcher directly — bypassing HTTP — start from the same actor the
// production code would see. Use this in any test that calls
// `srv.Dispatch(...)` without going through the auth middleware.
func WithSystemUser(ctx context.Context) context.Context {
	return WithUser(ctx, &UserCtx{ID: SystemUserID, DisplayName: "System"})
}

// ProductionRefusalError is returned by NewSystemUser when the dev-mode
// guard refuses to start the server.
var ProductionRefusalError = errors.New("auth: ENV=production but AUTH_MODE=off; refusing to start")

// NewSystemUser loads the System User row (oidc_sub IS NULL,
// display_name='System') and returns a copy in memory. It is called once
// at startup; callers reuse the returned UserCtx for every request when
// AUTH_MODE=off. When AUTH_MODE=oidc the System User row is still loaded
// (some MCP / dev tooling falls back to it) but the HTTP middleware ignores
// it in favor of the per-request OIDC subject.
//
// Returns ProductionRefusalError when env=production and mode=off — the
// startup script must treat that as fatal (non-zero exit).
func NewSystemUser(ctx context.Context, pool *pgxpool.Pool, env string, mode Mode) (*UserCtx, error) {
	if env == "production" && mode == ModeOff {
		return nil, ProductionRefusalError
	}
	if mode != ModeOff && mode != ModeOIDC {
		return nil, fmt.Errorf("auth: mode %q not implemented", mode)
	}
	var u UserCtx
	row := pool.QueryRow(ctx, `
		SELECT id, display_name
		FROM user_account
		WHERE oidc_sub IS NULL AND display_name = 'System'
		ORDER BY id
		LIMIT 1
	`)
	if err := row.Scan(&u.ID, &u.DisplayName); err != nil {
		return nil, fmt.Errorf("auth: load System User: %w", err)
	}
	return &u, nil
}

// SystemUserID is the seed-installed System User row id (0002_seed.sql).
// Domain handlers use it as the actor when no user has been attached to
// ctx — the dev-mode contract until OIDC lands in phase 20.
const SystemUserID int64 = 1

// RolesPool is the read-only surface LoadUserRoles needs. *pgxpool.Pool
// satisfies it naturally; tests can pass mocks. Mirrors reg.ValidationPool
// without importing reg (which would import auth — cycle).
type RolesPool interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// LoadUserRoles returns the names of the roles userID can use, at any
// scope (user_role_effective). Returns an empty slice if the user has
// none. Used for the session's identity, the MCP tool surface and proc
// discovery; the dispatcher's role gate uses LoadRoleScopes, which also
// says where each role is held.
//
// Agent semantics: an agent (a user with a parent_user_id) uses only the
// rows its owner also holds, the same role at that scope or workspace-
// wide. Granting `manager` to an agent does nothing until the owner holds
// `manager` there, and the agent loses it the moment the owner does —
// grant-time checks alone don't survive a later revocation.
func LoadUserRoles(ctx context.Context, pool RolesPool, userID int64) ([]string, error) {
	scopes, err := LoadRoleScopes(ctx, pool, userID)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(scopes))
	for name := range scopes {
		out = append(out, name)
	}
	sort.Strings(out)
	return out, nil
}

// LoadRoleScopes maps each role userID can use (user_role_effective) to
// whether it is held workspace-wide (true) or only scoped to projects
// (false). The role gate needs the difference: an admin-only handler with
// no project to check against takes a workspace admin.
func LoadRoleScopes(ctx context.Context, pool RolesPool, userID int64) (map[string]bool, error) {
	b := named.New()
	b.Set("user", userID)
	sql, args, err := b.Compile(`
		SELECT r.name, bool_or(ur.scope_card_id IS NULL)
		FROM user_role_effective(:user) ur
		JOIN role r ON r.id = ur.role_id
		GROUP BY r.name
	`)
	if err != nil {
		return nil, fmt.Errorf("auth: load user roles: compile: %w", err)
	}
	rows, err := pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("auth: load user roles: %w", err)
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var name string
		var global bool
		if err := rows.Scan(&name, &global); err != nil {
			return nil, err
		}
		out[name] = global
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// RowQuerier is the surface IsGlobalAdmin needs: *pgxpool.Pool, pgx.Tx
// and reg.ValidationPool all satisfy it.
type RowQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// IsGlobalAdmin reports whether userID holds the admin role
// workspace-wide (user_is_global_admin; an agent only while its owner
// does too). The one admin check behind the admin-only handlers; a
// project-scoped admin is not a workspace admin.
func IsGlobalAdmin(ctx context.Context, q RowQuerier, userID int64) (bool, error) {
	b := named.New()
	b.Set("user", userID)
	sql, args, err := b.Compile(`SELECT user_is_global_admin(:user)`)
	if err != nil {
		return false, fmt.Errorf("auth: admin check: compile: %w", err)
	}
	var admin bool
	if err := q.QueryRow(ctx, sql, args...).Scan(&admin); err != nil {
		return false, fmt.Errorf("auth: admin check: %w", err)
	}
	return admin, nil
}

// ActorOrSystem returns the user id from ctx, falling back to the System
// User when ctx has no user attached.
func ActorOrSystem(ctx context.Context) int64 {
	if u, ok := FromContext(ctx); ok && u != nil && u.ID != 0 {
		return u.ID
	}
	return SystemUserID
}

// Middleware returns an http middleware that injects the System User into
// every incoming request. In dev mode (AUTH_MODE=off), if the request
// carries an X-Dev-User-Id header AND env != "production", the dispatcher
// runs as that user instead. This is a dev-only knob to exercise role
// matrices via curl; OIDC mode (Phase 20) replaces it with verified
// subjects from validated tokens. The header is silently dropped in
// production builds (which refuse AUTH_MODE=off anyway).
func Middleware(u *UserCtx) func(http.Handler) http.Handler {
	// Resolve the impersonation gate once at wiring time: the
	// X-Dev-User-Id header is honoured only outside production. This is
	// a hard, in-function guard (SEC-5 / A8) so a future re-wire of this
	// middleware into a production router can't accidentally ship the
	// impersonation bypass — it doesn't depend on the caller remembering
	// to not mount it.
	allowImpersonation := os.Getenv("ENV") != "production"
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			actor := u
			if allowImpersonation {
				if hdr := r.Header.Get("X-Dev-User-Id"); hdr != "" {
					if id := parseInt64(hdr); id > 0 {
						actor = &UserCtx{ID: id, DisplayName: "dev-impersonate"}
					}
				}
			}
			ctx := WithUser(r.Context(), actor)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// parseInt64 parses a header value as int64; returns 0 on failure.
func parseInt64(s string) int64 {
	var n int64
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c < '0' || c > '9' {
			return 0
		}
		n = n*10 + int64(c-'0')
	}
	return n
}
