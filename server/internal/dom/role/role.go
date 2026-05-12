// Package role exposes role.list — a lightweight read used by the admin UI
// role-picker and by anyone curious what each role can do. Authz is open
// because the role catalogue is metadata, not user data.
package role

import (
	"context"
	"reflect"

	"github.com/jackc/pgx/v5"

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
		Run: func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
			rows, err := tx.Query(ctx, `
				SELECT r.id, r.name, COALESCE(r.doc, '')
				FROM role r
				ORDER BY r.id
			`)
			if err != nil {
				return nil, err
			}
			byID := map[int64]*Row{}
			ordered := []*Row{}
			for rows.Next() {
				var rr Row
				if err := rows.Scan(&rr.ID, &rr.Name, &rr.Doc); err != nil {
					rows.Close()
					return nil, err
				}
				cp := rr
				ordered = append(ordered, &cp)
				byID[cp.ID] = &cp
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return nil, err
			}

			gRows, err := tx.Query(ctx, `
				SELECT rg.role_id, ct.name, p.name
				FROM role_grant rg
				JOIN card_type ct ON ct.id = rg.card_type_id
				JOIN process p   ON p.id  = rg.process_id
				ORDER BY rg.role_id, ct.name, p.name
			`)
			if err != nil {
				return nil, err
			}
			for gRows.Next() {
				var roleID int64
				var ctName, procName string
				if err := gRows.Scan(&roleID, &ctName, &procName); err != nil {
					gRows.Close()
					return nil, err
				}
				if r, ok := byID[roleID]; ok {
					r.Grants = append(r.Grants, Grant{CardType: ctName, Process: procName})
				}
			}
			gRows.Close()
			if err := gRows.Err(); err != nil {
				return nil, err
			}

			out := SelectOutput{Rows: make([]Row, len(ordered))}
			for i, p := range ordered {
				out.Rows[i] = *p
			}
			outs := make([]any, len(ins))
			for i := range ins {
				outs[i] = out
			}
			return outs, nil
		},
	})
}
