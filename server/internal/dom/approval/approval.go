// Package approval exposes task APPROVAL REQUESTS: a request asks named
// people to approve or reject one of the task's status actions ("Approve:
// Review → Done"), and each decision is recorded on the task.
//
// Approvals are documentation, never a gate: nothing blocks or advances a
// status change. A request is an `approval` card under the task (action
// snapshot, approvers, note); a decision is an immutable approval_decision
// activity row on the task (with an optional reason stored like a comment
// body), so removing a request keeps its decisions. A vote belongs to the
// EDGE — the task moving from one specific status to another — and a
// request only asks people to vote on one. An edge's votes run in rounds:
// once the task reaches the edge's target they are settled, leaving the
// task's approval properties but staying on the task. See
// db/schema/functions/approval_*_batch.sql.
//
// What's waiting on whom is a property of the task, not an endpoint:
// card.select_with_attributes filters on approval_waiting_on ("vote needed
// from"), approval_state and approval_asked_at, sorts on the last two, and
// adds each row's approvals on with_approvals (approval_summary.sql).
//
// Endpoints:
//   - approval.set    — ask (create) or change who is asked / the note.
//   - approval.remove — withdraw a request.
//   - approval.decide — vote approve or reject, asked or not. Agents (via
//     MCP) can vote too: they're shown with their owner, and their vote
//     never stands in for a person who was asked.
//   - approval.list   — a task's requests, decisions and actions.
//
// Authz: set / remove gate on card.update of the parent task (like
// link.set), decide on comment.post of the task; the reads apply the
// task's visibility in SQL.
package approval

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

// SetInput is the wire payload for approval.set. Without ID it creates a
// request (task, from → to, approvers required); with ID it PATCHes the
// approvers and / or note. Note is a pointer so omit and clear differ.
type SetInput struct {
	ID           int64    `json:"id,string,omitempty" mcp:"desc=approval request id to change; omit to create a request"`
	TaskID       int64    `json:"task_id,string" mcp:"required,desc=task the request is on"`
	FromStatusID int64    `json:"from_status_id,string,omitempty" mcp:"desc=status the action starts from (create only), e.g. the Review status card id"`
	ToStatusID   int64    `json:"to_status_id,string,omitempty" mcp:"desc=status the action leads to (create only); from → to must be a step of the task's status flow"`
	ApproverIDs  []string `json:"approver_ids,omitempty" mcp:"desc=person card ids to ask (each a person with a login who can see the project); on update, replaces the list"`
	Note         *string  `json:"note,omitempty" mcp:"desc=optional message to the people asked; '' clears; omit to leave unchanged"`
}

// SetOutput surfaces the request id and what the call did.
type SetOutput struct {
	ApprovalID int64 `json:"approval_id,string" mcp:"desc=id of the created or updated approval request"`
	Created    bool  `json:"created" mcp:"desc=true when this call created the request"`
	Changed    bool  `json:"changed" mcp:"desc=true when anything was written"`
}

// RemoveInput names one request to withdraw.
type RemoveInput struct {
	ID int64 `json:"id,string" mcp:"required,desc=approval request id to remove (decisions already given stay in the task's history)"`
}

// RemoveOutput acknowledges the removal.
type RemoveOutput struct {
	Removed bool `json:"removed" mcp:"desc=true once the request is removed"`
}

// DecideInput records an approve / reject vote on a status edge, named by
// a request (ApprovalID, whose edge is used) or directly (FromStatusID →
// ToStatusID). Only the edge is stored.
type DecideInput struct {
	TaskID       int64  `json:"task_id,string" mcp:"required,desc=task decided on"`
	ApprovalID   int64  `json:"approval_id,string,omitempty" mcp:"desc=a request naming the edge to vote on; or give from_status_id and to_status_id"`
	FromStatusID int64  `json:"from_status_id,string,omitempty" mcp:"desc=without approval_id: status the edge starts from"`
	ToStatusID   int64  `json:"to_status_id,string,omitempty" mcp:"desc=without approval_id: status the edge leads to"`
	Decision     string `json:"decision" mcp:"required,desc='approve' or 'reject'; a later vote on the same edge supersedes an earlier one until the task reaches the edge's target"`
	Reason       string `json:"reason,omitempty" mcp:"desc=optional reason, shown with the decision in the task's comments"`
}

// DecideOutput names the decision row.
type DecideOutput struct {
	DecisionID int64 `json:"decision_id,string" mcp:"desc=activity id of the decision (the one already in force when unchanged)"`
	Changed    bool  `json:"changed" mcp:"desc=false when the same decision was already in force and no reason was given"`
}

// ListInput names the task whose approvals to read.
type ListInput struct {
	TaskID int64 `json:"task_id,string" mcp:"required,desc=task whose approvals to list"`
}

// StatusRef is a status value-card.
type StatusRef struct {
	ID    int64  `json:"id,string" mcp:"desc=status card id"`
	Label string `json:"label" mcp:"desc=status name"`
	Phase string `json:"phase" mcp:"desc=triage | active | terminal"`
}

// Action is one step of the task's status flow.
type Action struct {
	From  StatusRef `json:"from" mcp:"desc=status the action starts from"`
	To    StatusRef `json:"to" mcp:"desc=status it leads to"`
	Label string    `json:"label" mcp:"desc=the action's name, e.g. 'Approve'"`
}

// Approver is one person a request asks.
type Approver struct {
	PersonID int64  `json:"person_id,string" mcp:"desc=person card id"`
	Name     string `json:"name" mcp:"desc=the person's name"`
}

// Request is one live approval request.
type Request struct {
	ID            int64      `json:"id,string" mcp:"desc=approval request id"`
	From          StatusRef  `json:"from" mcp:"desc=status the action starts from"`
	To            StatusRef  `json:"to" mcp:"desc=status it leads to"`
	Action        string     `json:"action" mcp:"desc=the action's name when asked"`
	Note          string     `json:"note" mcp:"desc=message to the people asked"`
	RequestedByID int64      `json:"requested_by_id,string" mcp:"desc=user who asked"`
	RequestedBy   string     `json:"requested_by" mcp:"desc=who asked (an agent is named with its owner)"`
	RequestedAt   time.Time  `json:"requested_at" mcp:"desc=when it was asked"`
	ReachedAt     *time.Time `json:"reached_at,omitempty" mcp:"desc=when the task got to the edge's target after the request (settled); absent while open"`
	Approvers     []Approver `json:"approvers" mcp:"desc=the people asked"`
}

// Decision is one recorded approve / reject.
type Decision struct {
	ID         int64      `json:"id,string" mcp:"desc=activity id of the decision"`
	ByID       int64      `json:"by_id,string" mcp:"desc=user who decided"`
	By         string     `json:"by" mcp:"desc=who decided; an agent is named with its owner, e.g. 'claude (for Dana)'"`
	PersonID   string     `json:"person_id" mcp:"desc=their person card id; empty when their login has none"`
	Decision   string     `json:"decision" mcp:"desc=approve | reject"`
	FromID     string     `json:"from_id" mcp:"desc=status the action starts from"`
	ToID       string     `json:"to_id" mcp:"desc=status it leads to"`
	Action     string     `json:"action" mcp:"desc=the action's name"`
	Status     *StatusRef `json:"status,omitempty" mcp:"desc=the task's status when decided"`
	Reason     string     `json:"reason" mcp:"desc=the reason given, if any"`
	At         time.Time  `json:"at" mcp:"desc=when decided"`
	Settled    bool       `json:"settled" mcp:"desc=true when cast before the task last reached the edge's target: a finished round"`
	Stale      bool       `json:"stale" mcp:"desc=true when the task has since moved to a status other than the edge's target"`
}

// ListOutput is a task's approvals.
type ListOutput struct {
	Status    *StatusRef `json:"status,omitempty" mcp:"desc=the task's current status"`
	Actions   []Action   `json:"actions" mcp:"desc=every step of the task's status flow"`
	Requests  []Request  `json:"requests" mcp:"desc=live approval requests, oldest first"`
	Decisions []Decision `json:"decisions" mcp:"desc=every decision on the task, newest first"`
}

// Register installs the approval.* dispatcher endpoints.
func Register(_ *store.Pool) {
	writers := []string{"worker", "manager", "admin"}
	taskCardType := func(id func(any) int64) func(context.Context, reg.ValidationPool, any) (int64, error) {
		return func(ctx context.Context, pool reg.ValidationPool, in any) (int64, error) {
			return schema.CardTypeIDByCardID(ctx, pool, id(in))
		}
	}
	scope := func(id func(any) int64) func(context.Context, reg.ValidationPool, any) (int64, error) {
		return func(_ context.Context, _ reg.ValidationPool, in any) (int64, error) {
			return id(in), nil
		}
	}
	setTask := func(in any) int64 { return in.(SetInput).TaskID }
	decideTask := func(in any) int64 { return in.(DecideInput).TaskID }

	reg.Register(reg.Handler{
		Endpoint:     "approval",
		Action:       "set",
		Doc:          "Ask people to approve or reject one of a task's status actions (from_status_id → to_status_id, a step of its flow, e.g. Review → Done), or change who is asked / the note (with id). Approvals are a record, not a gate: nothing blocks or moves the task. Each person asked must have a login and see the project. Requires edit rights on the task.",
		InputType:    reflect.TypeFor[SetInput](),
		OutputType:   reflect.TypeFor[SetOutput](),
		AllowedRoles: writers,
		// Gate on the task's card.update (like link.set): the grant's
		// card_type is the task's, the scope pass walks task → project.
		ProcessName: "card.update",
		CardTypeID:  taskCardType(setTask),
		ScopeCardID: scope(setTask),
		// Unified handler — body lives in
		// db/schema/functions/approval_set_batch.sql.
		SQLFunc: "approval_set_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "approval",
		Action:       "remove",
		Doc:          "Withdraw an approval request (id from approval.list). Decisions already given stay in the task's history. Requires edit rights on the task.",
		InputType:    reflect.TypeFor[RemoveInput](),
		OutputType:   reflect.TypeFor[RemoveOutput](),
		AllowedRoles: writers,
		ProcessName:  "card.update",
		// Input carries only the request id: dereference request → task for
		// the grant's card_type; the scope pass walks request → task →
		// project on its own.
		CardTypeID: parentCardTypeOfRequest,
		ScopeCardID: func(_ context.Context, _ reg.ValidationPool, in any) (int64, error) {
			return in.(RemoveInput).ID, nil
		},
		// Unified handler — body lives in
		// db/schema/functions/approval_remove_batch.sql.
		SQLFunc: "approval_remove_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "approval",
		Action:       "decide",
		Doc:          "Vote approve or reject on a status edge of a task — the task moving from one status to another, named by a request (approval_id) or directly (from_status_id → to_status_id) — with an optional reason that shows in the task's comments. A later vote supersedes an earlier one until the task reaches the edge's target, which settles the round. A record only: it moves nothing. An agent's vote is shown with its owner ('claude (for Dana)') but doesn't answer a request that asked the owner. Requires comment rights on the task.",
		InputType:    reflect.TypeFor[DecideInput](),
		OutputType:   reflect.TypeFor[DecideOutput](),
		AllowedRoles: writers,
		ProcessName:  "comment.post",
		CardTypeID:   taskCardType(decideTask),
		ScopeCardID:  scope(decideTask),
		// Unified handler — body lives in
		// db/schema/functions/approval_decide_batch.sql.
		SQLFunc: "approval_decide_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "approval",
		Action:       "list",
		Doc:          "A task's approvals: its current status, its status-flow actions, the live requests (who is asked, by whom, when, and when settled) and every decision (newest first, with reason and whether the task has since moved on). To find the tasks waiting on someone's vote, use card.select_with_attributes with the tree leaf {attr: approval_waiting_on, op: in, values: ['@me' or person ids]} (and with_approvals for each row's tally).",
		InputType:    reflect.TypeFor[ListInput](),
		OutputType:   reflect.TypeFor[ListOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		IsRead:       true,
		// Unified handler — body lives in
		// db/schema/functions/approval_list_batch.sql.
		SQLFunc: "approval_list_batch",
	})
}

// parentCardTypeOfRequest resolves the card_type of the request's parent
// task so approval.remove is gated on (task, card.update) like
// approval.set. Returns 0 (skip the grant check) when the id doesn't
// resolve; the SQL function then reports approval_not_found.
func parentCardTypeOfRequest(ctx context.Context, pool reg.ValidationPool, in any) (int64, error) {
	b := named.New()
	b.Set("id", in.(RemoveInput).ID)
	sql, args, err := b.Compile(`
		SELECT p.card_type_id
		FROM card a
		JOIN card p ON p.id = a.parent_card_id
		WHERE a.id = :id
	`)
	if err != nil {
		return 0, fmt.Errorf("approval.remove: compile: %w", err)
	}
	var ctID int64
	if err := pool.QueryRow(ctx, sql, args...).Scan(&ctID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, nil
		}
		return 0, fmt.Errorf("approval.remove: card_type lookup: %w", err)
	}
	return ctID, nil
}
