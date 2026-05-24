// Package usertoken exposes user_token.create / user_token.list /
// user_token.revoke. Tokens are opaque 32-byte base64url strings stored
// in the user_token table (`id` is the secret). The wire shape is
// designed so the secret never leaves the server except in the single
// create reply: list / revoke address rows by (user_id, label).
//
// Authz model (mirrors the agent package): the calling user must be
// EITHER the target user_account's parent_user_id OR a global admin.
// Agents themselves cannot manage tokens — symmetric with the
// self-escalation guards on user_role and agent.* endpoints.
package usertoken

import (
	"context"
	"errors"
	"fmt"
	"reflect"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// CreateInput is one row of user_token.create. label is required and
// must be unique per (user_id) — the (user_id, label) pair is the
// non-secret handle used by list and revoke.
type CreateInput struct {
	UserID    int64  `json:"user_id,string" mcp:"required,desc=user_account id the token authenticates as (typically an agent owned by the caller)"`
	Label     string `json:"label" mcp:"required,desc=human-readable label, unique per user (max 200 chars)"`
	ExpiresAt string `json:"expires_at,omitempty" mcp:"desc=optional RFC3339 timestamp at which the token stops working"`
}

// CreateOutput carries the secret bearer value — surfaced ONCE. The
// client MUST present it to the human immediately; the server cannot
// recover it later. Label round-trips so the UI can render a "your
// new token is ..." panel without juggling state across requests.
type CreateOutput struct {
	Token string `json:"token" mcp:"desc=opaque bearer value; shown ONCE, store immediately, cannot be recovered later"`
	Label string `json:"label" mcp:"desc=label echoed back for UI convenience"`
}

// ListInput selects every token bound to UserID.
type ListInput struct {
	UserID int64 `json:"user_id,string" mcp:"required,desc=user_account id whose tokens to list"`
}

// ListRow is one row of the listing — never includes the bearer value.
type ListRow struct {
	Label      string  `json:"label" mcp:"desc=human-readable label"`
	CreatedAt  string  `json:"created_at" mcp:"desc=RFC3339 timestamp"`
	LastUsedAt string  `json:"last_used_at" mcp:"desc=RFC3339 timestamp; same value as created_at when never used"`
	ExpiresAt  *string `json:"expires_at,omitempty" mcp:"desc=RFC3339 timestamp; null when no hard expiry"`
	RevokedAt  *string `json:"revoked_at,omitempty" mcp:"desc=RFC3339 timestamp; null when still active"`
}

// ListOutput wraps the row list.
type ListOutput struct {
	Rows []ListRow `json:"rows" mcp:"desc=tokens bound to the requested user_account"`
}

// RevokeInput names one token by (user_id, label). Idempotent — a
// revoked or absent row reports Deleted=0 without error.
type RevokeInput struct {
	UserID int64  `json:"user_id,string" mcp:"required,desc=user_account id the token is bound to"`
	Label  string `json:"label" mcp:"required,desc=label of the token to revoke"`
}

// RevokeOutput reports how many rows transitioned to revoked (0 or 1).
type RevokeOutput struct {
	OK      bool `json:"ok" mcp:"desc=true if a row was revoked by this call"`
	Deleted int  `json:"deleted" mcp:"desc=number of rows transitioned to revoked (0 or 1)"`
}

// Register installs all three handlers.
func Register(p *store.Pool) {
	authzPool = p
	reg.Register(reg.Handler{
		Endpoint:     "user_token",
		Action:       "create",
		Doc:          "Mint an opaque bearer token bound to user_id. The plaintext value is returned ONCE in the response — store it immediately. Authz: caller is the target's parent_user_id, or a global admin.",
		InputType:    reflect.TypeFor[CreateInput](),
		OutputType:   reflect.TypeFor[CreateOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Authz:        authzCreate,
		// Unified handler — body lives in
		// db/schema/functions/user_token_create_batch.sql per Phase 3
		// of docs/UNIFIED_HANDLER_PLAN.md.
		SQLFunc: "user_token_create_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "user_token",
		Action:       "list",
		Doc:          "List every token bound to user_id (label + timestamps; the secret value is never returned). Authz: caller is the target's parent_user_id, or a global admin.",
		InputType:    reflect.TypeFor[ListInput](),
		OutputType:   reflect.TypeFor[ListOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Authz:        authzList,
		// Unified handler — body lives in
		// db/schema/functions/user_token_list_batch.sql per Phase 5 of
		// docs/UNIFIED_HANDLER_PLAN.md. Labels + timestamps ONLY; the
		// secret value is never surfaced after the create-time mint.
		SQLFunc: "user_token_list_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "user_token",
		Action:       "revoke",
		Doc:          "Revoke one token by (user_id, label). Idempotent. Authz: caller is the target's parent_user_id, or a global admin.",
		InputType:    reflect.TypeFor[RevokeInput](),
		OutputType:   reflect.TypeFor[RevokeOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Authz:        authzRevoke,
		// Unified handler — body lives in
		// db/schema/functions/user_token_revoke_batch.sql per Phase 3
		// of docs/UNIFIED_HANDLER_PLAN.md.
		SQLFunc: "user_token_revoke_batch",
	})
}

var authzPool any

// authzParentOrAdmin permits the call when the actor is the target's
// parent_user_id, or when the actor holds the global admin / system
// role. Agents are always rejected as actors. Shared by all three
// user_token endpoints — the input shape is whichever struct the
// caller's reflect.TypeFor[*] resolves to.
func authzParentOrAdmin(ctx context.Context, targetUserID int64) error {
	pool, _ := authzPool.(*store.Pool)
	if pool == nil {
		return nil // tests
	}
	actor := auth.ActorOrSystem(ctx)
	var actorIsAgent bool
	if err := pool.P.QueryRow(ctx,
		`SELECT is_agent FROM user_account WHERE id = $1`, actor,
	).Scan(&actorIsAgent); err != nil {
		return fmt.Errorf("user_token.authz: load actor: %w", err)
	}
	if actorIsAgent {
		return &reg.HandlerError{Code: "forbidden",
			Message: fmt.Sprintf("user_token: agent actor %d cannot manage tokens", actor)}
	}
	var parentID *int64
	if err := pool.P.QueryRow(ctx,
		`SELECT parent_user_id FROM user_account WHERE id = $1`, targetUserID,
	).Scan(&parentID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &reg.HandlerError{Code: "not_found",
				Message: fmt.Sprintf("user_token: target user %d not found", targetUserID)}
		}
		return fmt.Errorf("user_token.authz: load target: %w", err)
	}
	if parentID != nil && *parentID == actor {
		return nil
	}
	var n int
	if err := pool.P.QueryRow(ctx, `
		SELECT count(*) FROM user_role ur JOIN role r ON r.id = ur.role_id
		WHERE ur.user_id = $1 AND r.name IN ('admin','system') AND ur.scope_card_id IS NULL
	`, actor).Scan(&n); err != nil {
		return fmt.Errorf("user_token.authz: admin check: %w", err)
	}
	if n == 0 {
		return &reg.HandlerError{Code: "forbidden",
			Message: fmt.Sprintf("user_token: actor %d is neither parent of %d nor a global admin", actor, targetUserID)}
	}
	return nil
}

func authzCreate(ctx context.Context, in any) error {
	row, ok := in.(CreateInput)
	if !ok {
		return nil
	}
	return authzParentOrAdmin(ctx, row.UserID)
}

func authzList(ctx context.Context, in any) error {
	row, ok := in.(ListInput)
	if !ok {
		return nil
	}
	return authzParentOrAdmin(ctx, row.UserID)
}

func authzRevoke(ctx context.Context, in any) error {
	row, ok := in.(RevokeInput)
	if !ok {
		return nil
	}
	return authzParentOrAdmin(ctx, row.UserID)
}


