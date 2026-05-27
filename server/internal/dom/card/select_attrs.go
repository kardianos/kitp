// File card/select_attrs.go: wire types for card.select_with_attributes.
//
// The handler body itself lives in
// db/schema/functions/card_select_with_attributes_batch.sql; this file
// keeps only the typed Input / Output shapes the dispatcher serialises
// through JSONB. The exported Predicate / OrderClause /
// CardWhereGroup / CompileTree machinery stays in where.go because
// projectexport reuses card.CompileTree for its own LATERAL build (the
// dispatcher's hot path no longer needs the Go-side compiler, but
// other domain packages still do).
//
// Phase 5 of docs/UNIFIED_HANDLER_PLAN.md.
package card

import (
	"encoding/json"
	"time"
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
	// Field can be "attributes.<name>", "created_at",
	// "last_activity_at", or "personal_sort_order".
	Field     string `json:"field" mcp:"required,desc=field name to sort by; one of created_at, last_activity_at, personal_sort_order, or attributes.<name>"`
	Direction string `json:"direction,omitempty" mcp:"enum=ASC|DESC,desc=sort direction"`
}

// SelectWithAttributesInput is the typed wire shape.
//
// `Where` is the v1 flat list of predicates (top-level AND of leaves).
// `Tree` is the v2 recursive predicate tree (AND / OR / NOT with
// nesting). When Tree is non-nil it is used and Where is ignored;
// otherwise Where is interpreted as a top-level AND (its v1 behaviour).
type SelectWithAttributesInput struct {
	ParentCardID     *int64          `json:"parent_card_id,string,omitempty" mcp:"desc=if set, return only cards with this parent_card_id"`
	ProjectID        *int64          `json:"project_id,string,omitempty" mcp:"desc=if set, return only cards ENCLOSED BY this project (the project itself or any descendant) — scopes grandchild cards like filters (filter→screen→project) that parent_card_id can't reach"`
	CardTypeName     *string         `json:"card_type_name,omitempty" mcp:"desc=if set, return only cards of this card_type"`
	Where            []Predicate     `json:"where,omitempty" mcp:"desc=v1 flat list of predicates ANDed together (legacy; use tree for OR/NOT/nesting)"`
	Tree             *CardWhereGroup `json:"tree,omitempty" mcp:"desc=v2 recursive predicate tree; takes precedence over where[] when set"`
	Order            []OrderClause   `json:"order,omitempty" mcp:"desc=optional ordering clauses"`
	Limit            *int            `json:"limit,omitempty" mcp:"desc=optional row limit"`
	Offset           *int            `json:"offset,omitempty" mcp:"desc=optional row offset"`
	IncludeDeleted   bool            `json:"include_deleted,omitempty" mcp:"desc=if true, include soft-deleted rows"`
	WithPersonalSort bool            `json:"with_personal_sort,omitempty" mcp:"desc=when true, LEFT JOIN user_card_sort for the calling actor and expose personal_sort_order on each row; lets clients (e.g. Inbox) sort by the user's own ordering without a separate handler"`
	RoutedToMe       bool            `json:"routed_to_me,omitempty" mcp:"desc=agent-perspective inbox filter: when true the result is restricted to cards whose user_card_agent row routes them to the calling agent (agent_user_id=actor AND user_id=actor.parent_user_id). Returns no rows when the caller is not an agent."`
}

// CardWithAttrs is one row of the LATERAL read.
type CardWithAttrs struct {
	ID           int64                      `json:"id,string" mcp:"desc=card id"`
	CardTypeID   int64                      `json:"card_type_id,string" mcp:"desc=card_type id"`
	CardTypeName string                     `json:"card_type_name" mcp:"desc=card_type name"`
	ParentCardID *int64                     `json:"parent_card_id,string,omitempty" mcp:"desc=parent card id, if any"`
	Phase        string                     `json:"phase,omitempty" mcp:"desc=phase of this value-card (triage/active/terminal); only present on value-cards bound to a flow (status / comm_status). Tasks / projects / milestones / etc. carry an unused default in the column and the field is omitted from the wire."`
	Attributes   map[string]json.RawMessage `json:"attributes" mcp:"desc=current attribute values keyed by attribute_def name"`
	// CreatedAt is the card's row-level created_at column (NOT an
	// attribute) — surfaced on the wire so list screens can render
	// and sort by it without a follow-up read.
	CreatedAt time.Time `json:"created_at" mcp:"desc=card creation timestamp"`
	// LastActivityAt is MAX(activity.created_at) for this card —
	// virtual, derived from the activity stream. Null when the card
	// has no activity rows yet (fresh insert before any handler
	// emitted an activity).
	LastActivityAt *time.Time `json:"last_activity_at,omitempty" mcp:"desc=most recent activity timestamp for this card (MAX(activity.created_at)); null when the card has no activity yet"`
	DeletedAt      *time.Time `json:"deleted_at,omitempty" mcp:"desc=non-null when the card has been soft-deleted"`
	PersonalSort   *float64   `json:"personal_sort_order,omitempty" mcp:"desc=caller's user_card_sort.sort_order when with_personal_sort=true; null when the user hasn't reordered this card"`
}

// SelectWithAttributesOutput is per-input.
type SelectWithAttributesOutput struct {
	Rows []CardWithAttrs `json:"rows" mcp:"desc=matching cards with their attributes"`
}
