// Package area switches a project's areas on and off (docs/AREAS.md).
//
// A project's configuration and data are split into areas — Tasks,
// Conversations, Approvals, Content — and the workspace has Sites. The
// catalog is db/schema/bundles/areas.hcsv (materialised into the `area`
// table at boot). An area that is off is hidden completely:
// card_in_off_area hides its items from every DI-6 read, the dispatcher
// refuses writes to them (api.checkArea), and its automation pauses (mail
// workers, activity sinks, portal builds).
//
// Dispatcher endpoints: area.list (the Areas settings, the sidebar, the
// detail view) and area.set.
package area

import (
	"context"
	"reflect"
	"time"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

// ListInput names a project; none lists the workspace areas.
type ListInput struct {
	ProjectID int64 `json:"project_id,string,omitempty" mcp:"desc=project card id; omit for the whole catalog: every project area (state unused) and the workspace areas with their state"`
}

// Start is one starting point of an area.
type Start struct {
	Key   string `json:"key" mcp:"desc=feature bundle key"`
	Title string `json:"title" mcp:"desc=display name"`
}

// Area is one area and its state.
type Area struct {
	Key       string   `json:"key" mcp:"desc=area key"`
	Title     string   `json:"title" mcp:"desc=display name"`
	Doc       string   `json:"doc" mcp:"desc=what it holds"`
	Scope     string   `json:"scope" mcp:"desc=project or workspace"`
	Sort      int      `json:"sort" mcp:"desc=display order"`
	State     string   `json:"state" mcp:"desc=on, off, or unused (nothing of the area in the project yet)"`
	DependsOn []string `json:"depends_on" mcp:"desc=areas it needs on"`
	Starts    []Start  `json:"starts" mcp:"desc=starting points, the default first"`
	Added     []string `json:"added" mcp:"desc=starting points the project used"`
	Screens   []string `json:"screens" mcp:"desc=ids of the project's screens that belong to the area"`
	Items     *int64   `json:"items" mcp:"desc=how many items the area holds in the project; admins only, null otherwise"`
}

// ListOutput wraps the areas.
type ListOutput struct {
	Areas []Area `json:"areas" mcp:"desc=areas in display order"`
}

// SetInput switches one area.
type SetInput struct {
	ProjectID int64  `json:"project_id,string,omitempty" mcp:"desc=project card id; omit for a workspace area (Sites)"`
	Key       string `json:"key" mcp:"required,desc=area key (area.list)"`
	On        *bool  `json:"on" mcp:"required,desc=true switches the area on (admin only), false off (manager or admin)"`
	Start     string `json:"start,omitempty" mcp:"desc=starting point to add when switching on an area that never had one; default its first"`
}

// SetOutput reports the switch.
type SetOutput struct {
	Key     string   `json:"key" mcp:"desc=area key"`
	State   string   `json:"state" mcp:"desc=on or off"`
	Applied []string `json:"applied" mcp:"desc=starting points this call added"`
}

// Register installs area.list and area.set.
func Register(_ *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "area",
		Action:       "list",
		Doc:          "List a project's areas (Tasks, Conversations, Approvals, Content) with their state — on, off, or unused — starting points and screens; without a project, the whole catalog, including the workspace areas (Sites) and their state. An area that is off is hidden completely.",
		InputType:    reflect.TypeFor[ListInput](),
		OutputType:   reflect.TypeFor[ListOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		IsRead:       true,
		SQLFunc:      "area_list_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "area",
		Action:       "set",
		Doc:          "Switch an area on or off. Off hides everything in it from everyone, refuses changes to it and pauses its automation; on restores it (admin only), turning on the areas it needs and adding a starting point if it never had one. A project area needs project_id; Sites is workspace-wide.",
		InputType:    reflect.TypeFor[SetInput](),
		OutputType:   reflect.TypeFor[SetOutput](),
		AllowedRoles: []string{"manager", "admin"},
		// A project area is project configuration: gate on card.update of
		// the project card, scoped to it. A workspace area has no project
		// (CardTypeID 0 skips the scoped check); area_set_batch requires
		// an admin for it, and an admin to switch anything on.
		ProcessName: "card.update",
		CardTypeID: func(ctx context.Context, pool reg.ValidationPool, in any) (int64, error) {
			id := in.(SetInput).ProjectID
			if id == 0 {
				return 0, nil
			}
			return schema.CardTypeIDByCardID(ctx, pool, id)
		},
		ScopeCardID: func(_ context.Context, _ reg.ValidationPool, in any) (int64, error) {
			return in.(SetInput).ProjectID, nil
		},
		Timeout: 60 * time.Second, // switching on can add a starting point (a graph copy)
		SQLFunc: "area_set_batch",
	})
}
