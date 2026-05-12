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
	"context"
	"encoding/json"
	"reflect"

	"github.com/jackc/pgx/v5"

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
	IDs            []int64 `json:"ids,omitempty"             mcp:"desc=optional explicit id filter; combined via AND"`
	ParentUserID   *int64  `json:"parent_user_id,string,omitempty" mcp:"desc=optional parent_user_id filter; useful to list a user's owned agents"`
	IsAgent        *bool   `json:"is_agent,omitempty"        mcp:"desc=optional is_agent filter; true = only agent rows, false = only humans"`
}

// Row is one user_account row — only the fields the UI needs.
type Row struct {
	ID            int64  `json:"id,string"                      mcp:"desc=user account id"`
	DisplayName   string `json:"display_name"                    mcp:"desc=user display name"`
	ParentUserID  *int64 `json:"parent_user_id,string,omitempty" mcp:"desc=human owner when is_agent=true; null for humans"`
	IsAgent       bool   `json:"is_agent"                        mcp:"desc=true when this row is an agent owned by parent_user_id"`
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
		Run:          runSelect,
	})
	reg.Register(reg.Handler{
		Endpoint:     "user",
		Action:       "list_with_roles",
		Doc:          "List every user_account row with role assignments and resolved project titles for scoped grants. Used by the admin UI.",
		InputType:    reflect.TypeFor[ListWithRolesInput](),
		OutputType:   reflect.TypeFor[ListWithRolesOutput](),
		AllowedRoles: []string{"admin"},
		Run:          runListWithRoles,
	})
}

// runSelect handles user.select. We coalesce concurrent inputs by
// taking the UNION of every input's filter — one SQL pass, then
// per-input we slice the row set down to that input's filter. Empty
// filters mean "match everything", so an empty SelectInput pulls the
// full table the way v1 used to.
func runSelect(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	// All inputs share the same column set; we just need to run ONE
	// query that's permissive enough to satisfy every caller, then
	// filter per-input below.
	rows, err := tx.Query(ctx, `
		SELECT id, display_name, parent_user_id, is_agent
		FROM user_account
		ORDER BY display_name, id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	all := []Row{}
	for rows.Next() {
		var r Row
		if err := rows.Scan(&r.ID, &r.DisplayName, &r.ParentUserID, &r.IsAgent); err != nil {
			return nil, err
		}
		all = append(all, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	outs := make([]any, len(ins))
	for i, raw := range ins {
		in := raw.(SelectInput)
		out := make([]Row, 0, len(all))
		idSet := buildIDSet(in.IDs)
		for _, r := range all {
			if idSet != nil {
				if _, ok := idSet[r.ID]; !ok {
					continue
				}
			}
			if in.ParentUserID != nil {
				if r.ParentUserID == nil || *r.ParentUserID != *in.ParentUserID {
					continue
				}
			}
			if in.IsAgent != nil && r.IsAgent != *in.IsAgent {
				continue
			}
			out = append(out, r)
		}
		outs[i] = SelectOutput{Rows: out}
	}
	return outs, nil
}

func buildIDSet(ids []int64) map[int64]struct{} {
	if len(ids) == 0 {
		return nil
	}
	set := make(map[int64]struct{}, len(ids))
	for _, id := range ids {
		set[id] = struct{}{}
	}
	return set
}

// runListWithRoles loads every user + their role assignments + scope project
// titles in two queries (no N+1). The scope title is fetched via a LATERAL
// lookup against attribute_value.title.
func runListWithRoles(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	users := []RowWithRoles{}
	rows, err := tx.Query(ctx, `
		SELECT id, display_name, email, oidc_sub, parent_user_id, is_agent
		FROM user_account
		ORDER BY display_name, id
	`)
	if err != nil {
		return nil, err
	}
	idx := map[int64]int{}
	for rows.Next() {
		var r RowWithRoles
		if err := rows.Scan(&r.ID, &r.DisplayName, &r.Email, &r.OIDCSub, &r.ParentUserID, &r.IsAgent); err != nil {
			rows.Close()
			return nil, err
		}
		r.Roles = []RoleAssignment{}
		idx[r.ID] = len(users)
		users = append(users, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	roleRows, err := tx.Query(ctx, `
		SELECT ur.user_id, r.name, ur.scope_card_id, title.value
		FROM user_role ur
		JOIN role r ON r.id = ur.role_id
		LEFT JOIN LATERAL (
			SELECT av.value
			FROM attribute_value av
			JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE av.card_id = ur.scope_card_id AND ad.name = 'title'
			LIMIT 1
		) title ON ur.scope_card_id IS NOT NULL
		ORDER BY ur.user_id, r.name
	`)
	if err != nil {
		return nil, err
	}
	for roleRows.Next() {
		var userID int64
		var roleName string
		var scope *int64
		var titleRaw []byte
		if err := roleRows.Scan(&userID, &roleName, &scope, &titleRaw); err != nil {
			roleRows.Close()
			return nil, err
		}
		ra := RoleAssignment{RoleName: roleName, ScopeProjectID: scope}
		if scope != nil && len(titleRaw) > 0 {
			var s string
			if err := json.Unmarshal(titleRaw, &s); err == nil {
				ra.ScopeProjectTitle = &s
			}
		}
		if pos, ok := idx[userID]; ok {
			users[pos].Roles = append(users[pos].Roles, ra)
		}
	}
	roleRows.Close()
	if err := roleRows.Err(); err != nil {
		return nil, err
	}

	outs := make([]any, len(ins))
	out := ListWithRolesOutput{Rows: users}
	for i := range ins {
		outs[i] = out
	}
	return outs, nil
}
