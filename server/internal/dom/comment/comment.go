// Package comment exposes comment.insert. A comment is a special activity
// row of kind='comment' that points at a comment_body row via
// value_new->>'comment_body_id'. Both rows are inserted in one CTE per Run.
package comment

import (
	"context"
	"errors"
	"fmt"
	"reflect"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

// InsertInput is one comment to post.
type InsertInput struct {
	CardID int64  `json:"card_id,string" mcp:"required,desc=id of the card being commented on"`
	Body   string `json:"body" mcp:"required,desc=free-form comment text body"`
}

// InsertOutput surfaces the new ids so a UI can route by them.
type InsertOutput struct {
	OK            bool  `json:"ok" mcp:"desc=true on success"`
	ActivityID    int64 `json:"activity_id,string" mcp:"desc=id of the activity row created for this comment"`
	CommentBodyID int64 `json:"comment_body_id,string" mcp:"desc=id of the comment_body row holding the text"`
}

// Register installs comment.insert and comment.update.
func Register(p *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "comment",
		Action:       "insert",
		Doc:          "Post a comment on a card; writes one comment_body row and one activity row of kind=comment.",
		InputType:    reflect.TypeFor[InsertInput](),
		OutputType:   reflect.TypeFor[InsertOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "comment.post",
		CardTypeID:   cardTypeFromInput,
		// Unified handler — body lives in
		// db/schema/functions/comment_insert_batch.sql. See
		// docs/UNIFIED_HANDLER_PLAN.md Phase 1.
		SQLFunc: "comment_insert_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "comment",
		Action:       "update",
		Doc:          "Edit the body of an existing comment. Updates the linked comment_body row in place and inserts a new activity row of kind='comment_edit' for the audit trail. Only the original author may edit.",
		InputType:    reflect.TypeFor[UpdateInput](),
		OutputType:   reflect.TypeFor[UpdateOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "comment.edit",
		CardTypeID:   cardTypeFromUpdateInput,
		// The input carries activity_id, not card_id, so the per-row
		// scope pass needs an explicit resolver to dereference it to the
		// activity's card (then walk that card → project). Without this a
		// project-scoped manager editing a comment would be denied
		// (BE-H3 / A2).
		ScopeCardID: scopeCardFromUpdateInput,
		// Unified handler — body lives in
		// db/schema/functions/comment_update_batch.sql. See
		// docs/UNIFIED_HANDLER_PLAN.md Phase 2.
		SQLFunc: "comment_update_batch",
	})
}

func cardTypeFromInput(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	return schema.CardTypeIDByCardID(ctx, pool, raw.(InsertInput).CardID)
}

// UpdateInput is one comment edit.
type UpdateInput struct {
	ActivityID int64  `json:"activity_id,string" mcp:"required,desc=id of the activity row (kind='comment') whose body is being edited"`
	Body       string `json:"body" mcp:"required,desc=new comment body text; replaces the linked comment_body row in place"`
}

// UpdateOutput surfaces the edit-activity id so callers can route on it.
type UpdateOutput struct {
	OK             bool  `json:"ok" mcp:"desc=true on success"`
	EditActivityID int64 `json:"edit_activity_id,string" mcp:"desc=id of the new activity row of kind='comment_edit' inserted for the audit trail"`
}

func cardTypeFromUpdateInput(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	cardID, err := scopeCardFromUpdateInput(ctx, pool, raw)
	if err != nil {
		return 0, err
	}
	if cardID == 0 {
		return 0, nil
	}
	return schema.CardTypeIDByCardID(ctx, pool, cardID)
}

// scopeCardFromUpdateInput dereferences the edited activity to the card
// it belongs to so the per-row scope pass can walk that card → project.
// Used as reg.Handler.ScopeCardID for comment.update (BE-H3 / A2).
// Returns (0, nil) when the activity is missing — the handler's own
// validation surfaces the proper not-found error.
func scopeCardFromUpdateInput(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	in := raw.(UpdateInput)
	var cardID int64
	err := pool.QueryRow(ctx, `SELECT card_id FROM activity WHERE id = $1`, in.ActivityID).Scan(&cardID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, nil
		}
		return 0, fmt.Errorf("comment.update: lookup card_id from activity: %w", err)
	}
	return cardID, nil
}

