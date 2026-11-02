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
// Roles are the caller's effective ones (auth.LoadRoleScopes: an agent
// uses only what its owner holds). A role held only on some projects
// passes the gate for handlers whose per-row pass then checks the target
// project; an admin-only handler with no project to check against (no
// CardTypeID + ProcessName, or GlobalScope) takes a workspace admin, so a
// project's admin can't reach workspace-wide admin surfaces (people,
// users, portals, themes, …).
//
// Permission failures here use the same `unauthorized` code as the
// per-handler ownership checks in reg.Unauthorized so callers see one
// canonical shape.
package api

import (
	"context"
	"fmt"

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
		set    map[string]bool // role name → held workspace-wide
		err    error
	}
	cache := rolesCache{}
	loadRoles := func() (map[string]bool, error) {
		if cache.loaded {
			return cache.set, cache.err
		}
		cache.loaded = true
		userID := auth.ActorOrSystem(ctx)
		cache.set, cache.err = auth.LoadRoleScopes(ctx, s.Pool.P, userID)
		return cache.set, cache.err
	}

	for _, p := range prepped {
		if err := s.checkLeafRoles(ctx, p.Handler, loadRoles); err != nil {
			// A deny is a curated *reg.HandlerError ("unauthorized");
			// a role-load failure is a wrapped internal error. errEnvelope
			// keeps the former and redacts the latter (A5 / SEC-2).
			s.abortWithError(ctx, slots, p.OuterIdx, "unauthorized", err)
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
	loadRoles func() (map[string]bool, error),
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
		// Internal failure — return raw so the dispatcher's errEnvelope
		// redacts it instead of shipping err.Error() (A5 / SEC-2).
		return fmt.Errorf("role gate: load roles for %s.%s: %w", h.Endpoint, h.Action, err)
	}
	workspaceOnly := needsWorkspaceAdmin(h)
	for _, r := range h.AllowedRoles {
		global, ok := have[r]
		if ok && (global || !workspaceOnly) {
			return nil
		}
	}
	if workspaceOnly {
		return reg.Unauthorized(
			"user %d is not a workspace admin, which %s.%s needs",
			user.ID, h.Endpoint, h.Action,
		)
	}
	return reg.Unauthorized(
		"user %d lacks any role in %v for %s.%s",
		user.ID, h.AllowedRoles, h.Endpoint, h.Action,
	)
}

// needsWorkspaceAdmin reports whether a handler is admin-only (every
// AllowedRoles entry is admin or system) with no project for the per-row
// pass to check: it has no CardTypeID + ProcessName, or is GlobalScope.
// Such a handler acts workspace-wide, so a role held only on some
// projects doesn't reach it.
func needsWorkspaceAdmin(h reg.Handler) bool {
	for _, r := range h.AllowedRoles {
		if r != "admin" && r != "system" {
			return false
		}
	}
	anchored := h.CardTypeID != nil && h.ProcessName != "" && !h.GlobalScope
	return !anchored
}
