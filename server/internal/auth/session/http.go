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
	UserID      int64    `json:"user_id,string"`
	DisplayName string   `json:"display_name"`
	Roles       []string `json:"roles"`
	IsAdmin     bool     `json:"is_admin"`
}

// buildMe loads roles for userID and returns a MeResponse the handlers
// share. Skips the role lookup when Pool is nil (test wiring).
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

