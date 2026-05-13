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
	"errors"
	"fmt"
	"reflect"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

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
		Run:          runFlowSet(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "flow",
		Action:       "delete",
		Doc:          "Admin-only: delete one flow row. ON DELETE CASCADE removes every flow_step under it; value cards and tasks are untouched.",
		InputType:    reflect.TypeFor[DeleteInput](),
		OutputType:   reflect.TypeFor[DeleteOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		Run:          runFlowDelete(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "flow",
		Action:       "list",
		Doc:          "List flow rows, optionally filtered by scope_card_id (project) and / or attribute_def_id. Available to any authenticated user.",
		InputType:    reflect.TypeFor[ListInput](),
		OutputType:   reflect.TypeFor[ListOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Run:          runFlowList(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "flow",
		Action:       "preview_delete",
		Doc:          "Admin-only: dry-run preview for flow.delete. Returns step count, affected-task counts (total + phase breakdown), and up to 5 sample step labels so the admin dialog can show consequences before the destructive call (V16).",
		InputType:    reflect.TypeFor[PreviewDeleteInput](),
		OutputType:   reflect.TypeFor[PreviewDeleteOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		Run:          runFlowPreviewDelete(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "flow_step",
		Action:       "set",
		Doc:          "Admin-only: upsert one flow_step row. id=0 inserts; id>0 updates by id. Without id, the (flow_id, from_card_id, to_card_id, label) unique key rejects duplicates.",
		InputType:    reflect.TypeFor[StepSetInput](),
		OutputType:   reflect.TypeFor[StepSetOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		Run:          runStepSet(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "flow_step",
		Action:       "delete",
		Doc:          "Admin-only: delete one flow_step row by id.",
		InputType:    reflect.TypeFor[StepDeleteInput](),
		OutputType:   reflect.TypeFor[StepDeleteOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		Run:          runStepDelete(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "flow_step",
		Action:       "list",
		Doc:          "List flow_step rows for one flow, joined to the optional requires_role name. Sorted by sort_order then label.",
		InputType:    reflect.TypeFor[StepListInput](),
		OutputType:   reflect.TypeFor[StepListOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Run:          runStepList(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "flow_step",
		Action:       "list_for_card",
		Doc:          "Read-side affordance API: return every flow_step the given card may currently fire — one row per (flow, attribute_def, from_card_id=card's value) match — pre-joined with from/to titles + phases, optional requires_role name, and a per-actor allowed bit. Gate 5's attribute.update rejection envelope reuses the same query.",
		InputType:    reflect.TypeFor[ListForCardInput](),
		OutputType:   reflect.TypeFor[ListForCardOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Run:          runStepListForCard(p),
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

// ---- flow.set ----

func runFlowSet(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(SetInput)
			if err := validateSetInput(ctx, tx, i, in); err != nil {
				return nil, err
			}
			id, err := upsertFlow(ctx, tx, in)
			if err != nil {
				return nil, mapFlowSetError(i, err)
			}
			outs[i] = SetOutput{ID: id}
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}

// validateSetInput runs the cheap field validations and the existence /
// type checks we want to surface as structured errors. Heavier checks
// (e.g. is the default status really a card of the target_card_type)
// piggyback on tx so the rejection happens inside the same Run.
func validateSetInput(ctx context.Context, tx pgx.Tx, idx int, in SetInput) error {
	if in.Name == "" {
		return &reg.HandlerError{InputIndex: idx, Code: "validation",
			Message: "flow.set: name is required"}
	}
	if in.AttributeDefID == 0 {
		return &reg.HandlerError{InputIndex: idx, Code: "validation",
			Message: "flow.set: attribute_def_id is required"}
	}
	if in.ScopeCardID == 0 {
		return &reg.HandlerError{InputIndex: idx, Code: "validation",
			Message: "flow.set: scope_card_id is required (every flow is project-scoped)"}
	}

	// attribute_def must exist and resolve the target value-card type so
	// we can validate the optional default_create_status_id below.
	var targetCardTypeID *int64
	row := tx.QueryRow(ctx, `SELECT target_card_type_id FROM attribute_def WHERE id = $1`, in.AttributeDefID)
	if err := row.Scan(&targetCardTypeID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &reg.HandlerError{InputIndex: idx, Code: "attribute_def_not_found",
				Message: fmt.Sprintf("flow.set: attribute_def %d not found", in.AttributeDefID)}
		}
		return fmt.Errorf("flow.set: load attribute_def: %w", err)
	}

	// scope_card_id must exist and be a project card (card_type.name='project').
	var scopeKind string
	row = tx.QueryRow(ctx, `
		SELECT ct.name FROM card c JOIN card_type ct ON ct.id = c.card_type_id WHERE c.id = $1
	`, in.ScopeCardID)
	if err := row.Scan(&scopeKind); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &reg.HandlerError{InputIndex: idx, Code: "scope_card_not_found",
				Message: fmt.Sprintf("flow.set: scope_card_id %d not found", in.ScopeCardID)}
		}
		return fmt.Errorf("flow.set: load scope card: %w", err)
	}
	if scopeKind != "project" {
		return &reg.HandlerError{InputIndex: idx, Code: "scope_not_project",
			Message: fmt.Sprintf("flow.set: scope_card_id %d is a %q card, not a project", in.ScopeCardID, scopeKind)}
	}

	// Optional default_create_status_id must point at a value-card of the
	// attribute_def's target_card_type (e.g. status when the flow gates
	// the status attribute).
	if in.DefaultCreateStatusID != 0 {
		if targetCardTypeID == nil {
			return &reg.HandlerError{InputIndex: idx, Code: "validation",
				Message: "flow.set: attribute_def has no target_card_type — default_create_status_id is not applicable"}
		}
		var ctid int64
		row = tx.QueryRow(ctx, `SELECT card_type_id FROM card WHERE id = $1`, in.DefaultCreateStatusID)
		if err := row.Scan(&ctid); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return &reg.HandlerError{InputIndex: idx, Code: "default_status_not_found",
					Message: fmt.Sprintf("flow.set: default_create_status_id %d not found", in.DefaultCreateStatusID)}
			}
			return fmt.Errorf("flow.set: load default status: %w", err)
		}
		if ctid != *targetCardTypeID {
			return &reg.HandlerError{InputIndex: idx, Code: "default_status_wrong_type",
				Message: fmt.Sprintf("flow.set: default_create_status_id %d is card_type %d, expected %d (target of attribute_def %d)",
					in.DefaultCreateStatusID, ctid, *targetCardTypeID, in.AttributeDefID)}
		}
	}
	return nil
}

// upsertFlow inserts when in.ID == 0, updates by id otherwise. Returns
// the row id. The caller maps pgx errors (specifically the unique
// constraint) into a structured HandlerError via mapFlowSetError.
func upsertFlow(ctx context.Context, tx pgx.Tx, in SetInput) (int64, error) {
	var defaultID *int64
	if in.DefaultCreateStatusID != 0 {
		v := in.DefaultCreateStatusID
		defaultID = &v
	}
	if in.ID == 0 {
		var id int64
		row := tx.QueryRow(ctx, `
			INSERT INTO flow (name, doc, attribute_def_id, scope_card_id, default_create_status_id)
			VALUES ($1, NULLIF($2, ''), $3, $4, $5)
			RETURNING id
		`, in.Name, in.Doc, in.AttributeDefID, in.ScopeCardID, defaultID)
		if err := row.Scan(&id); err != nil {
			return 0, err
		}
		return id, nil
	}
	var id int64
	row := tx.QueryRow(ctx, `
		UPDATE flow SET
			name = $2,
			doc = NULLIF($3, ''),
			attribute_def_id = $4,
			scope_card_id = $5,
			default_create_status_id = $6
		WHERE id = $1
		RETURNING id
	`, in.ID, in.Name, in.Doc, in.AttributeDefID, in.ScopeCardID, defaultID)
	if err := row.Scan(&id); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, &reg.HandlerError{Code: "flow_not_found",
				Message: fmt.Sprintf("flow.set: id %d not found", in.ID)}
		}
		return 0, err
	}
	return id, nil
}

// mapFlowSetError translates pgx errors into structured HandlerError
// codes the wire can show the user. Unique-violation maps to
// "flow_duplicate_scope" (V18: forbid two flows on the same attribute
// in the same project).
func mapFlowSetError(idx int, err error) error {
	var he *reg.HandlerError
	if errors.As(err, &he) {
		he.InputIndex = idx
		return he
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		switch pg.Code {
		case "23505": // unique_violation
			return &reg.HandlerError{InputIndex: idx, Code: "flow_duplicate_scope",
				Message: "flow.set: a flow already exists for this (attribute_def, scope_card_id) — only one flow per attribute per project (V18)"}
		case "23503": // foreign_key_violation
			return &reg.HandlerError{InputIndex: idx, Code: "fk_violation",
				Message: fmt.Sprintf("flow.set: %s", pg.Message)}
		}
	}
	return fmt.Errorf("flow.set: %w", err)
}

// ---- flow.delete ----

func runFlowDelete(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(DeleteInput)
			if in.FlowID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "flow.delete: flow_id is required"}
			}
			ct, err := tx.Exec(ctx, `DELETE FROM flow WHERE id = $1`, in.FlowID)
			if err != nil {
				return nil, fmt.Errorf("flow.delete: %w", err)
			}
			rows := int(ct.RowsAffected())
			outs[i] = DeleteOutput{OK: rows > 0, Deleted: rows}
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}

// ---- flow.list ----

func runFlowList(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(ListInput)
			rows, err := tx.Query(ctx, `
				SELECT f.id, f.name, COALESCE(f.doc, ''),
				       f.attribute_def_id, ad.name,
				       f.scope_card_id, COALESCE(f.default_create_status_id, 0),
				       to_char(f.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
				FROM flow f
				JOIN attribute_def ad ON ad.id = f.attribute_def_id
				WHERE ($1::bigint = 0 OR f.scope_card_id = $1::bigint)
				  AND ($2::bigint = 0 OR f.attribute_def_id = $2::bigint)
				ORDER BY f.scope_card_id, ad.name, f.id
			`, in.ScopeCardID, in.AttributeDefID)
			if err != nil {
				return nil, fmt.Errorf("flow.list: %w", err)
			}
			var out []ListRow
			for rows.Next() {
				var r ListRow
				if err := rows.Scan(&r.ID, &r.Name, &r.Doc, &r.AttributeDefID, &r.AttributeDefName,
					&r.ScopeCardID, &r.DefaultCreateStatusID, &r.CreatedAt); err != nil {
					rows.Close()
					return nil, err
				}
				out = append(out, r)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return nil, err
			}
			outs[i] = ListOutput{Rows: out}
		}
		if p != nil {
			p.NoteRead()
		}
		return outs, nil
	}
}

// ---- flow.preview_delete ----

func runFlowPreviewDelete(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(PreviewDeleteInput)
			if in.FlowID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "flow.preview_delete: flow_id is required"}
			}
			// Pick up the basics. attribute_def_id is needed for the
			// affected-task count; we also fetch the name + step count
			// in the same row to keep the round-trip count down.
			var name string
			var attrDefID int64
			var stepCount int
			row := tx.QueryRow(ctx, `
				SELECT f.name,
				       f.attribute_def_id,
				       (SELECT count(*) FROM flow_step fs WHERE fs.flow_id = f.id)
				FROM flow f
				WHERE f.id = $1
			`, in.FlowID)
			if err := row.Scan(&name, &attrDefID, &stepCount); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return nil, &reg.HandlerError{InputIndex: i, Code: "flow_not_found",
						Message: fmt.Sprintf("flow.preview_delete: id %d not found", in.FlowID)}
				}
				return nil, fmt.Errorf("flow.preview_delete: load flow: %w", err)
			}
			out := PreviewDeleteOutput{
				FlowID:    in.FlowID,
				FlowName:  name,
				StepCount: stepCount,
			}

			// tasks_currently_in_flow_states: count attribute_value rows
			// for this attribute_def whose value (card-ref) names a
			// value-card that appears as either from_card_id or
			// to_card_id in any flow_step under this flow — i.e. any
			// value-card the flow gates.
			//
			// card_ref values are serialised as JSON numbers (the value
			// card's id). We cast to bigint to match.
			//
			// We compute per-phase bucketing in the same statement.
			rows, err := tx.Query(ctx, `
				WITH gated AS (
					SELECT DISTINCT card_id FROM (
						SELECT from_card_id AS card_id FROM flow_step WHERE flow_id = $1
						UNION
						SELECT to_card_id   AS card_id FROM flow_step WHERE flow_id = $1
					) u
				),
				affected AS (
					SELECT c.phase
					FROM attribute_value av
					JOIN card c ON c.id = (av.value)::text::bigint
					WHERE av.attribute_def_id = $2
					  AND jsonb_typeof(av.value) = 'number'
					  AND (av.value)::text::bigint IN (SELECT card_id FROM gated)
				)
				SELECT COALESCE(phase, 'triage') AS phase, count(*)
				FROM affected
				GROUP BY phase
			`, in.FlowID, attrDefID)
			if err != nil {
				return nil, fmt.Errorf("flow.preview_delete: count tasks: %w", err)
			}
			for rows.Next() {
				var phase string
				var n int
				if err := rows.Scan(&phase, &n); err != nil {
					rows.Close()
					return nil, err
				}
				switch phase {
				case "triage":
					out.TasksByPhase.Triage = n
				case "active":
					out.TasksByPhase.Active = n
				case "terminal":
					out.TasksByPhase.Terminal = n
				}
				out.TasksCurrentlyInFlowStates += n
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return nil, err
			}

			// Up to 5 sample labels in sort_order, then label, so the
			// UI shows a deterministic preview.
			lblRows, err := tx.Query(ctx, `
				SELECT label FROM flow_step
				WHERE flow_id = $1
				ORDER BY sort_order, label
				LIMIT 5
			`, in.FlowID)
			if err != nil {
				return nil, fmt.Errorf("flow.preview_delete: sample labels: %w", err)
			}
			labels := []string{}
			for lblRows.Next() {
				var lbl string
				if err := lblRows.Scan(&lbl); err != nil {
					lblRows.Close()
					return nil, err
				}
				labels = append(labels, lbl)
			}
			lblRows.Close()
			if err := lblRows.Err(); err != nil {
				return nil, err
			}
			out.SampleStepLabels = labels

			outs[i] = out
		}
		if p != nil {
			p.NoteRead()
		}
		return outs, nil
	}
}

// ---- flow_step.set ----

func runStepSet(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(StepSetInput)
			if err := validateStepInput(ctx, tx, i, in); err != nil {
				return nil, err
			}
			id, err := upsertStep(ctx, tx, in)
			if err != nil {
				return nil, mapStepSetError(i, err)
			}
			outs[i] = StepSetOutput{ID: id}
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}

func validateStepInput(ctx context.Context, tx pgx.Tx, idx int, in StepSetInput) error {
	if in.FlowID == 0 {
		return &reg.HandlerError{InputIndex: idx, Code: "validation",
			Message: "flow_step.set: flow_id is required"}
	}
	if in.FromCardID == 0 || in.ToCardID == 0 {
		return &reg.HandlerError{InputIndex: idx, Code: "validation",
			Message: "flow_step.set: from_card_id and to_card_id are required"}
	}
	if in.Label == "" {
		return &reg.HandlerError{InputIndex: idx, Code: "validation",
			Message: "flow_step.set: label is required"}
	}

	// Flow must exist; pull the attribute_def's target_card_type so the
	// from/to cards can be validated as value-cards of the right type.
	var targetCardTypeID *int64
	row := tx.QueryRow(ctx, `
		SELECT ad.target_card_type_id
		FROM flow f
		JOIN attribute_def ad ON ad.id = f.attribute_def_id
		WHERE f.id = $1
	`, in.FlowID)
	if err := row.Scan(&targetCardTypeID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &reg.HandlerError{InputIndex: idx, Code: "flow_not_found",
				Message: fmt.Sprintf("flow_step.set: flow %d not found", in.FlowID)}
		}
		return fmt.Errorf("flow_step.set: load flow: %w", err)
	}
	if targetCardTypeID == nil {
		return &reg.HandlerError{InputIndex: idx, Code: "flow_attr_not_card_ref",
			Message: "flow_step.set: flow's attribute_def is not card_ref-typed; transitions are not applicable"}
	}
	for _, pair := range []struct {
		field  string
		cardID int64
	}{{"from_card_id", in.FromCardID}, {"to_card_id", in.ToCardID}} {
		var ctid int64
		row = tx.QueryRow(ctx, `SELECT card_type_id FROM card WHERE id = $1`, pair.cardID)
		if err := row.Scan(&ctid); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return &reg.HandlerError{InputIndex: idx, Code: "card_not_found",
					Message: fmt.Sprintf("flow_step.set: %s=%d not found", pair.field, pair.cardID)}
			}
			return fmt.Errorf("flow_step.set: load %s: %w", pair.field, err)
		}
		if ctid != *targetCardTypeID {
			return &reg.HandlerError{InputIndex: idx, Code: "card_wrong_type",
				Message: fmt.Sprintf("flow_step.set: %s=%d is card_type %d, expected %d (target of flow's attribute_def)",
					pair.field, pair.cardID, ctid, *targetCardTypeID)}
		}
	}
	return nil
}

func upsertStep(ctx context.Context, tx pgx.Tx, in StepSetInput) (int64, error) {
	var role *int64
	if in.RequiresRoleID != 0 {
		v := in.RequiresRoleID
		role = &v
	}
	if in.ID == 0 {
		var id int64
		row := tx.QueryRow(ctx, `
			INSERT INTO flow_step (flow_id, from_card_id, to_card_id, label, requires_role_id, sort_order)
			VALUES ($1, $2, $3, $4, $5, $6)
			RETURNING id
		`, in.FlowID, in.FromCardID, in.ToCardID, in.Label, role, in.SortOrder)
		if err := row.Scan(&id); err != nil {
			return 0, err
		}
		return id, nil
	}
	var id int64
	row := tx.QueryRow(ctx, `
		UPDATE flow_step SET
			flow_id = $2,
			from_card_id = $3,
			to_card_id = $4,
			label = $5,
			requires_role_id = $6,
			sort_order = $7
		WHERE id = $1
		RETURNING id
	`, in.ID, in.FlowID, in.FromCardID, in.ToCardID, in.Label, role, in.SortOrder)
	if err := row.Scan(&id); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, &reg.HandlerError{Code: "flow_step_not_found",
				Message: fmt.Sprintf("flow_step.set: id %d not found", in.ID)}
		}
		return 0, err
	}
	return id, nil
}

func mapStepSetError(idx int, err error) error {
	var he *reg.HandlerError
	if errors.As(err, &he) {
		he.InputIndex = idx
		return he
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		switch pg.Code {
		case "23505":
			return &reg.HandlerError{InputIndex: idx, Code: "flow_step_duplicate",
				Message: "flow_step.set: a flow_step already exists with this (flow_id, from_card_id, to_card_id, label)"}
		case "23503":
			return &reg.HandlerError{InputIndex: idx, Code: "fk_violation",
				Message: fmt.Sprintf("flow_step.set: %s", pg.Message)}
		}
	}
	return fmt.Errorf("flow_step.set: %w", err)
}

// ---- flow_step.delete ----

func runStepDelete(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(StepDeleteInput)
			if in.FlowStepID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "flow_step.delete: flow_step_id is required"}
			}
			ct, err := tx.Exec(ctx, `DELETE FROM flow_step WHERE id = $1`, in.FlowStepID)
			if err != nil {
				return nil, fmt.Errorf("flow_step.delete: %w", err)
			}
			n := int(ct.RowsAffected())
			outs[i] = StepDeleteOutput{OK: n > 0, Deleted: n}
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}

// ---- flow_step.list ----

func runStepList(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(StepListInput)
			if in.FlowID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "flow_step.list: flow_id is required"}
			}
			rows, err := tx.Query(ctx, `
				SELECT fs.id, fs.flow_id, fs.from_card_id, fs.to_card_id,
				       fs.label,
				       COALESCE(fs.requires_role_id, 0),
				       COALESCE(r.name, ''),
				       fs.sort_order
				FROM flow_step fs
				LEFT JOIN role r ON r.id = fs.requires_role_id
				WHERE fs.flow_id = $1
				ORDER BY fs.sort_order, fs.label, fs.id
			`, in.FlowID)
			if err != nil {
				return nil, fmt.Errorf("flow_step.list: %w", err)
			}
			var out []StepListRow
			for rows.Next() {
				var r StepListRow
				if err := rows.Scan(&r.ID, &r.FlowID, &r.FromCardID, &r.ToCardID,
					&r.Label, &r.RequiresRoleID, &r.RequiresRoleName, &r.SortOrder); err != nil {
					rows.Close()
					return nil, err
				}
				out = append(out, r)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return nil, err
			}
			outs[i] = StepListOutput{Rows: out}
		}
		if p != nil {
			p.NoteRead()
		}
		return outs, nil
	}
}

// ---- flow_step.list_for_card ----

// runStepListForCard is the Gate-4 read-side handler. Per input card, it
// resolves the enclosing project, then defers to listAvailableTransitions
// — the same helper Gate 5's attribute.update rejection envelope calls
// to populate `available[]` on a flow_disallowed reject. One query, two
// call sites.
func runStepListForCard(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		actorID := auth.ActorOrSystem(ctx)
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(ListForCardInput)
			if in.CardID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "flow_step.list_for_card: card_id is required"}
			}
			projectID, err := projectIDForCard(ctx, tx, in.CardID)
			if err != nil {
				return nil, fmt.Errorf("flow_step.list_for_card: resolve project: %w", err)
			}
			// projectID == 0 ⇒ no enclosing project (orphan or root). No
			// flows can apply, so we shortcut to an empty result rather
			// than running the join.
			rows, err := listAvailableTransitions(ctx, tx, actorID, in.CardID, projectID)
			if err != nil {
				return nil, fmt.Errorf("flow_step.list_for_card: %w", err)
			}
			outs[i] = ListForCardOutput{Rows: rows}
		}
		if p != nil {
			p.NoteRead()
		}
		return outs, nil
	}
}

// ProjectIDForCard is the exported variant of the package-private
// projectIDForCard helper, accepting the broader Reader surface (any
// pgxpool / pgx.Tx) so callers outside this package (Gate 5's
// attribute.update validate branch) can resolve the enclosing project
// against a read-only pool before the transaction opens.
func ProjectIDForCard(ctx context.Context, db Reader, cardID int64) (int64, error) {
	return projectIDForCardRead(ctx, db, cardID)
}

// Reader is the read surface ProjectIDForCard / ListAvailableTransitions
// need. Both pgxpool.Pool and pgx.Tx satisfy it. Defined here so
// callers don't have to choose between "validate uses the pool" and
// "the read handler uses tx" — same function, same shape.
type Reader interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// projectIDForCard walks the parent_card_id chain from cardID upward
// and returns the id of the first ancestor (including cardID itself)
// whose card_type is 'project'. Returns 0 if none is found — the
// caller treats that as "no enclosing project", which means no
// project-scoped flows can apply.
//
// Recursive CTE so the round trip is one query regardless of nesting
// depth. Cards have ON DELETE CASCADE on parent_card_id so the chain
// is always intact for live rows.
func projectIDForCard(ctx context.Context, tx pgx.Tx, cardID int64) (int64, error) {
	return projectIDForCardRead(ctx, tx, cardID)
}

// projectIDForCardRead is the underlying implementation accepting the
// broader Reader interface so both projectIDForCard (in-tx, pgx.Tx) and
// ProjectIDForCard (pre-tx, pgxpool) can share the same SQL.
func projectIDForCardRead(ctx context.Context, db Reader, cardID int64) (int64, error) {
	var pid int64
	row := db.QueryRow(ctx, `
		WITH RECURSIVE chain AS (
			SELECT id, parent_card_id, card_type_id
			FROM card WHERE id = $1
			UNION ALL
			SELECT c.id, c.parent_card_id, c.card_type_id
			FROM card c
			JOIN chain ch ON ch.parent_card_id = c.id
		)
		SELECT chain.id
		FROM chain
		JOIN card_type ct ON ct.id = chain.card_type_id
		WHERE ct.name = 'project'
		LIMIT 1
	`, cardID)
	if err := row.Scan(&pid); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, nil
		}
		return 0, err
	}
	return pid, nil
}

// ListAvailableTransitions is the exported call site for Gate 5's
// attribute.update rejection envelope. Accepts any Reader (pgxpool
// for pre-tx Validate use, pgx.Tx for in-tx use) so the same helper
// answers both the read-side handler (`flow_step.list_for_card`,
// Gate 4) and the write-side rejection envelope (Gate 5). One
// implementation, two call sites.
func ListAvailableTransitions(ctx context.Context, db Reader, actorID, cardID, projectID int64) ([]AvailableTransition, error) {
	return listAvailableTransitionsRead(ctx, db, actorID, cardID, projectID)
}

// listAvailableTransitions is the shared core query. Given a card,
// the actor firing the request, and the enclosing project (the
// caller can pre-resolve it via projectIDForCard or pass 0 to mean
// "no project scope, return empty"), it returns every flow_step the
// card may currently attempt to traverse — one row per
// (flow, attribute_def, from_card_id) match — pre-joined with the
// from/to value-card title and phase, the optional required role
// name, and a per-actor `allowed` bit.
//
// Match shape: for each flow whose scope_card_id is this project, the
// card must have an attribute_value on the flow's attribute_def whose
// JSON value equals one of the flow_step.from_card_id values. The
// (av.value)::text::bigint cast matches the canonical form
// (jsonb_typeof = 'number') the attribute writer canonicalises to —
// same idiom flow.preview_delete uses.
//
// `allowed` is true when requires_role_id IS NULL, OR the actor holds
// the seeded `system` role globally (mirrors the dispatcher gate's
// system bypass — F-ROLE auth model), OR the actor holds that role
// via a user_role row that is either global (scope_card_id IS NULL)
// or scoped to this project.
//
// Gate 5's attribute.update rejection envelope calls this same helper
// (with the same args) to populate the `available[]` field on a
// flow_disallowed reject. The shape must therefore stay stable —
// AvailableTransition is the wire contract for both endpoints and the
// rejection payload.
func listAvailableTransitions(ctx context.Context, tx pgx.Tx, actorID, cardID, projectID int64) ([]AvailableTransition, error) {
	return listAvailableTransitionsRead(ctx, tx, actorID, cardID, projectID)
}

// listAvailableTransitionsRead is the Reader-typed core shared by the
// in-tx (pgx.Tx) and pre-tx (pgxpool) call sites. Both wrappers call
// it and surface the same []AvailableTransition shape.
func listAvailableTransitionsRead(ctx context.Context, db Reader, actorID, cardID, projectID int64) ([]AvailableTransition, error) {
	if projectID == 0 {
		return nil, nil
	}
	const q = `
		WITH actor_roles AS (
			SELECT role_id, scope_card_id FROM user_role WHERE user_id = $1
		),
		actor_has_system AS (
			SELECT EXISTS (
				SELECT 1 FROM actor_roles ar
				JOIN role r ON r.id = ar.role_id
				WHERE r.name = 'system' AND ar.scope_card_id IS NULL
			) AS yes
		)
		SELECT
			fs.id,
			fs.flow_id, f.name AS flow_name,
			f.attribute_def_id, ad.name AS attribute_def_name,
			fs.from_card_id,
			COALESCE(av_from_title.value #>> '{}', '')  AS from_label,
			fc.phase AS from_phase,
			fs.to_card_id,
			COALESCE(av_to_title.value   #>> '{}', '')  AS to_label,
			tc.phase AS to_phase,
			fs.label,
			COALESCE(fs.requires_role_id, 0) AS requires_role_id,
			COALESCE(r.name, '')             AS requires_role_name,
			fs.sort_order,
			(
				fs.requires_role_id IS NULL
				OR (SELECT yes FROM actor_has_system)
				OR EXISTS (
					SELECT 1 FROM actor_roles ar
					WHERE ar.role_id = fs.requires_role_id
					  AND (ar.scope_card_id IS NULL OR ar.scope_card_id = $3)
				)
			) AS allowed
		FROM flow f
		JOIN attribute_def ad ON ad.id = f.attribute_def_id
		JOIN attribute_value av
		  ON av.card_id = $2
		 AND av.attribute_def_id = f.attribute_def_id
		 AND jsonb_typeof(av.value) = 'number'
		JOIN flow_step fs
		  ON fs.flow_id = f.id
		 AND fs.from_card_id = (av.value)::text::bigint
		JOIN card fc ON fc.id = fs.from_card_id AND fc.deleted_at IS NULL
		JOIN card tc ON tc.id = fs.to_card_id   AND tc.deleted_at IS NULL
		LEFT JOIN role r ON r.id = fs.requires_role_id
		LEFT JOIN attribute_def ad_title ON ad_title.name = 'title'
		LEFT JOIN attribute_value av_from_title
		  ON av_from_title.card_id          = fs.from_card_id
		 AND av_from_title.attribute_def_id = ad_title.id
		LEFT JOIN attribute_value av_to_title
		  ON av_to_title.card_id          = fs.to_card_id
		 AND av_to_title.attribute_def_id = ad_title.id
		WHERE f.scope_card_id = $3
		ORDER BY ad.name, fs.sort_order, fs.label, fs.id
	`
	rows, err := db.Query(ctx, q, actorID, cardID, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AvailableTransition
	for rows.Next() {
		var r AvailableTransition
		if err := rows.Scan(
			&r.ID,
			&r.FlowID, &r.FlowName,
			&r.AttributeDefID, &r.AttributeDefName,
			&r.FromCardID, &r.FromLabel, &r.FromPhase,
			&r.ToCardID, &r.ToLabel, &r.ToPhase,
			&r.Label,
			&r.RequiresRoleID, &r.RequiresRoleName,
			&r.SortOrder,
			&r.Allowed,
		); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
