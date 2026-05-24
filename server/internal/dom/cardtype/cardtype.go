// Package cardtype exposes card_type read access. Card types are seeded
// via migration in v1; there is no insert/update/delete handler.
package cardtype

import (
	"reflect"

	"github.com/kitp/kitp/server/internal/reg"
)

// SelectInput has no fields in v1 — every call returns every row. We keep
// the struct so the registry has a stable InputType to decode into.
type SelectInput struct{}

// Row is one card_type row. parent_card_type_id may be nil for top-level
// types like "project".
type Row struct {
	ID               int64  `json:"id,string" mcp:"desc=card_type id"`
	Name             string `json:"name" mcp:"desc=card_type name"`
	ParentCardTypeID *int64 `json:"parent_card_type_id,string,omitempty" mcp:"desc=id of the only allowed parent card_type, if constrained"`
	AllowSelfParent  bool   `json:"allow_self_parent" mcp:"desc=if true, instances may be parented to other instances of the same type"`
	IsBuiltIn        bool   `json:"is_built_in" mcp:"desc=true for v1 built-in types"`
}

// SelectOutput is the per-input payload — every input returns the same
// snapshot of every row (one query per Run, regardless of input length).
type SelectOutput struct {
	Rows []Row `json:"rows" mcp:"desc=every card_type row"`
}

// Register installs the handler.
func Register() {
	reg.Register(reg.Handler{
		Endpoint:     "card_type",
		Action:       "select",
		Doc:          "List every card_type row known to the server (built-in types are seeded via migration).",
		InputType:    reflect.TypeFor[SelectInput](),
		OutputType:   reflect.TypeFor[SelectOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		// Unified handler — body lives in
		// db/schema/functions/card_type_select_batch.sql.
		SQLFunc: "card_type_select_batch",
	})
}
