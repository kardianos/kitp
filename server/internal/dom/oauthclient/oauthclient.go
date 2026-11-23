// Package oauthclient exposes oauth_client.list / .set / .delete: the
// OAuth clients kitp trusts to sign members in to MCP (docs/MCP_OAUTH.md).
// A client — Claude, Claude Code — names itself with a client_id that is
// the HTTPS address of its published details; kitp fetches those only for
// a client_id an admin allows here, exactly or by a prefix ending in /. A
// member refused for a client asks an administrator (internal/auth/oauth),
// which records the request on a row here; an admin allows it on the
// workspace "MCP apps" screen.
//
// Authz: every action is for global admins. The list names the members who
// asked; set and delete decide which apps can get agent tokens.
package oauthclient

import (
	"context"
	"fmt"
	"reflect"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// ListInput is empty.
type ListInput struct{}

// ListRow is one trusted client, or one members asked for.
type ListRow struct {
	ID              int64   `json:"id,string" mcp:"desc=row id"`
	ClientID        string  `json:"client_id" mcp:"desc=an exact client_id (the https address a client publishes its details at), or a prefix ending in / covering every client_id under it"`
	Covers          string  `json:"covers" mcp:"desc=This client only, or Every client published under this address (a prefix)"`
	Allowed         bool    `json:"allowed" mcp:"desc=true when kitp trusts it"`
	Waiting         bool    `json:"waiting" mcp:"desc=true when a member asked for it after the last admin decision and it isn't allowed"`
	Status          string  `json:"status" mcp:"desc=Allowed, Waiting for an admin, or Not allowed"`
	RedirectURI     string  `json:"redirect_uri" mcp:"desc=where the app last asked to return a member to"`
	RequestedBy     *int64  `json:"requested_by,string,omitempty" mcp:"desc=user_account id of the member who asked last"`
	RequestedByName string  `json:"requested_by_name" mcp:"desc=that member's name"`
	RequestedAt     *string `json:"requested_at,omitempty" mcp:"desc=RFC 3339 time of the last request"`
	RequestCount    int     `json:"request_count" mcp:"desc=how many times members asked for it"`
	DecidedByName   string  `json:"decided_by_name" mcp:"desc=the admin who last allowed or disallowed it"`
	DecidedAt       *string `json:"decided_at,omitempty" mcp:"desc=RFC 3339 time of that decision"`
	RequestNote     string  `json:"request_note" mcp:"desc=who asked and when, or who disallowed it, on a row that isn't allowed; empty when allowed"`
	AllowedNote     string  `json:"allowed_note" mcp:"desc=who allowed it and when; empty when not allowed"`
}

// ListOutput wraps the rows.
type ListOutput struct {
	Rows []ListRow `json:"rows" mcp:"desc=every row, waiting requests first"`
}

// SetInput allows or disallows one client, named by id or by client_id.
type SetInput struct {
	ID       int64  `json:"id,string,omitempty" mcp:"desc=row id from oauth_client.list; omit to name the client_id instead"`
	ClientID string `json:"client_id,omitempty" mcp:"desc=the https client_id to allow or disallow (added when not listed), or a prefix ending in / to cover every client under it; used when id is omitted"`
	Allowed  bool   `json:"allowed" mcp:"required,desc=true to trust it, false to stop (its connections end at their next refresh)"`
}

// SetOutput echoes the row.
type SetOutput struct {
	ID       int64  `json:"id,string" mcp:"desc=row id"`
	ClientID string `json:"client_id" mcp:"desc=the client_id as stored (scheme and host lower-cased)"`
	Allowed  bool   `json:"allowed" mcp:"desc=its allowed state now"`
}

// DeleteInput names one row.
type DeleteInput struct {
	ID int64 `json:"id,string" mcp:"required,desc=row id to remove"`
}

// DeleteOutput reports whether a row went.
type DeleteOutput struct {
	OK      bool `json:"ok" mcp:"desc=true if a row was deleted"`
	Deleted int  `json:"deleted" mcp:"desc=rows deleted (0 or 1)"`
}

// Register installs the three handlers.
func Register(p *store.Pool) {
	authzPool = p
	reg.Register(reg.Handler{
		Endpoint:     "oauth_client",
		Action:       "list",
		Doc:          "Admin: list the OAuth clients kitp trusts to sign members in to MCP (apps such as Claude), and members' requests for ones it doesn't, with who asked.",
		InputType:    reflect.TypeFor[ListInput](),
		OutputType:   reflect.TypeFor[ListOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		SQLFunc:      "oauth_client_list_batch",
		IsRead:       true,
	})
	reg.Register(reg.Handler{
		Endpoint:     "oauth_client",
		Action:       "set",
		Doc:          "Admin: allow (allowed true) or stop allowing (false) an MCP app's OAuth client, by row id or by client_id (exact, or a prefix ending in /). Disallowing ends its connections at their next refresh.",
		InputType:    reflect.TypeFor[SetInput](),
		OutputType:   reflect.TypeFor[SetOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		SQLFunc:      "oauth_client_set_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "oauth_client",
		Action:       "delete",
		Doc:          "Admin: remove an OAuth client row by id. It is then untrusted, as if disallowed.",
		InputType:    reflect.TypeFor[DeleteInput](),
		OutputType:   reflect.TypeFor[DeleteOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		SQLFunc:      "oauth_client_delete_batch",
	})
}

var authzPool *store.Pool

// authzAdmin: the actor must hold admin globally. Mirrors
// dom/rolemapping.authzAdmin.
func authzAdmin(ctx context.Context, _ any) error {
	if authzPool == nil {
		return nil
	}
	userID := auth.ActorOrSystem(ctx)
	admin, err := auth.IsGlobalAdmin(ctx, authzPool.P, userID)
	if err != nil {
		return fmt.Errorf("oauth_client.authz: %w", err)
	}
	if !admin {
		return fmt.Errorf("oauth_client: actor %d is not a global admin", userID)
	}
	return nil
}
