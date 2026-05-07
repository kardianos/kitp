// Package attributedef exposes the admin CRUD surface for attribute_def +
// edge rows. T5 owns this — it powers the /admin/attributes screen, where
// admins register new attribute_defs, bind them to additional card types,
// and unbind them.
//
// Endpoints:
//   - attribute_def.select — every def with the card_types it is bound to
//     (built-in defs included). Single read.
//   - attribute_def.insert — create one def and bind it to N card types in
//     one tx. The created def is never marked is_built_in (only migrations
//     install built-in defs).
//   - edge.insert — bind an existing def to one more card type. Idempotent.
//   - edge.delete — unbind a def from a card type. Refuses (returns
//     "in_use") if any attribute_value rows reference (card_type, def)
//     today. Built-in edges are protected (refuses with "built_in"). The
//     admin must clear references first via attribute.update or move the
//     deletion to a migration.
//
// All writers are arrayPath; reads run one SQL statement per Run.
package attributedef

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// SelectInput is empty.
type SelectInput struct{}

// BoundCardType is one (card_type_id, name, is_required) tuple in the bound
// list of a def. Edges may include built-in card types; the client decides
// whether to allow unbinding them (we surface is_built_in via card_type).
type BoundCardType struct {
	CardTypeID   int32  `json:"card_type_id" mcp:"desc=card_type id this attribute is bound to"`
	CardTypeName string `json:"card_type_name" mcp:"desc=card_type name"`
	IsRequired   bool   `json:"is_required" mcp:"desc=true when the edge marks the attribute as required for that card_type"`
	IsBuiltIn    bool   `json:"is_built_in" mcp:"desc=true if the bound card_type is built-in (admin UI may protect deletes)"`
	Ordering     int32  `json:"ordering" mcp:"desc=display ordering for the edge"`
}

// AttributeDefOptionRow is one allowed option for an enum-typed
// attribute_def. Options come from the attribute_def_option table (see
// migration 0012). Only enum-typed defs ever populate this list; for all
// other value_types the field is empty/omitted.
type AttributeDefOptionRow struct {
	Value    string `json:"value" mcp:"desc=stored JSON value (the literal jsonb the server accepts)"`
	Label    string `json:"label" mcp:"desc=display label for the option"`
	Ordering int32  `json:"ordering" mcp:"desc=display ordering (ascending)"`
}

// SelectRow is one attribute_def row plus its bindings.
type SelectRow struct {
	ID        int32                   `json:"id" mcp:"desc=attribute_def id"`
	Name      string                  `json:"name" mcp:"desc=attribute_def name"`
	ValueType string                  `json:"value_type" mcp:"desc=value type label (text, bool, card_ref, …)"`
	IsBuiltIn bool                    `json:"is_built_in" mcp:"desc=true if installed by a migration"`
	BoundTo   []BoundCardType         `json:"bound_to" mcp:"desc=card_types the attribute is bound to via edge"`
	Options   []AttributeDefOptionRow `json:"options,omitempty" mcp:"desc=allowed options for enum-typed attributes (sorted by ordering); empty for non-enum defs"`
}

// SelectOutput wraps the rows.
type SelectOutput struct {
	Rows []SelectRow `json:"rows" mcp:"desc=every attribute_def with its bound card types"`
}

// EdgeInput describes one (card_type, is_required) binding.
type EdgeInput struct {
	CardTypeID int32 `json:"card_type_id" mcp:"required,desc=card_type id to bind"`
	IsRequired bool  `json:"is_required,omitempty" mcp:"desc=optional: mark the edge as required (default false)"`
	Ordering   int32 `json:"ordering,omitempty" mcp:"desc=optional ordering hint"`
}

// InsertInput creates a new attribute_def and seeds initial edges.
type InsertInput struct {
	Name      string      `json:"name" mcp:"required,desc=attribute_def name (must be unique)"`
	ValueType string      `json:"value_type" mcp:"required,desc=value type label (text, bool, card_ref, …)"`
	BindTo    []EdgeInput `json:"bind_to,omitempty" mcp:"desc=optional initial edges to seed"`
}

// InsertOutput surfaces the new id.
type InsertOutput struct {
	ID int32 `json:"id" mcp:"desc=id of the new attribute_def row"`
}

// EdgeInsertInput binds an existing def to a card_type.
type EdgeInsertInput struct {
	AttributeDefID int32 `json:"attribute_def_id" mcp:"required,desc=existing attribute_def to bind"`
	CardTypeID     int32 `json:"card_type_id" mcp:"required,desc=card_type to bind to"`
	IsRequired     bool  `json:"is_required,omitempty" mcp:"desc=optional required flag"`
	Ordering       int32 `json:"ordering,omitempty" mcp:"desc=optional ordering hint"`
}

// EdgeInsertOutput acknowledges the upsert.
type EdgeInsertOutput struct {
	OK bool `json:"ok" mcp:"desc=true on success"`
}

// EdgeDeleteInput removes one (def, card_type) binding.
type EdgeDeleteInput struct {
	AttributeDefID int32 `json:"attribute_def_id" mcp:"required,desc=def the edge points at"`
	CardTypeID     int32 `json:"card_type_id" mcp:"required,desc=card_type the edge connects to"`
}

// EdgeDeleteOutput reports whether a row was deleted.
type EdgeDeleteOutput struct {
	OK         bool `json:"ok" mcp:"desc=true if the edge was deleted"`
	UsageCount int  `json:"usage_count,omitempty" mcp:"desc=number of attribute_value rows that block the delete"`
}

// OptionUpsertInput adds or rewrites one row in attribute_def_option. The
// (def_id, value) pair is the natural key — sending the same value twice is
// an UPDATE of label / ordering, not a duplicate. Admin-only because the
// option list is the schema's source of truth for what's an acceptable
// jsonb literal on cards.
type OptionUpsertInput struct {
	AttributeDefID int32  `json:"attribute_def_id" mcp:"required,desc=enum-typed attribute_def to add the option to"`
	Value          string `json:"value" mcp:"required,desc=stored value (the literal jsonb the server accepts on attribute.update)"`
	Label          string `json:"label" mcp:"required,desc=display label"`
	Ordering       int32  `json:"ordering,omitempty" mcp:"desc=display ordering (ascending; default 0)"`
}

// OptionUpsertOutput acks the upsert.
type OptionUpsertOutput struct {
	OK bool `json:"ok" mcp:"desc=true on successful upsert"`
}

// OptionDeleteInput removes one option from an enum-typed attribute_def.
// Refuses with usage_count > 0 if any attribute_value still references the
// value, so the admin must clear or migrate references first.
type OptionDeleteInput struct {
	AttributeDefID int32  `json:"attribute_def_id" mcp:"required,desc=enum-typed attribute_def"`
	Value          string `json:"value" mcp:"required,desc=stored value to remove"`
}

// OptionDeleteOutput surfaces the same usage-count guard as edge.delete so
// the admin UI can render a "in use by N cards" warning.
type OptionDeleteOutput struct {
	OK         bool `json:"ok" mcp:"desc=true if the option was deleted"`
	UsageCount int  `json:"usage_count,omitempty" mcp:"desc=number of attribute_value rows blocking the delete"`
}

var authzPool *store.Pool

// Register installs every endpoint.
func Register(p *store.Pool) {
	authzPool = p
	reg.Register(reg.Handler{
		Endpoint:     "attribute_def",
		Action:       "select",
		Doc:          "List every attribute_def with the card_types it is bound to via edge.",
		InputType:    reflect.TypeFor[SelectInput](),
		OutputType:   reflect.TypeFor[SelectOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Run:          runSelect(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "attribute_def",
		Action:       "insert",
		Doc:          "Admin-only: insert a new attribute_def with optional initial edges, in one tx.",
		InputType:    reflect.TypeFor[InsertInput](),
		OutputType:   reflect.TypeFor[InsertOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		Run:          runInsert(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "edge",
		Action:       "insert",
		Doc:          "Admin-only: bind an existing attribute_def to a card_type. Idempotent (re-binding is a no-op).",
		InputType:    reflect.TypeFor[EdgeInsertInput](),
		OutputType:   reflect.TypeFor[EdgeInsertOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		Run:          runEdgeInsert(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "edge",
		Action:       "delete",
		Doc:          "Admin-only: unbind an attribute_def from a card_type. Refuses with usage_count if any attribute_value rows reference it.",
		InputType:    reflect.TypeFor[EdgeDeleteInput](),
		OutputType:   reflect.TypeFor[EdgeDeleteOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		Run:          runEdgeDelete(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "attribute_def_option",
		Action:       "upsert",
		Doc:          "Admin-only: add or update one allowed option on an enum-typed attribute_def.",
		InputType:    reflect.TypeFor[OptionUpsertInput](),
		OutputType:   reflect.TypeFor[OptionUpsertOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		Run:          runOptionUpsert(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "attribute_def_option",
		Action:       "delete",
		Doc:          "Admin-only: remove one option from an enum-typed attribute_def. Refuses with usage_count when any attribute_value still references the value.",
		InputType:    reflect.TypeFor[OptionDeleteInput](),
		OutputType:   reflect.TypeFor[OptionDeleteOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		Run:          runOptionDelete(p),
	})
}

// authzAdmin gates writes. The actor must hold admin or system globally.
// Mirrors rolemapping.authzAdmin.
func authzAdmin(ctx context.Context, _ any) error {
	if authzPool == nil {
		return nil
	}
	userID := auth.ActorOrSystem(ctx)
	var n int
	if err := authzPool.P.QueryRow(ctx, `
		SELECT count(*)
		FROM user_role ur
		JOIN role r ON r.id = ur.role_id
		WHERE ur.user_id = $1 AND r.name IN ('admin','system') AND ur.scope_card_id IS NULL
	`, userID).Scan(&n); err != nil {
		return fmt.Errorf("attribute_def.authz: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("attribute_def: actor %d is not an admin", userID)
	}
	return nil
}

// runSelect issues three queries (defs + edges + options) and stitches
// them in Go. We choose follow-up reads over a jsonb LATERAL to keep the
// SQL small and the per-row scan trivial; in practice attribute_def has
// well under 100 rows and only a handful are enum-typed.
func runSelect(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		defRows, err := tx.Query(ctx, `
			SELECT id, name, value_type, is_built_in
			FROM attribute_def
			ORDER BY name
		`)
		if err != nil {
			return nil, fmt.Errorf("attribute_def.select: defs: %w", err)
		}
		var out []SelectRow
		idx := map[int32]int{}
		for defRows.Next() {
			var r SelectRow
			if err := defRows.Scan(&r.ID, &r.Name, &r.ValueType, &r.IsBuiltIn); err != nil {
				defRows.Close()
				return nil, err
			}
			idx[r.ID] = len(out)
			out = append(out, r)
		}
		defRows.Close()
		if err := defRows.Err(); err != nil {
			return nil, err
		}

		edgeRows, err := tx.Query(ctx, `
			SELECT e.attribute_def_id, e.card_type_id, ct.name, ct.is_built_in,
			       e.is_required, e.ordering
			FROM edge e
			JOIN card_type ct ON ct.id = e.card_type_id
			ORDER BY e.attribute_def_id, e.ordering, ct.name
		`)
		if err != nil {
			return nil, fmt.Errorf("attribute_def.select: edges: %w", err)
		}
		for edgeRows.Next() {
			var defID int32
			var b BoundCardType
			if err := edgeRows.Scan(&defID, &b.CardTypeID, &b.CardTypeName, &b.IsBuiltIn, &b.IsRequired, &b.Ordering); err != nil {
				edgeRows.Close()
				return nil, err
			}
			if i, ok := idx[defID]; ok {
				out[i].BoundTo = append(out[i].BoundTo, b)
			}
		}
		edgeRows.Close()
		if err := edgeRows.Err(); err != nil {
			return nil, err
		}

		// Options for enum-typed defs (migration 0012). We follow the same
		// pattern as the edges query: one read, bucket by attribute_def_id
		// in Go. ORDER BY ordering ASC so the client can render options
		// in the canonical sequence without sorting.
		optRows, err := tx.Query(ctx, `
			SELECT attribute_def_id, value, label, ordering
			FROM attribute_def_option
			ORDER BY attribute_def_id, ordering, value
		`)
		if err != nil {
			return nil, fmt.Errorf("attribute_def.select: options: %w", err)
		}
		for optRows.Next() {
			var defID int32
			var o AttributeDefOptionRow
			if err := optRows.Scan(&defID, &o.Value, &o.Label, &o.Ordering); err != nil {
				optRows.Close()
				return nil, err
			}
			if i, ok := idx[defID]; ok {
				out[i].Options = append(out[i].Options, o)
			}
		}
		optRows.Close()
		if err := optRows.Err(); err != nil {
			return nil, err
		}

		if p != nil {
			p.NoteRead()
		}
		outs := make([]any, len(ins))
		for i := range ins {
			outs[i] = SelectOutput{Rows: out}
		}
		return outs, nil
	}
}

// jsonInsertRow is the per-input shape fed to jsonb_to_recordset.
type jsonInsertRow struct {
	Ord       int    `json:"ord"`
	Name      string `json:"name"`
	ValueType string `json:"value_type"`
}

// jsonEdgeSeed represents one edge to seed alongside a freshly inserted
// def. We carry the def's ord so the CTE can correlate it back to the
// returning id.
type jsonEdgeSeed struct {
	Ord        int   `json:"ord"`
	CardTypeID int32 `json:"card_type_id"`
	IsRequired bool  `json:"is_required"`
	Ordering   int32 `json:"ordering"`
}

// runInsert is an arrayPath writer. For each input we INSERT one
// attribute_def row, then INSERT any seeded edges in a follow-up CTE that
// joins back via row_number. We never set is_built_in=true. // arrayPath
func runInsert(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		defs := make([]jsonInsertRow, len(ins))
		var edges []jsonEdgeSeed
		for i, raw := range ins {
			in := raw.(InsertInput)
			if in.Name == "" || in.ValueType == "" {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "attribute_def.insert: name and value_type are required"}
			}
			defs[i] = jsonInsertRow{Ord: i, Name: in.Name, ValueType: in.ValueType}
			for _, e := range in.BindTo {
				if e.CardTypeID == 0 {
					return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
						Message: "attribute_def.insert: bind_to[].card_type_id is required"}
				}
				edges = append(edges, jsonEdgeSeed{
					Ord:        i,
					CardTypeID: e.CardTypeID,
					IsRequired: e.IsRequired,
					Ordering:   e.Ordering,
				})
			}
		}

		defsBuf, err := json.Marshal(defs)
		if err != nil {
			return nil, err
		}

		// Insert defs in ord order; capture (ord, id).
		const defQ = `
			WITH input AS (
				SELECT * FROM jsonb_to_recordset($1::jsonb)
				AS x(ord int, name text, value_type text)
			),
			ins AS (
				INSERT INTO attribute_def (name, value_type, is_built_in)
				SELECT name, value_type, false FROM input ORDER BY ord
				RETURNING id, name
			),
			ins_numbered AS (
				SELECT id, name, row_number() OVER (ORDER BY id) AS rn FROM ins
			),
			input_numbered AS (
				SELECT ord, name, row_number() OVER (ORDER BY ord) AS rn FROM input
			)
			SELECT i.ord, n.id
			FROM ins_numbered n
			JOIN input_numbered i ON i.rn = n.rn
			ORDER BY i.ord
		`
		rows, err := tx.Query(ctx, defQ, defsBuf)
		if err != nil {
			return nil, fmt.Errorf("attribute_def.insert: %w", err)
		}
		outs := make([]any, len(ins))
		idByOrd := make([]int32, len(ins))
		for rows.Next() {
			var ord int
			var id int32
			if err := rows.Scan(&ord, &id); err != nil {
				rows.Close()
				return nil, err
			}
			if ord < 0 || ord >= len(ins) {
				rows.Close()
				return nil, fmt.Errorf("attribute_def.insert: ord %d out of range", ord)
			}
			idByOrd[ord] = id
			outs[ord] = InsertOutput{ID: id}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		if p != nil {
			p.NoteWrite()
		}

		// If any seeded edges, do them in a second statement-group. Map ord
		// to the freshly returned attribute_def_id, then ON CONFLICT DO
		// NOTHING in case a duplicate slipped in.
		if len(edges) > 0 {
			type rendered struct {
				AttributeDefID int32 `json:"attribute_def_id"`
				CardTypeID     int32 `json:"card_type_id"`
				IsRequired     bool  `json:"is_required"`
				Ordering       int32 `json:"ordering"`
			}
			payload := make([]rendered, len(edges))
			for i, e := range edges {
				payload[i] = rendered{
					AttributeDefID: idByOrd[e.Ord],
					CardTypeID:     e.CardTypeID,
					IsRequired:     e.IsRequired,
					Ordering:       e.Ordering,
				}
			}
			buf, err := json.Marshal(payload)
			if err != nil {
				return nil, err
			}
			const edgeQ = `
				INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
				SELECT card_type_id, attribute_def_id, is_required, ordering
				FROM jsonb_to_recordset($1::jsonb)
				AS x(card_type_id int, attribute_def_id int, is_required boolean, ordering int)
				ON CONFLICT (card_type_id, attribute_def_id) DO NOTHING
			`
			if _, err := tx.Exec(ctx, edgeQ, buf); err != nil {
				return nil, fmt.Errorf("attribute_def.insert: edges: %w", err)
			}
			if p != nil {
				p.NoteWrite()
			}
		}
		return outs, nil
	}
}

// jsonEdgeRow is the per-input shape for runEdgeInsert.
type jsonEdgeRow struct {
	AttributeDefID int32 `json:"attribute_def_id"`
	CardTypeID     int32 `json:"card_type_id"`
	IsRequired     bool  `json:"is_required"`
	Ordering       int32 `json:"ordering"`
}

// runEdgeInsert is an arrayPath writer. // arrayPath
func runEdgeInsert(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		payload := make([]jsonEdgeRow, len(ins))
		for i, raw := range ins {
			in := raw.(EdgeInsertInput)
			if in.AttributeDefID == 0 || in.CardTypeID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "edge.insert: attribute_def_id and card_type_id are required"}
			}
			payload[i] = jsonEdgeRow{
				AttributeDefID: in.AttributeDefID,
				CardTypeID:     in.CardTypeID,
				IsRequired:     in.IsRequired,
				Ordering:       in.Ordering,
			}
		}
		buf, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		const q = `
			INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
			SELECT card_type_id, attribute_def_id, is_required, ordering
			FROM jsonb_to_recordset($1::jsonb)
			AS x(card_type_id int, attribute_def_id int, is_required boolean, ordering int)
			ON CONFLICT (card_type_id, attribute_def_id) DO NOTHING
		`
		if _, err := tx.Exec(ctx, q, buf); err != nil {
			return nil, fmt.Errorf("edge.insert: %w", err)
		}
		if p != nil {
			p.NoteWrite()
		}
		outs := make([]any, len(ins))
		for i := range ins {
			outs[i] = EdgeInsertOutput{OK: true}
		}
		return outs, nil
	}
}

// runOptionUpsert handles per-input upserts with ordering-collision repair.
//
// Each row is processed in turn:
//  1. Validate that the target def is enum-typed (a guard that catches admins
//     pointing the option editor at a text/number/ref def).
//  2. If another option on the same def is already sitting at the requested
//     ordering, bump every other option whose ordering is >= the requested
//     value up by one. The dragged-in option then slots in cleanly without
//     two rows colliding at the same ordinal. Re-saving an option at its
//     current (value, ordering) is a no-op for the bump step.
//  3. UPSERT (value is the natural key; label/ordering refresh on conflict).
//
// arrayPath — the per-row pattern is needed because each row's bump SQL
// references parameters we don't want to multiplex.
func runOptionUpsert(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(OptionUpsertInput)
			if in.AttributeDefID == 0 || in.Value == "" {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "attribute_def_option.upsert: attribute_def_id and value are required"}
			}
			label := in.Label
			if label == "" {
				label = in.Value
			}

			// Guard: must point at an enum-typed def. Cheap point query;
			// runs once per input rather than batched so a bad row in a
			// mixed batch is reported with the matching InputIndex.
			var vt string
			if err := tx.QueryRow(ctx, `
				SELECT value_type FROM attribute_def WHERE id = $1
			`, in.AttributeDefID).Scan(&vt); err != nil {
				if err == pgx.ErrNoRows {
					return nil, &reg.HandlerError{InputIndex: i, Code: "not_found",
						Message: fmt.Sprintf("attribute_def_option.upsert: attribute_def %d not found", in.AttributeDefID)}
				}
				return nil, fmt.Errorf("attribute_def_option.upsert: guard: %w", err)
			}
			if vt != "enum" {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "attribute_def_option.upsert: target attribute_def is not enum-typed"}
			}

			// Bump if a *different* row already sits at this ordering.
			// Re-saving the same row at the same ordering doesn't shift
			// anything (idempotent label-only edits stay no-ops).
			var conflict int
			if err := tx.QueryRow(ctx, `
				SELECT count(*) FROM attribute_def_option
				WHERE attribute_def_id = $1
				  AND ordering = $2
				  AND value <> $3
			`, in.AttributeDefID, in.Ordering, in.Value).Scan(&conflict); err != nil {
				return nil, fmt.Errorf("attribute_def_option.upsert: collision check: %w", err)
			}
			if conflict > 0 {
				if _, err := tx.Exec(ctx, `
					UPDATE attribute_def_option
					SET ordering = ordering + 1
					WHERE attribute_def_id = $1
					  AND ordering >= $2
					  AND value <> $3
				`, in.AttributeDefID, in.Ordering, in.Value); err != nil {
					return nil, fmt.Errorf("attribute_def_option.upsert: bump: %w", err)
				}
			}

			if _, err := tx.Exec(ctx, `
				INSERT INTO attribute_def_option (attribute_def_id, value, label, ordering)
				VALUES ($1, $2, $3, $4)
				ON CONFLICT (attribute_def_id, value) DO UPDATE
					SET label = EXCLUDED.label,
					    ordering = EXCLUDED.ordering
			`, in.AttributeDefID, in.Value, label, in.Ordering); err != nil {
				return nil, fmt.Errorf("attribute_def_option.upsert: %w", err)
			}
			outs[i] = OptionUpsertOutput{OK: true}
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}

// runOptionDelete deletes one option per input, refusing with usage_count
// when any attribute_value rows still reference the value (mirrors
// runEdgeDelete's safety check). Per-input loop keeps the implementation
// small; option lists are short.
func runOptionDelete(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(OptionDeleteInput)
			if in.AttributeDefID == 0 || in.Value == "" {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "attribute_def_option.delete: attribute_def_id and value are required"}
			}
			// usage = number of attribute_value rows on this def whose stored
			// jsonb literal equals the option's value. We compare via the
			// to_jsonb wrapping the server uses on writes — anything else
			// would miss strict-typed values.
			var usage int
			row := tx.QueryRow(ctx, `
				SELECT count(*) FROM attribute_value
				WHERE attribute_def_id = $1 AND value = to_jsonb($2::text)
			`, in.AttributeDefID, in.Value)
			if err := row.Scan(&usage); err != nil {
				return nil, fmt.Errorf("attribute_def_option.delete: usage: %w", err)
			}
			if usage > 0 {
				outs[i] = OptionDeleteOutput{OK: false, UsageCount: usage}
				continue
			}
			ct, err := tx.Exec(ctx, `
				DELETE FROM attribute_def_option
				WHERE attribute_def_id = $1 AND value = $2
			`, in.AttributeDefID, in.Value)
			if err != nil {
				return nil, fmt.Errorf("attribute_def_option.delete: %w", err)
			}
			outs[i] = OptionDeleteOutput{OK: ct.RowsAffected() > 0}
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}

// runEdgeDelete deletes (or refuses to delete) one edge per input. We use
// the array-path: one DELETE per input run as separate statements inside
// the same Run. We also fan out a usage check per input — if any
// attribute_value rows exist for (card_type, def), we mark that input as
// blocked and skip the DELETE. The caller learns via usage_count > 0 and
// can clear references first.
//
// We intentionally protect built-in edges (refuse with code "built_in").
// Migrations install those; admins should not be able to silently rewire
// the schema.
func runEdgeDelete(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(EdgeDeleteInput)
			if in.AttributeDefID == 0 || in.CardTypeID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "edge.delete: attribute_def_id and card_type_id are required"}
			}

			// Refuse on built-in edges. We treat built-in as "the edge
			// connects a built-in def to a built-in card_type" — matches
			// what migrations seed today (the title edges, etc.).
			var defBuiltIn, ctBuiltIn bool
			row := tx.QueryRow(ctx, `
				SELECT ad.is_built_in, ct.is_built_in
				FROM attribute_def ad, card_type ct
				WHERE ad.id = $1 AND ct.id = $2
			`, in.AttributeDefID, in.CardTypeID)
			if err := row.Scan(&defBuiltIn, &ctBuiltIn); err != nil {
				if err == pgx.ErrNoRows {
					return nil, &reg.HandlerError{InputIndex: i, Code: "not_found",
						Message: fmt.Sprintf("edge.delete: def %d or card_type %d not found", in.AttributeDefID, in.CardTypeID)}
				}
				return nil, fmt.Errorf("edge.delete: lookup: %w", err)
			}
			if defBuiltIn && ctBuiltIn {
				return nil, &reg.HandlerError{InputIndex: i, Code: "built_in",
					Message: "edge.delete: refusing to remove a built-in (def + card_type) edge — change the migration instead"}
			}

			// Count usage. The (card_type, def) pair is in use if any card
			// of that type carries an attribute_value for that def.
			var usage int
			row = tx.QueryRow(ctx, `
				SELECT count(*)
				FROM attribute_value av
				JOIN card c ON c.id = av.card_id
				WHERE av.attribute_def_id = $1 AND c.card_type_id = $2
			`, in.AttributeDefID, in.CardTypeID)
			if err := row.Scan(&usage); err != nil {
				return nil, fmt.Errorf("edge.delete: usage check: %w", err)
			}
			if usage > 0 {
				outs[i] = EdgeDeleteOutput{OK: false, UsageCount: usage}
				continue
			}

			ct, err := tx.Exec(ctx, `
				DELETE FROM edge
				WHERE attribute_def_id = $1 AND card_type_id = $2
			`, in.AttributeDefID, in.CardTypeID)
			if err != nil {
				return nil, fmt.Errorf("edge.delete: %w", err)
			}
			outs[i] = EdgeDeleteOutput{OK: ct.RowsAffected() > 0}
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}
