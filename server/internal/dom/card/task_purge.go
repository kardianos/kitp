// File card/task_purge.go: task.purge — hard delete a task and every
// piece of state that hangs off it. Distinct from card.delete, which
// is a soft-delete (deleted_at = now()); purge removes the row so it
// can't be undeleted. Used from the TaskDetail kebab's "Delete
// forever…" affordance behind a strong UI confirm.
//
// Unified-handler shape (Phase 2 of docs/UNIFIED_HANDLER_PLAN.md); the
// full cascade + refusal lattice lives in
// db/schema/functions/task_purge_batch.sql.
package card

import (
	"context"
	"reflect"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

// TaskPurgeInput targets one task for hard-delete.
type TaskPurgeInput struct {
	CardID int64 `json:"card_id,string" mcp:"required,desc=task card id to permanently delete"`
}

// TaskPurgeOutput surfaces what was actually removed so the client
// can refresh the right surfaces (or just navigate back).
type TaskPurgeOutput struct {
	OK              bool    `json:"ok" mcp:"desc=true on success"`
	PurgedCardIDs   []int64 `json:"purged_card_ids" mcp:"desc=every card id that was removed (the task + cascaded comms + reply_bodies)"`
	PurgedReplyBody []int64 `json:"purged_reply_body_ids,omitempty" mcp:"desc=reply_body card ids removed because their parent comm was purged"`
}

// RegisterTaskPurge installs the handler. Manager/admin only.
func RegisterTaskPurge(_ *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "task",
		Action:       "purge",
		Doc:          "Permanently delete a task (and its comms / reply_bodies / attachments / activity). Refuses when live sub-tasks or flow references exist. UI must gate this behind a strong confirm.",
		InputType:    reflect.TypeFor[TaskPurgeInput](),
		OutputType:   reflect.TypeFor[TaskPurgeOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "card.delete",
		CardTypeID:   cardTypeFromTaskPurgeInput,
		// Unified handler — body lives in
		// db/schema/functions/task_purge_batch.sql.
		SQLFunc: "task_purge_batch",
	})
}

func cardTypeFromTaskPurgeInput(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	return schema.CardTypeIDByCardID(ctx, pool, raw.(TaskPurgeInput).CardID)
}
