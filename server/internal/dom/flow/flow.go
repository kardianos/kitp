// Package flow exposes admin CRUD for the flow + flow_step tables that
// drive the per-attribute state machine kernel (Gate 3 of
// docs/FLOW_AND_SCREEN_KERNEL.md).
//
// A flow binds one attribute_def (typically `status`) to one project
// (scope_card_id) and lists the allowed (from → to) transitions through
// flow_step rows. There are no install-wide / global flows — every flow
// is project-scoped. Templates for a fresh project live in the seed and
// are stamped into each new project via project.stamp (Gate 11).
//
// Endpoints:
//   - flow.set                  — upsert one flow row
//   - flow.delete               — delete one flow row (cascades flow_step rows)
//   - flow.list                 — list flows, optionally filtered by project / attribute_def
//   - flow.preview_delete       — dry-run delete preview (V16 spec shape)
//   - flow_step.set             — upsert one flow_step row
//   - flow_step.delete          — delete one flow_step row
//   - flow_step.list            — list flow_step rows for a flow
//   - flow_step.list_for_card   — list available transitions for a given card
//                                  (read-side affordance API; gate 4 of FLOW_AND_SCREEN_KERNEL)
//
// Authz: every write handler is admin-only via a global-admin guard on
// the same shape used by attributedef / rolemapping (load the actor's
// user_role rows and require admin or system globally). Reads are open
// to any authenticated user — the admin Flows UI loads the list to
// render the editor.
//
// No write path through attribute.update yet — admins can author
// transitions without them taking effect; the validation branch lands
// in Gate 5.
package flow

import (
	"context"
	"fmt"
	"reflect"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// ---- flow handler I/O ----

// SetInput upserts one flow row. id=0 inserts; id>0 updates by id.
// The unique (attribute_def_id, scope_card_id) constraint surfaces as
// the error code "flow_duplicate_scope" on the wire so the admin UI
// can map "two flows on the same attribute in this project" to a
// human-readable message.
type SetInput struct {
	ID                    int64  `json:"id,string,omitempty" mcp:"desc=existing flow id to update; omit / 0 to insert a new row"`
	Name                  string `json:"name" mcp:"required,desc=display name shown in the admin UI"`
	Doc                   string `json:"doc,omitempty" mcp:"desc=human-readable description"`
	AttributeDefID        int64  `json:"attribute_def_id,string" mcp:"required,desc=attribute_def the flow governs (typically status)"`
	ScopeCardID           int64  `json:"scope_card_id,string" mcp:"required,desc=project card id this flow applies to; NOT NULL — no global flows"`
	DefaultCreateStatusID int64  `json:"default_create_status_id,string,omitempty" mcp:"desc=optional value-card id used as the new-task default for this flow"`
}

// SetOutput surfaces the row id so the caller can chain.
type SetOutput struct {
	ID int64 `json:"id,string" mcp:"desc=id of the created or updated flow row"`
}

// DeleteInput removes one flow row by id. ON DELETE CASCADE on
// flow_step removes the transition edges.
type DeleteInput struct {
	FlowID int64 `json:"flow_id,string" mcp:"required,desc=flow row id to delete"`
}

// DeleteOutput reports success.
type DeleteOutput struct {
	OK      bool `json:"ok" mcp:"desc=true on success"`
	Deleted int  `json:"deleted" mcp:"desc=number of flow rows deleted (0 or 1)"`
}

// ListInput filters the result set. Both fields optional; omitting both
// returns every flow row.
type ListInput struct {
	ScopeCardID    int64 `json:"scope_card_id,string,omitempty" mcp:"desc=filter to flows scoped to this project card"`
	AttributeDefID int64 `json:"attribute_def_id,string,omitempty" mcp:"desc=filter to flows for this attribute_def"`
}

// ListRow is one flow joined to its attribute_def name.
type ListRow struct {
	ID                    int64  `json:"id,string" mcp:"desc=flow id"`
	Name                  string `json:"name" mcp:"desc=flow display name"`
	Doc                   string `json:"doc,omitempty" mcp:"desc=human-readable description"`
	AttributeDefID        int64  `json:"attribute_def_id,string" mcp:"desc=attribute_def the flow governs"`
	AttributeDefName      string `json:"attribute_def_name" mcp:"desc=name of that attribute_def for display"`
	ScopeCardID           int64  `json:"scope_card_id,string" mcp:"desc=project card id this flow is scoped to"`
	DefaultCreateStatusID int64  `json:"default_create_status_id,string,omitempty" mcp:"desc=value-card id used as the new-task default; 0 / omitted = none"`
	CreatedAt             string `json:"created_at" mcp:"desc=RFC3339 creation timestamp"`
}

// ListOutput wraps the rows in a stable envelope.
type ListOutput struct {
	Rows []ListRow `json:"rows" mcp:"desc=matching flow rows"`
}

// PreviewDeleteInput is the dry-run preview for flow.delete (V16).
type PreviewDeleteInput struct {
	FlowID int64 `json:"flow_id,string" mcp:"required,desc=flow row id to preview deleting"`
}

// PhaseCounts breaks the affected-task count by phase of the
// gated value-card.
type PhaseCounts struct {
	Triage   int `json:"triage" mcp:"desc=tasks currently at a triage value-card in this flow"`
	Active   int `json:"active" mcp:"desc=tasks currently at an active value-card in this flow"`
	Terminal int `json:"terminal" mcp:"desc=tasks currently at a terminal value-card in this flow"`
}

// PreviewDeleteOutput matches the V16 shape so the admin dialog renders
// affected-data summary before the destructive call.
type PreviewDeleteOutput struct {
	FlowID                     int64       `json:"flow_id,string" mcp:"desc=echo of the input flow id"`
	FlowName                   string      `json:"flow_name" mcp:"desc=flow display name"`
	StepCount                  int         `json:"step_count" mcp:"desc=number of flow_step rows under this flow"`
	TasksCurrentlyInFlowStates int         `json:"tasks_currently_in_flow_states" mcp:"desc=count of tasks whose attribute value points at a value-card this flow gates"`
	TasksByPhase               PhaseCounts `json:"tasks_by_phase" mcp:"desc=affected-task counts bucketed by phase"`
	SampleStepLabels           []string    `json:"sample_step_labels" mcp:"desc=up to 5 representative step labels in sort_order"`
}

// ---- flow_step handler I/O ----

// StepSetInput upserts one flow_step row. id=0 inserts; id>0 updates by
// id. Without id, the (flow_id, from_card_id, to_card_id, label) unique
// key still rejects duplicates with code "flow_step_duplicate".
type StepSetInput struct {
	ID             int64  `json:"id,string,omitempty" mcp:"desc=existing flow_step id to update; omit / 0 to insert"`
	FlowID         int64  `json:"flow_id,string" mcp:"required,desc=parent flow id"`
	FromCardID     int64  `json:"from_card_id,string" mcp:"required,desc=value-card id the transition starts at"`
	ToCardID       int64  `json:"to_card_id,string" mcp:"required,desc=value-card id the transition lands at"`
	Label          string `json:"label" mcp:"required,desc=button text shown in TransitionBar"`
	RequiresRoleID int64  `json:"requires_role_id,string,omitempty" mcp:"desc=optional role id required to fire the transition; omitted / 0 = any authenticated user"`
	SortOrder      int32  `json:"sort_order,omitempty" mcp:"desc=ordering within the same UI bucket"`
}

// StepSetOutput surfaces the id.
type StepSetOutput struct {
	ID int64 `json:"id,string" mcp:"desc=id of the created or updated flow_step row"`
}

// StepDeleteInput removes one flow_step row by id.
type StepDeleteInput struct {
	FlowStepID int64 `json:"flow_step_id,string" mcp:"required,desc=flow_step row id to delete"`
}

// StepDeleteOutput reports success.
type StepDeleteOutput struct {
	OK      bool `json:"ok" mcp:"desc=true on success"`
	Deleted int  `json:"deleted" mcp:"desc=number of flow_step rows deleted (0 or 1)"`
}

// StepListInput lists flow_step rows for one flow.
type StepListInput struct {
	FlowID int64 `json:"flow_id,string" mcp:"required,desc=parent flow id"`
}

// StepListRow is one flow_step joined to the optional role name.
type StepListRow struct {
	ID               int64  `json:"id,string" mcp:"desc=flow_step id"`
	FlowID           int64  `json:"flow_id,string" mcp:"desc=parent flow id"`
	FromCardID       int64  `json:"from_card_id,string" mcp:"desc=value-card id the transition starts at"`
	ToCardID         int64  `json:"to_card_id,string" mcp:"desc=value-card id the transition lands at"`
	Label            string `json:"label" mcp:"desc=button text"`
	RequiresRoleID   int64  `json:"requires_role_id,string,omitempty" mcp:"desc=role id required to fire; 0 / omitted = any authenticated user"`
	RequiresRoleName string `json:"requires_role_name,omitempty" mcp:"desc=name of the required role for display"`
	SortOrder        int32  `json:"sort_order" mcp:"desc=ordering within the same UI bucket"`
}

// StepListOutput wraps the rows in a stable envelope.
type StepListOutput struct {
	Rows []StepListRow `json:"rows" mcp:"desc=flow_step rows for this flow, in sort_order then label"`
}

// ---- flow_step.list_for_card ----

// ListForCardInput identifies the card whose available transitions we want
// (Gate 4 of FLOW_AND_SCREEN_KERNEL.md). The handler returns every
// flow_step whose from_card_id matches one of the card's current
// attribute values on a flow-bound attribute, stamped with phase /
// labels / allowed so the client renders without re-querying.
type ListForCardInput struct {
	CardID int64 `json:"card_id,string" mcp:"required,desc=id of the card to find available transitions for"`
}

// AvailableTransition is one flow_step the caller may attempt to fire,
// pre-joined with the from/to value-card metadata (title + phase),
// optional requires_role name, and the per-actor allowed bit.
type AvailableTransition struct {
	ID               int64  `json:"id,string" mcp:"desc=flow_step id"`
	FlowID           int64  `json:"flow_id,string" mcp:"desc=parent flow id"`
	FlowName         string `json:"flow_name" mcp:"desc=parent flow name"`
	AttributeDefID   int64  `json:"attribute_def_id,string" mcp:"desc=attribute_def the flow is bound to"`
	AttributeDefName string `json:"attribute_def_name" mcp:"desc=attribute_def name (e.g. status)"`
	FromCardID       int64  `json:"from_card_id,string" mcp:"desc=value-card the transition starts from"`
	FromLabel        string `json:"from_label" mcp:"desc=title of the from value-card"`
	FromPhase        string `json:"from_phase" mcp:"desc=phase of the from value-card (triage|active|terminal)"`
	ToCardID         int64  `json:"to_card_id,string" mcp:"desc=value-card the transition lands on"`
	ToLabel          string `json:"to_label" mcp:"desc=title of the to value-card"`
	ToPhase          string `json:"to_phase" mcp:"desc=phase of the to value-card (triage|active|terminal)"`
	Label            string `json:"label" mcp:"desc=transition button label"`
	RequiresRoleID   int64  `json:"requires_role_id,string,omitempty" mcp:"desc=role id required to fire this transition; 0 = any authenticated"`
	RequiresRoleName string `json:"requires_role_name,omitempty" mcp:"desc=role name required, empty when no role gate"`
	SortOrder        int32  `json:"sort_order" mcp:"desc=display order within UI bucket"`
	Allowed          bool   `json:"allowed" mcp:"desc=true if the calling actor's roles satisfy requires_role_id (or it's NULL)"`
}

// ListForCardOutput wraps the rows in a stable envelope.
type ListForCardOutput struct {
	Rows []AvailableTransition `json:"rows" mcp:"desc=available transitions, ordered by attribute_def_name, sort_order, label"`
}

// ---- Register + authz ----

// authzPool is the package-level pool used by the admin gate. Set by
// Register; consumed by authzAdmin via closure-free callback signature.
var authzPool *store.Pool

// Register installs every flow + flow_step handler.
func Register(p *store.Pool) {
	authzPool = p
	reg.Register(reg.Handler{
		Endpoint:     "flow",
		Action:       "set",
		Doc:          "Admin-only: upsert one flow row (per-project state machine on an attribute_def). id=0 inserts; id>0 updates by id.",
		InputType:    reflect.TypeFor[SetInput](),
		OutputType:   reflect.TypeFor[SetOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		// Unified handler — body lives in
		// db/schema/functions/flow_set_batch.sql.
		SQLFunc: "flow_set_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "flow",
		Action:       "delete",
		Doc:          "Admin-only: delete one flow row. Refuses with code='flow_disallowed' and a {blockers[], count} payload when any flow_step row still references the flow; admins must clear steps first.",
		InputType:    reflect.TypeFor[DeleteInput](),
		OutputType:   reflect.TypeFor[DeleteOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		// Unified handler — body lives in
		// db/schema/functions/flow_delete_batch.sql.
		SQLFunc: "flow_delete_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "flow",
		Action:       "list",
		Doc:          "List flow rows, optionally filtered by scope_card_id (project) and / or attribute_def_id. Available to any authenticated user.",
		InputType:    reflect.TypeFor[ListInput](),
		OutputType:   reflect.TypeFor[ListOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		// Unified handler — body lives in
		// db/schema/functions/flow_list_batch.sql.
		SQLFunc: "flow_list_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "flow",
		Action:       "preview_delete",
		Doc:          "Admin-only: dry-run preview for flow.delete. Returns step count, affected-task counts (total + phase breakdown), and up to 5 sample step labels so the admin dialog can show consequences before the destructive call (V16).",
		InputType:    reflect.TypeFor[PreviewDeleteInput](),
		OutputType:   reflect.TypeFor[PreviewDeleteOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		// Unified handler — body lives in
		// db/schema/functions/flow_preview_delete_batch.sql.
		SQLFunc: "flow_preview_delete_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "flow_step",
		Action:       "set",
		Doc:          "Admin-only: upsert one flow_step row. id=0 inserts; id>0 updates by id. Without id, the (flow_id, from_card_id, to_card_id, label) unique key rejects duplicates.",
		InputType:    reflect.TypeFor[StepSetInput](),
		OutputType:   reflect.TypeFor[StepSetOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		// Unified handler — body lives in
		// db/schema/functions/flow_step_set_batch.sql.
		SQLFunc: "flow_step_set_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "flow_step",
		Action:       "delete",
		Doc:          "Admin-only: delete one flow_step row by id.",
		InputType:    reflect.TypeFor[StepDeleteInput](),
		OutputType:   reflect.TypeFor[StepDeleteOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		// Unified handler — body lives in
		// db/schema/functions/flow_step_delete_batch.sql.
		SQLFunc: "flow_step_delete_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "flow_step",
		Action:       "list",
		Doc:          "List flow_step rows for one flow, joined to the optional requires_role name. Sorted by sort_order then label.",
		InputType:    reflect.TypeFor[StepListInput](),
		OutputType:   reflect.TypeFor[StepListOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		// Unified handler — body lives in
		// db/schema/functions/flow_step_list_batch.sql.
		SQLFunc: "flow_step_list_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "flow_step",
		Action:       "list_for_card",
		Doc:          "Read-side affordance API: return every flow_step the given card may currently fire — one row per (flow, attribute_def, from_card_id=card's value) match — pre-joined with from/to titles + phases, optional requires_role name, and a per-actor allowed bit. Gate 5's attribute.update rejection envelope reuses the same query.",
		InputType:    reflect.TypeFor[ListForCardInput](),
		OutputType:   reflect.TypeFor[ListForCardOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		// Unified handler — body lives in
		// db/schema/functions/flow_step_list_for_card_batch.sql.
		SQLFunc: "flow_step_list_for_card_batch",
	})
}

// authzAdmin gates every flow / flow_step writer. Mirrors the gate in
// attributedef / rolemapping: the actor must hold the admin or system
// role globally.
func authzAdmin(ctx context.Context, _ any) error {
	if authzPool == nil {
		return nil // tests may bypass Register
	}
	userID := auth.ActorOrSystem(ctx)
	var n int
	if err := authzPool.P.QueryRow(ctx, `
		SELECT count(*)
		FROM user_role ur
		JOIN role r ON r.id = ur.role_id
		WHERE ur.user_id = $1 AND r.name IN ('admin','system') AND ur.scope_card_id IS NULL
	`, userID).Scan(&n); err != nil {
		return fmt.Errorf("flow.authz: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("flow: actor %d is not an admin", userID)
	}
	return nil
}
