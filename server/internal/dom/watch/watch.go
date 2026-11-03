// Package watch serves watch lists (docs/WATCH_LISTS.md): each account's
// own bookmark lists of tasks and threads. A list is a global watch_list
// card owned through its subscriber (the account's person, or an agent's
// owner's: watch_owner); what is on it lives in watch_entry, in the list's
// own order. Every account starts with Stars (★), made the first time it
// lists its watch lists. The card filter's watch_list leaf ("@me" = any of
// my lists) finds what is on them (watched_on).
package watch

import (
	"reflect"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// ListInput optionally names a card, to say whether it is on each list.
type ListInput struct {
	CardID int64 `json:"card_id,string,omitempty" mcp:"desc=a task or thread: each list then says whether it is on it (has_card)"`
}

// ListRow is one watch list.
type ListRow struct {
	ID          int64  `json:"id,string" mcp:"desc=watch list id"`
	Title       string `json:"title" mcp:"desc=the list's name, e.g. Stars"`
	Symbol      string `json:"symbol" mcp:"desc=the list's symbol, e.g. ★ (shown on every task and thread)"`
	Description string `json:"description" mcp:"desc=what the list is for"`
	Count       int    `json:"count" mcp:"desc=how many tasks and threads are on it"`
	HasCard     bool   `json:"has_card" mcp:"desc=with card_id: whether that card is on this list"`
}

// ListOutput wraps the lists.
type ListOutput struct {
	Lists []ListRow `json:"lists" mcp:"desc=your watch lists, oldest first"`
}

// SetInput creates (ID 0) or updates a list; absent fields are left alone on
// update.
type SetInput struct {
	ID          int64   `json:"id,string,omitempty" mcp:"desc=omit or 0 to create"`
	Title       *string `json:"title,omitempty" mcp:"desc=name, 1–60 characters (required to create)"`
	Symbol      *string `json:"symbol,omitempty" mcp:"desc=an emoji or a character, up to 16 (default ★)"`
	Description *string `json:"description,omitempty" mcp:"desc=up to 1000 characters"`
}

// IDOutput names a list.
type IDOutput struct {
	ID int64 `json:"id,string" mcp:"desc=watch list id"`
}

// DeleteInput deletes a list.
type DeleteInput struct {
	ID int64 `json:"id,string" mcp:"required,desc=watch list id"`
}

// SetEntryInput puts a card on a list or takes it off.
type SetEntryInput struct {
	WatchListID int64 `json:"watch_list_id,string" mcp:"required,desc=one of your watch lists"`
	CardID      int64 `json:"card_id,string" mcp:"required,desc=a task or thread you can see"`
	On          bool  `json:"on" mcp:"required,desc=true puts it on the list (at the top), false takes it off"`
}

// SetEntryOutput says where the card stands.
type SetEntryOutput struct {
	On bool `json:"on" mcp:"desc=whether it is on the list now"`
}

// ItemsInput names a list.
type ItemsInput struct {
	WatchListID int64 `json:"watch_list_id,string" mcp:"required,desc=one of your watch lists"`
}

// Item is one task or thread on a list.
type Item struct {
	CardID       int64   `json:"card_id,string" mcp:"desc=the task or thread"`
	CardType     string  `json:"card_type" mcp:"desc=task or comm (a thread)"`
	Title        string  `json:"title" mcp:"desc=its title"`
	TaskID       int64   `json:"task_id,string" mcp:"desc=for a thread on a task, the task (where it opens); 0 otherwise"`
	ProjectID    int64   `json:"project_id,string" mcp:"desc=its project"`
	ProjectTitle string  `json:"project_title" mcp:"desc=its project's name"`
	Status       string  `json:"status" mcp:"desc=its status (a thread's comm status)"`
	Phase        string  `json:"phase" mcp:"desc=the status's phase: triage, active or terminal"`
	SortOrder    float64 `json:"sort_order" mcp:"desc=its place on the list (lower first)"`
	AddedAt      string  `json:"added_at" mcp:"desc=RFC 3339 time it was put on the list"`
}

// ItemsOutput wraps the items.
type ItemsOutput struct {
	Items []Item `json:"items" mcp:"desc=what is on the list, in its order; only cards you can see"`
}

// MoveInput sets an item's place.
type MoveInput struct {
	WatchListID int64   `json:"watch_list_id,string" mcp:"required,desc=one of your watch lists"`
	CardID      int64   `json:"card_id,string" mcp:"required,desc=a task or thread on it"`
	SortOrder   float64 `json:"sort_order" mcp:"required,desc=the new place: between its new neighbours' sort_order (lower first)"`
}

// MoveOutput echoes the place.
type MoveOutput struct {
	SortOrder float64 `json:"sort_order" mcp:"desc=the item's sort_order"`
}

// Register wires watch_list.* and watch.*. Anyone signed in keeps their own
// lists; the SQL functions check the owner (watch_list_owned_by) and, for a
// card, that the caller can see it — there is no project anchor, since a
// list spans every project its owner sees.
func Register(_ *store.Pool) {
	own := []string{reg.RoleAuthenticated}
	reg.Register(reg.Handler{
		Endpoint: "watch_list", Action: "list",
		Doc:          "List YOUR watch lists (bookmark lists of tasks and threads): name, symbol, description and how many items each holds; with card_id, whether that card is on each. Your first call makes your Stars (★) list.",
		InputType:    reflect.TypeFor[ListInput](),
		OutputType:   reflect.TypeFor[ListOutput](),
		AllowedRoles: own,
		// Not IsRead: the first call writes the Stars list.
		SQLFunc: "watch_list_list_batch",
	})
	reg.Register(reg.Handler{
		Endpoint: "watch_list", Action: "set",
		Doc:          "Create (id omitted) or update one of YOUR watch lists: name (1–60 characters), symbol (an emoji or a character; default ★) and description.",
		InputType:    reflect.TypeFor[SetInput](),
		OutputType:   reflect.TypeFor[IDOutput](),
		AllowedRoles: own,
		SQLFunc:      "watch_list_set_batch",
	})
	reg.Register(reg.Handler{
		Endpoint: "watch_list", Action: "delete",
		Doc:          "Delete one of YOUR watch lists; the tasks and threads on it are untouched.",
		InputType:    reflect.TypeFor[DeleteInput](),
		OutputType:   reflect.TypeFor[IDOutput](),
		AllowedRoles: own,
		SQLFunc:      "watch_list_delete_batch",
	})
	reg.Register(reg.Handler{
		Endpoint: "watch", Action: "set",
		Doc:          "Put a task or thread you can see on one of YOUR watch lists (it goes to the top), or take it off (on=false).",
		InputType:    reflect.TypeFor[SetEntryInput](),
		OutputType:   reflect.TypeFor[SetEntryOutput](),
		AllowedRoles: own,
		SQLFunc:      "watch_set_batch",
	})
	reg.Register(reg.Handler{
		Endpoint: "watch", Action: "items",
		Doc:          "What is on one of YOUR watch lists, in its order: each task or thread with its title, project and status. To filter a screen instead, use the card filter leaf {attr: watch_list, op: in, values: ['@me']} (any of your lists) or list ids.",
		InputType:    reflect.TypeFor[ItemsInput](),
		OutputType:   reflect.TypeFor[ItemsOutput](),
		AllowedRoles: own, IsRead: true,
		SQLFunc: "watch_items_batch",
	})
	reg.Register(reg.Handler{
		Endpoint: "watch", Action: "move",
		Doc:          "Move an item on one of YOUR watch lists: give it a sort_order between its new neighbours' (lower first).",
		InputType:    reflect.TypeFor[MoveInput](),
		OutputType:   reflect.TypeFor[MoveOutput](),
		AllowedRoles: own,
		SQLFunc:      "watch_move_batch",
	})
}
