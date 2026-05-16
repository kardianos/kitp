package help

import (
	"encoding/json"
	"fmt"
	"strings"
)

// RenderPredicateJSON parses the JSON encoding produced by the client's
// predicateToJson (client/src/filter/predicate.ts) and returns a single
// plain-English sentence describing the predicate. Empty / null input
// returns "every task" — the no-filter case.
//
// The op set mirrors OP_TO_WIRE on the client. Unknown operators or
// shapes produce an error; callers degrade gracefully by surfacing a
// generic "this view shows tasks matching its filter."
func RenderPredicateJSON(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" || s == "null" {
		return "every task", nil
	}
	var any json.RawMessage
	if err := json.Unmarshal([]byte(s), &any); err != nil {
		return "", fmt.Errorf("help: predicate JSON: %w", err)
	}
	n, err := parseNode(any)
	if err != nil {
		return "", err
	}
	return "tasks where " + renderNode(n, false), nil
}

// node is the parsed predicate AST. kind discriminates: "leaf" carries
// (attr, op, values); "group" carries (connective, children).
type node struct {
	kind       string
	attr       string
	op         string
	values     []json.RawMessage
	connective string
	children   []node
}

func parseNode(raw json.RawMessage) (node, error) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return node{}, fmt.Errorf("predicate node not an object: %w", err)
	}
	if _, ok := m["connective"]; ok {
		return parseGroup(m)
	}
	return parseLeaf(m)
}

func parseLeaf(m map[string]json.RawMessage) (node, error) {
	var attr, op string
	if raw, ok := m["attr"]; ok {
		if err := json.Unmarshal(raw, &attr); err != nil {
			return node{}, fmt.Errorf("leaf attr: %w", err)
		}
	}
	if raw, ok := m["op"]; ok {
		if err := json.Unmarshal(raw, &op); err != nil {
			return node{}, fmt.Errorf("leaf op: %w", err)
		}
	}
	if attr == "" || op == "" {
		return node{}, fmt.Errorf("leaf missing attr/op")
	}
	out := node{kind: "leaf", attr: attr, op: op}
	if raw, ok := m["values"]; ok {
		var vs []json.RawMessage
		if err := json.Unmarshal(raw, &vs); err != nil {
			return node{}, fmt.Errorf("leaf values: %w", err)
		}
		out.values = vs
	}
	return out, nil
}

func parseGroup(m map[string]json.RawMessage) (node, error) {
	var conn string
	if err := json.Unmarshal(m["connective"], &conn); err != nil {
		return node{}, fmt.Errorf("group connective: %w", err)
	}
	if conn != "and" && conn != "or" && conn != "not" {
		return node{}, fmt.Errorf("group connective %q unsupported", conn)
	}
	out := node{kind: "group", connective: conn}
	if raw, ok := m["children"]; ok {
		var arr []json.RawMessage
		if err := json.Unmarshal(raw, &arr); err != nil {
			return node{}, fmt.Errorf("group children: %w", err)
		}
		for i, c := range arr {
			ch, err := parseNode(c)
			if err != nil {
				return node{}, fmt.Errorf("group child %d: %w", i, err)
			}
			out.children = append(out.children, ch)
		}
	}
	if conn == "not" && len(out.children) != 1 {
		return node{}, fmt.Errorf("not group must have exactly one child (got %d)", len(out.children))
	}
	return out, nil
}

// opPhrase maps wire operators to their English equivalents. The
// operators here mirror OP_TO_WIRE in predicate.ts; the value is the
// phrase inserted between the attribute and the value(s).
var opPhrase = map[string]string{
	"=":            "is",
	"!=":           "is not",
	"in":           "is one of",
	"not in":       "is not one of",
	"exists":       "is set",
	"not exists":   "is empty",
	"contains":     "contains",
	"not terminal": "is still open",
	"has_phase":    "is in phase",
}

func renderNode(n node, inGroup bool) string {
	if n.kind == "leaf" {
		return renderLeaf(n)
	}
	switch n.connective {
	case "not":
		// Always parenthesise so "not X and Y" reads unambiguously.
		return "not (" + renderNode(n.children[0], true) + ")"
	case "and", "or":
		if len(n.children) == 0 {
			if n.connective == "and" {
				return "always true"
			}
			return "always false"
		}
		if len(n.children) == 1 {
			return renderNode(n.children[0], inGroup)
		}
		parts := make([]string, len(n.children))
		for i, c := range n.children {
			s := renderNode(c, true)
			// Wrap nested groups in parens; leaves stay bare.
			if c.kind == "group" {
				s = "(" + s + ")"
			}
			parts[i] = s
		}
		joiner := ", and "
		if n.connective == "or" {
			joiner = ", or "
		}
		// Oxford comma: "A, B, and C".
		if len(parts) == 2 {
			// Two-element AND/OR reads better without an internal comma.
			return parts[0] + strings.TrimPrefix(joiner, ",") + parts[1]
		}
		return strings.Join(parts[:len(parts)-1], ", ") + joiner + parts[len(parts)-1]
	}
	return ""
}

func renderLeaf(n node) string {
	phrase, ok := opPhrase[n.op]
	if !ok {
		phrase = n.op
	}
	attr := friendlyAttr(n.attr)
	switch n.op {
	case "exists", "not exists", "not terminal":
		// Arity 0: "<attr> is set", "<attr> is empty", "phase is still open"
		if n.op == "not terminal" {
			return "the task is still open"
		}
		return attr + " " + phrase
	case "in", "not in", "has_phase":
		// Arity multi: "<attr> is one of (a, b, c)"
		vs := renderValues(n.values)
		return attr + " " + phrase + " " + vs
	default:
		// Arity 1: "<attr> is <value>"
		v := "nothing"
		if len(n.values) > 0 {
			v = renderValue(n.values[0])
		}
		return attr + " " + phrase + " " + v
	}
}

// friendlyAttr converts a snake_case attribute name into a slightly
// nicer reading form. Underscores become spaces; a small set of known
// suffixes ("_ref", "_id") get trimmed since they are implementation
// details users do not need to see in prose.
func friendlyAttr(name string) string {
	s := name
	s = strings.TrimSuffix(s, "_ref")
	s = strings.TrimSuffix(s, "_id")
	return strings.ReplaceAll(s, "_", " ")
}

func renderValues(vs []json.RawMessage) string {
	if len(vs) == 0 {
		return "(nothing)"
	}
	parts := make([]string, len(vs))
	for i, v := range vs {
		parts[i] = renderValue(v)
	}
	return "(" + strings.Join(parts, ", ") + ")"
}

// renderValue turns a JSON value into prose. Strings drop their quotes;
// numbers / booleans render verbatim; objects / arrays fall back to
// their JSON encoding so unexpected shapes are still visible.
func renderValue(raw json.RawMessage) string {
	s := strings.TrimSpace(string(raw))
	if s == "" || s == "null" {
		return "nothing"
	}
	var str string
	if err := json.Unmarshal(raw, &str); err == nil {
		// Numeric ids round-tripped as strings (card_ref attrs) read more
		// naturally as "card #123" than as a bare integer in a sentence.
		if isAllDigits(str) {
			return "card #" + str
		}
		return str
	}
	var b bool
	if err := json.Unmarshal(raw, &b); err == nil {
		if b {
			return "yes"
		}
		return "no"
	}
	return s
}

func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
