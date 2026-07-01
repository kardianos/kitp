// Package user exposes user.select — a tiny read-only handler the UI
// consults to populate assignee dropdowns and similar pickers. It returns
// every user_account row sorted by display_name. There is no insert or
// delete handler in v1; users are seeded via migration today and are
// auto-provisioned via OIDC when AUTH_MODE=oidc.
//
// Phase 20 also adds user.list_with_roles — the admin assignment screen
// reads it to render every user with their role chips.
package user

import (
	"reflect"

	"github.com/kitp/kitp/server/internal/reg"
)

// SelectInput optionally narrows the result set. All filters AND
// together; an empty input returns every user_account row.
//
// The Admin → Agents screen reads with `ParentUserID=actor, IsAgent=true`
// to list a parent's agents. The assignee picker hides agents from
// non-parents by filtering `IsAgent=false`. Other callers pass nothing
// and get the full list (sorted by display_name) — the v1 behaviour.
type SelectInput struct {
	IDs          []int64 `json:"ids,omitempty"                   mcp:"desc=optional explicit id filter; combined via AND"`
	ParentUserID *int64  `json:"parent_user_id,string,omitempty" mcp:"desc=optional parent_user_id filter; useful to list a user's owned agents"`
	IsAgent      *bool   `json:"is_agent,omitempty"              mcp:"desc=optional is_agent filter; true = only agent rows, false = only humans"`
}

// Row is one user_account row — only the fields the UI needs.
type Row struct {
	ID             int64   `json:"id,string"                        mcp:"desc=user account id"`
	DisplayName    string  `json:"display_name"                      mcp:"desc=user display name"`
	ParentUserID   *int64  `json:"parent_user_id,string,omitempty"   mcp:"desc=human owner when is_agent=true; null for humans"`
	ParentUserName *string `json:"parent_user_name,omitempty"        mcp:"desc=resolved display_name of the owner when is_agent=true; null for humans"`
	IsAgent        bool    `json:"is_agent"                          mcp:"desc=true when this row is an agent owned by parent_user_id"`
}

// SelectOutput is the per-input payload — every input gets the same
// snapshot (one query per Run, regardless of input length).
type SelectOutput struct {
	Rows []Row `json:"rows" mcp:"desc=every user_account row sorted by display_name"`
}

// RoleAssignment is one (role, scope) tuple held by a user. ScopeProjectID
// is nil for global grants; ScopeProjectTitle is the resolved title of the
// scoped project (nil when ScopeProjectID is nil).
type RoleAssignment struct {
	RoleName          string  `json:"role_name" mcp:"desc=role name"`
	ScopeProjectID    *int64  `json:"scope_project_id,string,omitempty" mcp:"desc=optional project id; null = global"`
	ScopeProjectTitle *string `json:"scope_project_title,omitempty" mcp:"desc=resolved project title for scoped grants"`
}

// RowWithRoles is one user_account row with their role assignments.
type RowWithRoles struct {
	ID           int64            `json:"id,string"                        mcp:"desc=user account id"`
	DisplayName  string           `json:"display_name"                      mcp:"desc=user display name"`
	Email        *string          `json:"email,omitempty"                   mcp:"desc=user email"`
	OIDCSub      *string          `json:"oidc_sub,omitempty"                mcp:"desc=OIDC subject (sub claim) when provisioned"`
	ParentUserID *int64           `json:"parent_user_id,string,omitempty"   mcp:"desc=human owner when is_agent=true; null for humans"`
	IsAgent      bool             `json:"is_agent"                          mcp:"desc=true when this row is an agent"`
	PersonCardID *int64           `json:"person_card_id,string,omitempty"   mcp:"desc=linked person card id when this user_account is associated with a person card (member tier); null for login-only accounts and agents"`
	Roles        []RoleAssignment `json:"roles"                             mcp:"desc=role assignments held by this user"`
}

// ListWithRolesInput has no fields. Every authenticated caller may list.
type ListWithRolesInput struct{}

// ListWithRolesOutput is the per-input payload.
type ListWithRolesOutput struct {
	Rows []RowWithRoles `json:"rows" mcp:"desc=every user_account row with their roles"`
}

// Register installs the handler.
func Register() {
	reg.Register(reg.Handler{
		Endpoint:     "user",
		Action:       "select",
		Doc:          "List every user_account row sorted by display_name.",
		InputType:    reflect.TypeFor[SelectInput](),
		OutputType:   reflect.TypeFor[SelectOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		// Unified handler — body lives in
		// db/schema/functions/user_select_batch.sql per Phase 5 of
		// docs/UNIFIED_HANDLER_PLAN.md.
		SQLFunc: "user_select_batch",
		IsRead:  true,
	})
	reg.Register(reg.Handler{
		Endpoint:     "user",
		Action:       "list_with_roles",
		Doc:          "List every user_account row with role assignments and resolved project titles for scoped grants. Used by the admin UI.",
		InputType:    reflect.TypeFor[ListWithRolesInput](),
		OutputType:   reflect.TypeFor[ListWithRolesOutput](),
		AllowedRoles: []string{"admin"},
		// Unified handler — body lives in
		// db/schema/functions/user_list_with_roles_batch.sql per Phase
		// 5 of docs/UNIFIED_HANDLER_PLAN.md.
		SQLFunc: "user_list_with_roles_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "user",
		Action:       "unlink_person",
		Doc:          "Delete the user_account_person link between a user_account row and a person card. The user_account row itself stays — they can still sign in, they just no longer correspond to an assignable person card (demotes 'user' tier to 'login-only'). Idempotent: deleting an absent link succeeds with deleted=false.",
		InputType:    reflect.TypeFor[UnlinkPersonInput](),
		OutputType:   reflect.TypeFor[UnlinkPersonOutput](),
		AllowedRoles: []string{"admin"},
		// Unified handler — body lives in
		// db/schema/functions/user_unlink_person_batch.sql per Phase 3
		// of docs/UNIFIED_HANDLER_PLAN.md.
		SQLFunc: "user_unlink_person_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "user",
		Action:       "set_display_name",
		Doc:          "Update user_account.display_name for one user_account row. The /auth/me probe reads display_name straight from this column, so this is what powers the shell's signed-in user chip — renaming the linked person card (attribute.update on title) does NOT propagate here. Admin-only; no-op (ok=true) when the value already matches.",
		InputType:    reflect.TypeFor[SetDisplayNameInput](),
		OutputType:   reflect.TypeFor[SetDisplayNameOutput](),
		AllowedRoles: []string{"admin"},
		SQLFunc:      "user_set_display_name_batch",
	})
}

// SetDisplayNameInput addresses the user_account row whose display_name is
// being updated. We key on user_account_id rather than the linked person card
// because admin call sites land on this action from the user record.
type SetDisplayNameInput struct {
	UserAccountID int64  `json:"user_account_id,string" mcp:"required,desc=user_account row whose display_name is being updated"`
	DisplayName   string `json:"display_name"          mcp:"required,desc=new display_name; non-empty (the column is NOT NULL and the shell falls back to its config default on empty)"`
}

// SetDisplayNameOutput reports whether the column actually changed, so the
// caller can distinguish a real rename from a no-op repeat.
type SetDisplayNameOutput struct {
	Updated bool `json:"updated" mcp:"desc=true when the column changed; false when the value already matched"`
}

// UnlinkPersonInput addresses the user_account row whose person link
// is being removed. We key on user_account_id rather than the person
// card id because admins land on this action from the user-centric
// view; the link is 1:1 so either key would work.
type UnlinkPersonInput struct {
	UserAccountID int64 `json:"user_account_id,string" mcp:"required,desc=user_account row whose user_account_person link is being deleted"`
}

// UnlinkPersonOutput reports whether a row was actually deleted (so
// the caller can distinguish a real demotion from a no-op repeat).
type UnlinkPersonOutput struct {
	Deleted bool `json:"deleted" mcp:"desc=true when a row was removed; false when the link was already absent"`
}
