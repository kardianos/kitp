// Package card holds card.insert and card.select.
//
// card.insert and card.select are unified-handler shape (Phase 2 / 5
// of docs/UNIFIED_HANDLER_PLAN.md); the function bodies live in
// db/schema/functions/card_*_batch.sql. card.select_with_attributes
// still runs on the Go-side Run path during the sweep.
package card

import (
	"context"
	"encoding/json"
	"reflect"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// InsertInput is the wire shape for one row of card.insert. ParentCardID
// is nil for top-level cards (projects).
//
// Title is shorthand for the built-in title attribute. Attributes is an
// optional map of additional attribute writes that fire as part of the
// same insert; together with Title they go through the
// attribute_value+activity pipeline so the activity stream shows
// kind='card_create' plus one kind='attr_update' per initial attribute.
type InsertInput struct {
	CardTypeName string                     `json:"card_type_name" mcp:"required,desc=name of the card_type to create (e.g. project, task)"`
	ParentCardID *int64                     `json:"parent_card_id,string,omitempty" mcp:"desc=parent card id; nil for top-level project cards"`
	Title        string                     `json:"title" mcp:"required,desc=value for the built-in title attribute"`
	Attributes   map[string]json.RawMessage `json:"attributes,omitempty" mcp:"desc=optional map of additional attribute name to JSON value"`
	// Optional initial value for the structural `phase` column. Empty
	// means "let the column default apply" (triage). When set, must be
	// one of triage|active|terminal — `phase` is otherwise unreachable
	// because it doesn't live in attribute_value.
	Phase string `json:"phase,omitempty" mcp:"desc=initial phase for value-cards; one of triage|active|terminal (defaults to triage)"`
	// AssignToMe is the single-call ergonomic for "create this and put
	// it in my inbox." When the actor is a human linked to a person
	// card via user_account_person, it sets the `assignee` attribute
	// to that person card. When the actor is an agent, it writes a
	// user_card_agent routing row keyed on the parent (so the
	// routed_to_me filter picks it up). Silently no-ops when the
	// actor has no person link AND isn't an agent.
	AssignToMe bool `json:"assign_to_me,omitempty" mcp:"desc=after insert, route the card to the calling user's inbox: agents self-route via user_card_agent; humans get assignee set to their linked person card"`
}

// InsertOutput carries the new row id.
type InsertOutput struct {
	ID int64 `json:"id,string" mcp:"desc=id of the newly inserted card row"`
}

// SelectInput filters cards by parent and/or type. Both fields are optional;
// no fields means "all top-level cards" (parent IS NULL).
type SelectInput struct {
	ParentCardID *int64  `json:"parent_card_id,string,omitempty" mcp:"desc=if set, return only cards with this parent_card_id"`
	CardTypeName *string `json:"card_type_name,omitempty" mcp:"desc=if set, return only cards of this card_type"`
}

// CardRow is a card record with its title flattened in for convenience.
type CardRow struct {
	ID           int64   `json:"id,string" mcp:"desc=card id"`
	CardTypeID   int64   `json:"card_type_id,string" mcp:"desc=card_type id"`
	CardTypeName string  `json:"card_type_name" mcp:"desc=card_type name"`
	ParentCardID *int64  `json:"parent_card_id,string,omitempty" mcp:"desc=parent card id, if any"`
	Title        *string `json:"title,omitempty" mcp:"desc=convenience copy of the title attribute"`
}

// SelectOutput is one row's worth — every input gets a snapshot.
type SelectOutput struct {
	Rows []CardRow `json:"rows" mcp:"desc=matching card rows"`
}

// Register installs every card.* handler. The pool reference lets the
// writers note one statement-group per Run for the write counter.
func Register(p *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:   "card",
		Action:     "insert",
		Doc:        "Insert a new card with the given card_type, optional parent, and initial title plus attributes.",
		InputType:  reflect.TypeFor[InsertInput](),
		OutputType: reflect.TypeFor[InsertOutput](),
		// Worker can insert tasks; manager/admin can insert any card type.
		// The handler / scope authz enforces card-type-specific limits;
		// this list is the broadest set of roles that may reach the
		// handler at all.
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "card.create",
		CardTypeID:   cardTypeFromName,
		// Unified handler — body lives in
		// db/schema/functions/card_insert_batch.sql.
		SQLFunc: "card_insert_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "card",
		Action:       "select",
		Doc:          "List cards filtered by optional parent and card_type; soft-deleted rows are excluded.",
		InputType:    reflect.TypeFor[SelectInput](),
		OutputType:   reflect.TypeFor[SelectOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		// Unified handler — body lives in
		// db/schema/functions/card_select_batch.sql.
		SQLFunc: "card_select_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "card",
		Action:       "select_with_attributes",
		Doc:          "Select cards plus their full attribute set in one round-trip; supports filters and ordering for grids and kanbans.",
		InputType:    reflect.TypeFor[SelectWithAttributesInput](),
		OutputType:   reflect.TypeFor[SelectWithAttributesOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		// Unified handler — body lives in
		// db/schema/functions/card_select_with_attributes_batch.sql.
		SQLFunc: "card_select_with_attributes_batch",
		IsRead:  true,
	})
	RegisterSearch(p)
	RegisterMoveDelete(p)
	RegisterSetPhase(p)
	RegisterTaskMove(p)
	RegisterTaskPurge(p)
}

// cardTypeFromName resolves the card_type_id for an InsertInput. Pre-tx
// authz uses the result against the (card_type, process) role_grant
// table; if the name doesn't resolve we return 0 and let the dispatcher
// surface the failure rather than masking it as authz.
func cardTypeFromName(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	in := raw.(InsertInput)
	if in.CardTypeName == "" {
		return 0, nil
	}
	var id int64
	row := pool.QueryRow(ctx, `SELECT id FROM card_type WHERE name = $1`, in.CardTypeName)
	if err := row.Scan(&id); err != nil {
		return 0, nil
	}
	return id, nil
}

// SelectInput.ParentCardID semantics:
//   - nil  → do not filter on parent (return rows regardless of parent).
//     Listing top-level projects is done by setting CardTypeName="project";
//     in v1 every project has parent IS NULL, so that's enough.
//   - non-nil → return rows whose parent_card_id equals that value.
//
// The body lives in db/schema/functions/card_select_batch.sql.
