package session

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
)

// EndSessionFunc, when set on HTTPConfig, returns the OP's RP-initiated
// logout URL for the unified logout: after the local session is cleared the
// handler hands this URL back to the client to navigate to, ending the IdP
// session too. ok=false means no end-session is available (dev-login, or an
// OP that advertises no end_session_endpoint) → the client just returns to
// the app root. Wired from the OIDC validator in main.go; nil in AUTH_MODE=off.
type EndSessionFunc func(ctx context.Context) (url string, ok bool, err error)

// HTTPConfig wires the Manager + cookie attributes into the HTTP
// handlers Mount registers on the apiRouter.
type HTTPConfig struct {
	Manager *Manager
	// Pool feeds the /me handler's role lookup. Required.
	Pool *pgxpool.Pool
	// SystemUserID is the user_account row dev-login authenticates as.
	// Mirrors auth.SystemUserID; kept here as a field so a test can
	// inject a different row.
	SystemUserID int64
	// DevLoginEnabled gates POST /api/v1/auth/dev-login. Only enabled
	// when AUTH_MODE=off; in OIDC mode the endpoint is not registered
	// at all so a stray production curl can't bypass the OP.
	DevLoginEnabled bool
	// InsecureCookie disables the Secure cookie attribute. Set when
	// running over plain http://localhost in dev.
	InsecureCookie bool
	// EndSession, when non-nil (OIDC mode), supplies the OP's
	// RP-initiated logout URL so /auth/logout can perform a unified
	// logout (end the IdP session too). nil in AUTH_MODE=off.
	EndSession EndSessionFunc
}

// Mount registers the session auth surface on the apiRouter:
//
//   - POST /api/v1/auth/dev-login        Public (DevLoginEnabled only)
//   - POST /api/v1/auth/dev-impersonate  Authed (DevLoginEnabled only)
//   - POST /api/v1/auth/logout           Public  (clears cookie even
//                                                 when no session)
//   - GET  /api/v1/auth/me               Public  (200 + authenticated:
//                                                 false on no session
//                                                 — avoids a noisy 401
//                                                 every cold-boot probe)
//
// The OIDC redirect endpoints are registered separately by the oidc
// package — they share the Manager + cookie config but the OIDC dance
// lives next to the validator code.
func Mount(rt *api.Router, cfg HTTPConfig) {
	if cfg.DevLoginEnabled {
		rt.Public("POST /api/v1/auth/dev-login", func(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
			return handleDevLogin(ctx, w, r, cfg)
		})
		// Impersonation lets a parent test their agent's UI view
		// without shipping a separate agent-login flow. AUTH_MODE=off
		// only — gated by the surrounding DevLoginEnabled check.
		rt.Authed("POST /api/v1/auth/dev-impersonate", func(ctx context.Context, w http.ResponseWriter, r *http.Request, u *auth.UserCtx) error {
			return handleDevImpersonate(ctx, w, r, cfg, u)
		})
	}
	// Logout is Public because a user with a stale / corrupt cookie
	// still needs the server to clear it. Authed would 401 those out
	// and leave the cookie alive on the client.
	rt.Public("POST /api/v1/auth/logout", func(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
		return handleLogout(ctx, w, r, cfg)
	})
	rt.Public("GET /api/v1/auth/me", func(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
		return handleMe(ctx, w, r, cfg)
	})
}

// MeResponse is the JSON body of GET /api/v1/auth/me. The shape is
// stable; the client renders these fields verbatim into AuthState.
// `Authenticated` is false when no valid session cookie is present;
// all other fields are zero in that case. Switching from 401 to
// 200+flag keeps the cold-boot session probe out of the browser's
// red-error column.
// `Roles` is the names of the user's role rows (e.g. ["admin","manager"]);
// `IsAdmin` is the precomputed convenience flag the UI uses to gate
// the sidebar Admin section without reimplementing the role list check.
type MeResponse struct {
	Authenticated bool     `json:"authenticated"`
	UserID        int64    `json:"user_id,string,omitempty"`
	DisplayName   string   `json:"display_name,omitempty"`
	Roles         []string `json:"roles,omitempty"`
	IsAdmin       bool     `json:"is_admin,omitempty"`
	IsAgent       bool     `json:"is_agent,omitempty"`
	ParentUserID  *int64   `json:"parent_user_id,string,omitempty"`
	// PersonCardID is the card id of the person row linked to this
	// user_account (via user_account_person), or nil for a login-only
	// account with no person card. The client uses it to resolve the
	// "Self" quick-pick when editing a person-typed card_ref (assignee
	// / originator) — assignee values are person CARD ids, not user ids.
	PersonCardID *int64 `json:"person_card_id,string,omitempty"`
}

// buildMe loads roles for userID and returns a MeResponse the handlers
// share. Skips the role lookup when Pool is nil (test wiring). Also
// surfaces is_agent + parent_user_id so the client can branch its
// Inbox query into the agent-perspective view (#50) without a second
// round-trip.
func buildMe(ctx context.Context, cfg HTTPConfig, userID int64, displayName string) (MeResponse, error) {
	out := MeResponse{
		Authenticated: true,
		UserID:        userID,
		DisplayName:   displayName,
		Roles:         []string{},
	}
	if cfg.Pool == nil {
		return out, nil
	}
	roles, err := auth.LoadUserRoles(ctx, cfg.Pool, userID)
	if err != nil {
		return out, err
	}
	out.Roles = roles
	for _, r := range roles {
		if r == "admin" {
			out.IsAdmin = true
			break
		}
	}
	// Best-effort agent fields. The user_account row always exists
	// when we got here through a valid session, so a missing-row error
	// would be surprising; log nothing and fall through with default
	// zero values rather than failing the whole /auth/me probe.
	var isAgent bool
	var parentID *int64
	var personCardID *int64
	if err := cfg.Pool.QueryRow(ctx, `
		SELECT ua.is_agent, ua.parent_user_id, uap.person_card_id
		FROM user_account ua
		LEFT JOIN user_account_person uap ON uap.user_account_id = ua.id
		WHERE ua.id = $1
	`, userID).Scan(&isAgent, &parentID, &personCardID); err == nil {
		out.IsAgent = isAgent
		out.ParentUserID = parentID
		out.PersonCardID = personCardID
	}
	return out, nil
}

func handleMe(ctx context.Context, w http.ResponseWriter, r *http.Request, cfg HTTPConfig) error {
	id := Read(r)
	user, err := cfg.Manager.Lookup(ctx, id)
	if err != nil {
		// Missing / expired / revoked cookie all collapse to
		// authenticated:false. The 200 response keeps the probe out
		// of the browser's red-error column on cold boot.
		writeJSON(w, http.StatusOK, MeResponse{Authenticated: false})
		return nil
	}
	me, err := buildMe(ctx, cfg, user.ID, user.DisplayName)
	if err != nil {
		return api.Internal(err)
	}
	writeJSON(w, http.StatusOK, me)
	return nil
}

func handleDevLogin(ctx context.Context, w http.ResponseWriter, _ *http.Request, cfg HTTPConfig) error {
	id, err := cfg.Manager.Create(ctx, cfg.SystemUserID, "")
	if err != nil {
		return api.Internal(err)
	}
	Set(w, id, CookieOptions{
		MaxAge:         cfg.Manager.cfg.AbsoluteCap,
		InsecureCookie: cfg.InsecureCookie,
	})
	me, err := buildMe(ctx, cfg, cfg.SystemUserID, "System")
	if err != nil {
		return api.Internal(err)
	}
	writeJSON(w, http.StatusOK, me)
	return nil
}

func handleLogout(ctx context.Context, w http.ResponseWriter, r *http.Request, cfg HTTPConfig) error {
	id := Read(r)
	if id != "" {
		// Unified logout: drop EVERY session this user holds (all
		// devices/browsers), not just the cookie in this one. Resolve the
		// user from the current session first; if that lookup fails (stale
		// or already-revoked cookie) fall back to a best-effort single
		// revoke so the row still closes. Either way we clear the cookie
		// below so the browser is locally signed out regardless of DB error.
		if user, err := cfg.Manager.Lookup(ctx, id); err == nil {
			_ = cfg.Manager.RevokeAllForUser(ctx, user.ID)
		} else {
			_ = cfg.Manager.Revoke(ctx, id)
		}
	}
	Clear(w, cfg.InsecureCookie)

	// OIDC Single Logout: hand the client the OP's end-session URL so the
	// IdP session ends too. Absent (dev-login, or an OP without an
	// end_session_endpoint) → empty redirect and the client returns to the
	// app root. A discovery error here is non-fatal: the local logout
	// already succeeded, so log it and fall back to the local redirect.
	var redirect string
	if cfg.EndSession != nil {
		if u, ok, err := cfg.EndSession(ctx); err != nil {
			slog.Default().LogAttrs(ctx, slog.LevelWarn, "oidc end-session url",
				slog.String("err", err.Error()))
		} else if ok {
			redirect = u
		}
	}
	writeJSON(w, http.StatusOK, struct {
		OK       bool   `json:"ok"`
		Redirect string `json:"redirect,omitempty"`
	}{OK: true, Redirect: redirect})
	return nil
}

// handleDevImpersonate swaps the session cookie to one of the calling
// user's agents. AUTH_MODE=off only — Mount gates the registration on
// DevLoginEnabled so this handler isn't reachable in OIDC mode.
//
// Authz: the agent must have parent_user_id = caller AND is_agent =
// true; otherwise Forbidden. No admin escape — admins can use the
// regular dev-login surface to act as System and explicitly route
// from there if they need to test another user's tree.
func handleDevImpersonate(ctx context.Context, w http.ResponseWriter, r *http.Request, cfg HTTPConfig, u *auth.UserCtx) error {
	var body struct {
		UserID int64 `json:"user_id,string"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		return api.BadRequest("bad_body", "bad request body")
	}
	if body.UserID == 0 {
		return api.BadRequest("validation", "user_id required")
	}
	// Verify ownership.
	var isAgent bool
	var parentID *int64
	var displayName string
	err := cfg.Pool.QueryRow(ctx, `
		SELECT is_agent, parent_user_id, display_name FROM user_account WHERE id = $1
	`, body.UserID).Scan(&isAgent, &parentID, &displayName)
	if err != nil {
		return api.NotFound("user not found")
	}
	if !isAgent || parentID == nil || *parentID != u.ID {
		return api.Forbidden("user is not an agent owned by you")
	}
	// Revoke the caller's existing session before minting a fresh one,
	// so a quick "step back out" can be modelled by another dev-login
	// without a hung cookie.
	if id := Read(r); id != "" {
		_ = cfg.Manager.Revoke(ctx, id)
	}
	id, err := cfg.Manager.Create(ctx, body.UserID, "")
	if err != nil {
		return api.Internal(err)
	}
	Set(w, id, CookieOptions{
		MaxAge:         cfg.Manager.cfg.AbsoluteCap,
		InsecureCookie: cfg.InsecureCookie,
	})
	me, err := buildMe(ctx, cfg, body.UserID, displayName)
	if err != nil {
		return api.Internal(err)
	}
	writeJSON(w, http.StatusOK, me)
	return nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
