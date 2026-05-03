// File card/select_attrs.go: card.select_with_attributes — the LATERAL-join
// read shape grids and kanbans use. Predicate fragments and ordering are
// translated to safe parameterised SQL — never string-concatenated.
package card

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/store"
)

// Predicate is one element of where[]. v1 supports:
//
//	{ "attr": "<name>", "op": "=", "value": <json> }
//	{ "attr": "<name>", "op": "!=", "value": <json> }
//	{ "attr": "<name>", "op": "in", "values": [<json>, …] }
//
// Predicate also supports a compound shape:
//
//	{ "and": [ <pred>, <pred>, ... ] }
//
// The compound shape ANDs every nested predicate. Nested predicates may
// themselves be compound — the translator recurses without bound — but
// in practice clients use a single level of AND for the inbox/grid.
type Predicate struct {
	// Single-condition fields (one of these shapes is set).
	Attr   string            `json:"attr,omitempty" mcp:"desc=attribute name to compare (single-condition shape)"`
	Op     string            `json:"op,omitempty" mcp:"enum==|!=|in,desc=comparison operator (single-condition shape)"`
	Value  json.RawMessage   `json:"value,omitempty" mcp:"desc=JSON value compared against the attribute"`
	Values []json.RawMessage `json:"values,omitempty" mcp:"desc=values for the in operator"`
	// Compound: a list of predicates ANDed together. Mutually exclusive
	// with the single-condition fields above.
	And []Predicate `json:"and,omitempty" mcp:"desc=compound AND of nested predicates; mutually exclusive with attr/op"`
}

// OrderClause sorts by an attribute or a built-in column.
type OrderClause struct {
	// Field can be "attributes.<name>" or "created_at".
	Field     string `json:"field" mcp:"required,desc=field name to sort by; either created_at or attributes.<name>"`
	Direction string `json:"direction,omitempty" mcp:"enum=ASC|DESC,desc=sort direction"`
}

// SelectWithAttributesInput is the typed wire shape.
//
// `Where` is the v1 flat list of predicates (top-level AND of leaves).
// `Tree` is the v2 recursive predicate tree (AND / OR / NOT with
// nesting). When Tree is non-nil it is used and Where is ignored;
// otherwise Where is interpreted as a top-level AND (its v1 behaviour).
type SelectWithAttributesInput struct {
	ParentCardID    *int64          `json:"parent_card_id,omitempty" mcp:"desc=if set, return only cards with this parent_card_id"`
	CardTypeName    *string         `json:"card_type_name,omitempty" mcp:"desc=if set, return only cards of this card_type"`
	Where           []Predicate     `json:"where,omitempty" mcp:"desc=v1 flat list of predicates ANDed together (legacy; use tree for OR/NOT/nesting)"`
	Tree            *CardWhereGroup `json:"tree,omitempty" mcp:"desc=v2 recursive predicate tree; takes precedence over where[] when set"`
	Order           []OrderClause   `json:"order,omitempty" mcp:"desc=optional ordering clauses"`
	Limit           *int            `json:"limit,omitempty" mcp:"desc=optional row limit"`
	Offset          *int            `json:"offset,omitempty" mcp:"desc=optional row offset"`
	IncludeDeleted  bool            `json:"include_deleted,omitempty" mcp:"desc=if true, include soft-deleted rows"`
}

// CardWithAttrs is one row of the LATERAL read.
type CardWithAttrs struct {
	ID            int64                      `json:"id" mcp:"desc=card id"`
	CardTypeID    int32                      `json:"card_type_id" mcp:"desc=card_type id"`
	CardTypeName  string                     `json:"card_type_name" mcp:"desc=card_type name"`
	ParentCardID  *int64                     `json:"parent_card_id,omitempty" mcp:"desc=parent card id, if any"`
	Attributes    map[string]json.RawMessage `json:"attributes" mcp:"desc=current attribute values keyed by attribute_def name"`
	DeletedAt     *time.Time                 `json:"deleted_at,omitempty" mcp:"desc=non-null when the card has been soft-deleted"`
}

// SelectWithAttributesOutput is per-input.
type SelectWithAttributesOutput struct {
	Rows []CardWithAttrs `json:"rows" mcp:"desc=matching cards with their attributes"`
}

func runSelectWithAttributes(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(SelectWithAttributesInput)
			rows, err := queryOne(ctx, tx, in)
			if err != nil {
				return nil, err
			}
			if p != nil {
				p.NoteRead()
			}
			outs[i] = SelectWithAttributesOutput{Rows: rows}
		}
		return outs, nil
	}
}

// queryOne builds a parameterised query from in and runs it. Predicate
// values flow through pgx parameters — they are NEVER concatenated into SQL.
func queryOne(ctx context.Context, tx pgx.Tx, in SelectWithAttributesInput) ([]CardWithAttrs, error) {
	var (
		args    []any
		clauses []string
	)
	addArg := func(v any) string {
		args = append(args, v)
		return fmt.Sprintf("$%d", len(args))
	}

	// Soft-delete filter.
	if !in.IncludeDeleted {
		clauses = append(clauses, "c.deleted_at IS NULL")
	}
	if in.ParentCardID != nil {
		clauses = append(clauses, fmt.Sprintf("c.parent_card_id = %s", addArg(*in.ParentCardID)))
	}
	if in.CardTypeName != nil {
		clauses = append(clauses, fmt.Sprintf("ct.name = %s", addArg(*in.CardTypeName)))
	}

	// Predicate tree (v2) takes precedence over the flat list (v1). When
	// neither is set we apply no attribute filter.
	if in.Tree != nil {
		s, err := compileTree(*in.Tree, addArg)
		if err != nil {
			return nil, fmt.Errorf("select_with_attributes: tree: %w", err)
		}
		clauses = append(clauses, s)
	} else {
		// Translate every predicate. The single-condition shapes turn into
		// (NOT) EXISTS sub-queries; the compound `and` shape recurses.
		for i, w := range in.Where {
			s, err := translatePredicate(w, addArg)
			if err != nil {
				return nil, fmt.Errorf("select_with_attributes: where[%d]: %w", i, err)
			}
			clauses = append(clauses, s)
		}
	}

	whereSQL := ""
	if len(clauses) > 0 {
		whereSQL = "WHERE " + strings.Join(clauses, " AND ")
	}

	// ORDER BY clause: translate each entry. For attributes.<name> we add a
	// LATERAL JOIN that exposes the value as a sortable jsonb. For
	// created_at we use the column directly.
	orderSQL := "ORDER BY c.id"
	var orderJoins []string
	if len(in.Order) > 0 {
		var parts []string
		for i, o := range in.Order {
			dir := "ASC"
			if strings.EqualFold(o.Direction, "DESC") {
				dir = "DESC"
			}
			switch {
			case o.Field == "created_at":
				parts = append(parts, "c.created_at "+dir)
			case strings.HasPrefix(o.Field, "attributes."):
				name := strings.TrimPrefix(o.Field, "attributes.")
				if !validIdent(name) {
					return nil, fmt.Errorf("select_with_attributes: bad order field %q", o.Field)
				}
				alias := fmt.Sprintf("ord_%d", i)
				orderJoins = append(orderJoins, fmt.Sprintf(`
					LEFT JOIN LATERAL (
						SELECT av.value AS v
						FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
						WHERE av.card_id = c.id AND ad.name = %s
					) %s ON TRUE`, addArg(name), alias))
				parts = append(parts, fmt.Sprintf("%s.v %s", alias, dir))
			default:
				return nil, fmt.Errorf("select_with_attributes: unsupported order field %q", o.Field)
			}
		}
		if len(parts) > 0 {
			orderSQL = "ORDER BY " + strings.Join(parts, ", ")
		}
	}

	limitSQL := ""
	if in.Limit != nil {
		limitSQL = fmt.Sprintf(" LIMIT %s", addArg(*in.Limit))
	}
	offsetSQL := ""
	if in.Offset != nil {
		offsetSQL = fmt.Sprintf(" OFFSET %s", addArg(*in.Offset))
	}

	q := fmt.Sprintf(`
		SELECT c.id, c.card_type_id, ct.name, c.parent_card_id, c.deleted_at,
		       coalesce(attrs.values, '{}'::jsonb) AS attrs
		FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id
		%s
		LEFT JOIN LATERAL (
			SELECT jsonb_object_agg(ad.name, av.value) AS values
			FROM attribute_value av
			JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE av.card_id = c.id
		) attrs ON TRUE
		%s
		%s%s%s
	`, strings.Join(orderJoins, "\n"), whereSQL, orderSQL, limitSQL, offsetSQL)

	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("card.select_with_attributes: %w", err)
	}
	defer rows.Close()

	var out []CardWithAttrs
	for rows.Next() {
		var r CardWithAttrs
		var attrsRaw []byte
		if err := rows.Scan(&r.ID, &r.CardTypeID, &r.CardTypeName, &r.ParentCardID, &r.DeletedAt, &attrsRaw); err != nil {
			return nil, err
		}
		if len(attrsRaw) > 0 {
			r.Attributes = map[string]json.RawMessage{}
			if err := json.Unmarshal(attrsRaw, &r.Attributes); err != nil {
				return nil, err
			}
		} else {
			r.Attributes = map[string]json.RawMessage{}
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// translatePredicate turns one Predicate (single-condition or compound)
// into a SQL boolean expression suitable to drop into the outer WHERE.
// Every value is bound through addArg — there is NO string concatenation
// of caller-supplied data.
func translatePredicate(w Predicate, addArg func(any) string) (string, error) {
	// Compound: { "and": [ ... ] }. Detected by Attr/Op being empty AND
	// And being a non-nil slice (encoding/json decodes a present "and" key
	// to a non-nil slice even when its array is empty). Recurse and join
	// with " AND "; an empty list is a vacuously-true conjunction.
	isCompound := w.Attr == "" && w.Op == "" && w.And != nil
	if isCompound {
		if len(w.And) == 0 {
			return "TRUE", nil
		}
		parts := make([]string, len(w.And))
		for i, sub := range w.And {
			s, err := translatePredicate(sub, addArg)
			if err != nil {
				return "", fmt.Errorf("and[%d]: %w", i, err)
			}
			parts[i] = "(" + s + ")"
		}
		return strings.Join(parts, " AND "), nil
	}
	// Single-condition: attr / op required.
	if !validIdent(w.Attr) {
		return "", fmt.Errorf("bad attribute name %q", w.Attr)
	}
	switch strings.ToLower(w.Op) {
	case "=":
		val := normalizeJSON(w.Value)
		return fmt.Sprintf(`EXISTS (
			SELECT 1 FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE av.card_id = c.id AND ad.name = %s AND av.value = %s::jsonb
		)`, addArg(w.Attr), addArg(string(val))), nil
	case "!=":
		val := normalizeJSON(w.Value)
		return fmt.Sprintf(`NOT EXISTS (
			SELECT 1 FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE av.card_id = c.id AND ad.name = %s AND av.value = %s::jsonb
		)`, addArg(w.Attr), addArg(string(val))), nil
	case "in":
		if len(w.Values) == 0 {
			return "FALSE", nil
		}
		placeholders := make([]string, len(w.Values))
		for j, v := range w.Values {
			placeholders[j] = addArg(string(normalizeJSON(v))) + "::jsonb"
		}
		return fmt.Sprintf(`EXISTS (
			SELECT 1 FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE av.card_id = c.id AND ad.name = %s AND av.value IN (%s)
		)`, addArg(w.Attr), strings.Join(placeholders, ", ")), nil
	default:
		return "", fmt.Errorf("unsupported op %q", w.Op)
	}
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
