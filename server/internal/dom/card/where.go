// File card/where.go: predicate-tree compilation for the `tree` field
// of card.select_with_attributes.
//
// The legacy `where[]` field (a flat list of attribute predicates that
// the server ANDs together) keeps working — see translatePredicate in
// select_attrs.go. The `tree` field below is the v2 shape used by the
// general filter UI (T2) and lets clients express OR / NOT / nesting.
//
// Design constraints:
//   - Every value flows through pgx parameters via addArg — caller
//     supplied data is NEVER concatenated into SQL.
//   - The compiled SQL slots straight into the outer WHERE the same way
//     translatePredicate's output does (it is a boolean expression
//     suitable for AND-joining with the soft-delete / parent / type
//     clauses).
//   - When `tree` is set on the wire, queryOne uses ONLY the tree (and
//     ignores the flat `where[]` list). This is the explicit hand-off
//     between v1 and v2; clients pick one or the other.

package card

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

// CardWhereGroup is the recursive predicate-tree wire shape. A group has
// a connective (and/or/not) plus a list of children; each child is
// either another group or a leaf. NOT groups must have exactly one child
// (any other shape is rejected at compile time).
//
// Children carry both shapes; the compiler picks based on whether
// `connective` is set.
type CardWhereGroup struct {
	Connective string              `json:"connective" mcp:"required,enum=and|or|not,desc=group connective"`
	Children   []CardWhereTreeNode `json:"children,omitempty" mcp:"desc=child predicates (leaves or groups)"`
}

// CardWhereTreeNode is one tree node. Either Connective is set (it's a
// group with Children) OR Attr/Op are set (it's a leaf). The compiler
// picks based on which shape is populated.
type CardWhereTreeNode struct {
	// Group fields.
	Connective string              `json:"connective,omitempty" mcp:"desc=group connective when this node is a group"`
	Children   []CardWhereTreeNode `json:"children,omitempty" mcp:"desc=child predicates when this node is a group"`

	// Leaf fields.
	Attr   string            `json:"attr,omitempty" mcp:"desc=attribute name (leaf shape)"`
	Op     string            `json:"op,omitempty" mcp:"desc=comparison operator (leaf shape)"`
	Values []json.RawMessage `json:"values,omitempty" mcp:"desc=values for the leaf operator"`
}

// compileCtx threads the per-compile environment through every recursive
// call: the SQL parameter binder (`addArg`), the schema snapshot for
// card_ref value canonicalisation, plus the pgx ctx/tx and a `visited`
// set used by the `snippet` leaf to detect reference cycles between
// predicate_snippet cards. `tx` may be nil for tests / call sites that
// don't need snippet expansion — leaves with op="snippet" then fail
// with a clear error.
type compileCtx struct {
	ctx     context.Context
	tx      store.Querier
	addArg  func(any) string
	snap    *schema.Snapshot
	visited map[int64]bool
}

// CompileTree is the exported entry point used by other domain packages
// that need to layer the same v2 predicate-tree compilation on top of
// their own queries. The addArg callback hands back the parameter
// placeholder string for one bound argument; the returned token is
// spliced verbatim into the SQL. Callers using `internal/named`
// pass `b.Bind` here (returns `:_bN`); legacy callers pass a
// `$N`-emitting closure backed by their own `[]any`. `snap` lets the
// compiler look up
// attribute_def.value_type so it can canonicalise card_ref values to
// JSON numbers before they hit jsonb comparison (clients ship bigint
// ids as JSON strings, seeded storage uses JSON numbers — without the
// snap lookup the two never match). Pass nil to skip the lookup
// (legacy callers / tests that ship number-form values directly).
//
// `ctx` and `tx` are needed when the predicate references a
// predicate_snippet card (op="snippet") so the compiler can dereference
// the stored predicate at compile time. Callers that don't pass these
// and hit a snippet leaf get an explicit error.
func CompileTree(ctx context.Context, tx store.Querier, g CardWhereGroup, addArg func(any) string, snap *schema.Snapshot) (string, error) {
	c := &compileCtx{ctx: ctx, tx: tx, addArg: addArg, snap: snap, visited: map[int64]bool{}}
	return compileTree(g, c)
}

// compileTree turns a CardWhereGroup into a SQL boolean expression
// suitable for the outer WHERE.
func compileTree(g CardWhereGroup, c *compileCtx) (string, error) {
	conn := strings.ToLower(g.Connective)
	switch conn {
	case "and":
		if len(g.Children) == 0 {
			return "TRUE", nil
		}
		return joinChildren(g.Children, " AND ", "TRUE", c)
	case "or":
		if len(g.Children) == 0 {
			return "FALSE", nil
		}
		return joinChildren(g.Children, " OR ", "FALSE", c)
	case "not":
		if len(g.Children) != 1 {
			return "", fmt.Errorf("not group must have exactly one child (got %d)", len(g.Children))
		}
		s, err := compileNode(g.Children[0], c)
		if err != nil {
			return "", fmt.Errorf("not.0: %w", err)
		}
		return "NOT (" + s + ")", nil
	default:
		return "", fmt.Errorf("unknown connective %q", g.Connective)
	}
}

// joinChildren compiles every child and joins them with sep; identity is
// the empty-list result.
func joinChildren(children []CardWhereTreeNode, sep, identity string, c *compileCtx) (string, error) {
	parts := make([]string, len(children))
	for i, ch := range children {
		s, err := compileNode(ch, c)
		if err != nil {
			return "", fmt.Errorf("[%d]: %w", i, err)
		}
		parts[i] = "(" + s + ")"
	}
	if len(parts) == 0 {
		return identity, nil
	}
	return strings.Join(parts, sep), nil
}

// compileNode dispatches over the leaf-vs-group shape of a node.
func compileNode(n CardWhereTreeNode, c *compileCtx) (string, error) {
	if n.Connective != "" {
		return compileTree(CardWhereGroup{
			Connective: n.Connective,
			Children:   n.Children,
		}, c)
	}
	return compileLeaf(n, c)
}

// compileLeaf turns one leaf into a SQL boolean expression. Operators
// map to PostgreSQL as follows:
//
//	eq         → av.value = $jsonb
//	ne         → av.value != $jsonb (inside an EXISTS that gates on
//	             attribute presence; see note below)
//	in         → av.value = ANY($jsonb[])
//	not in     → av.value != ALL($jsonb[]) (inside the same EXISTS)
//	exists     → EXISTS (... attribute_value row ...)
//	not exists → NOT EXISTS (... attribute_value row ...)
//
// The EXISTS / NOT EXISTS wrapping mirrors translatePredicate's v1
// behaviour: an attribute predicate is rooted in attribute_value rather
// than card so the same name can appear in many cards with their own
// per-row values. For `ne` and `not in` we make the same choice as v1:
// "attribute X is not equal to v" means "there is no attribute_value
// row with name=X and value=v" — which is what users expect for the
// inbox-style queries (a missing assignee never matches "assignee=alice"
// nor "assignee != alice"). Switch to a stricter "attribute exists AND
// is not equal" by combining `exists` and `ne` in an AND group.
// classGuard returns the value_type_id band predicate for `attr` so the
// partitioned attribute_value indexes are usable: structured attributes
// (number/bool/date/card_ref/…) live in the `(attribute_def_id, value)`
// btree (value_type_id < 1000); text lives in the trigram (>= 1000). The
// predicate is redundant-but-true for the attr's own rows (value_type_id
// derives from the def's immutable value_type), so it never changes
// results — it only lets the planner pick the right partial index. When
// the class is unknown (no snapshot / unmapped attr) it returns "" so the
// query stays correct, just unindexed for that leaf. Mirrors the
// `_class_guard` logic in card_compile_predicate.sql.
func classGuard(attr string, snap *schema.Snapshot) string {
	switch snap.ValueType(attr) {
	case "":
		return ""
	case "text":
		return " AND av.value_type_id >= 1000"
	default:
		return " AND av.value_type_id < 1000"
	}
}

func compileLeaf(n CardWhereTreeNode, c *compileCtx) (string, error) {
	addArg := c.addArg
	snap := c.snap
	if !validIdent(n.Attr) {
		return "", fmt.Errorf("bad attribute name %q", n.Attr)
	}
	op := strings.ToLower(n.Op)
	switch op {
	case "snippet":
		return compileSnippet(n, c)
	case "before_today":
		// Relative-date op: matches when the stored ISO-date text is
		// strictly less than today (server-side now()::date). Used
		// for "Overdue" snippets on the due_date attribute. No
		// values; comparison is text-to-text because ISO 8601 dates
		// sort lexically as chronologically.
		return fmt.Sprintf(`EXISTS (
			SELECT 1
			FROM attribute_value av
			JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE av.card_id = c.id
			  AND ad.name = %s
			  AND av.value #>> '{}' <> ''
			  AND av.value #>> '{}' < to_char(now()::date, 'YYYY-MM-DD')
		)`, addArg(n.Attr)), nil
	case "within_days":
		// Relative-date op: matches when the stored ISO-date text
		// sits in [today, today + N days]. N comes from values[0]
		// and must be a non-negative int (negative N would be
		// "overdue this far back"; we forbid it for clarity — use
		// before_today for past dates). Used for "Due soon" snippets.
		days, derr := withinDaysValue(n.Values)
		if derr != nil {
			return "", derr
		}
		// `days` flows through addArg as a pgx parameter (the only
		// %-substitution is the placeholder string addArg returns).
		// Multiplying by INTERVAL '1 day' lets us bind the count as a
		// plain int — no string interpolation inside the predicate.
		// Closes S5 (defence-in-depth: no value escapes the
		// "every user value is a pgx parameter" contract).
		return fmt.Sprintf(`EXISTS (
			SELECT 1
			FROM attribute_value av
			JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE av.card_id = c.id
			  AND ad.name = %s
			  AND av.value #>> '{}' <> ''
			  AND av.value #>> '{}' >= to_char(now()::date, 'YYYY-MM-DD')
			  AND av.value #>> '{}' <= to_char((now() + %s * interval '1 day')::date, 'YYYY-MM-DD')
		)`, addArg(n.Attr), addArg(days)), nil
	case "within_last_days":
		// Relative-date op, PAST window (mirror of within_days). N from
		// values[0], non-negative. Two targets: the top-level card
		// timestamps last_activity_at (via a MAX(activity) subquery — no
		// `la` join needed, so it compiles in any `FROM card c` context
		// incl. project export) / created_at (the card column), compared
		// `>= now() - N days`; or a date attribute in [today-N, today].
		days, derr := withinDaysValue(n.Values)
		if derr != nil {
			return "", derr
		}
		switch n.Attr {
		case "last_activity_at":
			return fmt.Sprintf(
				`(SELECT MAX(a.created_at) FROM activity a WHERE a.card_id = c.id) >= now() - %s * interval '1 day'`,
				addArg(days)), nil
		case "created_at":
			return fmt.Sprintf(`c.created_at >= now() - %s * interval '1 day'`, addArg(days)), nil
		default:
			return fmt.Sprintf(`EXISTS (
				SELECT 1
				FROM attribute_value av
				JOIN attribute_def ad ON ad.id = av.attribute_def_id
				WHERE av.card_id = c.id
				  AND ad.name = %s
				  AND av.value #>> '{}' <> ''
				  AND av.value #>> '{}' >= to_char((now() - %s * interval '1 day')::date, 'YYYY-MM-DD')
				  AND av.value #>> '{}' <= to_char(now()::date, 'YYYY-MM-DD')
			)`, addArg(n.Attr), addArg(days)), nil
		}
	case "=", "eq":
		// card_ref[] (e.g. tags) stores ONE row per card holding a JSON
		// array; "= X" means "the array contains the id X" (membership),
		// not scalar equality against the whole array — which never
		// matches. Use jsonb containment with the value canonicalised to
		// a number so it matches the array's numeric elements.
		if snap.ValueType(n.Attr) == "card_ref[]" {
			val := snap.CanonicalizeRefScalar(singleValue(n.Values))
			return fmt.Sprintf(`EXISTS (
				SELECT 1 FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
				WHERE av.card_id = c.id AND ad.name = %s AND av.value @> %s::jsonb
			)`, addArg(n.Attr), addArg(string(val))), nil
		}
		val := CanonicalizeFilterValue(n.Attr, snap, singleValue(n.Values))
		return fmt.Sprintf(`EXISTS (
			SELECT 1 FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE av.card_id = c.id AND ad.name = %s AND av.value = %s::jsonb%s
		)`, addArg(n.Attr), addArg(string(val)), classGuard(n.Attr, snap)), nil
	case "!=", "ne":
		// card_ref[]: "!= X" means "the array does NOT contain X".
		if snap.ValueType(n.Attr) == "card_ref[]" {
			val := snap.CanonicalizeRefScalar(singleValue(n.Values))
			return fmt.Sprintf(`NOT EXISTS (
				SELECT 1 FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
				WHERE av.card_id = c.id AND ad.name = %s AND av.value @> %s::jsonb
			)`, addArg(n.Attr), addArg(string(val))), nil
		}
		val := CanonicalizeFilterValue(n.Attr, snap, singleValue(n.Values))
		return fmt.Sprintf(`NOT EXISTS (
			SELECT 1 FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE av.card_id = c.id AND ad.name = %s AND av.value = %s::jsonb%s
		)`, addArg(n.Attr), addArg(string(val)), classGuard(n.Attr, snap)), nil
	case "in":
		if len(n.Values) == 0 {
			return "FALSE", nil
		}
		// card_ref[]: "in (X, Y)" means "the array contains X OR Y" — a
		// disjunction of membership tests, not scalar IN against the
		// whole array.
		if snap.ValueType(n.Attr) == "card_ref[]" {
			conds := make([]string, len(n.Values))
			for j, v := range n.Values {
				conds[j] = "av.value @> " + addArg(string(snap.CanonicalizeRefScalar(normalizeJSON(v)))) + "::jsonb"
			}
			return fmt.Sprintf(`EXISTS (
				SELECT 1 FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
				WHERE av.card_id = c.id AND ad.name = %s AND (%s)
			)`, addArg(n.Attr), strings.Join(conds, " OR ")), nil
		}
		placeholders := make([]string, len(n.Values))
		for j, v := range n.Values {
			placeholders[j] = addArg(string(CanonicalizeFilterValue(n.Attr, snap, normalizeJSON(v)))) + "::jsonb"
		}
		return fmt.Sprintf(`EXISTS (
			SELECT 1 FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE av.card_id = c.id AND ad.name = %s AND av.value IN (%s)%s
		)`, addArg(n.Attr), strings.Join(placeholders, ", "), classGuard(n.Attr, snap)), nil
	case "not in":
		if len(n.Values) == 0 {
			// Empty "not in" is vacuously true (nothing is in the empty
			// set). Mirror translatePredicate's empty-AND choice.
			return "TRUE", nil
		}
		// card_ref[]: "not in (X, Y)" means "the array contains NEITHER
		// X nor Y".
		if snap.ValueType(n.Attr) == "card_ref[]" {
			conds := make([]string, len(n.Values))
			for j, v := range n.Values {
				conds[j] = "av.value @> " + addArg(string(snap.CanonicalizeRefScalar(normalizeJSON(v)))) + "::jsonb"
			}
			return fmt.Sprintf(`NOT EXISTS (
				SELECT 1 FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
				WHERE av.card_id = c.id AND ad.name = %s AND (%s)
			)`, addArg(n.Attr), strings.Join(conds, " OR ")), nil
		}
		placeholders := make([]string, len(n.Values))
		for j, v := range n.Values {
			placeholders[j] = addArg(string(CanonicalizeFilterValue(n.Attr, snap, normalizeJSON(v)))) + "::jsonb"
		}
		return fmt.Sprintf(`NOT EXISTS (
			SELECT 1 FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE av.card_id = c.id AND ad.name = %s AND av.value IN (%s)%s
		)`, addArg(n.Attr), strings.Join(placeholders, ", "), classGuard(n.Attr, snap)), nil
	case "exists":
		return fmt.Sprintf(`EXISTS (
			SELECT 1 FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE av.card_id = c.id AND ad.name = %s
		)`, addArg(n.Attr)), nil
	case "not exists":
		return fmt.Sprintf(`NOT EXISTS (
			SELECT 1 FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE av.card_id = c.id AND ad.name = %s
		)`, addArg(n.Attr)), nil
	case "not terminal":
		// Hide cards whose `<attr>` ref points at a value-card with
		// phase='terminal' (e.g. status='Done', status='Cancelled'). A
		// card with NO value for <attr> passes the gate — "no status"
		// is treated as non-terminal so unstarted work isn't accidentally
		// hidden. The jsonb_typeof check shields the bigint cast from
		// stringified-id values that slipped past CanonicalizeFilterValue.
		// Kept as an alias of has_phase ∈ {'terminal'} for filter cards
		// seeded before Gate 1; new code uses has_phase directly.
		return fmt.Sprintf(`NOT EXISTS (
			SELECT 1
			FROM attribute_value av
			JOIN attribute_def ad ON ad.id = av.attribute_def_id
			JOIN card target ON target.id = (av.value)::text::bigint
			WHERE av.card_id = c.id
			  AND ad.name = %s
			  AND jsonb_typeof(av.value) = 'number'
			  AND target.phase = 'terminal'
			  AND target.deleted_at IS NULL
		)`, addArg(n.Attr)), nil
	case "parent_status_phase":
		// 2-hop traversal: gate the row on its `parent_task` ref's
		// STATUS card's phase. Unlike `has_phase`, which inspects the
		// referenced card's own `phase` column, this walks one
		// additional attribute hop because tasks themselves carry the
		// default `phase='triage'` (schema.hcsv:142) — only value-cards
		// like `status` have meaningful phases. Closes the gap that
		// blocked the "open tasks at the head of an in-progress chain"
		// filter: combine `parent_task not exists` OR `parent_task
		// parent_status_phase [terminal]` to express "no parent or
		// parent's status is done."
		//
		// `n.Attr` is required to be `parent_task` (the only attribute
		// shape this op is wired into in the client palette); the SQL
		// hard-codes the second hop as `status` since that's the
		// flow-bearing attribute every task carries.
		if n.Attr != "parent_task" {
			return "", fmt.Errorf(
				"parent_status_phase: attr must be 'parent_task' (got %q)", n.Attr)
		}
		if len(n.Values) == 0 {
			return "FALSE", nil
		}
		placeholders := make([]string, len(n.Values))
		for j, v := range n.Values {
			var s string
			if err := json.Unmarshal(v, &s); err != nil {
				return "", fmt.Errorf("parent_status_phase: value[%d] must be a string: %w", j, err)
			}
			if s != "triage" && s != "active" && s != "terminal" {
				return "", fmt.Errorf("parent_status_phase: value[%d] %q: must be triage|active|terminal", j, s)
			}
			placeholders[j] = addArg(s)
		}
		return fmt.Sprintf(`EXISTS (
			SELECT 1
			FROM attribute_value pav
			JOIN attribute_def pad ON pad.id = pav.attribute_def_id
			JOIN card parent ON parent.id = (pav.value)::text::bigint
			JOIN attribute_value sav ON sav.card_id = parent.id
			JOIN attribute_def sad ON sad.id = sav.attribute_def_id
			JOIN card status_card ON status_card.id = (sav.value)::text::bigint
			WHERE pav.card_id = c.id
			  AND pad.name = 'parent_task'
			  AND sad.name = 'status'
			  AND jsonb_typeof(pav.value) = 'number'
			  AND jsonb_typeof(sav.value) = 'number'
			  AND parent.deleted_at IS NULL
			  AND status_card.deleted_at IS NULL
			  AND status_card.phase = ANY(ARRAY[%s])
		)`, strings.Join(placeholders, ", ")), nil
	case "has_phase":
		// Show cards whose `<attr>` ref points at a value-card whose
		// phase is one of the given values. Mirror "not terminal"'s
		// dereference shape (jsonb→bigint→card) but flip to positive
		// match against the supplied phase set. `values` is a flat list
		// of phase strings, e.g. ['active'] or ['triage','active'].
		// Empty values → no row qualifies (vacuously false).
		if len(n.Values) == 0 {
			return "FALSE", nil
		}
		placeholders := make([]string, len(n.Values))
		for j, v := range n.Values {
			var s string
			if err := json.Unmarshal(v, &s); err != nil {
				return "", fmt.Errorf("has_phase: value[%d] must be a string: %w", j, err)
			}
			if s != "triage" && s != "active" && s != "terminal" {
				return "", fmt.Errorf("has_phase: value[%d] %q: must be triage|active|terminal", j, s)
			}
			placeholders[j] = addArg(s)
		}
		return fmt.Sprintf(`EXISTS (
			SELECT 1
			FROM attribute_value av
			JOIN attribute_def ad ON ad.id = av.attribute_def_id
			JOIN card target ON target.id = (av.value)::text::bigint
			WHERE av.card_id = c.id
			  AND ad.name = %s
			  AND jsonb_typeof(av.value) = 'number'
			  AND target.phase = ANY(ARRAY[%s])
			  AND target.deleted_at IS NULL
		)`, addArg(n.Attr), strings.Join(placeholders, ", ")), nil
	case "contains":
		// Trigram-accelerated substring match. The special attr name
		// "comments" pivots from attribute_value to comment_body via the
		// activity row that links a comment_body to its card; every other
		// attr name matches the rendered jsonb text of the attribute_value
		// row (so "title" / "description" hit the GIN trigram index on
		// (value::text)). The needle ships through addArg — no string
		// concatenation into SQL.
		needle, err := containsNeedle(n.Values)
		if err != nil {
			return "", err
		}
		if n.Attr == "comments" {
			return fmt.Sprintf(`EXISTS (
				SELECT 1 FROM activity a
				JOIN comment_body cb ON cb.id = (a.value_new ->> 'comment_body_id')::bigint
				WHERE a.card_id = c.id AND a.kind = 'comment' AND cb.body ILIKE %s
			)`, addArg("%"+needle+"%")), nil
		}
		return fmt.Sprintf(`EXISTS (
			SELECT 1 FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE av.card_id = c.id AND ad.name = %s AND av.value::text ILIKE %s%s
		)`, addArg(n.Attr), addArg("%"+needle+"%"), classGuard(n.Attr, snap)), nil
	default:
		return "", fmt.Errorf("unsupported op %q", n.Op)
	}
}

// containsNeedle pulls the single string value from a contains leaf.
// Empty / missing values reject so the query plan doesn't degrade to a
// full table scan via a "%%" match.
func containsNeedle(vs []json.RawMessage) (string, error) {
	if len(vs) == 0 {
		return "", fmt.Errorf("contains: missing value")
	}
	var s string
	if err := json.Unmarshal(vs[0], &s); err != nil {
		return "", fmt.Errorf("contains: value must be a string: %w", err)
	}
	if s == "" {
		return "", fmt.Errorf("contains: value must be non-empty")
	}
	return s, nil
}

// CanonicalizeFilterValue is a thin shim around
// schema.Snapshot.CanonicalizeValue, kept here so existing call sites
// in this package don't need a rename. The single source of truth for
// the canonical jsonb shape of card_ref / card_ref[] values lives in
// schema so write-side handlers (attribute.update) and read-side
// handlers (card.select_with_attributes) reach for the same logic.
func CanonicalizeFilterValue(attr string, snap *schema.Snapshot, raw json.RawMessage) json.RawMessage {
	return snap.CanonicalizeValue(attr, raw)
}

// withinDaysValue parses the `within_days` op's single integer value
// (the "N" in "next N days"). Accepts either a JSON number or a
// quoted-string number to be friendly to the dispatcher's bigint
// stringifier on the client side; rejects negative N so the op stays
// semantically distinct from before_today.
func withinDaysValue(vs []json.RawMessage) (int, error) {
	if len(vs) == 0 {
		return 0, fmt.Errorf("within_days: missing day count")
	}
	raw := vs[0]
	var n int
	if err := json.Unmarshal(raw, &n); err == nil {
		if n < 0 {
			return 0, fmt.Errorf("within_days: negative N (%d); use before_today for past dates", n)
		}
		if n > 3650 {
			return 0, fmt.Errorf("within_days: %d days is unreasonable (>10y)", n)
		}
		return n, nil
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		parsed, perr := strconv.Atoi(strings.TrimSpace(s))
		if perr != nil {
			return 0, fmt.Errorf("within_days: not an int: %q", s)
		}
		if parsed < 0 {
			return 0, fmt.Errorf("within_days: negative N (%d); use before_today for past dates", parsed)
		}
		if parsed > 3650 {
			return 0, fmt.Errorf("within_days: %d days is unreasonable (>10y)", parsed)
		}
		return parsed, nil
	}
	return 0, fmt.Errorf("within_days: value must be int or string-int")
}

// singleValue returns the first element of vs (normalised) or `null`
// when the list is empty. Used by eq / ne; the wire shape is the same
// `values: [...]` field as in/not-in for symmetry.
func singleValue(vs []json.RawMessage) json.RawMessage {
	if len(vs) == 0 {
		return json.RawMessage(`null`)
	}
	return normalizeJSON(vs[0])
}

// validIdent screens attribute names so they cannot inject SQL when they
// flow through ad.name = $N comparisons. We only allow [A-Za-z0-9_].
func validIdent(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if !(r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')) {
			return false
		}
	}
	return true
}

// normalizeJSON returns the input unchanged if non-empty; "null" otherwise.
func normalizeJSON(b json.RawMessage) json.RawMessage {
	if len(b) == 0 {
		return json.RawMessage(`null`)
	}
	return b
}

// compileSnippet expands a `snippet` leaf by fetching the referenced
// predicate_snippet card's stored predicate JSON and recursively
// compiling it as if it had been written inline. Cycles between
// snippets are detected via `c.visited` and surface as an error
// instead of looping. A missing or soft-deleted snippet compiles to
// FALSE: a stale reference shouldn't widen the result set, and FALSE
// makes the failure visible (zero rows) rather than silent (any-rows).
func compileSnippet(n CardWhereTreeNode, c *compileCtx) (string, error) {
	if c.tx == nil {
		return "", fmt.Errorf("snippet: compiler has no tx (call site didn't pass ctx/tx)")
	}
	if len(n.Values) == 0 {
		return "", fmt.Errorf("snippet: missing snippet id")
	}
	id, err := snippetIDFromRaw(n.Values[0])
	if err != nil {
		return "", fmt.Errorf("snippet: value[0]: %w", err)
	}
	if c.visited[id] {
		return "", fmt.Errorf("snippet: cycle detected at snippet id %d", id)
	}

	// Fetch the snippet card's `predicate` attribute value. The card
	// type gate keeps a misused snippet id (pointing at a non-snippet
	// card) from being decoded as a tree.
	var raw string
	err = c.tx.QueryRow(c.ctx, `
		SELECT COALESCE(av.value #>> '{}', '')
		FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id
		LEFT JOIN LATERAL (
			SELECT av.value
			FROM attribute_value av
			JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE av.card_id = c.id AND ad.name = 'predicate'
			LIMIT 1
		) av ON TRUE
		WHERE c.id = $1
		  AND c.deleted_at IS NULL
		  AND ct.name = 'predicate_snippet'
	`, id).Scan(&raw)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "FALSE", nil
		}
		return "", fmt.Errorf("snippet: lookup id=%d: %w", id, err)
	}
	if strings.TrimSpace(raw) == "" {
		// Snippet exists but carries no predicate — treat as no-op
		// (TRUE so it doesn't mask the rest of the AND it lives in).
		return "TRUE", nil
	}

	// Snippets can be either a bare leaf or a group. Decode as the
	// general node shape and route accordingly.
	var node CardWhereTreeNode
	if err := json.Unmarshal([]byte(raw), &node); err != nil {
		return "", fmt.Errorf("snippet id=%d: decode predicate: %w", id, err)
	}

	// Push id onto visited for the recursive expansion; pop on return.
	c.visited[id] = true
	defer delete(c.visited, id)
	return compileNode(node, c)
}

// snippetIDFromRaw decodes a snippet id from the wire shape. Clients
// send bigint ids as JSON strings via the dispatcher's outgoing
// replacer; legacy callers / tests may also send a JSON number.
// Accept both shapes.
func snippetIDFromRaw(r json.RawMessage) (int64, error) {
	var s string
	if err := json.Unmarshal(r, &s); err == nil {
		n, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			return 0, fmt.Errorf("not an int: %q", s)
		}
		return n, nil
	}
	var n int64
	if err := json.Unmarshal(r, &n); err != nil {
		return 0, fmt.Errorf("must be a JSON string or number")
	}
	return n, nil
}
