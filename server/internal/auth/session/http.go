package session

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
)

// HTTPConfig wires the Manager + cookie attributes into the HTTP
// handlers RegisterHTTP mounts.
type HTTPConfig struct {
	Manager *Manager
	// Pool feeds the /me handler's role lookup. Required.
	Pool *pgxpool.Pool
	// SystemUserID is the user_account row dev-login authenticates as.
	// Mirrors auth.SystemUserID; kept here as a field so a test can
	// inject a different row.
	SystemUserID int64
	// DevLoginEnabled gates POST /api/v1/auth/dev-login. Only enabled
	// when AUTH_MODE=off; in OIDC mode the endpoint 404s so a stray
	// production curl can't bypass the OP.
	DevLoginEnabled bool
	// InsecureCookie disables the Secure cookie attribute. Set when
	// running over plain http://localhost in dev.
	InsecureCookie bool
}

// RegisterHTTP mounts the auth surface on mux:
//   - POST /api/v1/auth/dev-login   (only when DevLoginEnabled)
//   - POST /api/v1/auth/logout      (always)
//   - GET  /api/v1/auth/me          (always)
//
// The OIDC redirect endpoints are mounted separately by the oidc
// package — they share the Manager + cookie config but live next to
// the OIDC validator code.
func RegisterHTTP(mux *http.ServeMux, cfg HTTPConfig) {
	if cfg.DevLoginEnabled {
		mux.HandleFunc("POST /api/v1/auth/dev-login", func(w http.ResponseWriter, r *http.Request) {
			handleDevLogin(w, r, cfg)
		})
		// Impersonation: swap the session to one of the calling user's
		// agents. Lets a parent test their agent's UI view without
		// shipping a separate agent-login flow. Only mounted when
		// AUTH_MODE=off so a stray production curl cannot escalate.
		mux.HandleFunc("POST /api/v1/auth/dev-impersonate", func(w http.ResponseWriter, r *http.Request) {
			handleDevImpersonate(w, r, cfg)
		})
	}
	mux.HandleFunc("POST /api/v1/auth/logout", func(w http.ResponseWriter, r *http.Request) {
		handleLogout(w, r, cfg)
	})
	mux.HandleFunc("GET /api/v1/auth/me", func(w http.ResponseWriter, r *http.Request) {
		handleMe(w, r, cfg)
	})
}

// MeResponse is the JSON body of GET /api/v1/auth/me. The shape is
// stable; the client renders these fields verbatim into AuthState.
// `Roles` is the names of the user's role rows (e.g. ["system","admin"]);
// `IsAdmin` is the precomputed convenience flag the UI uses to gate
// the sidebar Admin section without reimplementing the role list check.
type MeResponse struct {
	UserID       int64    `json:"user_id,string"`
	DisplayName  string   `json:"display_name"`
	Roles        []string `json:"roles"`
	IsAdmin      bool     `json:"is_admin"`
	IsAgent      bool     `json:"is_agent"`
	ParentUserID *int64   `json:"parent_user_id,string,omitempty"`
}

// buildMe loads roles for userID and returns a MeResponse the handlers
// share. Skips the role lookup when Pool is nil (test wiring). Also
// surfaces is_agent + parent_user_id so the client can branch its
// Inbox query into the agent-perspective view (#50) without a second
// round-trip.
func buildMe(ctx context.Context, cfg HTTPConfig, userID int64, displayName string) (MeResponse, error) {
	out := MeResponse{
		UserID:      userID,
		DisplayName: displayName,
		Roles:       []string{},
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
		if r == "admin" || r == "system" {
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
	if err := cfg.Pool.QueryRow(ctx,
		`SELECT is_agent, parent_user_id FROM user_account WHERE id = $1`, userID,
	).Scan(&isAgent, &parentID); err == nil {
		out.IsAgent = isAgent
		out.ParentUserID = parentID
	}
	return out, nil
}

func handleMe(w http.ResponseWriter, r *http.Request, cfg HTTPConfig) {
	u, ok := auth.FromContext(r.Context())
	if !ok || u == nil {
		writeJSONErr(w, http.StatusUnauthorized, "unauthenticated")
		return
	}
	me, err := buildMe(r.Context(), cfg, u.ID, u.DisplayName)
	if err != nil {
		writeJSONErr(w, http.StatusInternalServerError, fmt.Sprintf("load roles: %v", err))
		return
	}
	writeJSON(w, http.StatusOK, me)
}

func handleDevLogin(w http.ResponseWriter, r *http.Request, cfg HTTPConfig) {
	id, err := cfg.Manager.Create(r.Context(), cfg.SystemUserID, "")
	if err != nil {
		writeJSONErr(w, http.StatusInternalServerError, fmt.Sprintf("create session: %v", err))
		return
	}
	Set(w, id, CookieOptions{
		MaxAge:         cfg.Manager.cfg.AbsoluteCap,
		InsecureCookie: cfg.InsecureCookie,
	})
	me, err := buildMe(r.Context(), cfg, cfg.SystemUserID, "System")
	if err != nil {
		writeJSONErr(w, http.StatusInternalServerError, fmt.Sprintf("load roles: %v", err))
		return
	}
	writeJSON(w, http.StatusOK, me)
}

func handleLogout(w http.ResponseWriter, r *http.Request, cfg HTTPConfig) {
	id := Read(r)
	if id != "" {
		// Best-effort revoke. Even if the DB UPDATE errors we still
		// want the browser to drop the cookie so the user is locally
		// signed out; the row will be reaped naturally when its
		// absolute cap elapses.
		_ = cfg.Manager.Revoke(r.Context(), id)
	}
	Clear(w, cfg.InsecureCookie)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleDevImpersonate swaps the session cookie to one of the calling
// user's agents. AUTH_MODE=off only (caller already gated this in
// RegisterHTTP). Authz: the agent must have parent_user_id = caller AND
// is_agent = true; otherwise 403. No admin escape — admins can use the
// regular dev-login surface to act as System and explicitly route from
// there if they need to test another user's tree.
func handleDevImpersonate(w http.ResponseWriter, r *http.Request, cfg HTTPConfig) {
	u, ok := auth.FromContext(r.Context())
	if !ok || u == nil {
		writeJSONErr(w, http.StatusUnauthorized, "unauthenticated")
		return
	}
	var body struct {
		UserID int64 `json:"user_id,string"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSONErr(w, http.StatusBadRequest, fmt.Sprintf("bad body: %v", err))
		return
	}
	if body.UserID == 0 {
		writeJSONErr(w, http.StatusBadRequest, "user_id required")
		return
	}
	// Verify ownership.
	var isAgent bool
	var parentID *int64
	var displayName string
	err := cfg.Pool.QueryRow(r.Context(), `
		SELECT is_agent, parent_user_id, display_name FROM user_account WHERE id = $1
	`, body.UserID).Scan(&isAgent, &parentID, &displayName)
	if err != nil {
		writeJSONErr(w, http.StatusNotFound, fmt.Sprintf("user not found: %d", body.UserID))
		return
	}
	if !isAgent || parentID == nil || *parentID != u.ID {
		writeJSONErr(w, http.StatusForbidden,
			fmt.Sprintf("user %d is not an agent owned by you", body.UserID))
		return
	}
	// Revoke the caller's existing session before minting a fresh one,
	// so a quick "step back out" can be modelled by another dev-login
	// without a hung cookie.
	if id := Read(r); id != "" {
		_ = cfg.Manager.Revoke(r.Context(), id)
	}
	id, err := cfg.Manager.Create(r.Context(), body.UserID, "")
	if err != nil {
		writeJSONErr(w, http.StatusInternalServerError, fmt.Sprintf("create session: %v", err))
		return
	}
	Set(w, id, CookieOptions{
		MaxAge:         cfg.Manager.cfg.AbsoluteCap,
		InsecureCookie: cfg.InsecureCookie,
	})
	me, err := buildMe(r.Context(), cfg, body.UserID, displayName)
	if err != nil {
		writeJSONErr(w, http.StatusInternalServerError, fmt.Sprintf("load roles: %v", err))
		return
	}
	writeJSON(w, http.StatusOK, me)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeJSONErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{
			"code":    statusCodeName(status),
			"message": msg,
		},
	})
}

func statusCodeName(s int) string {
	switch s {
	case http.StatusUnauthorized:
		return "unauthorized"
	case http.StatusForbidden:
		return "forbidden"
	case http.StatusBadRequest:
		return "bad_request"
	default:
		return "internal"
	}
}

