// Package attributedef exposes the admin CRUD surface for attribute_def +
// edge rows. T5 owns this — it powers the /admin/attributes screen, where
// admins register new attribute_defs, bind them to additional card types,
// and unbind them.
//
// Endpoints:
//   - attribute_def.select — every def with the card_types it is bound to
//     (built-in defs included). Unified handler — body in
//     db/schema/functions/attribute_def_select_batch.sql.
//   - attribute_def.insert — create one def and bind it to N card types in
//     one tx. The created def is never marked is_built_in (only migrations
//     install built-in defs). Unified handler — body in
//     db/schema/functions/attribute_def_insert_batch.sql.
//   - edge.insert — bind an existing def to one more card type. Idempotent
//     (ON CONFLICT DO NOTHING on the (card_type, def) UNIQUE constraint).
//     Unified handler — db/schema/functions/edge_insert_batch.sql.
//   - edge.delete — unbind a def from a card type. Refuses with a
//     SUCCESSFUL response carrying usage_count when any attribute_value
//     rows reference (card_type, def) today; refuses with an error of
//     code='built_in' for built-in (def, card_type) pairs. Unified
//     handler — db/schema/functions/edge_delete_batch.sql.
package attributedef

import (
	"context"
	"fmt"
	"reflect"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// SelectInput is empty.
type SelectInput struct{}

// BoundCardType is one (card_type_id, name, is_required) tuple in the bound
// list of a def. Edges may include built-in card types; the client decides
// whether to allow unbinding them (we surface is_built_in via card_type).
type BoundCardType struct {
	CardTypeID   int64  `json:"card_type_id,string" mcp:"desc=card_type id this attribute is bound to"`
	CardTypeName string `json:"card_type_name" mcp:"desc=card_type name"`
	IsRequired   bool   `json:"is_required" mcp:"desc=true when the edge marks the attribute as required for that card_type"`
	IsBuiltIn    bool   `json:"is_built_in" mcp:"desc=true if the bound card_type is built-in (admin UI may protect deletes)"`
	Ordering     int32  `json:"ordering" mcp:"desc=display ordering for the edge"`
}

// SelectRow is one attribute_def row plus its bindings.
type SelectRow struct {
	ID                 int64           `json:"id,string" mcp:"desc=attribute_def id"`
	Name               string          `json:"name" mcp:"desc=attribute_def name"`
	ValueType          string          `json:"value_type" mcp:"desc=value type label (text, bool, number, date, card_ref, card_ref[])"`
	TargetCardTypeName string          `json:"target_card_type_name,omitempty" mcp:"desc=for card_ref / card_ref[] value_types, the name of the card_type whose cards are valid values (status / milestone / person / …)"`
	IsBuiltIn          bool            `json:"is_built_in" mcp:"desc=true if installed by a migration"`
	BoundTo            []BoundCardType `json:"bound_to" mcp:"desc=card_types the attribute is bound to via edge"`
}

// SelectOutput wraps the rows.
type SelectOutput struct {
	Rows []SelectRow `json:"rows" mcp:"desc=every attribute_def with its bound card types"`
}

// EdgeInput describes one (card_type, is_required) binding.
type EdgeInput struct {
	CardTypeID int64 `json:"card_type_id,string" mcp:"required,desc=card_type id to bind"`
	IsRequired bool  `json:"is_required,omitempty" mcp:"desc=optional: mark the edge as required (default false)"`
	Ordering   int32 `json:"ordering,omitempty" mcp:"desc=optional ordering hint"`
}

// InsertInput creates a new attribute_def and seeds initial edges.
type InsertInput struct {
	Name      string      `json:"name" mcp:"required,desc=attribute_def name (must be unique)"`
	ValueType string      `json:"value_type" mcp:"required,desc=value type label (text, bool, number, date, card_ref, card_ref[])"`
	BindTo    []EdgeInput `json:"bind_to,omitempty" mcp:"desc=optional initial edges to seed"`
}

// InsertOutput surfaces the new id.
type InsertOutput struct {
	ID int64 `json:"id,string" mcp:"desc=id of the new attribute_def row"`
}

// EdgeInsertInput binds an existing def to a card_type.
type EdgeInsertInput struct {
	AttributeDefID int64 `json:"attribute_def_id,string" mcp:"required,desc=existing attribute_def to bind"`
	CardTypeID     int64 `json:"card_type_id,string" mcp:"required,desc=card_type to bind to"`
	IsRequired     bool  `json:"is_required,omitempty" mcp:"desc=optional required flag"`
	Ordering       int32 `json:"ordering,omitempty" mcp:"desc=optional ordering hint"`
}

// EdgeInsertOutput acknowledges the upsert.
type EdgeInsertOutput struct {
	OK bool `json:"ok" mcp:"desc=true on success"`
}

// EdgeDeleteInput removes one (def, card_type) binding.
type EdgeDeleteInput struct {
	AttributeDefID int64 `json:"attribute_def_id,string" mcp:"required,desc=def the edge points at"`
	CardTypeID     int64 `json:"card_type_id,string" mcp:"required,desc=card_type the edge connects to"`
}

// EdgeDeleteOutput reports whether a row was deleted.
type EdgeDeleteOutput struct {
	OK         bool `json:"ok" mcp:"desc=true if the edge was deleted"`
	UsageCount int  `json:"usage_count,omitempty" mcp:"desc=number of attribute_value rows that block the delete"`
}

var authzPool *store.Pool

// Register installs every endpoint.
func Register(p *store.Pool) {
	authzPool = p
	reg.Register(reg.Handler{
		Endpoint:     "attribute_def",
		Action:       "select",
		Doc:          "List every attribute_def with the card_types it is bound to via edge.",
		InputType:    reflect.TypeFor[SelectInput](),
		OutputType:   reflect.TypeFor[SelectOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		// Unified handler — body lives in
		// db/schema/functions/attribute_def_select_batch.sql per Phase
		// 5 of docs/UNIFIED_HANDLER_PLAN.md.
		SQLFunc: "attribute_def_select_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "attribute_def",
		Action:       "insert",
		Doc:          "Admin-only: insert a new attribute_def with optional initial edges, in one tx.",
		InputType:    reflect.TypeFor[InsertInput](),
		OutputType:   reflect.TypeFor[InsertOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		// Unified handler — body lives in
		// db/schema/functions/attribute_def_insert_batch.sql.
		SQLFunc: "attribute_def_insert_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "edge",
		Action:       "insert",
		Doc:          "Admin-only: bind an existing attribute_def to a card_type. Idempotent (re-binding is a no-op).",
		InputType:    reflect.TypeFor[EdgeInsertInput](),
		OutputType:   reflect.TypeFor[EdgeInsertOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		// Unified handler — db/schema/functions/edge_insert_batch.sql.
		SQLFunc: "edge_insert_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "edge",
		Action:       "delete",
		Doc:          "Admin-only: unbind an attribute_def from a card_type. Refuses with usage_count if any attribute_value rows reference it.",
		InputType:    reflect.TypeFor[EdgeDeleteInput](),
		OutputType:   reflect.TypeFor[EdgeDeleteOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		// Unified handler — db/schema/functions/edge_delete_batch.sql.
		SQLFunc: "edge_delete_batch",
	})
}

// authzAdmin gates writes. The actor must hold admin or system globally.
// Mirrors rolemapping.authzAdmin.
func authzAdmin(ctx context.Context, _ any) error {
	if authzPool == nil {
		return nil
	}
	userID := auth.ActorOrSystem(ctx)
	var n int
	if err := authzPool.P.QueryRow(ctx, `
		SELECT count(*)
		FROM user_role ur
		JOIN role r ON r.id = ur.role_id
		WHERE ur.user_id = $1 AND r.name IN ('admin','system') AND ur.scope_card_id IS NULL
	`, userID).Scan(&n); err != nil {
		return fmt.Errorf("attribute_def.authz: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("attribute_def: actor %d is not an admin", userID)
	}
	return nil
}

