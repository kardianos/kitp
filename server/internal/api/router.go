// Package api — apiRouter: a typed sub-router for /api/* routes.
//
// Replaces the URL-prefix gate (session.GateAPI + Exempt list) with a
// structural contract:
//
//   - Public(pattern, h)   reachable by anyone. Used for the auth dance:
//                          dev-login, oidc/start, oidc/callback, logout.
//
//   - Authed(pattern, h)   session cookie required. The handler receives
//                          the resolved UserCtx; 401 if no cookie or the
//                          cookie is invalid. The router runs the cookie
//                          lookup before calling the handler — handlers
//                          cannot accidentally skip it.
//
//   - Bearer(pattern, h)   bearer token required. Same shape as Authed
//                          but resolved via the token Manager rather
//                          than the session cookie. Used by MCP.
//
// The top-level mux mounts `apiRouter.Mux()` at "/api/" and the SPA at
// "/". Domain packages register through the router; they do not see
// the underlying ServeMux. Adding a new authenticated /api/ route
// without going through Authed/Bearer is impossible by construction.
//
// Handlers return `error`. The router translates:
//
//   - nil                       → handler already wrote its response.
//   - *HTTPError (any wrap)     → status + JSON {code, message}.
//   - *reg.HandlerError         → bridged to JSON (same wire shape as
//                                 the dispatcher's batch responses).
//   - anything else             → 500 + log with request id.
//
// Sentinel errors and constructors live in httperror.go.
package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/reg"
)

// AuthedHandler runs after the router has resolved a session cookie
// to a user. The user is also stamped on the request context via
// auth.WithUser, so existing handler code that calls auth.FromContext
// keeps working unchanged.
type AuthedHandler func(ctx context.Context, w http.ResponseWriter, r *http.Request, user *auth.UserCtx) error

// PublicHandler has no user — it's the open auth surface (login, OIDC
// callback). Same return-an-error contract as AuthedHandler so the
// translation layer is uniform.
type PublicHandler func(ctx context.Context, w http.ResponseWriter, r *http.Request) error

// BearerHandler is the token-authenticated cousin of AuthedHandler.
// Shape is identical (user is resolved before the handler runs); only
// the resolution path differs (token Manager.Lookup vs. session
// Manager.Lookup). Same `error` return contract.
type BearerHandler = AuthedHandler

// Resolver turns an incoming request into a UserCtx or returns an
// error. Returning (nil, nil) means "no credential present" → 401.
// Returning an error means "credential present but rejected" → 401
// plus the cause is logged.
type Resolver func(r *http.Request) (*auth.UserCtx, error)

// RouterConfig wires the cookie + bearer resolvers in from main. We
// keep them as functions rather than concrete *session.Manager /
// *token.Manager so the router has no package dependency on either
// (tests can stub a resolver in one line).
type RouterConfig struct {
	// SessionResolver looks up the BFF session cookie. Used by Authed.
	// Required when any Authed routes are registered.
	SessionResolver Resolver
	// BearerResolver looks up an Authorization header / token. Used by
	// Bearer. Required when any Bearer routes are registered.
	BearerResolver Resolver
	// Logger surfaces 5xx causes and rejected-credential reasons. Falls
	// back to slog.Default when nil.
	Logger *slog.Logger
}

// Router is the kernel. Hand it to domain packages via Mount(rt
// *api.Router, …) so they can register routes without touching the
// underlying mux.
//
// `routes` is the in-order list of every registration the router has
// seen. Used by Routes() for auth-audit tooling (dump every /api/*
// route + its tier into a CSV the team reviews on every PR). The
// router never reads it back at request time — it's a side-channel
// inventory.
type Router struct {
	mux     *http.ServeMux
	session Resolver
	bearer  Resolver
	logger  *slog.Logger
	routes  []RouteSpec
}

// RouteSpec captures one HTTP route registered through the apiRouter.
// `Tier` is one of `public` | `authed` | `bearer` — the auth contract
// the router enforces before invoking the handler. `Pattern` is the
// raw Go 1.22 ServeMux pattern as passed to the register method
// (e.g. "POST /api/v1/cas/chunk").
type RouteSpec struct {
	Tier    string
	Pattern string
}

// NewRouter builds a Router. Callers wire resolvers in via cfg.
func NewRouter(cfg RouterConfig) *Router {
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &Router{
		mux:     http.NewServeMux(),
		session: cfg.SessionResolver,
		bearer:  cfg.BearerResolver,
		logger:  logger,
	}
}

// Mux returns the underlying ServeMux as a plain http.Handler so the
// top-level mux can mount it (`top.Handle("/api/", rt.Mux())`). We
// return Handler, not *ServeMux, so callers can't smuggle in a raw
// mux.Handle that skips the auth wrappers.
func (rt *Router) Mux() http.Handler { return rt.mux }

// Public registers an unauthenticated handler. Use sparingly — every
// Public route is a hole, by definition, in the authenticated surface.
// Current uses: dev-login, oidc/start, oidc/callback, logout.
func (rt *Router) Public(pattern string, h PublicHandler) {
	rt.mux.Handle(pattern, rt.wrapPublic(h))
	rt.routes = append(rt.routes, RouteSpec{Tier: "public", Pattern: pattern})
}

// Authed registers a session-cookie-authenticated handler. The
// handler is called with the resolved user; on auth failure the
// router writes a 401 and the handler never runs.
//
// Panics at register time when no SessionResolver is configured —
// catching the misconfiguration at startup is preferable to silently
// 401ing in production.
func (rt *Router) Authed(pattern string, h AuthedHandler) {
	if rt.session == nil {
		panic("api.Router: Authed registered but RouterConfig.SessionResolver is nil")
	}
	rt.mux.Handle(pattern, rt.wrap(rt.session, "session", h))
	rt.routes = append(rt.routes, RouteSpec{Tier: "authed", Pattern: pattern})
}

// Bearer registers a token-authenticated handler. Same auth-then-run
// contract as Authed, but resolves via the bearer resolver (token
// Manager). Panics when BearerResolver is unset, for the same
// startup-trip-rather-than-runtime-401 reason.
func (rt *Router) Bearer(pattern string, h BearerHandler) {
	if rt.bearer == nil {
		panic("api.Router: Bearer registered but RouterConfig.BearerResolver is nil")
	}
	rt.mux.Handle(pattern, rt.wrap(rt.bearer, "bearer", h))
	rt.routes = append(rt.routes, RouteSpec{Tier: "bearer", Pattern: pattern})
}

// Routes returns every route registered on this Router, in
// registration order. Tests / audit tooling enumerate the set to
// produce a CSV inventory of the authenticated surface.
//
// Returns a copy so the caller can't accidentally mutate the router's
// internal slice.
func (rt *Router) Routes() []RouteSpec {
	out := make([]RouteSpec, len(rt.routes))
	copy(out, rt.routes)
	return out
}

func (rt *Router) wrap(resolve Resolver, kind string, h AuthedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, err := resolve(r)
		if err != nil {
			// Credential present but rejected (bad cookie, expired
			// token). Log the cause for ops; the client gets a plain
			// 401 either way.
			rt.logger.InfoContext(r.Context(), "auth rejected",
				"kind", kind, "path", r.URL.Path, "err", err)
			rt.unauthorized(w, r, kind)
			return
		}
		if user == nil {
			rt.unauthorized(w, r, kind)
			return
		}
		ctx := auth.WithUser(r.Context(), user)
		if err := h(ctx, w, r, user); err != nil {
			rt.writeErr(w, r, err)
		}
	}
}

// unauthorized writes a 401 with the wire shape and, for bearer
// routes, a WWW-Authenticate header so generic HTTP clients (MCP
// SDKs, curl --negotiate, etc.) see the challenge per RFC 6750.
// Cookie-authed 401s don't need a WWW-Authenticate header — the SPA
// reads the JSON envelope directly.
func (rt *Router) unauthorized(w http.ResponseWriter, r *http.Request, kind string) {
	if kind == "bearer" {
		w.Header().Set("WWW-Authenticate", `Bearer realm="kitp"`)
	}
	rt.writeErr(w, r, ErrUnauthenticated)
}

func (rt *Router) wrapPublic(h PublicHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := h(r.Context(), w, r); err != nil {
			rt.writeErr(w, r, err)
		}
	}
}

// jsonErr is the wire shape. Matches reg.HandlerError's serialised
// form so clients see one envelope across dispatcher batches and
// direct HTTP routes.
type jsonErr struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (rt *Router) writeErr(w http.ResponseWriter, r *http.Request, err error) {
	// Order of checks:
	//   1. *HTTPError (sentinel or constructor) — most specific.
	//   2. *reg.HandlerError — bridge from the dispatcher's batch path
	//      so a handler that bubbles a HandlerError up to writeErr
	//      doesn't collapse to 500.
	//   3. Anything else — opaque internal error.
	var he *HTTPError
	if errors.As(err, &he) {
		if he.Err != nil {
			// Wrapped cause is for ops only — never on the wire.
			rt.logger.ErrorContext(r.Context(), "http handler error",
				"path", r.URL.Path, "code", he.Code, "status", he.Status, "err", he.Err)
		}
		writeJSON(w, he.Status, jsonErr{Code: he.Code, Message: he.Message})
		return
	}
	var ge *reg.HandlerError
	if errors.As(err, &ge) {
		writeJSON(w, regHandlerErrorStatus(ge), jsonErr{Code: ge.Code, Message: ge.Message})
		return
	}
	rt.logger.ErrorContext(r.Context(), "http handler error",
		"path", r.URL.Path, "code", "internal", "status", 500, "err", err)
	writeJSON(w, http.StatusInternalServerError, jsonErr{Code: "internal", Message: "internal error"})
}

// regHandlerErrorStatus maps the dispatcher's wire codes to HTTP
// statuses. The dispatcher itself uses 200 for everything (a batch
// can carry per-leaf errors), but when a HandlerError leaks into a
// direct HTTP route we want a sensible status. Unknown codes
// default to 500 so a future direct HTTP route that bubbles up an
// unrecognised `*reg.HandlerError` (e.g. one with a domain-specific
// code) renders as a server fault rather than a misleading 400 with
// a raw error string — see
// DI-9 in docs/DESIGN_INVARIANTS.md.
func regHandlerErrorStatus(e *reg.HandlerError) int {
	switch e.Code {
	case "unauthorized", "unauthenticated":
		return http.StatusUnauthorized
	case "forbidden":
		return http.StatusForbidden
	case "not_found", "card_not_found":
		return http.StatusNotFound
	case "conflict":
		return http.StatusConflict
	case "validation", "":
		return http.StatusBadRequest
	case "internal":
		return http.StatusInternalServerError
	default:
		return http.StatusInternalServerError
	}
}
