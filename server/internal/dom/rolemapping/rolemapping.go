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
	"encoding/json"
	"fmt"
	"reflect"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// ListInput is empty.
type ListInput struct{}

// ListRow is one role_mapping row joined to the role.
type ListRow struct {
	ClaimValue string `json:"claim_value" mcp:"desc=value of the role claim (e.g. kitp.admin)"`
	RoleID     int32  `json:"role_id" mcp:"desc=role id"`
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
		Run:          runList(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "role_mapping",
		Action:       "set",
		Doc:          "Admin-only: upsert one role_mapping row.",
		InputType:    reflect.TypeFor[SetInput](),
		OutputType:   reflect.TypeFor[SetOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		Run:          runSet(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "role_mapping",
		Action:       "delete",
		Doc:          "Admin-only: delete one role_mapping row by claim_value.",
		InputType:    reflect.TypeFor[DeleteInput](),
		OutputType:   reflect.TypeFor[DeleteOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		Run:          runDelete(p),
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

func runList(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		rows, err := tx.Query(ctx, `
			SELECT rm.claim_value, r.id, r.name
			FROM role_mapping rm
			JOIN role r ON r.id = rm.role_id
			ORDER BY rm.claim_value
		`)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []ListRow
		for rows.Next() {
			var r ListRow
			if err := rows.Scan(&r.ClaimValue, &r.RoleID, &r.RoleName); err != nil {
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
			outs[i] = ListOutput{Rows: out}
		}
		return outs, nil
	}
}

// jsonSetRow is the per-input shape fed to jsonb_to_recordset.
type jsonSetRow struct {
	ClaimValue string `json:"claim_value"`
	RoleName   string `json:"role_name"`
	Ord        int    `json:"ord"`
}

// runSet is an arrayPath writer. // arrayPath
func runSet(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		payload := make([]jsonSetRow, len(ins))
		for i, raw := range ins {
			in := raw.(SetInput)
			if in.ClaimValue == "" || in.RoleName == "" {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "role_mapping.set: claim_value and role_name are required"}
			}
			payload[i] = jsonSetRow{ClaimValue: in.ClaimValue, RoleName: in.RoleName, Ord: i}
		}
		buf, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		const q = `
			WITH input AS (
				SELECT i.ord, i.claim_value, r.id AS role_id
				FROM jsonb_to_recordset($1::jsonb)
					AS i(ord int, claim_value text, role_name text)
				JOIN role r ON r.name = i.role_name
			),
			ups AS (
				INSERT INTO role_mapping (claim_value, role_id)
				SELECT claim_value, role_id FROM input
				ON CONFLICT (claim_value) DO UPDATE SET role_id = EXCLUDED.role_id
				RETURNING claim_value
			)
			SELECT count(*) FROM ups
		`
		var n int
		if err := tx.QueryRow(ctx, q, buf).Scan(&n); err != nil {
			return nil, fmt.Errorf("role_mapping.set: %w", err)
		}
		if p != nil {
			p.NoteWrite()
		}
		outs := make([]any, len(ins))
		for i := range ins {
			outs[i] = SetOutput{OK: true}
		}
		return outs, nil
	}
}

// runDelete is an arrayPath writer. // arrayPath
func runDelete(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		vals := make([]string, len(ins))
		for i, raw := range ins {
			in := raw.(DeleteInput)
			if in.ClaimValue == "" {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "role_mapping.delete: claim_value required"}
			}
			vals[i] = in.ClaimValue
		}
		ct, err := tx.Exec(ctx, `DELETE FROM role_mapping WHERE claim_value = ANY($1::text[])`, vals)
		if err != nil {
			return nil, fmt.Errorf("role_mapping.delete: %w", err)
		}
		if p != nil {
			p.NoteWrite()
		}
		// We don't get per-row counts back from pgx for ANY; we return the
		// total and split it across slots — the client only needs OK.
		total := int(ct.RowsAffected())
		outs := make([]any, len(ins))
		for i := range ins {
			outs[i] = DeleteOutput{OK: total > 0, Deleted: total}
		}
		return outs, nil
	}
}
