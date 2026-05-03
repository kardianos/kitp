// Package schema centralises the in-memory snapshot of the kitp domain
// metadata: card types, attribute defs, edges. Handlers load it once per
// transaction (or once per Run) for validation. Loaders use the supplied
// pgx.Tx so they see the same view as the surrounding write.
package schema

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// CardType captures the row plus enough metadata to enforce parent rules.
type CardType struct {
	ID               int32
	Name             string
	ParentCardTypeID *int32
	AllowSelfParent  bool
}

// AttributeDef is one attribute_def row.
type AttributeDef struct {
	ID        int32
	Name      string
	ValueType string
	IsBuiltIn bool
}

// Edge is one edge row, linking a card_type to an attribute_def.
type Edge struct {
	CardTypeID     int32
	AttributeDefID int32
	IsRequired     bool
	Ordering       int32
}

// Snapshot is the fully-loaded metadata view. Map keys (e.g. CardTypeByName)
// are convenience indexes built once at load time.
type Snapshot struct {
	CardTypeByName     map[string]CardType
	CardTypeByID       map[int32]CardType
	AttrByName         map[string]AttributeDef
	AttrByID           map[int32]AttributeDef
	// EdgesByCardTypeID is the per-type edge list, in stable ordering by
	// (ordering, attribute_def_id).
	EdgesByCardTypeID map[int32][]Edge
	// AllowedAttrs is a set: cardTypeID -> attrDefID -> Edge.
	AllowedAttrs map[int32]map[int32]Edge
}

// Load reads card_type, attribute_def, and edge into a Snapshot using tx.
func Load(ctx context.Context, tx pgx.Tx) (*Snapshot, error) {
	s := &Snapshot{
		CardTypeByName:    map[string]CardType{},
		CardTypeByID:      map[int32]CardType{},
		AttrByName:        map[string]AttributeDef{},
		AttrByID:          map[int32]AttributeDef{},
		EdgesByCardTypeID: map[int32][]Edge{},
		AllowedAttrs:      map[int32]map[int32]Edge{},
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

	rows, err = tx.Query(ctx, `SELECT id, name, value_type, is_built_in FROM attribute_def`)
	if err != nil {
		return nil, fmt.Errorf("schema: load attribute_def: %w", err)
	}
	for rows.Next() {
		var a AttributeDef
		if err := rows.Scan(&a.ID, &a.Name, &a.ValueType, &a.IsBuiltIn); err != nil {
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
			s.AllowedAttrs[e.CardTypeID] = map[int32]Edge{}
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
func (s *Snapshot) EdgeFor(cardTypeID int32, attrName string) (Edge, AttributeDef, bool) {
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

// ParentAllowed enforces the v1 parent rule: child.allow_self_parent or
// parent's card_type matches child.ParentCardTypeID.
func (s *Snapshot) ParentAllowed(child CardType, parentTypeID int32) bool {
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

func CardTypeIDByCardID(ctx context.Context, pool queryRower, cardID int64) (int32, error) {
	if cardID == 0 {
		return 0, nil
	}
	var ctid int32
	row := pool.QueryRow(ctx, `SELECT card_type_id FROM card WHERE id = $1`, cardID)
	if err := row.Scan(&ctid); err != nil {
		return 0, nil
	}
	return ctid, nil
}
