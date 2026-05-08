// Package projecttype exposes CRUD over the project_type table.
//
// project_type is the schema-customization unit (PROJECT_SCOPED_SCHEMA_PLAN.md):
// projects of the same type share an effective edge set and an effective
// option list. The default project_type is seeded by migration 0017 and
// every project created without an explicit type binds to it.
//
// Endpoints:
//   - project_type.select — every row, ordered by id.
//   - project_type.insert — admin-only; creates one row.
//   - project_type.update — admin-only; renames or updates the doc / default.
//   - project_type.delete — admin-only; refuses with usage_count > 0 if any
//     project still binds to the row.
//
// All writers are arrayPath; reads run one statement per Run.
package projecttype

import (
	"context"
	"fmt"
	"reflect"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// Row is one project_type row.
type Row struct {
	ID        int32  `json:"id" mcp:"desc=project_type id"`
	Name      string `json:"name" mcp:"desc=project_type name"`
	Doc       string `json:"doc,omitempty" mcp:"desc=human-readable description"`
	IsBuiltIn bool   `json:"is_built_in" mcp:"desc=true for the migration-seeded default"`
	IsDefault bool   `json:"is_default" mcp:"desc=true for the row used when a project carries no explicit type"`
}

// SelectInput has no fields.
type SelectInput struct{}

// SelectOutput is the per-input snapshot.
type SelectOutput struct {
	Rows []Row `json:"rows" mcp:"desc=every project_type row"`
}

// InsertInput creates a new project_type. Name is required and must be
// unique. is_default may be set to flip the catch-all (the partial unique
// index forces at most one row carrying it).
type InsertInput struct {
	Name      string `json:"name" mcp:"required,desc=unique project_type name"`
	Doc       string `json:"doc,omitempty" mcp:"desc=optional description"`
	IsDefault bool   `json:"is_default,omitempty" mcp:"desc=mark as the catch-all default; flips off any prior default"`
}

// InsertOutput surfaces the new id.
type InsertOutput struct {
	ID int32 `json:"id" mcp:"desc=id of the new project_type row"`
}

// UpdateInput changes one row's mutable fields. Built-in rows accept doc
// and is_default updates only; renaming a built-in row is rejected.
type UpdateInput struct {
	ID        int32   `json:"id" mcp:"required,desc=project_type id to update"`
	Name      *string `json:"name,omitempty" mcp:"desc=new name; omit to leave unchanged"`
	Doc       *string `json:"doc,omitempty" mcp:"desc=new doc; omit to leave unchanged"`
	IsDefault *bool   `json:"is_default,omitempty" mcp:"desc=new default flag; omit to leave unchanged"`
}

// UpdateOutput acks the write.
type UpdateOutput struct {
	OK bool `json:"ok" mcp:"desc=true on successful update"`
}

// DeleteInput removes one row. Refuses with usage_count > 0 if any
// project card references it.
type DeleteInput struct {
	ID int32 `json:"id" mcp:"required,desc=project_type id to delete"`
}

// DeleteOutput surfaces the same usage gate as edge.delete.
type DeleteOutput struct {
	OK         bool `json:"ok" mcp:"desc=true if the row was deleted"`
	UsageCount int  `json:"usage_count,omitempty" mcp:"desc=number of project cards bound to this type, blocking the delete"`
}

var authzPool *store.Pool

// Register installs every project_type.* handler.
func Register(p *store.Pool) {
	authzPool = p
	reg.Register(reg.Handler{
		Endpoint:     "project_type",
		Action:       "select",
		Doc:          "List every project_type row.",
		InputType:    reflect.TypeFor[SelectInput](),
		OutputType:   reflect.TypeFor[SelectOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Run:          runSelect(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "project_type",
		Action:       "insert",
		Doc:          "Admin-only: create a project_type. Pass is_default=true to flip the catch-all.",
		InputType:    reflect.TypeFor[InsertInput](),
		OutputType:   reflect.TypeFor[InsertOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		Run:          runInsert(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "project_type",
		Action:       "update",
		Doc:          "Admin-only: update a project_type. Built-in rows refuse name changes.",
		InputType:    reflect.TypeFor[UpdateInput](),
		OutputType:   reflect.TypeFor[UpdateOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		Run:          runUpdate(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "project_type",
		Action:       "delete",
		Doc:          "Admin-only: delete a project_type. Refuses with usage_count when projects still bind.",
		InputType:    reflect.TypeFor[DeleteInput](),
		OutputType:   reflect.TypeFor[DeleteOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		Run:          runDelete(p),
	})
}

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
		return fmt.Errorf("project_type.authz: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("project_type: actor %d is not an admin", userID)
	}
	return nil
}

func runSelect(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		rows, err := tx.Query(ctx, `
			SELECT id, name, COALESCE(doc, ''), is_built_in, is_default
			FROM project_type
			ORDER BY id
		`)
		if err != nil {
			return nil, fmt.Errorf("project_type.select: %w", err)
		}
		defer rows.Close()
		var out []Row
		for rows.Next() {
			var r Row
			if err := rows.Scan(&r.ID, &r.Name, &r.Doc, &r.IsBuiltIn, &r.IsDefault); err != nil {
				return nil, err
			}
			out = append(out, r)
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
		if p != nil {
			p.NoteRead()
		}
		outs := make([]any, len(ins))
		for i := range ins {
			outs[i] = SelectOutput{Rows: out}
		}
		return outs, nil
	}
}

// runInsert is an arrayPath writer. We process inputs sequentially because
// is_default toggling requires a separate UPDATE before the INSERT to
// satisfy the partial unique index — and the size of project_type is
// always small (handful of rows). // arrayPath
func runInsert(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(InsertInput)
			if in.Name == "" {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "project_type.insert: name is required"}
			}
			if in.IsDefault {
				if _, err := tx.Exec(ctx,
					`UPDATE project_type SET is_default = false WHERE is_default = true`); err != nil {
					return nil, fmt.Errorf("project_type.insert: clear default: %w", err)
				}
			}
			var id int32
			row := tx.QueryRow(ctx, `
				INSERT INTO project_type (name, doc, is_built_in, is_default)
				VALUES ($1, NULLIF($2, ''), false, $3)
				RETURNING id
			`, in.Name, in.Doc, in.IsDefault)
			if err := row.Scan(&id); err != nil {
				return nil, fmt.Errorf("project_type.insert: %w", err)
			}
			outs[i] = InsertOutput{ID: id}
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}

// runUpdate processes inputs sequentially. // arrayPath
func runUpdate(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(UpdateInput)
			if in.ID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "project_type.update: id is required"}
			}
			var builtIn bool
			if err := tx.QueryRow(ctx, `SELECT is_built_in FROM project_type WHERE id = $1`, in.ID).Scan(&builtIn); err != nil {
				if err == pgx.ErrNoRows {
					return nil, &reg.HandlerError{InputIndex: i, Code: "not_found",
						Message: fmt.Sprintf("project_type.update: id %d not found", in.ID)}
				}
				return nil, fmt.Errorf("project_type.update: lookup: %w", err)
			}
			if builtIn && in.Name != nil {
				return nil, &reg.HandlerError{InputIndex: i, Code: "built_in",
					Message: "project_type.update: cannot rename a built-in project_type"}
			}
			if in.IsDefault != nil && *in.IsDefault {
				if _, err := tx.Exec(ctx,
					`UPDATE project_type SET is_default = false WHERE is_default = true AND id <> $1`, in.ID); err != nil {
					return nil, fmt.Errorf("project_type.update: clear default: %w", err)
				}
			}
			if in.Name != nil {
				if _, err := tx.Exec(ctx,
					`UPDATE project_type SET name = $1 WHERE id = $2`, *in.Name, in.ID); err != nil {
					return nil, fmt.Errorf("project_type.update: name: %w", err)
				}
			}
			if in.Doc != nil {
				if _, err := tx.Exec(ctx,
					`UPDATE project_type SET doc = NULLIF($1, '') WHERE id = $2`, *in.Doc, in.ID); err != nil {
					return nil, fmt.Errorf("project_type.update: doc: %w", err)
				}
			}
			if in.IsDefault != nil {
				if _, err := tx.Exec(ctx,
					`UPDATE project_type SET is_default = $1 WHERE id = $2`, *in.IsDefault, in.ID); err != nil {
					return nil, fmt.Errorf("project_type.update: is_default: %w", err)
				}
			}
			outs[i] = UpdateOutput{OK: true}
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}

// runDelete refuses if any project still binds. // arrayPath
func runDelete(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(DeleteInput)
			if in.ID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "project_type.delete: id is required"}
			}
			var builtIn bool
			if err := tx.QueryRow(ctx, `SELECT is_built_in FROM project_type WHERE id = $1`, in.ID).Scan(&builtIn); err != nil {
				if err == pgx.ErrNoRows {
					return nil, &reg.HandlerError{InputIndex: i, Code: "not_found",
						Message: fmt.Sprintf("project_type.delete: id %d not found", in.ID)}
				}
				return nil, fmt.Errorf("project_type.delete: lookup: %w", err)
			}
			if builtIn {
				return nil, &reg.HandlerError{InputIndex: i, Code: "built_in",
					Message: "project_type.delete: refusing to remove a built-in project_type"}
			}
			var usage int
			if err := tx.QueryRow(ctx, `
				SELECT count(*) FROM card WHERE project_type_id = $1
			`, in.ID).Scan(&usage); err != nil {
				return nil, fmt.Errorf("project_type.delete: usage: %w", err)
			}
			if usage > 0 {
				outs[i] = DeleteOutput{OK: false, UsageCount: usage}
				continue
			}
			ct, err := tx.Exec(ctx, `DELETE FROM project_type WHERE id = $1`, in.ID)
			if err != nil {
				return nil, fmt.Errorf("project_type.delete: %w", err)
			}
			outs[i] = DeleteOutput{OK: ct.RowsAffected() > 0}
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}
