// Package usertoken exposes user_token.create / user_token.list /
// user_token.revoke. Tokens are opaque 32-byte base64url strings stored
// in the user_token table (`id` is the secret). The wire shape is
// designed so the secret never leaves the server except in the single
// create reply: list / revoke address rows by (user_id, label).
//
// Authz model (authzToken): you may list and revoke your own tokens, your
// agents' and — as a global admin — anyone's; you may mint a token for
// yourself or an agent you own, and a global admin also for a workspace
// agent (owned by System). Agents themselves cannot manage tokens —
// symmetric with the self-escalation guards on user_role and agent.*
// endpoints.
package usertoken

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/isodate"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// CreateInput is one row of user_token.create. label is required and
// must be unique per (user_id) — the (user_id, label) pair is the
// non-secret handle used by list and revoke.
type CreateInput struct {
	UserID    int64  `json:"user_id,string" mcp:"required,desc=user_account id the token authenticates as (typically an agent owned by the caller)"`
	Label     string `json:"label" mcp:"required,desc=human-readable label, unique per user (max 200 chars)"`
	ExpiresAt string `json:"expires_at,omitempty" mcp:"desc=optional RFC3339 timestamp at which the token stops working; at most KITP_TOKEN_MAX_DAYS (default 365) days ahead, which is also the default"`
	Scope     string `json:"scope,omitempty" mcp:"desc=what the token may do: omit / '' for full access (MCP and every bearer route), or 'links' for ONLY the forge link hook POST /api/v1/links (the credential a code forge such as Gerrit holds)"`
}

// maxDays caps a new token's lifetime (KITP_TOKEN_MAX_DAYS, SetMaxDays):
// one with no expires_at gets that many days, and a later one is refused.
// 0 lets tokens live for ever. Tokens minted before the cap keep the expiry
// they had (review 2026-11-03 round 4: tokens had no maximum lifetime).
var maxDays atomic.Int64

func init() { maxDays.Store(DefaultMaxDays) }

// DefaultMaxDays is the token lifetime cap when KITP_TOKEN_MAX_DAYS is unset.
const DefaultMaxDays = 365

// MaxMaxDays is the largest cap KITP_TOKEN_MAX_DAYS may set (100 years);
// kitpd refuses to start with a larger or negative one (CheckMaxDays).
const MaxMaxDays = 36500

// CheckMaxDays says whether n is a cap KITP_TOKEN_MAX_DAYS may set: 0 (no
// cap) to MaxMaxDays. A negative value lifted the cap silently and a huge
// one overflowed the duration (review 2026-11-03 round 5).
func CheckMaxDays(n int64) error {
	if n < 0 || n > MaxMaxDays {
		return fmt.Errorf("KITP_TOKEN_MAX_DAYS=%d: want 0 (no cap) to %d days", n, MaxMaxDays)
	}
	return nil
}

// SetMaxDays sets the cap; 0 lifts it. Out-of-range values are clamped
// (kitpd checks them first with CheckMaxDays).
func SetMaxDays(n int64) { maxDays.Store(min(max(n, 0), MaxMaxDays)) }

// preRunCreate applies the lifetime cap to each new token.
func preRunCreate(_ context.Context, _ store.Querier, ins []any) ([]any, error) {
	days := maxDays.Load()
	if days == 0 {
		return ins, nil
	}
	limit := time.Now().Add(time.Duration(days) * 24 * time.Hour)
	for i, raw := range ins {
		in := raw.(CreateInput)
		if strings.TrimSpace(in.ExpiresAt) == "" {
			in.ExpiresAt = limit.UTC().Format(time.RFC3339)
			ins[i] = in
			continue
		}
		// Parsed as the SQL function checks it (iso_timestamp_ok, which
		// takes a lower-case t and z): Go's RFC3339 layout refused those,
		// and a value this couldn't read used to skip the cap while the
		// SQL stored it (review 2026-11-03 round 5 #10). What doesn't
		// parse is refused here; what does is passed on in one form.
		at, err := isodate.ParseTimestamp(strings.TrimSpace(in.ExpiresAt))
		if err != nil {
			return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
				Message: "user_token.create: expires_at must be an RFC 3339 timestamp (e.g. 2026-12-31T00:00:00Z)"}
		}
		if at.After(limit) {
			return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
				Message: fmt.Sprintf("user_token.create: a token can last at most %d days", days)}
		}
		in.ExpiresAt = at.UTC().Format(time.RFC3339Nano)
		ins[i] = in
	}
	return ins, nil
}

// CreateOutput carries the secret bearer value — surfaced ONCE. The
// client MUST present it to the human immediately; the server cannot
// recover it later. Label round-trips so the UI can render a "your
// new token is ..." panel without juggling state across requests.
type CreateOutput struct {
	Token string `json:"token" mcp:"desc=opaque bearer value; shown ONCE, store immediately, cannot be recovered later"`
	Label string `json:"label" mcp:"desc=label echoed back for UI convenience"`
	Scope string `json:"scope" mcp:"desc=scope echoed back: '' (full access) or 'links'"`
}

// ListInput selects every token bound to UserID.
type ListInput struct {
	UserID int64 `json:"user_id,string" mcp:"required,desc=user_account id whose tokens to list"`
}

// ListRow is one row of the listing — never includes the bearer value.
type ListRow struct {
	Label      string  `json:"label" mcp:"desc=human-readable label"`
	Scope      string  `json:"scope" mcp:"desc='' (full access) or 'links' (forge link hook only)"`
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
		Doc:          "Mint an opaque bearer token bound to user_id. The plaintext value is returned ONCE in the response — store it immediately. scope 'links' mints a narrow token that works ONLY on the forge link hook (POST /api/v1/links), for a code forge; omit it for a full-access (MCP) token. Authz: your own token, one for an agent you own, or (global admin) one for a workspace agent owned by System — never one for another human or their agent.",
		InputType:    reflect.TypeFor[CreateInput](),
		OutputType:   reflect.TypeFor[CreateOutput](),
		Secret:       true,
		AllowedRoles: []string{reg.RoleAuthenticated},
		Authz:        authzCreate,
		PreRun:       preRunCreate,
		// Unified handler — body lives in
		// db/schema/functions/user_token_create_batch.sql per Phase 3
		// of docs/UNIFIED_HANDLER_PLAN.md.
		SQLFunc: "user_token_create_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "user_token",
		Action:       "list",
		Doc:          "List every token bound to user_id (label + timestamps; the secret value is never returned). Authz: the user themselves, their owner (for an agent), or a global admin.",
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
		Doc:          "Revoke one token by (user_id, label). Idempotent. Authz: the user themselves, their owner (for an agent), or a global admin.",
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

// tokenAccess says what the actor may do with target's tokens.
type tokenAccess int

const (
	// accessList: see and revoke them (labels and timestamps only).
	accessList tokenAccess = iota
	// accessMint: also mint new ones, which act as the target.
	accessMint
)

// authzToken checks the actor against target's tokens. Agents are always
// refused as actors.
//
//   - Listing and revoking: the target themselves, the target's owner
//     (parent_user_id), or a global admin.
//   - Minting: a token acts as its target, private cards included (an
//     agent sees its owner's — docs/PERSONAL_SCREENS.md P2). So: your own
//     token, a token for an agent you own, or — for a global admin — a
//     token for a workspace agent (owned by System). Never one for another
//     human, or for another human's agent (review 2026-11-03 #14).
func authzToken(ctx context.Context, targetUserID int64, want tokenAccess) error {
	pool, _ := authzPool.(*store.Pool)
	if pool == nil {
		return nil // tests
	}
	actor := auth.ActorOrSystem(ctx)
	b := named.New()
	b.Set("actor", actor)
	b.Set("target", targetUserID)
	q, args, err := b.Compile(`
		SELECT a.is_agent, t.is_agent, t.parent_user_id
		FROM user_account a, user_account t
		WHERE a.id = :actor AND t.id = :target
	`)
	if err != nil {
		return fmt.Errorf("user_token.authz: compile: %w", err)
	}
	var (
		actorIsAgent, targetIsAgent bool
		parentID                    *int64
	)
	if err := pool.P.QueryRow(ctx, q, args...).Scan(&actorIsAgent, &targetIsAgent, &parentID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &reg.HandlerError{Code: "not_found",
				Message: fmt.Sprintf("user_token: target user %d not found", targetUserID)}
		}
		return fmt.Errorf("user_token.authz: load users: %w", err)
	}
	if actorIsAgent {
		return &reg.HandlerError{Code: "forbidden",
			Message: fmt.Sprintf("user_token: agent actor %d cannot manage tokens", actor)}
	}
	if targetUserID == actor || (parentID != nil && *parentID == actor) {
		return nil
	}
	admin, err := auth.IsGlobalAdmin(ctx, pool.P, actor)
	if err != nil {
		return fmt.Errorf("user_token.authz: admin check: %w", err)
	}
	if admin && want == accessList {
		return nil
	}
	if admin && targetIsAgent && parentID != nil && *parentID == auth.SystemUserID {
		return nil
	}
	if admin {
		return &reg.HandlerError{Code: "forbidden",
			Message: fmt.Sprintf("user_token: a token for user %d would act as them; only they (or the agent's owner) can mint one", targetUserID)}
	}
	return &reg.HandlerError{Code: "forbidden",
		Message: fmt.Sprintf("user_token: actor %d is not user %d, its owner or a global admin", actor, targetUserID)}
}

func authzCreate(ctx context.Context, in any) error {
	row, ok := in.(CreateInput)
	if !ok {
		return nil
	}
	return authzToken(ctx, row.UserID, accessMint)
}

func authzList(ctx context.Context, in any) error {
	row, ok := in.(ListInput)
	if !ok {
		return nil
	}
	return authzToken(ctx, row.UserID, accessList)
}

func authzRevoke(ctx context.Context, in any) error {
	row, ok := in.(RevokeInput)
	if !ok {
		return nil
	}
	return authzToken(ctx, row.UserID, accessList)
}

// PreRunCreateForTest runs user_token.create's lifetime cap on ins.
func PreRunCreateForTest(ins []any) ([]any, error) { return preRunCreate(context.Background(), nil, ins) }
