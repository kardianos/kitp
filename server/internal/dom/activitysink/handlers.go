// Package activitysink exposes the CRUD handlers + pump worker for
// activity_sink and activity_subscription cards — kitp's outbound
// notification surface.
//
// An activity_sink is a project-scoped card naming a destination for the
// project's activity stream:
//
//   - sink_kind 'msgraph_teams' — a BROADCAST sink posting into one Teams
//     channel (admin-configured filters + rollup on the sink itself).
//   - sink_kind 'email' — a PERSONAL sink: it names a project
//     comm_channel (channel_ref) whose mailbox sends; each project member
//     opts in by creating their own activity_subscription card under it
//     (event filter + card filter + rollup_minutes), and the sink's own
//     filters act as an admin ceiling.
//
// The pump (pumper.go) runs one worker per delivery unit (broadcast sink
// or subscription), scans new activity rows past the unit's position,
// filters, rolls matches up for rollup_minutes, and delivers a digest
// grouped by task (digest.go, deliver.go). State (position, rollup clock,
// last error) lives in activity_sink_state — not on the card — so pointer
// advance does not write back into the activity stream being read.
//
// Authz: activity_sink.* is admin-only, mirroring the comm_channel
// surface (the install seed gates activity_sink card.* on the admin
// role; the handler-level guard restates that). client_secret is
// encrypted at rest via pgcrypto with the same KITP_COMM_SECRET_KEY
// GUC the comm subsystem uses — keeping a single secret-key surface.
// activity_subscription.* is open to every project tier through
// dedicated processes; the SQL enforces "your own subscription only"
// (admins exempt), and generic card.* on the card_type stays admin-only.
package activitysink

import (
	"context"
	"fmt"
	"reflect"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// ---- sink.set ----

// SinkSetInput is the wire payload for activity_sink.set. ID=0 inserts;
// non-zero updates an existing sink under the same project. Fields
// left at the zero value are skipped on update (PATCH semantics);
// ClientSecret is a *string so omit-vs-clear is distinguishable.
type SinkSetInput struct {
	ID                  int64   `json:"id,string,omitempty" mcp:"desc=existing activity_sink card id to update; omit / 0 to insert a new sink"`
	ProjectID           int64   `json:"project_id,string" mcp:"required,desc=project card id this sink lives under (parent_card_id)"`
	Name                string  `json:"name" mcp:"required,desc=human-readable sink name (stored as the card's title)"`
	SinkKind            string  `json:"sink_kind" mcp:"required,desc=sink kind; 'msgraph_teams' (broadcast to a Teams channel) or 'email' (personal subscriptions mailed through a comm channel)"`
	MSGraphTenantID     string  `json:"msgraph_tenant_id,omitempty" mcp:"desc=Azure AD tenant id (GUID) for the MS Graph app"`
	MSGraphClientID     string  `json:"msgraph_client_id,omitempty" mcp:"desc=Azure app registration client_id"`
	MSGraphClientSecret *string `json:"msgraph_client_secret,omitempty" mcp:"desc=Azure app client_secret; omit to leave unchanged on update; stored encrypted via pgcrypto"`
	MSGraphTeamID       string  `json:"msgraph_team_id,omitempty" mcp:"desc=Teams team id (group id GUID) to post into"`
	MSGraphChannelID    string  `json:"msgraph_channel_id,omitempty" mcp:"desc=Teams channel id (within the team) to post into"`
	// ActivityFilter / CardFilter / RollupMinutes are pointers so omit
	// (leave unchanged) and clear ('' / 0) stay distinguishable on the
	// JSONB the dispatcher hands the SQL function.
	ActivityFilter *string `json:"activity_filter,omitempty" mcp:"desc=JSON event predicate restricting which activity rows are delivered; '' clears (= every row); omit to leave unchanged. See dom/activitysink/predicate.go for shape."`
	CardFilter     *string `json:"card_filter,omitempty" mcp:"desc=JSON card predicate tree (the screen filter shape) the activity's task must match; '' clears; omit to leave unchanged. For email sinks it is an admin ceiling ANDed into every subscription."`
	RollupMinutes  *int    `json:"rollup_minutes,omitempty" mcp:"desc=hold matches this many minutes (0-1440) and deliver them as one digest; 0 = next tick; omit to leave unchanged. Teams sinks only — email subscriptions carry their own."`
	ChannelID      int64   `json:"channel_id,string,omitempty" mcp:"desc=comm_channel card id (same project) an email sink sends through; required when creating an email sink; omit to leave unchanged"`
	Status         string  `json:"channel_status,omitempty" mcp:"desc=tri-state status; one of 'enabled' | 'disabled-admin' | 'disabled-fault'; empty leaves the stored value unchanged"`
}

// SinkSetOutput surfaces the sink card id so callers can chain.
type SinkSetOutput struct {
	SinkID int64 `json:"sink_id,string" mcp:"desc=id of the created or updated activity_sink card"`
}

// ---- sink.list ----

// SinkListInput filters sinks by project. Required.
type SinkListInput struct {
	ProjectID int64 `json:"project_id,string" mcp:"required,desc=project card id whose sinks to list"`
}

// SinkRow is one activity_sink card. The encrypted secret is not
// returned; HasClientSecret tells the admin UI whether one is stored.
// LastActivityID / LastPushedAt / LastError come from the state table.
type SinkRow struct {
	ID                int64  `json:"id,string" mcp:"desc=activity_sink card id"`
	Name              string `json:"name" mcp:"desc=display name (title attribute)"`
	SinkKind          string `json:"sink_kind" mcp:"desc=sink kind"`
	MSGraphTenantID   string `json:"msgraph_tenant_id" mcp:"desc=Azure tenant id"`
	MSGraphClientID   string `json:"msgraph_client_id" mcp:"desc=Azure app client_id"`
	MSGraphTeamID     string `json:"msgraph_team_id" mcp:"desc=Teams team id"`
	MSGraphChannelID  string `json:"msgraph_channel_id" mcp:"desc=Teams channel id"`
	ActivityFilter    string `json:"activity_filter" mcp:"desc=stored JSON predicate; empty when unfiltered"`
	Status            string `json:"channel_status" mcp:"desc=tri-state status"`
	FaultReason       string `json:"channel_fault_reason,omitempty" mcp:"desc=free-form reason set by the runtime when status='disabled-fault'"`
	HasClientSecret   bool   `json:"has_client_secret" mcp:"desc=true if an encrypted client_secret is stored"`
	LastActivityID    int64  `json:"last_activity_id,string" mcp:"desc=largest activity.id this sink has successfully pushed; 0 means nothing pushed yet"`
	LastPushedAt      string `json:"last_pushed_at,omitempty" mcp:"desc=RFC3339 timestamp of the most recent successful push; empty when never pushed"`
	LastPushedCount   int64  `json:"last_pushed_count,string" mcp:"desc=cumulative number of activity rows pushed downstream by this sink"`
	LastError         string `json:"last_error,omitempty" mcp:"desc=most recent push error reported by the pump; cleared on the next successful push"`
	CreatedAt         string `json:"created_at" mcp:"desc=RFC3339 creation timestamp of the sink card"`
	ChannelID         int64  `json:"channel_id,string" mcp:"desc=comm_channel an email sink sends through; 0 when unset"`
	ChannelName       string `json:"channel_name" mcp:"desc=title of that comm_channel"`
	RollupMinutes     int    `json:"rollup_minutes" mcp:"desc=rollup window in minutes (Teams sinks)"`
	CardFilter        string `json:"card_filter" mcp:"desc=stored JSON card predicate tree; empty when unfiltered"`
	SubscriptionCount int64  `json:"subscription_count" mcp:"desc=live activity_subscription cards under this sink"`
	PendingSince      string `json:"pending_since,omitempty" mcp:"desc=RFC3339 start of the running rollup window; empty when none"`
}

// SinkListOutput wraps rows in a stable envelope.
type SinkListOutput struct {
	Rows []SinkRow `json:"rows" mcp:"desc=activity_sink cards under the project"`
}

// ---- activity_subscription.set ----

// SubscriptionSetInput is the wire payload for activity_subscription.set.
// ID=0 creates a subscription for the CALLER under SinkID (an email
// sink); non-zero updates one of the caller's own. The subscriber is
// never on the wire. Pointer fields: present → written, absent →
// unchanged (create defaults: ”, ”, 0, enabled).
type SubscriptionSetInput struct {
	ID             int64   `json:"id,string,omitempty" mcp:"desc=existing activity_subscription id to update; omit / 0 to create"`
	SinkID         int64   `json:"sink_id,string,omitempty" mcp:"desc=email activity_sink to subscribe under; required on create (see activity_subscription.sinks)"`
	Name           *string `json:"name,omitempty" mcp:"desc=subscription display name; required on create"`
	ActivityFilter *string `json:"activity_filter,omitempty" mcp:"desc=JSON event predicate (dom/activitysink/predicate.go); '' = every event"`
	CardFilter     *string `json:"card_filter,omitempty" mcp:"desc=JSON card predicate tree (screen filter shape; '@me' = you) the activity's task must match; '' = every card"`
	RollupMinutes  *int    `json:"rollup_minutes,omitempty" mcp:"desc=minutes (0-1440) to collect matches before mailing one digest; 0 = next pump tick"`
	Enabled        *bool   `json:"enabled,omitempty" mcp:"desc=false pauses the subscription; true resumes it (and clears a fault)"`
}

// SubscriptionSetOutput surfaces the subscription card id.
type SubscriptionSetOutput struct {
	SubscriptionID int64 `json:"subscription_id,string" mcp:"desc=id of the created or updated activity_subscription card"`
}

// ---- activity_subscription.delete ----

// SubscriptionDeleteInput names one of the caller's subscriptions.
type SubscriptionDeleteInput struct {
	ID int64 `json:"id,string" mcp:"required,desc=activity_subscription id to delete"`
}

// SubscriptionDeleteOutput acknowledges the soft-delete.
type SubscriptionDeleteOutput struct {
	Deleted bool `json:"deleted" mcp:"desc=true once the subscription is deleted"`
}

// ---- activity_subscription.list ----

// SubscriptionListInput optionally narrows to one project.
type SubscriptionListInput struct {
	ProjectID int64 `json:"project_id,string,omitempty" mcp:"desc=only subscriptions in this project; omit for all"`
}

// SubscriptionRow is one of the caller's subscriptions + delivery state.
type SubscriptionRow struct {
	ID              int64  `json:"id,string" mcp:"desc=activity_subscription card id"`
	Name            string `json:"name" mcp:"desc=subscription display name"`
	SinkID          int64  `json:"sink_id,string" mcp:"desc=parent email activity_sink"`
	SinkName        string `json:"sink_name" mcp:"desc=parent sink title"`
	SinkStatus      string `json:"sink_status" mcp:"desc=parent sink channel_status; deliveries pause unless 'enabled'"`
	ProjectID       int64  `json:"project_id,string" mcp:"desc=project the sink lives in"`
	ProjectName     string `json:"project_name" mcp:"desc=project title"`
	ChannelName     string `json:"channel_name" mcp:"desc=comm_channel the mail goes out through"`
	ActivityFilter  string `json:"activity_filter" mcp:"desc=stored JSON event predicate; empty = every event"`
	CardFilter      string `json:"card_filter" mcp:"desc=stored JSON card predicate tree; empty = every card"`
	RollupMinutes   int    `json:"rollup_minutes" mcp:"desc=rollup window in minutes"`
	Status          string `json:"channel_status" mcp:"desc=enabled | disabled-admin (paused) | disabled-fault"`
	FaultReason     string `json:"channel_fault_reason,omitempty" mcp:"desc=why the pump faulted the subscription"`
	LastPushedAt    string `json:"last_pushed_at,omitempty" mcp:"desc=RFC3339 time of the last delivered digest"`
	LastPushedCount int64  `json:"last_pushed_count,string" mcp:"desc=cumulative events delivered"`
	LastError       string `json:"last_error,omitempty" mcp:"desc=most recent delivery error"`
	PendingSince    string `json:"pending_since,omitempty" mcp:"desc=RFC3339 start of the running rollup window"`
	CreatedAt       string `json:"created_at" mcp:"desc=RFC3339 creation time"`
}

// SubscriptionListOutput wraps rows in a stable envelope.
type SubscriptionListOutput struct {
	Rows []SubscriptionRow `json:"rows" mcp:"desc=the caller's subscriptions"`
}

// ---- activity_subscription.sinks ----

// SubscriptionSinksInput takes no fields.
type SubscriptionSinksInput struct{}

// SubscribableSink is one email sink the caller may subscribe under.
type SubscribableSink struct {
	SinkID      int64  `json:"sink_id,string" mcp:"desc=email activity_sink id"`
	SinkName    string `json:"sink_name" mcp:"desc=sink title"`
	ProjectID   int64  `json:"project_id,string" mcp:"desc=project id"`
	ProjectName string `json:"project_name" mcp:"desc=project title"`
	ChannelName string `json:"channel_name" mcp:"desc=comm_channel the mail goes out through"`
	SinkStatus  string `json:"sink_status" mcp:"desc=sink channel_status"`
}

// SubscriptionSinksOutput wraps rows in a stable envelope.
type SubscriptionSinksOutput struct {
	Rows []SubscribableSink `json:"rows" mcp:"desc=email sinks in projects the caller can see"`
}

// ---- Register + authz ----

var authzPool *store.Pool

// Register installs every activity_sink.* handler. Mirrors comm.Register.
func Register(p *store.Pool) {
	authzPool = p
	reg.Register(reg.Handler{
		Endpoint:     "activity_sink",
		Action:       "set",
		Doc:          "Admin-only: create or update an activity_sink card (id=0 to insert). sink_kind 'msgraph_teams' broadcasts digests into one Teams channel (MS Graph fields + the pgcrypto-encrypted client_secret, optional on update); sink_kind 'email' opens a project comm_channel (channel_id) for personal notification subscriptions, its filters acting as an admin ceiling. Filters / rollup_minutes are written when present, unchanged when omitted.",
		InputType:    reflect.TypeFor[SinkSetInput](),
		OutputType:   reflect.TypeFor[SinkSetOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		// Unified handler — body lives in
		// db/schema/functions/activity_sink_set_batch.sql.
		SQLFunc: "activity_sink_set_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "activity_sink",
		Action:       "list",
		Doc:          "Admin-only: list activity_sink cards under a project, joined with activity_sink_secret (so has_client_secret reflects storage without exposing the encrypted bytes), activity_sink_state (last_activity_id pointer + last_pushed_at + last_error + pending_since from the pump), the email sink's comm channel and its subscription count.",
		InputType:    reflect.TypeFor[SinkListInput](),
		OutputType:   reflect.TypeFor[SinkListOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		// Unified handler — body lives in
		// db/schema/functions/activity_sink_list_batch.sql per Phase 5
		// of docs/UNIFIED_HANDLER_PLAN.md.
		SQLFunc: "activity_sink_list_batch",
	})

	// Personal subscriptions. Every project tier may manage its OWN
	// subscriptions: the (activity_subscription, activity_subscription.*)
	// role_grant rows admit viewer..admin scoped to the sink's project,
	// and the SQL function enforces subscriber = caller (admins exempt).
	subscriberRoles := []string{"viewer", "commenter", "worker", "manager", "admin"}
	reg.Register(reg.Handler{
		Endpoint:     "activity_subscription",
		Action:       "set",
		Doc:          "Create (id=0, under an email sink) or update one of YOUR notification subscriptions: name, event filter, card filter ('@me' = you), rollup_minutes and enabled. You are always the subscriber; the digest is mailed to your person card's email through the sink's comm channel, grouped by task.",
		InputType:    reflect.TypeFor[SubscriptionSetInput](),
		OutputType:   reflect.TypeFor[SubscriptionSetOutput](),
		AllowedRoles: subscriberRoles,
		ProcessName:  "activity_subscription.set",
		CardTypeID:   subscriptionCardTypeID,
		ScopeCardID: func(_ context.Context, _ reg.ValidationPool, in any) (int64, error) {
			v := in.(SubscriptionSetInput)
			if v.ID != 0 {
				return v.ID, nil
			}
			return v.SinkID, nil
		},
		// Unified handler — body lives in
		// db/schema/functions/activity_subscription_set_batch.sql.
		SQLFunc: "activity_subscription_set_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "activity_subscription",
		Action:       "delete",
		Doc:          "Delete one of YOUR notification subscriptions (admins may delete anyone's).",
		InputType:    reflect.TypeFor[SubscriptionDeleteInput](),
		OutputType:   reflect.TypeFor[SubscriptionDeleteOutput](),
		AllowedRoles: subscriberRoles,
		ProcessName:  "activity_subscription.delete",
		CardTypeID:   subscriptionCardTypeID,
		ScopeCardID: func(_ context.Context, _ reg.ValidationPool, in any) (int64, error) {
			return in.(SubscriptionDeleteInput).ID, nil
		},
		// Unified handler — body lives in
		// db/schema/functions/activity_subscription_delete_batch.sql.
		SQLFunc: "activity_subscription_delete_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "activity_subscription",
		Action:       "list",
		Doc:          "List YOUR notification subscriptions (optionally one project) with their sink, project, comm channel and delivery state (last sent, last error, running rollup window).",
		InputType:    reflect.TypeFor[SubscriptionListInput](),
		OutputType:   reflect.TypeFor[SubscriptionListOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		IsRead:       true,
		// Unified handler — body lives in
		// db/schema/functions/activity_subscription_list_batch.sql.
		SQLFunc: "activity_subscription_list_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "activity_subscription",
		Action:       "sinks",
		Doc:          "List the email activity sinks you can subscribe under — one per project mailbox an admin has opened for notifications, in projects you can see.",
		InputType:    reflect.TypeFor[SubscriptionSinksInput](),
		OutputType:   reflect.TypeFor[SubscriptionSinksOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		IsRead:       true,
		// Unified handler — body lives in
		// db/schema/functions/activity_subscription_sinks_batch.sql.
		SQLFunc: "activity_subscription_sinks_batch",
	})
}

// subscriptionCardTypeID resolves the activity_subscription card_type for
// the dispatcher's (card_type, process) grant check. A missing card_type
// is an error, never 0 — 0 would skip the grant check entirely.
func subscriptionCardTypeID(ctx context.Context, pool reg.ValidationPool, _ any) (int64, error) {
	b := named.New()
	b.Set("name", "activity_subscription")
	sql, args, err := b.Compile(`SELECT id FROM card_type WHERE name = :name`)
	if err != nil {
		return 0, fmt.Errorf("activity_subscription card_type: compile: %w", err)
	}
	var id int64
	if err := pool.QueryRow(ctx, sql, args...).Scan(&id); err != nil {
		return 0, fmt.Errorf("activity_subscription card_type: %w", err)
	}
	return id, nil
}

// authzAdmin requires the actor to hold the admin or system role
// globally. Mirrors comm.authzAdmin verbatim.
func authzAdmin(ctx context.Context, _ any) error {
	if authzPool == nil {
		return nil
	}
	userID := auth.ActorOrSystem(ctx)
	var n int
	if err := authzPool.P.QueryRow(ctx, `
		SELECT count(*)
		FROM user_role ur
		JOIN role r ON r.id = ur.role_id
		WHERE ur.user_id = $1 AND r.name IN ('admin','system') AND ur.scope_card_id IS NULL
	`, userID).Scan(&n); err != nil {
		return fmt.Errorf("activity_sink.authz: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("activity_sink: actor %d is not an admin", userID)
	}
	return nil
}
