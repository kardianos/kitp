// Package calendar serves per-person calendar feeds
// (docs/MAIL_INTAKE_AND_CALENDARS.md §8): a calendar card holds a card
// filter and a window of days; each of its secret URLs
// (/api/v1/calendar/<token>.ics) returns the owner's visible tasks due in
// that window as all-day events, built by a live query on every fetch.
package calendar

import (
	"reflect"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// ListInput is empty: a person lists their own calendars.
type ListInput struct{}

// URLRow is one secret URL. The token is never stored; hint is its first
// characters.
type URLRow struct {
	ID          int64  `json:"id,string" mcp:"desc=URL id"`
	Comment     string `json:"comment" mcp:"desc=where it is used, e.g. 'iPhone'"`
	Hint        string `json:"hint" mcp:"desc=the token's first 6 characters"`
	CreatedAt   string `json:"created_at" mcp:"desc=RFC 3339"`
	LastUsedAt  string `json:"last_used_at" mcp:"desc=RFC 3339 time of the last fetch; empty when never fetched"`
	LastClient  string `json:"last_client" mcp:"desc=the User-Agent of the last fetch (which calendar app)"`
	LastError   string `json:"last_error" mcp:"desc=why the last fetch failed; empty when fine"`
	LastErrorAt string `json:"last_error_at" mcp:"desc=RFC 3339; empty when none"`
}

// Row is one calendar.
type Row struct {
	ID         int64    `json:"id,string" mcp:"desc=calendar card id"`
	Title      string   `json:"title" mcp:"desc=the calendar's name (what calendar apps show)"`
	Predicate  string   `json:"predicate" mcp:"desc=card filter JSON (screen-filter shape; '@me' = you); empty = every task you can see"`
	PastDays   int      `json:"past_days" mcp:"desc=days back from today"`
	FutureDays int      `json:"future_days" mcp:"desc=days ahead of today"`
	URLs       []URLRow `json:"urls" mcp:"desc=the calendar's secret URLs"`
}

// ListOutput wraps the calendars.
type ListOutput struct {
	Calendars []Row `json:"calendars" mcp:"desc=your calendars"`
}

// SetInput creates (ID 0) or updates a calendar; absent fields are left
// alone on update.
type SetInput struct {
	ID         int64   `json:"id,string,omitempty" mcp:"desc=omit or 0 to create"`
	Title      *string `json:"title,omitempty" mcp:"desc=name (required to create)"`
	Predicate  *string `json:"predicate,omitempty" mcp:"desc=card filter JSON ('@me' = you); empty = every task you can see"`
	PastDays   *int    `json:"past_days,omitempty" mcp:"desc=0–3650; default 30"`
	FutureDays *int    `json:"future_days,omitempty" mcp:"desc=0–3650; default 365"`
}

// IDOutput names a calendar or URL.
type IDOutput struct {
	ID int64 `json:"id,string" mcp:"desc=id"`
}

// DeleteInput deletes a calendar.
type DeleteInput struct {
	ID int64 `json:"id,string" mcp:"required,desc=calendar id"`
}

// URLCreateInput adds a URL.
type URLCreateInput struct {
	CalendarID int64  `json:"calendar_id,string" mcp:"required,desc=calendar id"`
	Comment    string `json:"comment,omitempty" mcp:"desc=where it will be used, e.g. 'Google Calendar'"`
}

// URLCreateOutput carries the secret token — shown ONCE.
type URLCreateOutput struct {
	ID    int64  `json:"id,string" mcp:"desc=URL id"`
	Token string `json:"token" mcp:"desc=the secret: subscribe to <kitp>/api/v1/calendar/<token>.ics; not shown again"`
	Hint  string `json:"hint" mcp:"desc=the token's first 6 characters"`
}

// URLUpdateInput changes a URL's comment.
type URLUpdateInput struct {
	ID      int64  `json:"id,string" mcp:"required,desc=URL id"`
	Comment string `json:"comment" mcp:"desc=new comment"`
}

// URLDeleteInput revokes a URL.
type URLDeleteInput struct {
	ID int64 `json:"id,string" mcp:"required,desc=URL id"`
}

// Register wires calendar.* and calendar_url.*. Anyone signed in manages
// their own calendars; the SQL functions check the owner (calendar_owned_by).
func Register(_ *store.Pool) {
	own := []string{reg.RoleAuthenticated}
	reg.Register(reg.Handler{
		Endpoint: "calendar", Action: "list",
		Doc:          "List YOUR calendar feeds: each one's filter, window and secret URLs (with when and by which app each was last fetched).",
		InputType:    reflect.TypeFor[ListInput](),
		OutputType:   reflect.TypeFor[ListOutput](),
		AllowedRoles: own, IsRead: true,
		SQLFunc: "calendar_list_batch",
	})
	reg.Register(reg.Handler{
		Endpoint: "calendar", Action: "set",
		Doc:          "Create (id omitted) or update one of YOUR calendar feeds: title, card filter ('@me' = you; empty = every task you can see) and window (past_days / future_days, 0–3650, defaults 30 / 365). Tasks with a due date in the window become all-day events.",
		InputType:    reflect.TypeFor[SetInput](),
		OutputType:   reflect.TypeFor[IDOutput](),
		AllowedRoles: own,
		SQLFunc:      "calendar_set_batch",
	})
	reg.Register(reg.Handler{
		Endpoint: "calendar", Action: "delete",
		Doc:          "Delete one of YOUR calendars; its URLs stop working.",
		InputType:    reflect.TypeFor[DeleteInput](),
		OutputType:   reflect.TypeFor[IDOutput](),
		AllowedRoles: own,
		SQLFunc:      "calendar_delete_batch",
	})
	reg.Register(reg.Handler{
		Endpoint: "calendar_url", Action: "create",
		Doc:          "Add a secret URL to one of YOUR calendars, with a comment saying where it's used. Returns the token once: subscribe to /api/v1/calendar/<token>.ics. Calendar services fetch it from their own servers, so task titles go to them.",
		InputType:    reflect.TypeFor[URLCreateInput](),
		OutputType:   reflect.TypeFor[URLCreateOutput](),
		AllowedRoles: own,
		SQLFunc:      "calendar_url_create_batch",
	})
	reg.Register(reg.Handler{
		Endpoint: "calendar_url", Action: "update",
		Doc:          "Change a calendar URL's comment.",
		InputType:    reflect.TypeFor[URLUpdateInput](),
		OutputType:   reflect.TypeFor[IDOutput](),
		AllowedRoles: own,
		SQLFunc:      "calendar_url_update_batch",
	})
	reg.Register(reg.Handler{
		Endpoint: "calendar_url", Action: "delete",
		Doc:          "Revoke a calendar URL; it stops working at once.",
		InputType:    reflect.TypeFor[URLDeleteInput](),
		OutputType:   reflect.TypeFor[IDOutput](),
		AllowedRoles: own,
		SQLFunc:      "calendar_url_delete_batch",
	})
}
