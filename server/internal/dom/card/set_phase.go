// File card/set_phase.go: card.set_phase — write the structural `phase`
// column on a value-card (triage / active / terminal). Unified-handler
// shape (Phase 2 of docs/UNIFIED_HANDLER_PLAN.md); body lives in
// db/schema/functions/card_set_phase_batch.sql.
package card

import (
	"context"
	"reflect"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

// SetPhaseInput targets one card for a phase change.
type SetPhaseInput struct {
	CardID int64  `json:"card_id,string" mcp:"required,desc=id of the card whose phase column is being updated"`
	Phase  string `json:"phase" mcp:"required,desc=new phase value; must be triage, active, or terminal"`
}

// SetPhaseOutput acknowledges success.
type SetPhaseOutput struct {
	OK         bool  `json:"ok" mcp:"desc=true on success"`
	ActivityID int64 `json:"activity_id,string" mcp:"desc=id of the activity row recording the phase change"`
}

// RegisterSetPhase installs the handler; called from card.Register.
func RegisterSetPhase(_ *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "card",
		Action:       "set_phase",
		Doc:          "Set the structural phase column on a value-card (triage|active|terminal); emits an activity row recording the change.",
		InputType:    reflect.TypeFor[SetPhaseInput](),
		OutputType:   reflect.TypeFor[SetPhaseOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "card.update",
		CardTypeID:   cardTypeFromSetPhaseInput,
		// Unified handler — body lives in
		// db/schema/functions/card_set_phase_batch.sql.
		SQLFunc: "card_set_phase_batch",
	})
}

func cardTypeFromSetPhaseInput(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	return schema.CardTypeIDByCardID(ctx, pool, raw.(SetPhaseInput).CardID)
}
