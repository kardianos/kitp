// Predicate evaluator for aggregate guards.
//
// Background: WORKFLOW_AGGREGATE_GUARDS_PLAN.md + IMPL_PLAN_SCOPED_WORKFLOW
// Phase 5.
//
// The shape of a guard is:
//
//	{
//	  "scope":   {"card_type": "test_case"},
//	  "match":   "all" | "any" | "none",
//	  "where":   { "<attr_name>": { "<op>": <operand> | true } }
//	}
//
// Operators: eq, neq, in, nin, lt, lte, gt, gte, set, unset.
// Quantifiers: all (vacuous true on empty scope), any, none (vacuous true).
//
// The evaluator walks direct children of the parent (one hop only),
// matches `where` against each child's attribute_value rows, counts the
// matches, and compares against the quantifier.
package workflowtransition

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// Guard is the deserialised shape.
type Guard struct {
	Scope    GuardScope            `json:"scope"`
	Match    string                `json:"match"`
	Where    map[string]GuardCheck `json:"where"`
}

// GuardScope selects the descendant set.
type GuardScope struct {
	CardType string `json:"card_type"`
}

// GuardCheck is a single attribute predicate. At most one operator
// field is set per check.
type GuardCheck struct {
	Eq     *json.RawMessage `json:"eq,omitempty"`
	Neq    *json.RawMessage `json:"neq,omitempty"`
	In     []json.RawMessage `json:"in,omitempty"`
	Nin    []json.RawMessage `json:"nin,omitempty"`
	Lt     *float64         `json:"lt,omitempty"`
	Lte    *float64         `json:"lte,omitempty"`
	Gt     *float64         `json:"gt,omitempty"`
	Gte    *float64         `json:"gte,omitempty"`
	Set    *bool            `json:"set,omitempty"`
	Unset  *bool            `json:"unset,omitempty"`
}

// EvaluateGuard runs the predicate. Returns (passed, message). The
// message is human-readable when the guard failed and is suitable for
// surfacing in error responses.
func EvaluateGuard(ctx context.Context, tx pgx.Tx, parentCardID int64, raw json.RawMessage) (bool, string, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return true, "", nil
	}
	var g Guard
	if err := json.Unmarshal(raw, &g); err != nil {
		return false, "", fmt.Errorf("aggregate_guard: parse: %w", err)
	}
	if g.Scope.CardType == "" {
		return false, "", fmt.Errorf("aggregate_guard: scope.card_type is required")
	}
	if g.Match == "" {
		g.Match = "all"
	}
	switch g.Match {
	case "all", "any", "none":
		// ok
	default:
		return false, "", fmt.Errorf("aggregate_guard: unknown match %q", g.Match)
	}

	// Load every direct child of the parent matching the scope, with the
	// attributes referenced by `where`. We do one query: the child rows
	// plus a left-join per attribute name. For simplicity we read each
	// referenced attribute via a sub-select.
	var attrNames []string
	for k := range g.Where {
		attrNames = append(attrNames, k)
	}
	const baseQ = `
		SELECT c.id
		FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id
		WHERE c.parent_card_id = $1
		  AND ct.name = $2
		  AND c.deleted_at IS NULL
	`
	rows, err := tx.Query(ctx, baseQ, parentCardID, g.Scope.CardType)
	if err != nil {
		return false, "", fmt.Errorf("aggregate_guard: child scan: %w", err)
	}
	var childIDs []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return false, "", err
		}
		childIDs = append(childIDs, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return false, "", err
	}

	// Empty scope semantics: all/none are vacuously true; any is false.
	total := len(childIDs)
	if total == 0 {
		switch g.Match {
		case "all":
			return true, "0 of 0 children matched (vacuously satisfied)", nil
		case "any":
			return false, "0 of 0 children matched", nil
		case "none":
			return true, "0 of 0 children matched (vacuously satisfied)", nil
		}
	}

	// Per-child evaluation.
	matches := 0
	for _, id := range childIDs {
		ok, err := childMatches(ctx, tx, id, g.Where, attrNames)
		if err != nil {
			return false, "", err
		}
		if ok {
			matches++
		}
	}

	pass := false
	switch g.Match {
	case "all":
		pass = matches == total
	case "any":
		pass = matches > 0
	case "none":
		pass = matches == 0
	}
	msg := fmt.Sprintf("%d of %d children matched (%s)", matches, total, g.Match)
	return pass, msg, nil
}

func childMatches(ctx context.Context, tx pgx.Tx, childID int64, where map[string]GuardCheck, attrNames []string) (bool, error) {
	// Read every referenced attribute_value for this child.
	values := map[string]json.RawMessage{}
	for _, name := range attrNames {
		var raw json.RawMessage
		err := tx.QueryRow(ctx, `
			SELECT av.value
			FROM attribute_value av
			JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE av.card_id = $1 AND ad.name = $2
		`, childID, name).Scan(&raw)
		if err != nil && err != pgx.ErrNoRows {
			return false, fmt.Errorf("aggregate_guard: read %s: %w", name, err)
		}
		values[name] = raw
	}
	for name, check := range where {
		v, hasValue := values[name]
		if check.Set != nil && *check.Set {
			if !hasValue || len(v) == 0 || string(v) == "null" {
				return false, nil
			}
			continue
		}
		if check.Unset != nil && *check.Unset {
			if hasValue && len(v) > 0 && string(v) != "null" {
				return false, nil
			}
			continue
		}
		if !hasValue {
			return false, nil
		}
		if check.Eq != nil {
			if !jsonEqual(v, *check.Eq) {
				return false, nil
			}
		}
		if check.Neq != nil {
			if jsonEqual(v, *check.Neq) {
				return false, nil
			}
		}
		if len(check.In) > 0 {
			any := false
			for _, candidate := range check.In {
				if jsonEqual(v, candidate) {
					any = true
					break
				}
			}
			if !any {
				return false, nil
			}
		}
		if len(check.Nin) > 0 {
			for _, candidate := range check.Nin {
				if jsonEqual(v, candidate) {
					return false, nil
				}
			}
		}
		if check.Lt != nil || check.Lte != nil || check.Gt != nil || check.Gte != nil {
			f, err := jsonNumber(v)
			if err != nil {
				return false, nil
			}
			if check.Lt != nil && !(f < *check.Lt) {
				return false, nil
			}
			if check.Lte != nil && !(f <= *check.Lte) {
				return false, nil
			}
			if check.Gt != nil && !(f > *check.Gt) {
				return false, nil
			}
			if check.Gte != nil && !(f >= *check.Gte) {
				return false, nil
			}
		}
	}
	return true, nil
}

// jsonEqual normalises whitespace/ordering and compares.
func jsonEqual(a, b json.RawMessage) bool {
	var av, bv any
	if err := json.Unmarshal(a, &av); err != nil {
		return false
	}
	if err := json.Unmarshal(b, &bv); err != nil {
		return false
	}
	ab, _ := json.Marshal(av)
	bb, _ := json.Marshal(bv)
	return string(ab) == string(bb)
}

func jsonNumber(v json.RawMessage) (float64, error) {
	var f float64
	if err := json.Unmarshal(v, &f); err != nil {
		return 0, err
	}
	return f, nil
}
