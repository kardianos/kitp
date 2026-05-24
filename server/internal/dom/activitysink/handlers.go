// Package activitysink exposes the CRUD handlers + pump worker for
// activity_sink cards.
//
// An activity_sink is a project-scoped card_type that names an external
// destination (currently MS Graph → Teams channel) for the project's
// activity stream. The pump (pumper.go) runs one goroutine per sink,
// scans new activity rows past its last-pushed pointer, evaluates the
// stored predicate, and posts each match. State (pointer + last-error)
// lives in activity_sink_state — not on the card — so pointer advance
// does not write back into the activity stream we are reading from.
//
// Authz: every handler is admin-only, mirroring the comm_channel
// surface (the install seed gates activity_sink card.* on the admin
// role; the handler-level guard restates that). client_secret is
// encrypted at rest via pgcrypto with the same KITP_COMM_SECRET_KEY
// GUC the comm subsystem uses — keeping a single secret-key surface.
package activitysink

import (
	"context"
	"fmt"
	"reflect"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// ---- sink.set ----

// SinkSetInput is the wire payload for activity_sink.set. ID=0 inserts;
// non-zero updates an existing sink under the same project. Fields
// left at the zero value are skipped on update (PATCH semantics);
// ClientSecret is a *string so omit-vs-clear is distinguishable.
type SinkSetInput struct {
	ID               int64   `json:"id,string,omitempty" mcp:"desc=existing activity_sink card id to update; omit / 0 to insert a new sink"`
	ProjectID        int64   `json:"project_id,string" mcp:"required,desc=project card id this sink lives under (parent_card_id)"`
	Name             string  `json:"name" mcp:"required,desc=human-readable sink name (stored as the card's title)"`
	SinkKind         string  `json:"sink_kind" mcp:"required,desc=sink kind; v1 supports 'msgraph_teams'"`
	MSGraphTenantID  string  `json:"msgraph_tenant_id,omitempty" mcp:"desc=Azure AD tenant id (GUID) for the MS Graph app"`
	MSGraphClientID  string  `json:"msgraph_client_id,omitempty" mcp:"desc=Azure app registration client_id"`
	MSGraphClientSecret *string `json:"msgraph_client_secret,omitempty" mcp:"desc=Azure app client_secret; omit to leave unchanged on update; stored encrypted via pgcrypto"`
	MSGraphTeamID    string  `json:"msgraph_team_id,omitempty" mcp:"desc=Teams team id (group id GUID) to post into"`
	MSGraphChannelID string  `json:"msgraph_channel_id,omitempty" mcp:"desc=Teams channel id (within the team) to post into"`
	ActivityFilter   string  `json:"activity_filter,omitempty" mcp:"desc=JSON predicate restricting which activity rows are pushed; empty = push every row. See dom/activitysink/predicate.go for shape."`
	Status           string  `json:"channel_status,omitempty" mcp:"desc=tri-state status; one of 'enabled' | 'disabled-admin' | 'disabled-fault'; empty leaves the stored value unchanged"`
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
	ID                  int64  `json:"id,string" mcp:"desc=activity_sink card id"`
	Name                string `json:"name" mcp:"desc=display name (title attribute)"`
	SinkKind            string `json:"sink_kind" mcp:"desc=sink kind"`
	MSGraphTenantID     string `json:"msgraph_tenant_id" mcp:"desc=Azure tenant id"`
	MSGraphClientID     string `json:"msgraph_client_id" mcp:"desc=Azure app client_id"`
	MSGraphTeamID       string `json:"msgraph_team_id" mcp:"desc=Teams team id"`
	MSGraphChannelID    string `json:"msgraph_channel_id" mcp:"desc=Teams channel id"`
	ActivityFilter      string `json:"activity_filter" mcp:"desc=stored JSON predicate; empty when unfiltered"`
	Status              string `json:"channel_status" mcp:"desc=tri-state status"`
	FaultReason         string `json:"channel_fault_reason,omitempty" mcp:"desc=free-form reason set by the runtime when status='disabled-fault'"`
	HasClientSecret     bool   `json:"has_client_secret" mcp:"desc=true if an encrypted client_secret is stored"`
	LastActivityID      int64  `json:"last_activity_id,string" mcp:"desc=largest activity.id this sink has successfully pushed; 0 means nothing pushed yet"`
	LastPushedAt        string `json:"last_pushed_at,omitempty" mcp:"desc=RFC3339 timestamp of the most recent successful push; empty when never pushed"`
	LastPushedCount     int64  `json:"last_pushed_count,string" mcp:"desc=cumulative number of activity rows pushed downstream by this sink"`
	LastError           string `json:"last_error,omitempty" mcp:"desc=most recent push error reported by the pump; cleared on the next successful push"`
	CreatedAt           string `json:"created_at" mcp:"desc=RFC3339 creation timestamp of the sink card"`
}

// SinkListOutput wraps rows in a stable envelope.
type SinkListOutput struct {
	Rows []SinkRow `json:"rows" mcp:"desc=activity_sink cards under the project"`
}

// ---- Register + authz ----

var authzPool *store.Pool

// Register installs every activity_sink.* handler. Mirrors comm.Register.
func Register(p *store.Pool) {
	authzPool = p
	reg.Register(reg.Handler{
		Endpoint:     "activity_sink",
		Action:       "set",
		Doc:          "Admin-only: create or update an activity_sink card (id=0 to insert) plus its paired activity_sink_secret row holding the pgcrypto-encrypted client_secret. Password-style fields are optional on update — omitted leaves the stored value unchanged.",
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
		Doc:          "Admin-only: list activity_sink cards under a project, joined with activity_sink_secret (so has_client_secret reflects storage without exposing the encrypted bytes) and activity_sink_state (last_activity_id pointer + last_pushed_at + last_error from the pump).",
		InputType:    reflect.TypeFor[SinkListInput](),
		OutputType:   reflect.TypeFor[SinkListOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		// Unified handler — body lives in
		// db/schema/functions/activity_sink_list_batch.sql per Phase 5
		// of docs/UNIFIED_HANDLER_PLAN.md.
		SQLFunc: "activity_sink_list_batch",
	})
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

