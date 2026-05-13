// Package card — project screen seeding.
//
// When `card.insert` creates a new project, this helper auto-creates
// the four built-in screen cards (inbox / grid / kanban / project_detail),
// a "Default" filter card under each, and wires the screen's
// default_filter card_ref to its lone filter child. Runs in the same
// tx as the project insert so a failure rolls everything back together.
//
// Kept in a separate file so card.go stays focused on the generic
// insert path.
package card

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/schema"
)

// screenSeedSpec is one row in the data-driven table that drives the
// project-creation seed. New screen types are added by adding rows
// here — no extra Go branches.
type screenSeedSpec struct {
	Layout     string // renderer pick; matches the application's LAYOUTS set
	Slug       string // per-project URL token; matches ^[a-z][a-z0-9-]*$
	Hotkey     string // single character (g <hotkey>) inside the project scope
	Title      string // human-readable title on the screen card
	SortOrder  int64  // display order in the admin/UI listings
	ColumnAttr string // kanban-only convention; empty for other screens
}

var screenSeed = []screenSeedSpec{
	{Layout: "list", Slug: "inbox", Hotkey: "i", Title: "Inbox", SortOrder: 1},
	{Layout: "grid", Slug: "grid", Hotkey: "g", Title: "Grid", SortOrder: 2},
	{Layout: "kanban", Slug: "kanban", Hotkey: "k", Title: "Kanban", SortOrder: 3, ColumnAttr: "milestone_ref"},
	{Layout: "pair", Slug: "project", Title: "Project detail", SortOrder: 4},
}

// seedProjectScreens populates the per-project screen + filter cards
// for `projectID`. Idempotent within a tx (the per-row inserts assume
// the project was just created — no existence check).
func seedProjectScreens(ctx context.Context, tx pgx.Tx, projectID, actorID int64, snap *schema.Snapshot) error {
	screenCT, ok := snap.CardTypeByName["screen"]
	if !ok {
		return fmt.Errorf("seedProjectScreens: card_type 'screen' missing from schema")
	}
	filterCT, ok := snap.CardTypeByName["filter"]
	if !ok {
		return fmt.Errorf("seedProjectScreens: card_type 'filter' missing from schema")
	}
	titleAD, ok := snap.AttrByName["title"]
	if !ok {
		return fmt.Errorf("seedProjectScreens: attribute_def 'title' missing")
	}
	layoutAD, ok := snap.AttrByName["layout"]
	if !ok {
		return fmt.Errorf("seedProjectScreens: attribute_def 'layout' missing")
	}
	slugAD, ok := snap.AttrByName["slug"]
	if !ok {
		return fmt.Errorf("seedProjectScreens: attribute_def 'slug' missing")
	}
	hotkeyAD, ok := snap.AttrByName["hotkey"]
	if !ok {
		return fmt.Errorf("seedProjectScreens: attribute_def 'hotkey' missing")
	}
	defaultFilterAD, ok := snap.AttrByName["default_filter"]
	if !ok {
		return fmt.Errorf("seedProjectScreens: attribute_def 'default_filter' missing")
	}
	sortOrderAD, ok := snap.AttrByName["sort_order"]
	if !ok {
		return fmt.Errorf("seedProjectScreens: attribute_def 'sort_order' missing")
	}
	columnAttrAD, ok := snap.AttrByName["column_attr"]
	if !ok {
		return fmt.Errorf("seedProjectScreens: attribute_def 'column_attr' missing")
	}

	for _, s := range screenSeed {
		screenAttrs := []attrWrite{
			{defID: titleAD.ID, value: jsonString(s.Title)},
			{defID: layoutAD.ID, value: jsonString(s.Layout)},
			{defID: slugAD.ID, value: jsonString(s.Slug)},
			{defID: sortOrderAD.ID, value: jsonNumber(s.SortOrder)},
		}
		if s.Hotkey != "" {
			screenAttrs = append(screenAttrs, attrWrite{
				defID: hotkeyAD.ID,
				value: jsonString(s.Hotkey),
			})
		}
		screenID, err := insertCardWithAttrs(ctx, tx, screenCT.ID, &projectID, actorID, screenAttrs)
		if err != nil {
			return fmt.Errorf("seedProjectScreens: screen %q: %w", s.Slug, err)
		}

		filterAttrs := []attrWrite{
			{defID: titleAD.ID, value: jsonString("Default")},
		}
		if s.ColumnAttr != "" {
			filterAttrs = append(filterAttrs, attrWrite{
				defID: columnAttrAD.ID,
				value: jsonString(s.ColumnAttr),
			})
		}
		filterID, err := insertCardWithAttrs(ctx, tx, filterCT.ID, &screenID, actorID, filterAttrs)
		if err != nil {
			return fmt.Errorf("seedProjectScreens: filter for %q: %w", s.Slug, err)
		}

		// Wire screen.default_filter → filter card.
		if err := writeAttr(ctx, tx, screenID, defaultFilterAD.ID, jsonInt64(filterID), actorID); err != nil {
			return fmt.Errorf("seedProjectScreens: default_filter for %q: %w", s.Slug, err)
		}
	}
	return nil
}

/* ---------------------------------------------------------------- helpers */

// attrWrite is one (attribute_def_id, value) pair for a fresh card.
// The seed builds these inline and feeds insertCardWithAttrs.
type attrWrite struct {
	defID int64
	value json.RawMessage
}

// insertCardWithAttrs inserts a card row, emits a card_create activity,
// and writes each attribute as an activity + attribute_value pair.
// Returns the new card id.
//
// Single helper used for both screen and filter seeds so the SQL shape
// is identical in both cases.
func insertCardWithAttrs(
	ctx context.Context,
	tx pgx.Tx,
	cardTypeID int64,
	parentCardID *int64,
	actorID int64,
	attrs []attrWrite,
) (int64, error) {
	var cardID int64
	if err := tx.QueryRow(ctx, `
		INSERT INTO card (card_type_id, parent_card_id) VALUES ($1, $2) RETURNING id
	`, cardTypeID, parentCardID).Scan(&cardID); err != nil {
		return 0, fmt.Errorf("insert card: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO activity (card_id, kind, actor_id) VALUES ($1, 'card_create', $2)
	`, cardID, actorID); err != nil {
		return 0, fmt.Errorf("insert card_create activity: %w", err)
	}
	for _, a := range attrs {
		if err := writeAttr(ctx, tx, cardID, a.defID, a.value, actorID); err != nil {
			return 0, err
		}
	}
	return cardID, nil
}

// writeAttr emits one attr_update activity + attribute_value upsert.
// The activity's id flows into attribute_value.last_activity_id so the
// audit chain stays intact.
func writeAttr(
	ctx context.Context,
	tx pgx.Tx,
	cardID, attributeDefID int64,
	value json.RawMessage,
	actorID int64,
) error {
	var activityID int64
	if err := tx.QueryRow(ctx, `
		INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
		VALUES ($1, 'attr_update', $2, NULL, $3::jsonb, $4)
		RETURNING id
	`, cardID, attributeDefID, value, actorID).Scan(&activityID); err != nil {
		return fmt.Errorf("activity: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
		VALUES ($1, $2, $3::jsonb, $4)
		ON CONFLICT (card_id, attribute_def_id) DO UPDATE
			SET value = EXCLUDED.value,
			    last_activity_id = EXCLUDED.last_activity_id
	`, cardID, attributeDefID, value, activityID); err != nil {
		return fmt.Errorf("attribute_value: %w", err)
	}
	return nil
}

func jsonString(s string) json.RawMessage {
	b, _ := json.Marshal(s)
	return b
}

func jsonNumber(n int64) json.RawMessage {
	b, _ := json.Marshal(n)
	return b
}

func jsonInt64(n int64) json.RawMessage {
	b, _ := json.Marshal(n)
	return b
}
