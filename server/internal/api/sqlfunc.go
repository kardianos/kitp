// File sqlfunc.go: unified-handler dispatch path (Phase 0 of
// docs/UNIFIED_HANDLER_PLAN.md). When a registered handler sets
// `SQLFunc`, the dispatcher routes its `flush(group)` call through
// `runSQLFunc` instead of `Handler.Run`.
//
// Contract:
//   - Every handler function takes `(actor_id bigint, inputs jsonb)`
//     and returns `TABLE(idx int, ok bool, code text, message text,
//     result jsonb) ORDER BY idx`.
//   - Inputs are the array of typed leaf inputs, JSONB-encoded.
//   - Results are decoded per-row: `ok=true` → unmarshal `result`
//     into a fresh `OutputType` value; `ok=false` → emit
//     `*reg.HandlerError` with `InputIndex` set to that row.
//
// First-error semantics match the existing dispatcher: as soon as
// a row reports `ok=false`, we return that as the group's error,
// abandon any later rows' successes, and let the outer flush()
// abort the batch + rollback the tx.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/reg"
)

// runSQLFunc executes the handler's PL/pgSQL function once per
// group. Returns one Go value per input slot — successes carry the
// decoded `OutputType`; failures abort the group via a
// `*reg.HandlerError` whose `InputIndex` points at the offending
// leaf.
func (s *Server) runSQLFunc(ctx context.Context, tx pgx.Tx, group []prepared, ins []any) ([]any, error) {
	h := group[0].Handler
	if h.SQLFunc == "" {
		return nil, fmt.Errorf("runSQLFunc: handler %s.%s missing SQLFunc", h.Endpoint, h.Action)
	}
	if h.OutputType == nil {
		return nil, fmt.Errorf("runSQLFunc: handler %s.%s missing OutputType", h.Endpoint, h.Action)
	}

	// PreRun hook (project.import.* uses this to read CSV bytes
	// from file_chunk + parse them before the SQL function walks
	// rows). Same tx, same ctx; returns the transformed input
	// slice or a *reg.HandlerError pinned to its InputIndex.
	if h.PreRun != nil {
		newIns, prErr := h.PreRun(ctx, tx, ins)
		if prErr != nil {
			return nil, prErr
		}
		if len(newIns) != len(ins) {
			return nil, fmt.Errorf("%s.%s: pre_run returned %d inputs for %d originals",
				h.Endpoint, h.Action, len(newIns), len(ins))
		}
		ins = newIns
	}

	inputsJSON, err := json.Marshal(ins)
	if err != nil {
		return nil, fmt.Errorf("%s.%s: marshal inputs: %w", h.Endpoint, h.Action, err)
	}

	actorID := auth.ActorOrSystem(ctx)
	// Quote the function name conservatively. SQLFunc is registered
	// in-code (no user input) so injection isn't a real risk, but
	// the dispatcher's invariant is "never concat user values into
	// SQL"; folding it into the same shape keeps the rule uniform.
	q := fmt.Sprintf(
		"SELECT idx, ok, code, message, result FROM %s($1::bigint, $2::jsonb) ORDER BY idx",
		quoteIdent(h.SQLFunc),
	)
	rows, err := tx.Query(ctx, q, actorID, inputsJSON)
	if err != nil {
		return nil, mapPGError(h, err)
	}
	defer rows.Close()

	outs := make([]any, len(ins))
	filled := 0
	for rows.Next() {
		var idx int
		var ok bool
		var code, message string
		var resultJSON []byte
		if scanErr := rows.Scan(&idx, &ok, &code, &message, &resultJSON); scanErr != nil {
			return nil, fmt.Errorf("%s.%s: scan: %w", h.Endpoint, h.Action, scanErr)
		}
		if idx < 0 || idx >= len(ins) {
			return nil, fmt.Errorf("%s.%s: row idx %d out of range [0, %d)", h.Endpoint, h.Action, idx, len(ins))
		}
		if !ok {
			he := &reg.HandlerError{
				InputIndex: idx,
				Code:       code,
				Message:    message,
			}
			// On failure, the `result` column doubles as the structured
			// Detail payload. Migrated handlers (e.g. attribute.update's
			// flow_disallowed / flow_role_required) emit a JSON object
			// here so the dispatcher's ErrorEnvelope carries it
			// verbatim; legacy callers that leave it NULL still work.
			if len(resultJSON) > 0 && !bytes.Equal(bytes.TrimSpace(resultJSON), []byte("null")) {
				var detail any
				if uErr := json.Unmarshal(resultJSON, &detail); uErr == nil {
					he.Detail = detail
				}
			}
			return nil, he
		}
		if resultJSON == nil {
			return nil, fmt.Errorf("%s.%s: row %d ok=true but result is null", h.Endpoint, h.Action, idx)
		}
		outVal := reflect.New(h.OutputType).Interface()
		if uErr := json.Unmarshal(resultJSON, outVal); uErr != nil {
			return nil, fmt.Errorf("%s.%s: row %d unmarshal result: %w", h.Endpoint, h.Action, idx, uErr)
		}
		outs[idx] = reflect.ValueOf(outVal).Elem().Interface()
		filled++
	}
	if rErr := rows.Err(); rErr != nil {
		return nil, mapPGError(h, rErr)
	}
	if filled != len(ins) {
		return nil, fmt.Errorf("%s.%s: returned %d rows for %d inputs",
			h.Endpoint, h.Action, filled, len(ins))
	}
	if s.Pool != nil {
		// Mirror the legacy handlers' `p.NoteWrite()` / `p.NoteRead()`
		// at the end of each successful run. Read-shaped handlers
		// (`IsRead`) note one read per call so LATERAL-read benches
		// that assert `LastReads()==1` keep working post-migration;
		// every other SQLFunc handler is a write by convention.
		if h.IsRead {
			s.Pool.NoteRead()
		} else {
			s.Pool.NoteWrite()
		}
	}
	if h.PostRun != nil {
		// Same tx, same ctx; PostRun may mutate `outs` in place
		// (e.g. attachment.create fills in thumb_file_id after the
		// Go-side image decode). Errors abort the batch.
		if err := h.PostRun(ctx, tx, ins, outs); err != nil {
			return nil, fmt.Errorf("%s.%s: post_run: %w", h.Endpoint, h.Action, err)
		}
	}
	return outs, nil
}

// mapPGError translates a pgx-side error to a *reg.HandlerError when
// the SQLSTATE indicates a row-level rejection that escaped the
// function (e.g. a constraint violation the function didn't
// pre-check). Other errors pass through wrapped for context.
func mapPGError(h reg.Handler, err error) error {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return fmt.Errorf("%s.%s: %w", h.Endpoint, h.Action, err)
	}
	switch pgErr.Code {
	case "P0001":
		// RAISE EXCEPTION inside the function — use the message as-is.
		return &reg.HandlerError{Code: "internal", Message: pgErr.Message}
	case "23505":
		return &reg.HandlerError{Code: "conflict", Message: pgErr.Message}
	case "23503":
		return &reg.HandlerError{Code: "fk_violation", Message: pgErr.Message}
	case "40P01":
		return &reg.HandlerError{Code: "deadlock", Message: pgErr.Message}
	case "57014":
		// query_canceled — timeout fired (S1).
		return &reg.HandlerError{Code: "timeout", Message: pgErr.Message}
	}
	return fmt.Errorf("%s.%s: %w", h.Endpoint, h.Action, err)
}

// quoteIdent wraps a SQL identifier in double quotes and escapes any
// embedded quotes. Used for the function name in `runSQLFunc`'s
// dynamic SELECT; not for user values (those flow through pgx as
// $1/$2 parameters).
func quoteIdent(s string) string {
	out := make([]byte, 0, len(s)+2)
	out = append(out, '"')
	for i := 0; i < len(s); i++ {
		if s[i] == '"' {
			out = append(out, '"', '"')
		} else {
			out = append(out, s[i])
		}
	}
	out = append(out, '"')
	return string(out)
}
