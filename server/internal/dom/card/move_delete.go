// File card/move_delete.go: card.delete (soft), card.undelete, card.move.
// All three are unified handlers — bodies live in
// db/schema/functions/card_*_batch.sql.
package card

import (
	"context"
	"reflect"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

// DeleteInput is one card to soft-delete.
type DeleteInput struct {
	CardID int64 `json:"card_id,string" mcp:"required,desc=id of the card to soft-delete"`
}

// DeleteOutput acknowledges success.
type DeleteOutput struct {
	OK         bool  `json:"ok" mcp:"desc=true on success"`
	ActivityID int64 `json:"activity_id,string" mcp:"desc=id of the activity row recording the delete"`
}

// UndeleteInput is one card to undelete.
type UndeleteInput struct {
	CardID int64 `json:"card_id,string" mcp:"required,desc=id of the card to undelete"`
}

// UndeleteOutput acknowledges success.
type UndeleteOutput struct {
	OK         bool  `json:"ok" mcp:"desc=true on success"`
	ActivityID int64 `json:"activity_id,string" mcp:"desc=id of the activity row recording the undelete"`
}

// MoveInput moves card_id under new_parent_card_id.
type MoveInput struct {
	CardID            int64 `json:"card_id,string" mcp:"required,desc=id of the card to move"`
	NewParentCardID   int64 `json:"new_parent_card_id,string" mcp:"required,desc=id of the new parent card"`
}

// MoveOutput acknowledges success.
type MoveOutput struct {
	OK         bool  `json:"ok" mcp:"desc=true on success"`
	ActivityID int64 `json:"activity_id,string" mcp:"desc=id of the activity row recording the move"`
}

// RegisterMoveDelete is called from card.Register to install the three
// secondary handlers; placed in a separate file to keep card.go readable.
func RegisterMoveDelete(p *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "card",
		Action:       "delete",
		Doc:          "Soft-delete a card; the row is hidden from default selects but kept for activity history.",
		InputType:    reflect.TypeFor[DeleteInput](),
		OutputType:   reflect.TypeFor[DeleteOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "card.delete",
		CardTypeID:   cardTypeFromDeleteInput,
		// Unified handler — body lives in
		// db/schema/functions/card_delete_batch.sql.
		SQLFunc: "card_delete_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "card",
		Action:       "undelete",
		Doc:          "Undo a previous soft-delete by clearing deleted_at on the card.",
		InputType:    reflect.TypeFor[UndeleteInput](),
		OutputType:   reflect.TypeFor[UndeleteOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "card.delete",
		CardTypeID:   cardTypeFromUndeleteInput,
		// Unified handler — body lives in
		// db/schema/functions/card_undelete_batch.sql.
		SQLFunc: "card_undelete_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "card",
		Action:       "move",
		Doc:          "Re-parent a card under a different parent of a compatible card_type.",
		InputType:    reflect.TypeFor[MoveInput](),
		OutputType:   reflect.TypeFor[MoveOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "card.update",
		CardTypeID:   cardTypeFromMoveInput,
		// Unified handler — body lives in
		// db/schema/functions/card_move_batch.sql.
		SQLFunc: "card_move_batch",
	})
}

func cardTypeFromDeleteInput(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	return schema.CardTypeIDByCardID(ctx, pool, raw.(DeleteInput).CardID)
}

func cardTypeFromUndeleteInput(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	return schema.CardTypeIDByCardID(ctx, pool, raw.(UndeleteInput).CardID)
}

func cardTypeFromMoveInput(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	return schema.CardTypeIDByCardID(ctx, pool, raw.(MoveInput).CardID)
}


