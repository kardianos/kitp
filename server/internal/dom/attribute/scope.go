// File attribute/scope.go: per-project reference-scope validation. A task
// in project A may not point milestone_ref / component_ref / tags at value-
// cards living under project B. The check walks each value-card's parent
// chain to its enclosing project and asserts equality with the target
// card's enclosing project.
//
// Pre-filter on IsProjectScopedAttr and pre-parse JSON values via
// ParseCardRefValue, then hand a batch of ProjectScopeCheck rows to
// ValidateProjectScope for a single read.
//
// `assignee` (card_ref to a global `person` card) is deliberately out of
// scope — persons have no enclosing project, so the rule cannot apply.
package attribute

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/reg"
)

// Reader is the read surface ValidateProjectScope needs. Both pgxpool.Pool
// (pre-tx, via reg.ValidationPool) and pgx.Tx (in-tx, runInsert/runApply)
// satisfy it.
type Reader interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// ProjectScopeCheck is one (target, value-cards) pair to validate.
//
// StartCardID anchors the enclosing-project walk:
//   - For attribute.update / tag.apply, pass the target card id; the
//     walk lands on the project that contains it.
//   - For card.insert (the target row does not yet exist), pass the new
//     card's parent_card_id; the walk starts there.
//
// AttributeName is used only for diagnostic messages; callers must
// pre-filter with IsProjectScopedAttr so the helper never sees attrs
// the rule doesn't cover (e.g. assignee).
//
// ValueCardIDs lists every card id referenced by the write. The caller
// converts JSON values via ParseCardRefValue. Empty / null values are
// skipped upstream and should not reach this struct.
//
// InputIndex is the slot in the caller's input slice; the returned
// HandlerError carries it so the dispatcher can pin the failure to the
// originating sub-request.
type ProjectScopeCheck struct {
	StartCardID   int64
	AttributeName string
	ValueCardIDs  []int64
	InputIndex    int
	// TargetCardTypeID, when non-zero, constrains the validator to
	// accept only value cards whose card_type_id matches. The check is
	// derived from attribute_def.target_card_type_id and rejects
	// e.g. `milestone_ref` pointing at a `person` card with
	// `cross_project_ref` even though the person has no project
	// ancestor to clash with.
	TargetCardTypeID int64
}

// ValidateProjectScope batches enclosing-project lookups for every
// (StartCardID + ValueCardIDs) in `checks` and rejects any check where
// the start card and a referenced value-card resolve to different
// projects. The first violation surfaces as a *reg.HandlerError with
// code "cross_project_ref"; infra failures surface as a wrapped error.
//
// A value card with no enclosing project (a global card, e.g. person)
// is treated as a wildcard and accepted against any target — global
// values are by definition project-independent. The target itself is
// allowed to be global too: when the target has no project (i.e. is
// itself a global card), the value-cards must also be global.
//
// Card existence is verified separately; a referenced id with no row
// in `card` at all surfaces as cross_project_ref so the caller sees a
// clear failure instead of a silent accept.
func ValidateProjectScope(ctx context.Context, db Reader, checks []ProjectScopeCheck) error {
	if len(checks) == 0 {
		return nil
	}
	// Collect every card id we need to resolve in one batched walk.
	ids := map[int64]struct{}{}
	for _, c := range checks {
		if c.StartCardID == 0 {
			return &reg.HandlerError{InputIndex: c.InputIndex, Code: "validation",
				Message: fmt.Sprintf("attribute %q: missing target card id for scope check", c.AttributeName)}
		}
		ids[c.StartCardID] = struct{}{}
		for _, v := range c.ValueCardIDs {
			if v != 0 {
				ids[v] = struct{}{}
			}
		}
	}
	idList := make([]int64, 0, len(ids))
	for id := range ids {
		idList = append(idList, id)
	}
	projectByCard, existsByCard, err := enclosingProjectIDs(ctx, db, idList)
	if err != nil {
		return err
	}
	// One read of card_type_id per referenced value (and target) so we
	// can enforce the attribute_def.target_card_type_id contract.
	cardTypeByCard, err := cardTypeIDs(ctx, db, idList)
	if err != nil {
		return err
	}

	for _, c := range checks {
		if !existsByCard[c.StartCardID] {
			return &reg.HandlerError{InputIndex: c.InputIndex, Code: "cross_project_ref",
				Message: fmt.Sprintf("attribute %q: target card %d does not exist",
					c.AttributeName, c.StartCardID)}
		}
		targetProj := projectByCard[c.StartCardID] // 0 when the target is a global card
		for _, v := range c.ValueCardIDs {
			if v == 0 {
				continue
			}
			if !existsByCard[v] {
				return &reg.HandlerError{InputIndex: c.InputIndex, Code: "cross_project_ref",
					Message: fmt.Sprintf("attribute %q: value card %d does not exist",
						c.AttributeName, v)}
			}
			// Card-type contract: when the attribute_def names a
			// target_card_type, the value MUST be a card of that type.
			// Catches `milestone_ref` pointing at a `person`, etc.
			if c.TargetCardTypeID != 0 && cardTypeByCard[v] != c.TargetCardTypeID {
				return &reg.HandlerError{InputIndex: c.InputIndex, Code: "cross_project_ref",
					Message: fmt.Sprintf("attribute %q: value card %d is not of the expected card type",
						c.AttributeName, v)}
			}
			valProj := projectByCard[v] // 0 when the value is a global card (e.g. person)
			if valProj == 0 {
				continue // global value is a wildcard
			}
			if valProj != targetProj {
				return &reg.HandlerError{InputIndex: c.InputIndex, Code: "cross_project_ref",
					Message: fmt.Sprintf("attribute %q: value card %d belongs to project %d but target is in project %d",
						c.AttributeName, v, valProj, targetProj)}
			}
		}
	}
	return nil
}

// cardTypeIDs returns id -> card_type_id for every input row that
// exists in `card`. Missing ids are simply absent from the map.
func cardTypeIDs(ctx context.Context, db Reader, cardIDs []int64) (map[int64]int64, error) {
	out := map[int64]int64{}
	if len(cardIDs) == 0 {
		return out, nil
	}
	rows, err := db.Query(ctx,
		`SELECT id, card_type_id FROM card WHERE id = ANY($1::bigint[])`, cardIDs)
	if err != nil {
		return nil, fmt.Errorf("cardTypeIDs: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, ct int64
		if err := rows.Scan(&id, &ct); err != nil {
			return nil, err
		}
		out[id] = ct
	}
	return out, rows.Err()
}

// enclosingProjectIDs returns two maps over the input ids:
//   - projectByCard: card_id → enclosing_project_id (only for cards that
//     have a project ancestor; a project IS its own enclosing project).
//   - existsByCard: card_id → true for every id whose row is present in
//     `card`. Used by callers to distinguish "missing" from "global"
//     (a missing card is a hard error; a global card is a wildcard).
//
// A single recursive CTE walks the parent_card_id chain in parallel
// for every input id, so the helper costs one round-trip regardless
// of batch size. A second query confirms existence — cheap and
// keeps the scope check correct for both shapes.
func enclosingProjectIDs(ctx context.Context, db Reader, cardIDs []int64) (map[int64]int64, map[int64]bool, error) {
	existsByCard := map[int64]bool{}
	if len(cardIDs) == 0 {
		return map[int64]int64{}, existsByCard, nil
	}
	existsRows, err := db.Query(ctx, `SELECT id FROM card WHERE id = ANY($1::bigint[])`, cardIDs)
	if err != nil {
		return nil, nil, fmt.Errorf("enclosingProjectIDs: exists: %w", err)
	}
	for existsRows.Next() {
		var id int64
		if err := existsRows.Scan(&id); err != nil {
			existsRows.Close()
			return nil, nil, err
		}
		existsByCard[id] = true
	}
	existsRows.Close()
	if err := existsRows.Err(); err != nil {
		return nil, nil, err
	}
	const q = `
		WITH RECURSIVE up(start_id, id, parent_card_id, type_name) AS (
			SELECT c.id, c.id, c.parent_card_id, ct.name
			FROM card c JOIN card_type ct ON ct.id = c.card_type_id
			WHERE c.id = ANY($1::bigint[])
		  UNION ALL
			SELECT up.start_id, c.id, c.parent_card_id, ct.name
			FROM card c JOIN card_type ct ON ct.id = c.card_type_id
			JOIN up ON up.parent_card_id = c.id
		)
		SELECT start_id, id FROM up WHERE type_name = 'project'
	`
	rows, err := db.Query(ctx, q, cardIDs)
	if err != nil {
		return nil, nil, fmt.Errorf("enclosingProjectIDs: %w", err)
	}
	defer rows.Close()
	out := map[int64]int64{}
	for rows.Next() {
		var start, project int64
		if err := rows.Scan(&start, &project); err != nil {
			return nil, nil, err
		}
		out[start] = project
	}
	return out, existsByCard, rows.Err()
}

// ParseCardRefValue decodes a project-scoped attribute's JSON value into
// the slice of card ids it references. For scalar card_ref attributes
// (milestone_ref, component_ref) the slice has at most one id; for the
// card_ref[] attribute `tags` it can have many. Numeric values and
// numeric strings are both accepted — the dispatcher serialises bigint
// ids as strings while seed data uses bare numbers.
//
// A literal null payload returns (nil, nil); callers should short-circuit
// on null upstream so this only sees real writes.
func ParseCardRefValue(attr string, raw json.RawMessage) ([]int64, error) {
	if len(raw) == 0 || isJSONNull(raw) {
		return nil, nil
	}
	if attr == "tags" {
		var arr []json.RawMessage
		if err := json.Unmarshal(raw, &arr); err != nil {
			return nil, fmt.Errorf("tags: value must be a JSON array of card ids")
		}
		out := make([]int64, 0, len(arr))
		for _, el := range arr {
			id, err := parseCardID(el)
			if err != nil {
				return nil, fmt.Errorf("tags: %w", err)
			}
			if id != 0 {
				out = append(out, id)
			}
		}
		return out, nil
	}
	id, err := parseCardID(raw)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", attr, err)
	}
	if id == 0 {
		return nil, nil
	}
	return []int64{id}, nil
}

func parseCardID(raw json.RawMessage) (int64, error) {
	var n int64
	if err := json.Unmarshal(raw, &n); err == nil {
		return n, nil
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		v, perr := strconv.ParseInt(s, 10, 64)
		if perr == nil {
			return v, nil
		}
	}
	return 0, fmt.Errorf("card_ref value not a number or numeric string: %s", string(raw))
}
