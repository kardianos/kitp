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
	"encoding/json"
	"fmt"
	"strings"

	"github.com/kitp/kitp/server/internal/schema"
)

// CardWhereGroup is the recursive predicate-tree wire shape. A group has
// a connective (and/or/not) plus a list of children; each child is
// either another group or a leaf. NOT groups must have exactly one child
// (any other shape is rejected at compile time).
//
// Children carry both shapes; the compiler picks based on whether
// `connective` is set.
type CardWhereGroup struct {
	Connective string                `json:"connective" mcp:"required,enum=and|or|not,desc=group connective"`
	Children   []CardWhereTreeNode   `json:"children,omitempty" mcp:"desc=child predicates (leaves or groups)"`
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

// CompileTree is the exported entry point used by other domain packages
// that need to layer the same v2 predicate-tree compilation on top of
// their own queries. It is a thin alias around compileTree; the addArg
// callback hands back the parameter placeholder string (e.g. "$3") for
// one bound argument, mirroring the per-handler counter. `snap` lets the
// compiler look up attribute_def.value_type so it can canonicalise
// card_ref values to JSON numbers before they hit jsonb comparison
// (clients ship bigint ids as JSON strings, seeded storage uses JSON
// numbers — without the snap lookup the two never match). Pass nil to
// skip the lookup (legacy callers / tests that ship number-form values
// directly).
func CompileTree(g CardWhereGroup, addArg func(any) string, snap *schema.Snapshot) (string, error) {
	return compileTree(g, addArg, snap)
}

// compileTree turns a CardWhereGroup into a SQL boolean expression
// suitable for the outer WHERE. addArg threads through the parameter
// counter shared with the rest of queryOne; snap threads through to the
// leaf compiler for card_ref value canonicalisation.
func compileTree(g CardWhereGroup, addArg func(any) string, snap *schema.Snapshot) (string, error) {
	conn := strings.ToLower(g.Connective)
	switch conn {
	case "and":
		if len(g.Children) == 0 {
			return "TRUE", nil
		}
		return joinChildren(g.Children, " AND ", "TRUE", addArg, snap)
	case "or":
		if len(g.Children) == 0 {
			return "FALSE", nil
		}
		return joinChildren(g.Children, " OR ", "FALSE", addArg, snap)
	case "not":
		if len(g.Children) != 1 {
			return "", fmt.Errorf("not group must have exactly one child (got %d)", len(g.Children))
		}
		s, err := compileNode(g.Children[0], addArg, snap)
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
func joinChildren(children []CardWhereTreeNode, sep, identity string, addArg func(any) string, snap *schema.Snapshot) (string, error) {
	parts := make([]string, len(children))
	for i, c := range children {
		s, err := compileNode(c, addArg, snap)
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
func compileNode(n CardWhereTreeNode, addArg func(any) string, snap *schema.Snapshot) (string, error) {
	if n.Connective != "" {
		return compileTree(CardWhereGroup{
			Connective: n.Connective,
			Children:   n.Children,
		}, addArg, snap)
	}
	return compileLeaf(n, addArg, snap)
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
func compileLeaf(n CardWhereTreeNode, addArg func(any) string, snap *schema.Snapshot) (string, error) {
	if !validIdent(n.Attr) {
		return "", fmt.Errorf("bad attribute name %q", n.Attr)
	}
	op := strings.ToLower(n.Op)
	switch op {
	case "=", "eq":
		val := CanonicalizeFilterValue(n.Attr, snap, singleValue(n.Values))
		return fmt.Sprintf(`EXISTS (
			SELECT 1 FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE av.card_id = c.id AND ad.name = %s AND av.value = %s::jsonb
		)`, addArg(n.Attr), addArg(string(val))), nil
	case "!=", "ne":
		val := CanonicalizeFilterValue(n.Attr, snap, singleValue(n.Values))
		return fmt.Sprintf(`NOT EXISTS (
			SELECT 1 FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE av.card_id = c.id AND ad.name = %s AND av.value = %s::jsonb
		)`, addArg(n.Attr), addArg(string(val))), nil
	case "in":
		if len(n.Values) == 0 {
			return "FALSE", nil
		}
		placeholders := make([]string, len(n.Values))
		for j, v := range n.Values {
			placeholders[j] = addArg(string(CanonicalizeFilterValue(n.Attr, snap, normalizeJSON(v)))) + "::jsonb"
		}
		return fmt.Sprintf(`EXISTS (
			SELECT 1 FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE av.card_id = c.id AND ad.name = %s AND av.value IN (%s)
		)`, addArg(n.Attr), strings.Join(placeholders, ", ")), nil
	case "not in":
		if len(n.Values) == 0 {
			// Empty "not in" is vacuously true (nothing is in the empty
			// set). Mirror translatePredicate's empty-AND choice.
			return "TRUE", nil
		}
		placeholders := make([]string, len(n.Values))
		for j, v := range n.Values {
			placeholders[j] = addArg(string(CanonicalizeFilterValue(n.Attr, snap, normalizeJSON(v)))) + "::jsonb"
		}
		return fmt.Sprintf(`NOT EXISTS (
			SELECT 1 FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE av.card_id = c.id AND ad.name = %s AND av.value IN (%s)
		)`, addArg(n.Attr), strings.Join(placeholders, ", ")), nil
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
		// Hide cards whose `<attr>` ref points at a card flagged
		// is_terminal=TRUE (e.g. status='Done', status='Cancelled'). A
		// card with NO value for <attr> passes the gate — "no status"
		// is treated as non-terminal so unstarted work isn't accidentally
		// hidden. The jsonb_typeof check shields the bigint cast from
		// stringified-id values that slipped past CanonicalizeFilterValue.
		return fmt.Sprintf(`NOT EXISTS (
			SELECT 1
			FROM attribute_value av
			JOIN attribute_def ad ON ad.id = av.attribute_def_id
			JOIN card target ON target.id = (av.value)::text::bigint
			WHERE av.card_id = c.id
			  AND ad.name = %s
			  AND jsonb_typeof(av.value) = 'number'
			  AND target.is_terminal = TRUE
			  AND target.deleted_at IS NULL
		)`, addArg(n.Attr)), nil
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
			WHERE av.card_id = c.id AND ad.name = %s AND av.value::text ILIKE %s
		)`, addArg(n.Attr), addArg("%"+needle+"%")), nil
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

// singleValue returns the first element of vs (normalised) or `null`
// when the list is empty. Used by eq / ne; the wire shape is the same
// `values: [...]` field as in/not-in for symmetry.
func singleValue(vs []json.RawMessage) json.RawMessage {
	if len(vs) == 0 {
		return json.RawMessage(`null`)
	}
	return normalizeJSON(vs[0])
}
