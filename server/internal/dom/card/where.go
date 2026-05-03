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
// (e.g. inbox) that need to layer the same v2 predicate-tree compilation
// on top of their own queries. It is a thin alias around compileTree;
// the addArg callback hands back the parameter placeholder string (e.g.
// "$3") for one bound argument, mirroring the per-handler counter.
func CompileTree(g CardWhereGroup, addArg func(any) string) (string, error) {
	return compileTree(g, addArg)
}

// compileTree turns a CardWhereGroup into a SQL boolean expression
// suitable for the outer WHERE. addArg threads through the parameter
// counter shared with the rest of queryOne.
func compileTree(g CardWhereGroup, addArg func(any) string) (string, error) {
	conn := strings.ToLower(g.Connective)
	switch conn {
	case "and":
		if len(g.Children) == 0 {
			return "TRUE", nil
		}
		return joinChildren(g.Children, " AND ", "TRUE", addArg)
	case "or":
		if len(g.Children) == 0 {
			return "FALSE", nil
		}
		return joinChildren(g.Children, " OR ", "FALSE", addArg)
	case "not":
		if len(g.Children) != 1 {
			return "", fmt.Errorf("not group must have exactly one child (got %d)", len(g.Children))
		}
		s, err := compileNode(g.Children[0], addArg)
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
func joinChildren(children []CardWhereTreeNode, sep, identity string, addArg func(any) string) (string, error) {
	parts := make([]string, len(children))
	for i, c := range children {
		s, err := compileNode(c, addArg)
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
func compileNode(n CardWhereTreeNode, addArg func(any) string) (string, error) {
	if n.Connective != "" {
		return compileTree(CardWhereGroup{
			Connective: n.Connective,
			Children:   n.Children,
		}, addArg)
	}
	return compileLeaf(n, addArg)
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
func compileLeaf(n CardWhereTreeNode, addArg func(any) string) (string, error) {
	if !validIdent(n.Attr) {
		return "", fmt.Errorf("bad attribute name %q", n.Attr)
	}
	op := strings.ToLower(n.Op)
	switch op {
	case "=", "eq":
		val := singleValue(n.Values)
		return fmt.Sprintf(`EXISTS (
			SELECT 1 FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE av.card_id = c.id AND ad.name = %s AND av.value = %s::jsonb
		)`, addArg(n.Attr), addArg(string(val))), nil
	case "!=", "ne":
		val := singleValue(n.Values)
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
			placeholders[j] = addArg(string(normalizeJSON(v))) + "::jsonb"
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
			placeholders[j] = addArg(string(normalizeJSON(v))) + "::jsonb"
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
	default:
		return "", fmt.Errorf("unsupported op %q", n.Op)
	}
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
