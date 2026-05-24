// Package activity provides activity.select — paged, chronological
// activity for a card, with comments inlined via a join to comment_body.
package activity

import (
	"encoding/json"
	"reflect"
	"time"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// SelectInput selects activity with optional cursor paging.
//
// CardID is optional: when zero/null the handler returns activity across
// every card the actor can see (cross-card mode). When non-zero, only
// rows for that card are returned. BeforeActivityID is exclusive: the
// page contains rows with id < cursor.
type SelectInput struct {
	CardID           int64  `json:"card_id,string,omitempty" mcp:"desc=card whose activity is being read; omit for cross-card mode"`
	Limit            *int   `json:"limit,omitempty" mcp:"desc=optional row cap; defaults to 200"`
	BeforeActivityID *int64 `json:"before_activity_id,string,omitempty" mcp:"desc=cursor; only return activity rows with id < this"`
}

// Row is one denormalized activity row. CardID is set so cross-card
// callers can route per-row links back to a card.
type Row struct {
	ID            int64           `json:"id,string" mcp:"desc=activity row id"`
	CardID        int64           `json:"card_id,string" mcp:"desc=card the activity belongs to"`
	Kind          string          `json:"kind" mcp:"desc=activity kind (card_create, attr_update, comment, ...)"`
	AttributeName *string         `json:"attribute_name,omitempty" mcp:"desc=attribute name when kind is attr_update"`
	ValueOld      json.RawMessage `json:"value_old,omitempty" mcp:"desc=previous JSON value of the attribute, if any"`
	ValueNew      json.RawMessage `json:"value_new,omitempty" mcp:"desc=new JSON value of the attribute, if any"`
	CommentBody   *string         `json:"comment_body,omitempty" mcp:"desc=resolved comment body when kind is comment"`
	ActorID       int64           `json:"actor_id,string" mcp:"desc=user id that made the change"`
	CreatedAt     time.Time       `json:"created_at" mcp:"desc=activity timestamp"`
}

// SelectOutput is the per-input reply.
type SelectOutput struct {
	Rows []Row `json:"rows" mcp:"desc=matching activity rows in chronological order"`
}

// Register installs the handler.
func Register(p *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "activity",
		Action:       "select",
		Doc:          "Read paged activity for one card in chronological order; comments include their body inline.",
		InputType:    reflect.TypeFor[SelectInput](),
		OutputType:   reflect.TypeFor[SelectOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		// Unified handler — body lives in
		// db/schema/functions/activity_select_batch.sql.
		SQLFunc: "activity_select_batch",
	})
	_ = p
}
