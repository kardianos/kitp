// Package role exposes role.list — a lightweight read used by the admin UI
// role-picker and by anyone curious what each role can do. Authz is open
// because the role catalogue is metadata, not user data.
package role

import (
	"reflect"

	"github.com/kitp/kitp/server/internal/reg"
)

// SelectInput has no fields in v1. Kept for symmetry with the other reads.
type SelectInput struct{}

// Grant is one (card_type, process) pair available under a role.
type Grant struct {
	CardType string `json:"card_type" mcp:"desc=card_type name"`
	Process  string `json:"process" mcp:"desc=process name (e.g. card.update, comment.post)"`
}

// Row is one role with its grant set.
type Row struct {
	ID     int64   `json:"id,string" mcp:"desc=role id"`
	Name   string  `json:"name" mcp:"desc=role name"`
	Doc    string  `json:"doc" mcp:"desc=human-readable description"`
	Grants []Grant `json:"grants" mcp:"desc=granted (card_type, process) pairs"`
}

// SelectOutput wraps the rows in a stable envelope.
type SelectOutput struct {
	Rows []Row `json:"rows" mcp:"desc=every role"`
}

// Register installs the handler.
func Register() {
	reg.Register(reg.Handler{
		Endpoint:   "role",
		Action:     "list",
		Doc:        "List every role and its granted (card_type, process) pairs. The admin UI uses this to populate the role picker.",
		InputType:  reflect.TypeFor[SelectInput](),
		OutputType: reflect.TypeFor[SelectOutput](),
		// Available to every signed-in user — the role list is what the
		// client needs to render any role-selection UI; it's not
		// sensitive (just names + docs).
		AllowedRoles: []string{reg.RoleAuthenticated},
		// Unified handler — body lives in
		// db/schema/functions/role_list_batch.sql per Phase 5 of
		// docs/UNIFIED_HANDLER_PLAN.md.
		SQLFunc: "role_list_batch",
	})
}
