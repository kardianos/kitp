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
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"reflect"
	"time"

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
		Run:          runCreate(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "user_token",
		Action:       "list",
		Doc:          "List every token bound to user_id (label + timestamps; the secret value is never returned). Authz: caller is the target's parent_user_id, or a global admin.",
		InputType:    reflect.TypeFor[ListInput](),
		OutputType:   reflect.TypeFor[ListOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Authz:        authzList,
		Run:          runList(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "user_token",
		Action:       "revoke",
		Doc:          "Revoke one token by (user_id, label). Idempotent. Authz: caller is the target's parent_user_id, or a global admin.",
		InputType:    reflect.TypeFor[RevokeInput](),
		OutputType:   reflect.TypeFor[RevokeOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Authz:        authzRevoke,
		Run:          runRevoke(p),
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
		if err == pgx.ErrNoRows {
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

// runCreate mints one token per input. Each insert is its own
// statement (32 random bytes are generated per row; pgx can't share a
// jsonb_to_recordset path with crypto/rand cheaply). The handler
// remains coalesced at the batch envelope level — N create requests
// in one batch arrive as one runCreate call.
func runCreate(_ *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(CreateInput)
			if in.Label == "" {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "user_token.create: label is required"}
			}
			var expires *time.Time
			if in.ExpiresAt != "" {
				t, err := time.Parse(time.RFC3339, in.ExpiresAt)
				if err != nil {
					return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
						Message: fmt.Sprintf("user_token.create: bad expires_at: %v", err)}
				}
				expires = &t
			}
			id, err := newTokenID()
			if err != nil {
				return nil, fmt.Errorf("user_token.create: %w", err)
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO user_token (id, user_id, label, expires_at)
				VALUES ($1, $2, $3, $4)
			`, id, in.UserID, in.Label, expires); err != nil {
				return nil, fmt.Errorf("user_token.create: insert: %w", err)
			}
			outs[i] = CreateOutput{Token: id, Label: in.Label}
		}
		return outs, nil
	}
}

func runList(_ *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(ListInput)
			rows, err := tx.Query(ctx, `
				SELECT label, created_at, last_used_at, expires_at, revoked_at
				FROM user_token
				WHERE user_id = $1
				ORDER BY created_at DESC
			`, in.UserID)
			if err != nil {
				return nil, fmt.Errorf("user_token.list: %w", err)
			}
			var out ListOutput
			for rows.Next() {
				var r ListRow
				var createdAt, lastUsedAt time.Time
				var expiresAt, revokedAt *time.Time
				if err := rows.Scan(&r.Label, &createdAt, &lastUsedAt, &expiresAt, &revokedAt); err != nil {
					rows.Close()
					return nil, err
				}
				r.CreatedAt = createdAt.Format(time.RFC3339)
				r.LastUsedAt = lastUsedAt.Format(time.RFC3339)
				if expiresAt != nil {
					s := expiresAt.Format(time.RFC3339)
					r.ExpiresAt = &s
				}
				if revokedAt != nil {
					s := revokedAt.Format(time.RFC3339)
					r.RevokedAt = &s
				}
				out.Rows = append(out.Rows, r)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return nil, err
			}
			outs[i] = out
		}
		return outs, nil
	}
}

func runRevoke(_ *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(RevokeInput)
			tag, err := tx.Exec(ctx, `
				UPDATE user_token SET revoked_at = now()
				WHERE user_id = $1 AND label = $2 AND revoked_at IS NULL
			`, in.UserID, in.Label)
			if err != nil {
				return nil, fmt.Errorf("user_token.revoke: %w", err)
			}
			n := int(tag.RowsAffected())
			outs[i] = RevokeOutput{OK: n > 0, Deleted: n}
		}
		return outs, nil
	}
}

// newTokenID returns 32 random bytes base64url-encoded. Same shape as
// session.id / token.newTokenID — nothing meaningful embedded.
func newTokenID() (string, error) {
	var buf [32]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf[:]), nil
}

// Encoding helpers for tests / introspection. Not used at runtime but
// keep the json import live so `go vet` doesn't grumble in future
// edits.
var _ = json.Marshal
