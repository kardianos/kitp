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

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
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
}

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

// LoadUserRoles returns the role names assigned to userID via the
// `user_role` table, joined to `role.name`. Returns an empty slice if
// the user has no roles. The dispatcher calls this once per HTTP
// request as part of the AllowedRoles gate.
//
// Agent semantics: when userID points at an agent row (is_agent=true
// with a non-null parent_user_id), the returned set is the
// intersection of the agent's own grants and the parent's grants.
// This caps the agent's effective privileges at whatever the parent
// currently holds — granting `manager` to an agent has no runtime
// effect until the parent also holds `manager`, and the agent loses
// `manager` automatically the moment the parent does. Grant-time
// checks alone don't survive subsequent parent-role revocations.
func LoadUserRoles(ctx context.Context, pool RolesPool, userID int64) ([]string, error) {
	rows, err := pool.Query(ctx, `
		WITH self AS (
			SELECT id, is_agent, parent_user_id
			FROM user_account WHERE id = $1
		),
		own AS (
			SELECT r.name
			FROM user_role ur
			JOIN role r ON r.id = ur.role_id
			WHERE ur.user_id = $1
		),
		parent_roles AS (
			SELECT r.name
			FROM self
			JOIN user_role ur ON ur.user_id = self.parent_user_id
			JOIN role r ON r.id = ur.role_id
			WHERE self.is_agent AND self.parent_user_id IS NOT NULL
		)
		SELECT name FROM own
		WHERE
		    -- Non-agent target: return their grants verbatim.
		    NOT EXISTS (SELECT 1 FROM self WHERE is_agent AND parent_user_id IS NOT NULL)
		    -- Agent target: intersect literally with parent's current
		    -- grants. No wildcard role anymore — every grant the parent
		    -- holds must appear by name.
		 OR name IN (SELECT name FROM parent_roles)
	`, userID)
	if err != nil {
		return nil, fmt.Errorf("auth: load user roles: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
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
