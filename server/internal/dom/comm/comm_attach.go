package comm

// comm.attach — move a thread (comm card) onto a task, or back into its
// project as a thread on its own. See docs/CONVERSATIONS.md and
// db/schema/functions/comm_attach_batch.sql. comm.attachment_to_task —
// move a file that came by email from the thread onto its task
// (comm_attachment_to_task_batch.sql).

import (
	"context"
	"reflect"
	"time"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// CommAttachInput names the thread and where it goes.
type CommAttachInput struct {
	CommID int64 `json:"comm_id,string" mcp:"required,desc=comm card id (the thread) to move"`
	TaskID int64 `json:"task_id,string,omitempty" mcp:"desc=task card id to attach the thread to, in the same project; 0 or omitted detaches it back into its project as a thread on its own"`
	// NewTaskTitle, with no TaskID: make a task with this title in the
	// thread's project and attach the thread to it, in one transaction.
	NewTaskTitle string `json:"new_task_title,omitempty" mcp:"desc=with no task_id: make a task with this title in the thread's project and attach the thread to it (Make a task)"`
}

// CommAttachmentToTaskInput names a file on a thread to move onto the
// thread's task ("Add to task").
type CommAttachmentToTaskInput struct {
	CommID       int64 `json:"comm_id,string" mcp:"required,desc=comm card id (the thread) the file is on"`
	AttachmentID int64 `json:"attachment_id,string" mcp:"required,desc=attachment id of a file that came by email (on the thread)"`
}

// CommAttachmentToTaskOutput is the task's file: the moved one, or the
// task's own copy of the same bytes.
type CommAttachmentToTaskOutput struct {
	AttachmentID int64 `json:"attachment_id,string" mcp:"desc=the file's attachment id on the task (the task's own copy when it already had the same bytes)"`
	TaskID       int64 `json:"task_id,string" mcp:"desc=the task the file is now on"`
}

// CommAttachOutput reports where the thread now sits.
type CommAttachOutput struct {
	CommID   int64 `json:"comm_id,string" mcp:"desc=the thread's comm card id"`
	ParentID int64 `json:"parent_id,string" mcp:"desc=the thread's new parent: the task, or the project when detached"`
	TaskID   int64 `json:"task_id,string" mcp:"desc=the task the thread is on; 0 when detached"`
}

func registerCommAttach(_ *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:   "comm",
		Action:     "attach",
		Doc:        "Move a thread (comm card) onto a task in the same project, or detach it back into its project as a thread on its own (task_id 0); with new_task_title and no task_id, make a task with that title and attach the thread to it, in one go. Keeps both tasks' comms lists in step. Files stay where they are: a thread keeps the files that came by email (move one onto the task with comm.attachment_to_task). Refused while Tasks is switched off (area_off). Authz: card.update on comm (the dispatcher) plus card.update on task in the project, and card.create on task to make one (checked in SQL).",
		InputType:  reflect.TypeFor[CommAttachInput](),
		OutputType: reflect.TypeFor[CommAttachOutput](),
		// The dispatcher gates the thread itself: (comm, card.update), which
		// worker / manager hold (db/schema/seed.hcsv), scoped to the comm's
		// project. The input names comm_id, not card_id, so ScopeCardID
		// supplies the walk start. The SQL also checks (task, card.update)
		// in the project, since the task's comms list changes too.
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "card.update",
		CardTypeID:   commCardTypeID,
		ScopeCardID: func(_ context.Context, _ reg.ValidationPool, raw any) (int64, error) {
			return raw.(CommAttachInput).CommID, nil
		},
		Timeout: 10 * time.Second,
		SQLFunc: "comm_attach_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:   "comm",
		Action:     "attachment_to_task",
		Doc:        "Add to task: move a file that came by email (it lives on the thread) onto the thread's task, so it shows in the task's attachments; the messages that carried it keep their link. When the task already holds the same bytes, the messages link that file and the thread's copy goes — the task never has a file twice. Refused for a thread not on a task (not_on_task) and while Tasks is switched off (area_off). Authz: card.update on comm (the dispatcher) plus card.update on task in the project (checked in SQL).",
		InputType:  reflect.TypeFor[CommAttachmentToTaskInput](),
		OutputType: reflect.TypeFor[CommAttachmentToTaskOutput](),
		// The dispatcher gates the thread, as comm.attach does: (comm,
		// card.update), scoped to its project through ScopeCardID. The SQL
		// also checks (task, card.update), since the task's files change.
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "card.update",
		CardTypeID:   commCardTypeID,
		ScopeCardID: func(_ context.Context, _ reg.ValidationPool, raw any) (int64, error) {
			return raw.(CommAttachmentToTaskInput).CommID, nil
		},
		SQLFunc: "comm_attachment_to_task_batch",
	})
}
