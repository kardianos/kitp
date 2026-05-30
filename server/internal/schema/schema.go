// Package schema centralises the in-memory snapshot of the kitp domain
// metadata: card types, attribute defs, edges. Handlers load it once per
// transaction (or once per Run) for validation. Loaders use the supplied
// pgx.Tx so they see the same view as the surrounding write.
package schema

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/jackc/pgx/v5"
)

// CardType captures the row plus enough metadata to enforce parent rules.
type CardType struct {
	ID               int64
	Name             string
	ParentCardTypeID *int64
	AllowSelfParent  bool
}

// AttributeDef is one attribute_def row.
type AttributeDef struct {
	ID               int64
	Name             string
	ValueType        string
	IsBuiltIn        bool
	TargetCardTypeID int64 // 0 when value_type is not card_ref / card_ref[]
	// EnumManaged marks a card_ref attribute whose value-cards (the target
	// card_type's cards) are editable by a manager on the data-driven "Enums"
	// admin screen — e.g. milestone / component / tag.
	EnumManaged bool
}

// Edge is one edge row, linking a card_type to an attribute_def.
type Edge struct {
	CardTypeID     int64
	AttributeDefID int64
	IsRequired     bool
	Ordering       int32
}

// Snapshot is the fully-loaded metadata view. Map keys (e.g. CardTypeByName)
// are convenience indexes built once at load time.
type Snapshot struct {
	CardTypeByName map[string]CardType
	CardTypeByID   map[int64]CardType
	AttrByName     map[string]AttributeDef
	AttrByID       map[int64]AttributeDef
	// EdgesByCardTypeID is the per-type edge list, in stable ordering by
	// (ordering, attribute_def_id).
	EdgesByCardTypeID map[int64][]Edge
	// AllowedAttrs is a set: cardTypeID -> attrDefID -> Edge.
	AllowedAttrs map[int64]map[int64]Edge
}

// Load reads card_type, attribute_def, and edge into a Snapshot using tx.
func Load(ctx context.Context, tx pgx.Tx) (*Snapshot, error) {
	s := &Snapshot{
		CardTypeByName:    map[string]CardType{},
		CardTypeByID:      map[int64]CardType{},
		AttrByName:        map[string]AttributeDef{},
		AttrByID:          map[int64]AttributeDef{},
		EdgesByCardTypeID: map[int64][]Edge{},
		AllowedAttrs:      map[int64]map[int64]Edge{},
	}

	rows, err := tx.Query(ctx, `SELECT id, name, parent_card_type_id, allow_self_parent FROM card_type`)
	if err != nil {
		return nil, fmt.Errorf("schema: load card_type: %w", err)
	}
	for rows.Next() {
		var ct CardType
		if err := rows.Scan(&ct.ID, &ct.Name, &ct.ParentCardTypeID, &ct.AllowSelfParent); err != nil {
			rows.Close()
			return nil, err
		}
		s.CardTypeByName[ct.Name] = ct
		s.CardTypeByID[ct.ID] = ct
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rows, err = tx.Query(ctx, `SELECT id, name, value_type, is_built_in, COALESCE(target_card_type_id, 0), enum_managed FROM attribute_def`)
	if err != nil {
		return nil, fmt.Errorf("schema: load attribute_def: %w", err)
	}
	for rows.Next() {
		var a AttributeDef
		if err := rows.Scan(&a.ID, &a.Name, &a.ValueType, &a.IsBuiltIn, &a.TargetCardTypeID, &a.EnumManaged); err != nil {
			rows.Close()
			return nil, err
		}
		s.AttrByName[a.Name] = a
		s.AttrByID[a.ID] = a
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rows, err = tx.Query(ctx, `
		SELECT card_type_id, attribute_def_id, is_required, ordering
		FROM edge
		ORDER BY card_type_id, ordering, attribute_def_id
	`)
	if err != nil {
		return nil, fmt.Errorf("schema: load edge: %w", err)
	}
	for rows.Next() {
		var e Edge
		if err := rows.Scan(&e.CardTypeID, &e.AttributeDefID, &e.IsRequired, &e.Ordering); err != nil {
			rows.Close()
			return nil, err
		}
		s.EdgesByCardTypeID[e.CardTypeID] = append(s.EdgesByCardTypeID[e.CardTypeID], e)
		if s.AllowedAttrs[e.CardTypeID] == nil {
			s.AllowedAttrs[e.CardTypeID] = map[int64]Edge{}
		}
		s.AllowedAttrs[e.CardTypeID][e.AttributeDefID] = e
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	return s, nil
}

// EdgeFor returns the edge for (cardTypeID, attrName) or false if no such
// attribute is allowed on that card type.
func (s *Snapshot) EdgeFor(cardTypeID int64, attrName string) (Edge, AttributeDef, bool) {
	a, ok := s.AttrByName[attrName]
	if !ok {
		return Edge{}, AttributeDef{}, false
	}
	per, ok := s.AllowedAttrs[cardTypeID]
	if !ok {
		return Edge{}, a, false
	}
	e, ok := per[a.ID]
	return e, a, ok
}

// ValueType returns attrName's declared value_type (e.g. "card_ref",
// "card_ref[]", "text"), or "" when the attribute is unknown. Read paths
// use it to decide array-membership vs scalar-equality compilation.
func (s *Snapshot) ValueType(attrName string) string {
	if s == nil {
		return ""
	}
	if a, ok := s.AttrByName[attrName]; ok {
		return a.ValueType
	}
	return ""
}

// CanonicalizeRefScalar canonicalises a card_ref id for a MEMBERSHIP test
// against a stored card_ref[] array (e.g. "tags = X" meaning "the array
// contains X"). A scalar string-of-digits becomes a JSON number so it
// matches the numeric elements the array stores; a value that is itself a
// JSON array is canonicalised element-wise (subset containment). Unlike
// CanonicalizeValue this does NOT consult the attribute's value_type — the
// caller has already established the target is card_ref[] and is supplying
// a single element to test for.
func (s *Snapshot) CanonicalizeRefScalar(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return raw
	}
	var arr []json.RawMessage
	if json.Unmarshal(raw, &arr) == nil {
		return cardRefArrayToNumbers(raw)
	}
	return cardRefValueToNumber(raw)
}

// CanonicalizeValue rewrites a wire-side attribute value to the jsonb
// shape used in attribute_value storage. The dispatcher serialises
// bigint ids as JSON strings (`"123"`) but the seed writes them as JSON
// numbers (`123`); jsonb equality is type-sensitive, so without this
// step a card_ref filter or write would mismatch every demo-seeded row
// (and vice versa, a UI-written value would never match a UI-built
// filter). Pass through unchanged when the attribute is not a known
// card_ref / card_ref[]; non-numeric strings and parse failures also
// pass through so real data is never corrupted by over-eager
// normalisation.
//
// Used by read paths (predicate compilation, filter translation) AND
// by write paths (attribute.update) so stored values and queried
// values share the same canonical jsonb shape.
func (s *Snapshot) CanonicalizeValue(attrName string, raw json.RawMessage) json.RawMessage {
	if s == nil || len(raw) == 0 {
		return raw
	}
	a, ok := s.AttrByName[attrName]
	if !ok {
		return raw
	}
	switch a.ValueType {
	case "card_ref":
		return cardRefValueToNumber(raw)
	case "card_ref[]":
		return cardRefArrayToNumbers(raw)
	}
	return raw
}

// cardRefValueToNumber turns a JSON-string-of-digits into a JSON
// number. Values already in number form, JSON null, or non-digit
// strings pass through unchanged.
func cardRefValueToNumber(raw json.RawMessage) json.RawMessage {
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return raw
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return raw
	}
	return json.RawMessage(strconv.FormatInt(n, 10))
}

// cardRefArrayToNumbers normalises every element of a JSON array via
// cardRefValueToNumber. Re-encodes the array on any change; a no-op
// input is returned verbatim.
func cardRefArrayToNumbers(raw json.RawMessage) json.RawMessage {
	var arr []json.RawMessage
	if err := json.Unmarshal(raw, &arr); err != nil {
		return raw
	}
	changed := false
	out := make([]json.RawMessage, len(arr))
	for i, el := range arr {
		canon := cardRefValueToNumber(el)
		if string(canon) != string(el) {
			changed = true
		}
		out[i] = canon
	}
	if !changed {
		return raw
	}
	encoded, err := json.Marshal(out)
	if err != nil {
		return raw
	}
	return encoded
}

// ParentAllowed enforces the v1 parent rule: child.allow_self_parent or
// parent's card_type matches child.ParentCardTypeID.
func (s *Snapshot) ParentAllowed(child CardType, parentTypeID int64) bool {
	if child.AllowSelfParent && parentTypeID == child.ID {
		return true
	}
	if child.ParentCardTypeID != nil && parentTypeID == *child.ParentCardTypeID {
		return true
	}
	return false
}

// CardTypeIDByCardID is a one-shot lookup helper used by handler
// CardTypeID extractors; returns 0 when the card is missing so the
// dispatcher's authz check is skipped (Validate will surface the
// real error).
type queryRower interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

func CardTypeIDByCardID(ctx context.Context, pool queryRower, cardID int64) (int64, error) {
	if cardID == 0 {
		return 0, nil
	}
	var ctid int64
	row := pool.QueryRow(ctx, `SELECT card_type_id FROM card WHERE id = $1`, cardID)
	if err := row.Scan(&ctid); err != nil {
		return 0, nil
	}
	return ctid, nil
}
