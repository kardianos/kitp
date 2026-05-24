// Package rolemapping exposes role_mapping.list / .set / .delete — admin
// handlers that manage the OIDC-claim-value -> role mapping table. Every
// row says "if a token's role claim contains this value, grant the user
// this role globally on first login".
//
// Authz: list is open to authenticated users (the admin UI loads it for
// preview), set/delete require the actor to hold admin globally.
package rolemapping

import (
	"context"
	"fmt"
	"reflect"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// ListInput is empty.
type ListInput struct{}

// ListRow is one role_mapping row joined to the role.
type ListRow struct {
	ClaimValue string `json:"claim_value" mcp:"desc=value of the role claim (e.g. kitp.admin)"`
	RoleID     int64  `json:"role_id,string" mcp:"desc=role id"`
	RoleName   string `json:"role_name" mcp:"desc=role name"`
}

// ListOutput wraps the rows in a stable envelope.
type ListOutput struct {
	Rows []ListRow `json:"rows" mcp:"desc=every role_mapping row"`
}

// SetInput is one row to upsert.
type SetInput struct {
	ClaimValue string `json:"claim_value" mcp:"required,desc=claim value (e.g. kitp.manager)"`
	RoleName   string `json:"role_name" mcp:"required,desc=role name to assign"`
}

// SetOutput acknowledges success.
type SetOutput struct {
	OK bool `json:"ok" mcp:"desc=true on success"`
}

// DeleteInput is one row to delete.
type DeleteInput struct {
	ClaimValue string `json:"claim_value" mcp:"required,desc=claim value to delete"`
}

// DeleteOutput acknowledges success.
type DeleteOutput struct {
	OK      bool `json:"ok" mcp:"desc=true if a row was deleted"`
	Deleted int  `json:"deleted" mcp:"desc=number of rows deleted"`
}

// Register installs the three handlers.
func Register(p *store.Pool) {
	authzPool = p
	reg.Register(reg.Handler{
		Endpoint:     "role_mapping",
		Action:       "list",
		Doc:          "List every role_mapping row (claim value -> role).",
		InputType:    reflect.TypeFor[ListInput](),
		OutputType:   reflect.TypeFor[ListOutput](),
		AllowedRoles: []string{"admin"},
		// Unified handler — body lives in
		// db/schema/functions/role_mapping_list_batch.sql per Phase 5
		// of docs/UNIFIED_HANDLER_PLAN.md.
		SQLFunc: "role_mapping_list_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "role_mapping",
		Action:       "set",
		Doc:          "Admin-only: upsert one role_mapping row.",
		InputType:    reflect.TypeFor[SetInput](),
		OutputType:   reflect.TypeFor[SetOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		// Unified handler — body lives in
		// db/schema/functions/role_mapping_set_batch.sql per Phase 3
		// of docs/UNIFIED_HANDLER_PLAN.md.
		SQLFunc: "role_mapping_set_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "role_mapping",
		Action:       "delete",
		Doc:          "Admin-only: delete one role_mapping row by claim_value.",
		InputType:    reflect.TypeFor[DeleteInput](),
		OutputType:   reflect.TypeFor[DeleteOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		// Unified handler — body lives in
		// db/schema/functions/role_mapping_delete_batch.sql per Phase 3
		// of docs/UNIFIED_HANDLER_PLAN.md.
		SQLFunc: "role_mapping_delete_batch",
	})
}

var authzPool *store.Pool

// authzAdmin gates writes to role_mapping (Phase 20). The actor must hold
// the admin or system role globally. Mirrors the gate in dom/userrole.
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
		return fmt.Errorf("role_mapping.authz: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("role_mapping: actor %d is not an admin", userID)
	}
	return nil
}


