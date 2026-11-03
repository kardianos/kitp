package mailin

import (
	"context"
	"fmt"
	"reflect"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// RouteListInput lists one mail account's inbound routes.
type RouteListInput struct {
	ChannelID int64 `json:"channel_id,string" mcp:"required,desc=the mail account (comm_channel card id)"`
}

// RouteRow is one inbound route. The token itself is never stored, so it
// can't be listed; hint is its first characters.
type RouteRow struct {
	ID            int64  `json:"id,string" mcp:"desc=route id (card_access row); the Comm log's route_id"`
	ChannelID     int64  `json:"channel_id,string" mcp:"desc=the mail account"`
	Purpose       string `json:"purpose" mcp:"desc=inbound_post (a URL providers POST to) or inbound_smtp (an address for the SMTP listener)"`
	Provider      string `json:"provider" mcp:"desc=inbound_post: raw / mailgun / postmark"`
	Comment       string `json:"comment" mcp:"desc=what the route is for"`
	Hint          string `json:"hint" mcp:"desc=the token's first 6 characters"`
	Policy        Policy `json:"policy" mcp:"desc=the route's filters"`
	HasSigningKey bool   `json:"has_signing_key" mcp:"desc=Mailgun: whether the webhook signing key is set"`
	CreatedAt     string `json:"created_at" mcp:"desc=RFC 3339"`
	LastUsedAt    string `json:"last_used_at" mcp:"desc=RFC 3339 time of the last message; empty when none"`
	LastClient    string `json:"last_client" mcp:"desc=the address the last message came from"`
	LastError     string `json:"last_error" mcp:"desc=the last refusal or failure; empty when none"`
	LastErrorAt   string `json:"last_error_at" mcp:"desc=RFC 3339; empty when none"`
}

// RouteListOutput wraps the rows.
type RouteListOutput struct {
	Routes []RouteRow `json:"routes" mcp:"desc=newest first"`
}

// RouteCreateInput adds a route.
type RouteCreateInput struct {
	ChannelID  int64   `json:"channel_id,string" mcp:"required,desc=the mail account"`
	Purpose    string  `json:"purpose" mcp:"required,desc=inbound_post or inbound_smtp"`
	Provider   string  `json:"provider,omitempty" mcp:"desc=inbound_post: raw (Cloudflare Worker, SES via Lambda, scripts), mailgun or postmark"`
	Comment    string  `json:"comment,omitempty" mcp:"desc=what it is for, e.g. 'Mailgun route' or 'Exchange forward'"`
	Policy     *Policy `json:"policy,omitempty" mcp:"desc=filters: sources, require_tls, sender_hosts, envelope_from, header_from, dkim"`
	SigningKey string  `json:"signing_key,omitempty" mcp:"desc=Mailgun only (required): the HTTP webhook signing key"`
}

// RouteCreateOutput carries the secret token — shown ONCE.
type RouteCreateOutput struct {
	ID       int64  `json:"id,string" mcp:"desc=route id"`
	Token    string `json:"token" mcp:"desc=the secret: POST to /api/v1/comm/inbound/<token> (Mailgun: …/<token>/mime), or mail <token>@<smtp domain>; not shown again"`
	Hint     string `json:"hint" mcp:"desc=the token's first 6 characters"`
	Purpose  string `json:"purpose" mcp:"desc=as given"`
	Provider string `json:"provider" mcp:"desc=as given"`
}

// RouteUpdateInput changes a route; absent fields are left alone.
type RouteUpdateInput struct {
	ID         int64   `json:"id,string" mcp:"required,desc=route id"`
	Comment    *string `json:"comment,omitempty" mcp:"desc=new comment"`
	Policy     *Policy `json:"policy,omitempty" mcp:"desc=new filters (replaces them all)"`
	SigningKey *string `json:"signing_key,omitempty" mcp:"desc=Mailgun: a new signing key"`
}

// RouteDeleteInput removes a route.
type RouteDeleteInput struct {
	ID int64 `json:"id,string" mcp:"required,desc=route id"`
}

// RouteIDOutput echoes the route.
type RouteIDOutput struct {
	ID int64 `json:"id,string" mcp:"desc=route id"`
}

var authzPool *store.Pool

// authzAdmin: mail accounts are workspace-admin settings (as comm_channel.*).
func authzAdmin(ctx context.Context, _ any) error {
	if authzPool == nil {
		return nil
	}
	userID := auth.ActorOrSystem(ctx)
	admin, err := auth.IsGlobalAdmin(ctx, authzPool.P, userID)
	if err != nil {
		return fmt.Errorf("mailin.authz: %w", err)
	}
	if !admin {
		return fmt.Errorf("mailin: actor %d is not an admin", userID)
	}
	return nil
}

// Register wires comm_route.* (the routes) and mail_intake.status.
func Register(p *store.Pool, status *Status) {
	authzPool = p
	reg.Register(reg.Handler{
		Endpoint:     "comm_route",
		Action:       "list",
		Doc:          "Admin: a mail account's inbound routes — POST URLs and SMTP addresses — with their comment, filters, and last message / refusal. Filter the Comm log by route_id to see a route's traffic.",
		InputType:    reflect.TypeFor[RouteListInput](),
		OutputType:   reflect.TypeFor[RouteListOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		IsRead:       true,
		SQLFunc:      "comm_route_list_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "comm_route",
		Action:       "create",
		Doc:          "Admin: add an inbound route to a mail account — a POST URL for a provider (raw: Cloudflare Email Worker / SES via Lambda / scripts; mailgun: needs the webhook signing key; postmark: turn on 'include raw email') or an address for kitp's SMTP listener. Returns the secret token once.",
		InputType:    reflect.TypeFor[RouteCreateInput](),
		OutputType:   reflect.TypeFor[RouteCreateOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		SQLFunc:      "comm_route_create_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "comm_route",
		Action:       "update",
		Doc:          "Admin: change an inbound route's comment, filters or Mailgun signing key.",
		InputType:    reflect.TypeFor[RouteUpdateInput](),
		OutputType:   reflect.TypeFor[RouteIDOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		SQLFunc:      "comm_route_update_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "comm_route",
		Action:       "delete",
		Doc:          "Admin: remove an inbound route; its URL or address stops working at once.",
		InputType:    reflect.TypeFor[RouteDeleteInput](),
		OutputType:   reflect.TypeFor[RouteIDOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		SQLFunc:      "comm_route_delete_batch",
	})
	registerStatus(status)
}
