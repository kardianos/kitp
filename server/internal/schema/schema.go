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
//
// ProjectTypeID is nullable: an edge with ProjectTypeID == nil applies
// globally; an edge with ProjectTypeID == &X applies only on cards
// descended from a project of project_type X. See migration 0019 and
// PROJECT_SCOPED_SCHEMA_PLAN.md.
type Edge struct {
	CardTypeID     int32
	AttributeDefID int32
	ProjectTypeID  *int32
	IsRequired     bool
	Ordering       int32
}

// Snapshot is the fully-loaded metadata view. Map keys (e.g. CardTypeByName)
// are convenience indexes built once at load time.
type Snapshot struct {
	CardTypeByName map[string]CardType
	CardTypeByID   map[int32]CardType
	AttrByName     map[string]AttributeDef
	AttrByID       map[int32]AttributeDef
	// EdgesByCardTypeID is the per-type edge list, in stable ordering by
	// (ordering, attribute_def_id). Includes both global and scoped edges.
	EdgesByCardTypeID map[int32][]Edge
	// AllowedAttrs holds *global* edges only (ProjectTypeID == nil).
	// This preserves the legacy behaviour for callers that have no project
	// scope. Scoped lookups go through EffectiveEdgeFor.
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
		SELECT card_type_id, attribute_def_id, project_type_id, is_required, ordering
		FROM edge
		ORDER BY card_type_id, ordering, attribute_def_id
	`)
	if err != nil {
		return nil, fmt.Errorf("schema: load edge: %w", err)
	}
	for rows.Next() {
		var e Edge
		if err := rows.Scan(&e.CardTypeID, &e.AttributeDefID, &e.ProjectTypeID, &e.IsRequired, &e.Ordering); err != nil {
			rows.Close()
			return nil, err
		}
		s.EdgesByCardTypeID[e.CardTypeID] = append(s.EdgesByCardTypeID[e.CardTypeID], e)
		if e.ProjectTypeID == nil {
			if s.AllowedAttrs[e.CardTypeID] == nil {
				s.AllowedAttrs[e.CardTypeID] = map[int32]Edge{}
			}
			s.AllowedAttrs[e.CardTypeID][e.AttributeDefID] = e
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	return s, nil
}

// EdgeFor returns the global edge for (cardTypeID, attrName) or false if
// no such *global* attribute is allowed on that card type. For scope-aware
// lookups callers should use EffectiveEdgeFor.
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

// EffectiveEdgeFor returns the edge for (cardTypeID, attrName) given the
// enclosing project's project_type_id. Resolution order: a project-type
// -scoped edge wins over a global edge if both exist; if neither exists,
// returns false.
//
// projectTypeID == nil means "no project_type known"; only global edges
// match. This is the safe default for cards that don't yet descend from
// a typed project (legacy data, top-level workflow_def cards, etc.).
func (s *Snapshot) EffectiveEdgeFor(cardTypeID int32, projectTypeID *int32, attrName string) (Edge, AttributeDef, bool) {
	a, ok := s.AttrByName[attrName]
	if !ok {
		return Edge{}, AttributeDef{}, false
	}
	edges := s.EdgesByCardTypeID[cardTypeID]
	var globalHit *Edge
	for i, e := range edges {
		if e.AttributeDefID != a.ID {
			continue
		}
		if e.ProjectTypeID == nil {
			globalHit = &edges[i]
			continue
		}
		if projectTypeID != nil && *e.ProjectTypeID == *projectTypeID {
			return e, a, true
		}
	}
	if globalHit != nil {
		return *globalHit, a, true
	}
	return Edge{}, a, false
}

// EffectiveEdges returns every edge effective on a card of cardTypeID
// inside a project of projectTypeID. The returned slice is sorted by
// (ordering, attribute_def_id). Project-type-scoped edges shadow global
// edges that share the same attribute_def_id.
func (s *Snapshot) EffectiveEdges(cardTypeID int32, projectTypeID *int32) []Edge {
	edges := s.EdgesByCardTypeID[cardTypeID]
	if len(edges) == 0 {
		return nil
	}
	// Pick scoped edges first; remember which attribute_def_ids they cover.
	var out []Edge
	covered := map[int32]bool{}
	if projectTypeID != nil {
		for _, e := range edges {
			if e.ProjectTypeID != nil && *e.ProjectTypeID == *projectTypeID {
				out = append(out, e)
				covered[e.AttributeDefID] = true
			}
		}
	}
	for _, e := range edges {
		if e.ProjectTypeID != nil {
			continue
		}
		if covered[e.AttributeDefID] {
			continue
		}
		out = append(out, e)
	}
	return out
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

// ProjectTypeForCard walks parent_card_id up to the enclosing project
// and returns its project_type_id. Returns (nil, nil) if no enclosing
// project carries a project_type. Walks at most 16 levels to avoid
// runaway loops on corrupted parent chains.
func ProjectTypeForCard(ctx context.Context, tx pgx.Tx, cardID int64) (*int32, error) {
	if cardID == 0 {
		return nil, nil
	}
	const maxDepth = 16
	cur := cardID
	for i := 0; i < maxDepth; i++ {
		var ctid int32
		var parent *int64
		var pt *int32
		row := tx.QueryRow(ctx, `
			SELECT card_type_id, parent_card_id, project_type_id
			FROM card WHERE id = $1
		`, cur)
		if err := row.Scan(&ctid, &parent, &pt); err != nil {
			if err == pgx.ErrNoRows {
				return nil, nil
			}
			return nil, fmt.Errorf("schema: project_type walk: %w", err)
		}
		if pt != nil {
			return pt, nil
		}
		if parent == nil {
			return nil, nil
		}
		cur = *parent
	}
	return nil, nil
}
