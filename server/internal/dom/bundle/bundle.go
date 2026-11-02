// Package bundle exposes feature bundles: named, code-owned sets of cards
// (statuses + flows, screens, filters, starter pages) a project can be
// composed from or have added later, plus the presets that combine them.
//
// The bundles live in db/schema/bundles/*.hcsv. store.ApplySchema's bundle
// tier materialises each into a hidden source project and records it in
// the `bundle` table; presets are rows there too. Three endpoints:
//
//   - bundle.list      — the catalog, and for a project which features it
//     has (enabled) and which it can't take (conflict).
//   - bundle.apply     — add features to an existing project.
//   - project.compose  — create a project from a preset and/or features,
//     instead of copying one template.
//
// Applying a feature merge-copies its source into the project through
// copy_project_template_merge, the same graph-copy project.stamp uses,
// recording each copied card's origin (card_origin). Features add, they
// never modify: a feature whose flow would bind an attribute the project
// already drives itself is refused, and re-applying a feature adds only
// what's missing. See db/schema/functions/bundle_apply.sql.
package bundle

import (
	"context"
	"reflect"
	"time"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

// ListInput optionally names the project whose features to report.
type ListInput struct {
	ProjectID int64 `json:"project_id,string,omitempty" mcp:"desc=project to report enabled / conflicting features for; omit for the bare catalog (the new-project dialog)"`
}

// Feature is one feature bundle in the catalog.
type Feature struct {
	Key      string `json:"key" mcp:"desc=bundle key, e.g. 'publishing'"`
	Title    string `json:"title" mcp:"desc=display name"`
	Doc      string `json:"doc" mcp:"desc=what the feature adds"`
	Sort     int    `json:"sort" mcp:"desc=display order"`
	Enabled  bool   `json:"enabled" mcp:"desc=the project has this feature (some of its cards came from it)"`
	Conflict string `json:"conflict" mcp:"desc=why the project can't take this feature (it already drives one of the feature's flow attributes itself); empty when it can"`
}

// Preset is a named, ordered list of features.
type Preset struct {
	Key      string   `json:"key" mcp:"desc=preset key, e.g. 'content'"`
	Title    string   `json:"title" mcp:"desc=display name"`
	Doc      string   `json:"doc" mcp:"desc=what a project made from it starts with"`
	Sort     int      `json:"sort" mcp:"desc=display order"`
	Features []string `json:"features" mcp:"desc=feature keys applied in order"`
}

// ListOutput is the catalog.
type ListOutput struct {
	Features []Feature `json:"features" mcp:"desc=every feature bundle"`
	Presets  []Preset  `json:"presets" mcp:"desc=every preset"`
}

// ApplyInput names a project and the features to add.
type ApplyInput struct {
	ProjectID int64    `json:"project_id,string" mcp:"required,desc=project to add the features to"`
	Keys      []string `json:"keys" mcp:"required,desc=feature keys to add, applied in order (see bundle.list)"`
}

// ApplyResult reports what applying one feature did.
type ApplyResult struct {
	Key      string `json:"key" mcp:"desc=feature key"`
	Status   string `json:"status" mcp:"desc='applied' (first time) or 'updated' (re-applied: only missing items were added)"`
	Copied   int    `json:"copied" mcp:"desc=cards copied into the project"`
	Existing int    `json:"existing" mcp:"desc=feature cards the project already had (left as they are)"`
	Message  string `json:"message" mcp:"desc=human-readable note; empty on success"`
}

// ApplyOutput lists one result per key.
type ApplyOutput struct {
	Results []ApplyResult `json:"results" mcp:"desc=one entry per feature, in order"`
}

// ComposeInput names the new project and what it starts with.
type ComposeInput struct {
	Name        string   `json:"name" mcp:"required,desc=title for the new project"`
	Description string   `json:"description,omitempty" mcp:"desc=optional markdown description"`
	Preset      string   `json:"preset,omitempty" mcp:"desc=preset key (bundle.list presets) whose features the project starts with"`
	Features    []string `json:"features,omitempty" mcp:"desc=extra feature keys, added after the preset's"`
	AreasOff    []string `json:"areas_off,omitempty" mcp:"desc=area keys (area.list) the project starts with switched off"`
}

// ComposeOutput is the new project.
type ComposeOutput struct {
	NewProjectID int64    `json:"new_project_id,string" mcp:"desc=id of the new project"`
	Features     []string `json:"features" mcp:"desc=features the project was composed from, in order"`
}

// Register installs bundle.list, bundle.apply and project.compose.
func Register(_ *store.Pool) {
	writers := []string{"worker", "manager", "admin"}
	reg.Register(reg.Handler{
		Endpoint:     "bundle",
		Action:       "list",
		Doc:          "List the feature bundles (task tracking, conversations, publishing, …) and project presets this install ships. With project_id, also report which features that project has and which it can't take.",
		InputType:    reflect.TypeFor[ListInput](),
		OutputType:   reflect.TypeFor[ListOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		IsRead:       true,
		SQLFunc:      "bundle_list_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "bundle",
		Action:       "apply",
		Doc:          "Add feature bundles to a project: their statuses + flow, screens, filters and starter content are copied in. Re-applying a feature adds only what's missing; a feature whose flow would replace one the project already has is refused. Requires edit rights on the project.",
		InputType:    reflect.TypeFor[ApplyInput](),
		OutputType:   reflect.TypeFor[ApplyOutput](),
		AllowedRoles: writers,
		// Adding a feature edits the project's configuration: gate on
		// card.update of the project card, scoped to that project.
		ProcessName: "card.update",
		CardTypeID: func(ctx context.Context, pool reg.ValidationPool, in any) (int64, error) {
			return schema.CardTypeIDByCardID(ctx, pool, in.(ApplyInput).ProjectID)
		},
		ScopeCardID: func(_ context.Context, _ reg.ValidationPool, in any) (int64, error) {
			return in.(ApplyInput).ProjectID, nil
		},
		Timeout: 60 * time.Second, // graph-copy, like project.stamp
		SQLFunc: "bundle_apply_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "project",
		Action:       "compose",
		Doc:          "Create a project from a preset (bundle.list presets) and/or a list of feature bundles, instead of copying a template. Each feature's statuses + flow, screens, filters and starter content are copied in, in order.",
		InputType:    reflect.TypeFor[ComposeInput](),
		OutputType:   reflect.TypeFor[ComposeOutput](),
		AllowedRoles: writers,
		// Like project.stamp: a brand-new project has no existing card to
		// scope-check against.
		GlobalScope: true,
		Timeout:     60 * time.Second,
		SQLFunc:     "project_compose_batch",
	})
}
