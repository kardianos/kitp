// Package workflowtransition exposes CRUD over the workflow_transition
// table — the state graph for a workflow_def card. See
// WORKFLOW_HYBRID_PLAN.md and IMPL_PLAN_SCOPED_WORKFLOW Phase 2.
//
// Endpoints:
//   - workflow_transition.set — admin-only; bulk-replaces every row for a
//     given workflow_def_id with the supplied list. Implementation: one
//     DELETE + one INSERT per call, both inside the batch transaction.
//   - workflow_transition.list — read every transition for a workflow_def.
//
// Reachability is consulted in-line by the status-update guard (see
// dom/workflowdef and dom/attribute) via the Reachable helper.
package workflowtransition

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// Row is one transition.
type Row struct {
	WorkflowDefID  int64           `json:"workflow_def_id" mcp:"desc=workflow_def card id"`
	FromState      string          `json:"from_state" mcp:"desc=transition origin state"`
	ToState        string          `json:"to_state" mcp:"desc=transition target state"`
	ProcessID      *int32          `json:"process_id,omitempty" mcp:"desc=optional process to fire on successful transition"`
	AggregateGuard json.RawMessage `json:"aggregate_guard,omitempty" mcp:"desc=optional JSON predicate (Phase 5 aggregate guard)"`
}

// ListInput selects every transition for a workflow.
type ListInput struct {
	WorkflowDefID int64 `json:"workflow_def_id" mcp:"required,desc=workflow_def card id"`
}

// ListOutput per-input snapshot.
type ListOutput struct {
	Rows []Row `json:"rows" mcp:"desc=every transition for the workflow_def"`
}

// SetInput replaces every row for the workflow_def. The supplied list is
// the new state of the world; rows not in the list are deleted.
type SetInput struct {
	WorkflowDefID int64       `json:"workflow_def_id" mcp:"required,desc=workflow_def card id"`
	Transitions   []Transition `json:"transitions" mcp:"required,desc=every transition for the workflow"`
}

// Transition is one row in the SetInput payload.
type Transition struct {
	FromState      string          `json:"from_state" mcp:"required,desc=origin state"`
	ToState        string          `json:"to_state" mcp:"required,desc=target state"`
	ProcessID      *int32          `json:"process_id,omitempty" mcp:"desc=optional process to fire on transition"`
	AggregateGuard json.RawMessage `json:"aggregate_guard,omitempty" mcp:"desc=optional JSON predicate (Phase 5)"`
}

// SetOutput acks the bulk replace.
type SetOutput struct {
	OK    bool `json:"ok" mcp:"desc=true on success"`
	Count int  `json:"count" mcp:"desc=number of rows after the replace"`
}

var authzPool *store.Pool

// Register installs the handlers.
func Register(p *store.Pool) {
	authzPool = p
	reg.Register(reg.Handler{
		Endpoint:     "workflow_transition",
		Action:       "list",
		Doc:          "List every transition for a workflow_def.",
		InputType:    reflect.TypeFor[ListInput](),
		OutputType:   reflect.TypeFor[ListOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Run:          runList(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "workflow_transition",
		Action:       "set",
		Doc:          "Admin-only: bulk-replace every transition for a workflow_def in one tx.",
		InputType:    reflect.TypeFor[SetInput](),
		OutputType:   reflect.TypeFor[SetOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		Run:          runSet(p),
	})
}

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
		return fmt.Errorf("workflow_transition.authz: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("workflow_transition: actor %d is not an admin", userID)
	}
	return nil
}

func runList(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(ListInput)
			rows, err := tx.Query(ctx, `
				SELECT workflow_def_id, from_state, to_state, process_id, aggregate_guard
				FROM workflow_transition
				WHERE workflow_def_id = $1
				ORDER BY from_state, to_state
			`, in.WorkflowDefID)
			if err != nil {
				return nil, fmt.Errorf("workflow_transition.list: %w", err)
			}
			var out []Row
			for rows.Next() {
				var r Row
				if err := rows.Scan(&r.WorkflowDefID, &r.FromState, &r.ToState, &r.ProcessID, &r.AggregateGuard); err != nil {
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

// runSet bulk-replaces. // arrayPath
func runSet(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(SetInput)
			if in.WorkflowDefID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "workflow_transition.set: workflow_def_id is required"}
			}
			// Validate that the referenced card is a workflow_def.
			var ctName string
			if err := tx.QueryRow(ctx, `
				SELECT ct.name FROM card c JOIN card_type ct ON ct.id = c.card_type_id WHERE c.id = $1
			`, in.WorkflowDefID).Scan(&ctName); err != nil {
				if err == pgx.ErrNoRows {
					return nil, &reg.HandlerError{InputIndex: i, Code: "not_found",
						Message: fmt.Sprintf("workflow_transition.set: workflow_def %d not found", in.WorkflowDefID)}
				}
				return nil, fmt.Errorf("workflow_transition.set: lookup: %w", err)
			}
			if ctName != "workflow_def" {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "workflow_transition.set: target card is not a workflow_def"}
			}

			if _, err := tx.Exec(ctx,
				`DELETE FROM workflow_transition WHERE workflow_def_id = $1`, in.WorkflowDefID); err != nil {
				return nil, fmt.Errorf("workflow_transition.set: delete: %w", err)
			}

			for j, t := range in.Transitions {
				if t.FromState == "" || t.ToState == "" {
					return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
						Message: fmt.Sprintf("workflow_transition.set: transitions[%d] missing from_state or to_state", j)}
				}
				if _, err := tx.Exec(ctx, `
					INSERT INTO workflow_transition (workflow_def_id, from_state, to_state, process_id, aggregate_guard)
					VALUES ($1, $2, $3, $4, $5)
				`, in.WorkflowDefID, t.FromState, t.ToState, t.ProcessID, normalizeJSON(t.AggregateGuard)); err != nil {
					return nil, fmt.Errorf("workflow_transition.set: insert: %w", err)
				}
			}
			outs[i] = SetOutput{OK: true, Count: len(in.Transitions)}
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}

func normalizeJSON(j json.RawMessage) any {
	if len(j) == 0 || string(j) == "null" {
		return nil
	}
	return j
}

// Reachable returns true if `to` is reachable from `from` for the
// given workflow_def. The optional process_id and aggregate_guard are
// returned alongside. Used by the status-update guard.
func Reachable(ctx context.Context, tx pgx.Tx, workflowDefID int64, from, to string) (bool, *int32, error) {
	var procID *int32
	err := tx.QueryRow(ctx, `
		SELECT process_id FROM workflow_transition
		WHERE workflow_def_id = $1 AND from_state = $2 AND to_state = $3
	`, workflowDefID, from, to).Scan(&procID)
	if err == pgx.ErrNoRows {
		return false, nil, nil
	}
	if err != nil {
		return false, nil, fmt.Errorf("workflow_transition.Reachable: %w", err)
	}
	return true, procID, nil
}

// AggregateGuardFor returns the aggregate_guard JSON for a transition
// row, or nil if no guard is configured. Returns (nil, nil) for an
// unreachable transition.
func AggregateGuardFor(ctx context.Context, tx pgx.Tx, workflowDefID int64, from, to string) (json.RawMessage, error) {
	var raw json.RawMessage
	err := tx.QueryRow(ctx, `
		SELECT aggregate_guard FROM workflow_transition
		WHERE workflow_def_id = $1 AND from_state = $2 AND to_state = $3
	`, workflowDefID, from, to).Scan(&raw)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("workflow_transition.AggregateGuardFor: %w", err)
	}
	return raw, nil
}
