// Package myscreen serves personal screens (docs/PERSONAL_SCREENS.md): an
// account's own screens across every project it can see — a list or grid
// of tasks or threads with a base filter (a `project` leaf limits it to some
// projects) — listed in the left navigation under Mine. A personal screen is
// a parentless `screen` card private to the account's person
// (card.private_to); its saved views are filter cards under it, private by
// inheritance, written through the generic card handlers (the dispatcher
// lets an owner write their own private cards).
package myscreen

import (
	"reflect"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// ListInput is empty: an account lists its own screens.
type ListInput struct{}

// Row is one personal screen.
type Row struct {
	ID            int64   `json:"id,string" mcp:"desc=screen card id (open it at /my/<id>)"`
	Title         string  `json:"title" mcp:"desc=its name, shown in Mine"`
	Layout        string  `json:"layout" mcp:"desc=list or grid"`
	ListCardType  string  `json:"list_card_type" mcp:"desc=task or comm (threads)"`
	Predicate     string  `json:"predicate" mcp:"desc=the base filter JSON (screen-filter shape; '@me' = you; a project leaf limits it to some projects); empty = everything you can see"`
	SortOrder     float64 `json:"sort_order" mcp:"desc=its place in Mine (lower first)"`
	DefaultFilter int64   `json:"default_filter,string" mcp:"desc=the view it opens with; 0 = none"`
	ViewCount     int     `json:"view_count" mcp:"desc=how many saved views it has"`
}

// ListOutput wraps the screens.
type ListOutput struct {
	Screens []Row `json:"screens" mcp:"desc=your personal screens, in Mine order"`
}

// SetInput creates (ID 0) or updates a personal screen; absent fields are
// left alone on update.
type SetInput struct {
	ID            int64    `json:"id,string,omitempty" mcp:"desc=omit or 0 to create"`
	Title         *string  `json:"title,omitempty" mcp:"desc=name, 1–60 characters (required to create)"`
	Layout        *string  `json:"layout,omitempty" mcp:"desc=list (default) or grid"`
	ListCardType  *string  `json:"list_card_type,omitempty" mcp:"desc=task (default) or comm (threads)"`
	Predicate     *string  `json:"predicate,omitempty" mcp:"desc=base filter JSON; empty = everything you can see; {attr: project, op: in | not in, values: [ids]} limits the projects"`
	SortOrder     *float64 `json:"sort_order,omitempty" mcp:"desc=its place in Mine (lower first)"`
	DefaultFilter *int64   `json:"default_filter,string,omitempty" mcp:"desc=one of its own views to open with; 0 clears"`
}

// IDOutput names a screen.
type IDOutput struct {
	ID int64 `json:"id,string" mcp:"desc=screen card id"`
}

// DeleteInput deletes a screen.
type DeleteInput struct {
	ID int64 `json:"id,string" mcp:"required,desc=screen card id"`
}

// Register wires my_screen.*. Anyone signed in keeps their own screens; the
// SQL checks the owner (private_to = account_person) — there is no project
// anchor, since a personal screen spans every project its owner sees.
func Register(_ *store.Pool) {
	own := []string{reg.RoleAuthenticated}
	reg.Register(reg.Handler{
		Endpoint: "my_screen", Action: "list",
		Doc:          "List YOUR personal screens (Mine in the left navigation): name, layout, what they list, base filter, order and default view.",
		InputType:    reflect.TypeFor[ListInput](),
		OutputType:   reflect.TypeFor[ListOutput](),
		AllowedRoles: own, IsRead: true,
		SQLFunc: "my_screen_list_batch",
	})
	reg.Register(reg.Handler{
		Endpoint: "my_screen", Action: "set",
		Doc:          "Create (id omitted) or update one of YOUR personal screens: a list or grid of tasks or threads across every project you can see, narrowed by a base filter (a project leaf limits it to some projects). Only you see it. Save views on it with card.insert {card_type_name: filter, parent_card_id: <screen>} — they are yours too.",
		InputType:    reflect.TypeFor[SetInput](),
		OutputType:   reflect.TypeFor[IDOutput](),
		AllowedRoles: own,
		SQLFunc:      "my_screen_set_batch",
	})
	reg.Register(reg.Handler{
		Endpoint: "my_screen", Action: "delete",
		Doc:          "Delete one of YOUR personal screens and its views.",
		InputType:    reflect.TypeFor[DeleteInput](),
		OutputType:   reflect.TypeFor[IDOutput](),
		AllowedRoles: own,
		SQLFunc:      "my_screen_delete_batch",
	})
}
