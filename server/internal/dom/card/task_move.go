// File card/task_move.go: task.move — re-parent a task under a different
// project, clearing per-project attributes (status / milestone_ref /
// component_ref / tags) so the user re-classifies in the destination.
//
// Unified-handler shape (Phase 2 of docs/UNIFIED_HANDLER_PLAN.md); body
// lives in db/schema/functions/task_move_batch.sql. Sub-task cascade /
// break semantics, default intake-status resolution, per-attribute
// validation, and the "break dangling parent_task" cleanup all live in
// the PL/pgSQL function.
package card

import (
	"context"
	"reflect"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

// TaskMoveInput bumps `card_id` (a task) under `new_project_id` and
// optionally re-classifies it in the destination project.
//
// All four classification fields are optional. When set, they must
// reference cards parented under `new_project_id` (cross-project
// pickers won't compose). Missing status defaults to the destination
// project's intake status (lowest-sort-order status whose phase =
// 'triage'), falling back to the first 'active' status, then to any
// status at all — every project has at least one because tasks
// require a status edge.
type TaskMoveInput struct {
	CardID         int64   `json:"card_id,string" mcp:"required,desc=id of the task to move"`
	NewProjectID   int64   `json:"new_project_id,string" mcp:"required,desc=destination project card id"`
	NewStatusID    int64   `json:"new_status_id,string,omitempty" mcp:"desc=destination status id (defaults to intake of new project)"`
	NewMilestoneID int64   `json:"new_milestone_id,string,omitempty" mcp:"desc=optional milestone in the destination project"`
	NewComponentID int64   `json:"new_component_id,string,omitempty" mcp:"desc=optional component in the destination project"`
	NewTagIDs      reg.IDs `json:"new_tag_ids,omitempty" mcp:"desc=optional tag ids in the destination project"`
	// SubtaskStrategy is "cascade" (default) or "break". Empty input is
	// treated as cascade.
	SubtaskStrategy string `json:"subtask_strategy,omitempty" mcp:"desc=cascade (default) or break — controls descendant sub-task handling"`
}

// TaskMoveOutput reports what actually moved so the client can
// refresh the right cards.
type TaskMoveOutput struct {
	// MovedCardIDs is the task itself plus every descendant that
	// rode along in cascade mode (just [card_id] in break mode).
	MovedCardIDs []int64 `json:"moved_card_ids" mcp:"desc=ids of every card whose parent_card_id changed"`
	// BrokenChildIDs is the direct children whose parent_task was
	// cleared in break mode. Empty in cascade mode.
	BrokenChildIDs []int64 `json:"broken_child_ids,omitempty" mcp:"desc=children whose parent_task was cleared (break mode only)"`
	// ResolvedStatusID is the status applied — useful when the
	// caller let the server pick the intake default.
	ResolvedStatusID int64 `json:"resolved_status_id,string" mcp:"desc=the status id applied to the moved task(s)"`
}

// RegisterTaskMove installs the handler. Manager / admin only — the
// move spans two projects and the existing card.update grant on the
// SOURCE alone isn't enough.
func RegisterTaskMove(_ *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "task",
		Action:       "move",
		Doc:          "Bump a task (and optionally its sub-tree) to a different project, clearing per-project classification so the user re-classifies in the destination.",
		InputType:    reflect.TypeFor[TaskMoveInput](),
		OutputType:   reflect.TypeFor[TaskMoveOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "card.update",
		CardTypeID:   cardTypeFromTaskMoveInput,
		// Unified handler — body lives in
		// db/schema/functions/task_move_batch.sql.
		SQLFunc: "task_move_batch",
	})
}

func cardTypeFromTaskMoveInput(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	return schema.CardTypeIDByCardID(ctx, pool, raw.(TaskMoveInput).CardID)
}
