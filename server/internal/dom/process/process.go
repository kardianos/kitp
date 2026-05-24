// Package process holds the process executor (Phase 11). When a sub-request's
// (endpoint, action) maps to a row in the process table, the dispatcher
// expands it into a sequence of inner sub-requests inside the same tx.
package process

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// Step is one (endpoint, action) inside a Process.
type Step struct {
	Ordinal  int
	Endpoint string
	Action   string
}

// Process is the in-memory representation of one process row plus its steps.
type Process struct {
	ID    int64
	Name  string
	Steps []Step
}

// Lookup finds a process by name. Returns (proc, true) if found, (nil, false) otherwise.
func Lookup(ctx context.Context, tx pgx.Tx, name string) (*Process, error) {
	var p Process
	row := tx.QueryRow(ctx, `SELECT id, name FROM process WHERE name = $1`, name)
	if err := row.Scan(&p.ID, &p.Name); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	rows, err := tx.Query(ctx, `
		SELECT ordinal, endpoint, action FROM process_step
		WHERE process_id = $1 ORDER BY ordinal
	`, p.ID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var s Step
		if err := rows.Scan(&s.Ordinal, &s.Endpoint, &s.Action); err != nil {
			rows.Close()
			return nil, err
		}
		p.Steps = append(p.Steps, s)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return &p, nil
}

// LookupValidation is the variant used by the api dispatcher's pre-tx
// auth phase. It uses a ValidationPool (pgxpool) instead of a tx.
func LookupValidation(ctx context.Context, pool reg.ValidationPool, name string) (*Process, error) {
	var p Process
	row := pool.QueryRow(ctx, `SELECT id, name FROM process WHERE name = $1`, name)
	if err := row.Scan(&p.ID, &p.Name); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	rows, err := pool.Query(ctx, `
		SELECT ordinal, endpoint, action FROM process_step
		WHERE process_id = $1 ORDER BY ordinal
	`, p.ID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var s Step
		if err := rows.Scan(&s.Ordinal, &s.Endpoint, &s.Action); err != nil {
			rows.Close()
			return nil, err
		}
		p.Steps = append(p.Steps, s)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return &p, nil
}

// HasGrant returns true if the user has a role_grant on (card_type_id,
// process_id). For phase 11, scope_card_id is ignored — every grant is
// global.
func HasGrant(ctx context.Context, pool reg.ValidationPool, userID int64, cardTypeID, processID int64) (bool, error) {
	var n int
	row := pool.QueryRow(ctx, `
		SELECT count(*)
		FROM user_role ur
		JOIN role_grant rg ON rg.role_id = ur.role_id
		WHERE ur.user_id = $1
		  AND rg.card_type_id = $2
		  AND rg.process_id = $3
	`, userID, cardTypeID, processID)
	if err := row.Scan(&n); err != nil {
		return false, err
	}
	return n > 0, nil
}

// Register is a no-op stub. Process actions are resolved indirectly by
// the dispatcher when an unknown (endpoint, action) matches a process row;
// there is no per-process handler to register. The hook stays here for
// symmetry with the rest of the dom packages and so phase 19 (MCP) can
// find a single registration call.
func Register(_ *store.Pool) {}
