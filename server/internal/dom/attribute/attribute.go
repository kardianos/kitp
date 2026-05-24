// Package attribute holds attribute.update — the canonical event-sourced
// write path. Every attribute change generates an activity row and an
// upsert into attribute_value, both written by the PL/pgSQL function
// `attribute_update_batch` (see db/schema/functions/...). All
// validation (card existence, edge, required-removal, project-scope,
// screen-uniqueness, flow gate) lives inside that function per Phase 2
// of docs/UNIFIED_HANDLER_PLAN.md.
package attribute

import (
	"bytes"
	"context"
	"encoding/json"
	"reflect"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

// UpdateInput is one row of attribute.update.
type UpdateInput struct {
	CardID        int64           `json:"card_id,string" mcp:"required,desc=id of the card whose attribute is being updated"`
	AttributeName string          `json:"attribute_name" mcp:"required,desc=name of the attribute_def to write"`
	Value         json.RawMessage `json:"value" mcp:"required,desc=new JSON value; literal null requests removal"`
}

// UpdateOutput is the per-row reply.
type UpdateOutput struct {
	OK         bool            `json:"ok" mcp:"desc=true on success"`
	ActivityID int64           `json:"activity_id,string" mcp:"desc=id of the activity row recording the change"`
	PrevValue  json.RawMessage `json:"prev_value,omitempty" mcp:"desc=previous JSON value, if any"`
}

// Register installs the handler. The `_ *store.Pool` arg is preserved
// for call-site symmetry with the other domain Register functions.
func Register(_ *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "attribute",
		Action:       "update",
		Doc:          "Set an attribute value on a card; emits one activity row and one upsert per write.",
		InputType:    reflect.TypeFor[UpdateInput](),
		OutputType:   reflect.TypeFor[UpdateOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "card.update",
		CardTypeID:   cardTypeFromCardID,
		// Unified handler — body lives in
		// db/schema/functions/attribute_update_batch.sql. Per Phase 2
		// of docs/UNIFIED_HANDLER_PLAN.md the SQL function now owns the
		// full validate + write pipeline.
		SQLFunc: "attribute_update_batch",
	})
}

// cardTypeFromCardID resolves the card_type_id for the targeted card so the
// dispatcher can authorize the (card_type, process) pair.
func cardTypeFromCardID(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	return schema.CardTypeIDByCardID(ctx, pool, raw.(UpdateInput).CardID)
}

// isJSONNull reports whether raw is a JSON null literal (or empty).
// Still used by scope.go (ParseCardRefValue) and screen.go even though
// validateUpdate/runUpdate are gone — keeps the helper close to its
// remaining callers.
func isJSONNull(b []byte) bool {
	if len(b) == 0 {
		return true
	}
	return bytes.Equal(bytes.TrimSpace(b), []byte("null"))
}
