// File api/role_gate.go: declarative role gate for the dispatcher.
//
// Each Handler declares an AllowedRoles list at register time. The gate
// loads the calling user's roles once per HTTP request and rejects any
// sub-request whose handler doesn't share at least one role with the
// caller.
//
// Two sentinel role names short-circuit the check:
//
//   - reg.RolePublic        — no login required (echo / health).
//   - reg.RoleAuthenticated — any signed-in user.
//
// The seeded `system` role is hard-coded as a wildcard so dev-mode
// (AUTH_MODE=off, System User) keeps reaching every endpoint without
// having to list `"system"` in every handler.
//
// Permission failures here use the same `unauthorized` code as the
// per-handler ownership checks in reg.Unauthorized so callers see one
// canonical shape.
package api

import (
	"context"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/reg"
)

// runRoleGate checks every prepared leaf against the caller's roles.
// Loads roles once per HTTP request; subsequent batches in the same
// process pay one DB round-trip and a constant-time map check per leaf.
//
// Returns a non-nil error and writes the offending slot when the gate
// rejects, mirroring runAuthzPass's contract.
func (s *Server) runRoleGate(ctx context.Context, prepped []prepared, slots []SubResponse) error {
	if len(prepped) == 0 {
		return nil
	}

	// Resolve the user-roles set lazily: a batch made up entirely of
	// $public handlers (e.g. an MCP tool listing call) shouldn't pay for
	// a DB round-trip.
	type rolesCache struct {
		loaded bool
		set    map[string]struct{}
		err    error
	}
	cache := rolesCache{}
	loadRoles := func() (map[string]struct{}, error) {
		if cache.loaded {
			return cache.set, cache.err
		}
		cache.loaded = true
		userID := auth.ActorOrSystem(ctx)
		names, err := auth.LoadUserRoles(ctx, s.Pool.P, userID)
		if err != nil {
			cache.err = err
			return nil, err
		}
		cache.set = make(map[string]struct{}, len(names))
		for _, n := range names {
			cache.set[n] = struct{}{}
		}
		return cache.set, nil
	}

	for _, p := range prepped {
		if err := s.checkLeafRoles(ctx, p.Handler, loadRoles); err != nil {
			he, _ := err.(*reg.HandlerError)
			code := "unauthorized"
			msg := err.Error()
			if he != nil && he.Code != "" {
				code = he.Code
				msg = he.Message
			}
			abortAll(slots, p.OuterIdx, code, msg)
			return err
		}
	}
	return nil
}

// checkLeafRoles applies the AllowedRoles list of one handler. Returns
// nil on allow, *reg.HandlerError on deny.
func (s *Server) checkLeafRoles(
	ctx context.Context,
	h reg.Handler,
	loadRoles func() (map[string]struct{}, error),
) error {
	// 1. $public: skip everything (login + role).
	for _, r := range h.AllowedRoles {
		if r == reg.RolePublic {
			return nil
		}
	}

	// 2. Login required for anything past this point.
	user, ok := auth.FromContext(ctx)
	if !ok || user == nil || user.ID == 0 {
		return reg.Unauthorized("login required for %s.%s", h.Endpoint, h.Action)
	}

	// 3. $authenticated: any signed-in user passes without a role lookup.
	for _, r := range h.AllowedRoles {
		if r == reg.RoleAuthenticated {
			return nil
		}
	}

	// 4. Otherwise we need at least one of the declared roles. The
	//    seeded System user holds admin + manager + worker explicitly
	//    (see db/schema/seed.hcsv) so no wildcard short-circuit is
	//    needed — dev-mode and prod resolve through identical paths.
	have, err := loadRoles()
	if err != nil {
		return &reg.HandlerError{Code: "internal", Message: err.Error()}
	}
	for _, r := range h.AllowedRoles {
		if _, ok := have[r]; ok {
			return nil
		}
	}
	return reg.Unauthorized(
		"user %d lacks any role in %v for %s.%s",
		user.ID, h.AllowedRoles, h.Endpoint, h.Action,
	)
}

