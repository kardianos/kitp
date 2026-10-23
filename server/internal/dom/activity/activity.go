// Package activity provides activity.select — paged, chronological
// activity for a card, with comments inlined via a join to comment_body.
package activity

import (
	"encoding/json"
	"reflect"
	"time"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// SelectInput selects activity with optional cursor paging.
//
// CardID is optional: when zero/null the handler returns activity across
// every card the actor can see (cross-card mode). When non-zero, only
// rows for that card are returned. BeforeActivityID is exclusive: the
// page contains rows with id < cursor. ActorIDs / ExcludeActorIDs / Kinds /
// CardTypes / Q narrow the rows (AND-joined; an empty list is no filter);
// Facets asks for per-actor / kind / card-type counts over the window
// without them.
type SelectInput struct {
	CardID           int64    `json:"card_id,string,omitempty" mcp:"desc=card whose activity is being read; omit for cross-card mode"`
	ProjectID        int64    `json:"project_id,string,omitempty" mcp:"desc=project scope; when set, only activity for cards within that project (the project or a descendant) is returned"`
	Limit            *int     `json:"limit,omitempty" mcp:"desc=optional row cap; defaults to 200"`
	BeforeActivityID *int64   `json:"before_activity_id,string,omitempty" mcp:"desc=cursor; only return activity rows with id < this"`
	FromDate         string   `json:"from_date,omitempty" mcp:"desc=inclusive lower bound on created_at, ISO date YYYY-MM-DD"`
	ToDate           string   `json:"to_date,omitempty" mcp:"desc=inclusive upper bound on created_at, ISO date YYYY-MM-DD"`
	ActorIDs         []string `json:"actor_ids,omitempty" mcp:"desc=only rows by these user ids"`
	ExcludeActorIDs  []string `json:"exclude_actor_ids,omitempty" mcp:"desc=leave out rows by these user ids (e.g. your own changes)"`
	Kinds            []string `json:"kinds,omitempty" mcp:"desc=only rows of these kinds (card_create, attr_update, comment, tag_apply, attachment_create, ...)"`
	CardTypes        []string `json:"card_types,omitempty" mcp:"desc=only rows on cards of these card types (task, link, comm, reply_body, ...)"`
	Q                string   `json:"q,omitempty" mcp:"desc=text search over the owning card's title or #id, the card's own title, and comment bodies"`
	Facets           bool     `json:"facets,omitempty" mcp:"desc=also return per-actor / kind / card-type counts for the window (ignoring actor_ids / exclude_actor_ids / kinds / card_types / q / the cursor)"`
}

// Row is one denormalized activity row, carrying the names and titles a
// client needs to render it. CardID is set so cross-card callers can
// route per-row links back to a card.
type Row struct {
	ID            int64           `json:"id,string" mcp:"desc=activity row id"`
	CardID        int64           `json:"card_id,string" mcp:"desc=card the activity belongs to"`
	CardType      string          `json:"card_type" mcp:"desc=card type of card_id"`
	CardTitle     string          `json:"card_title" mcp:"desc=title of card_id (a reply's subject); empty when it has none"`
	NavCardID     int64           `json:"nav_card_id,string" mcp:"desc=card to open for this row: the owning task for a comm / link / reply, else card_id"`
	NavCardType   string          `json:"nav_card_type" mcp:"desc=card type of nav_card_id"`
	NavTitle      string          `json:"nav_title" mcp:"desc=title of nav_card_id"`
	Kind          string          `json:"kind" mcp:"desc=activity kind (card_create, attr_update, comment, ...)"`
	AttributeName *string         `json:"attribute_name,omitempty" mcp:"desc=attribute name when kind is attr_update"`
	ValueType     *string         `json:"value_type,omitempty" mcp:"desc=the attribute's value type (text, card_ref, card_ref[], ...)"`
	ValueOld      json.RawMessage `json:"value_old,omitempty" mcp:"desc=previous JSON value of the attribute, if any"`
	ValueNew      json.RawMessage `json:"value_new,omitempty" mcp:"desc=new JSON value of the attribute, if any"`
	Refs          json.RawMessage `json:"refs,omitempty" mcp:"desc=object of card id to title for every card a card_ref value or move target names"`
	CommentBody   *string         `json:"comment_body,omitempty" mcp:"desc=resolved comment body when kind is comment"`
	ActorID       int64           `json:"actor_id,string" mcp:"desc=user id that made the change"`
	ActorName     string          `json:"actor_name" mcp:"desc=who made the change; an agent is named with its owner, e.g. 'claude (for Daniel)'"`
	CreatedAt     time.Time       `json:"created_at" mcp:"desc=activity timestamp"`
}

// SelectOutput is the per-input reply.
type SelectOutput struct {
	Rows   []Row   `json:"rows" mcp:"desc=matching activity rows in chronological order"`
	Facets *Facets `json:"facets,omitempty" mcp:"desc=counts over the window when facets was requested"`
}

// Facets counts the window's rows (project / card / dates / visibility,
// before the actor / kind / card-type / text filters and the cursor).
type Facets struct {
	Total     int             `json:"total" mcp:"desc=rows in the window"`
	Actors    []ActorFacet    `json:"actors" mcp:"desc=rows per actor, most first"`
	Kinds     []KindFacet     `json:"kinds" mcp:"desc=rows per kind, most first"`
	CardTypes []CardTypeFacet `json:"card_types" mcp:"desc=rows per card type, most first"`
}

// ActorFacet is one actor's row count.
type ActorFacet struct {
	ID    int64  `json:"id,string" mcp:"desc=user id"`
	Name  string `json:"name" mcp:"desc=user label (agents name their owner)"`
	Count int    `json:"count" mcp:"desc=rows by this user"`
}

// KindFacet is one kind's row count.
type KindFacet struct {
	Kind  string `json:"kind" mcp:"desc=activity kind"`
	Count int    `json:"count" mcp:"desc=rows of this kind"`
}

// CardTypeFacet is one card type's row count.
type CardTypeFacet struct {
	CardType string `json:"card_type" mcp:"desc=card type name"`
	Count    int    `json:"count" mcp:"desc=rows on cards of this type"`
}

// ActorsInput asks for the accounts that can make changes in a project.
type ActorsInput struct {
	ProjectID int64    `json:"project_id,string" mcp:"required,desc=project whose accounts to list"`
	IDs       []string `json:"ids,omitempty" mcp:"desc=user ids to name as well, e.g. the ones a saved filter already holds"`
}

// Actor is one account, named the way activity rows name it.
type Actor struct {
	ID      int64  `json:"id,string" mcp:"desc=user id"`
	Name    string `json:"name" mcp:"desc=display name; an agent is named with its owner, e.g. 'claude (for Daniel)'"`
	IsAgent bool   `json:"is_agent" mcp:"desc=true for an agent account"`
	// PersonID is the account's linked person card, for conditions on
	// people (an approval request asks people); nil for an agent.
	PersonID *int64 `json:"person_id,string,omitempty" mcp:"desc=the account's person card id; absent for an agent"`
}

// ActorsOutput lists the accounts, people first, then agents, each by name.
type ActorsOutput struct {
	Rows []Actor `json:"rows" mcp:"desc=the accounts"`
}

// PollInput is the cheap "is there newer activity?" probe for the task-detail
// background poll: a task id + the latest activity id the client already has.
type PollInput struct {
	TaskID          int64 `json:"task_id,string" mcp:"required,desc=task card id to poll (spans the task + its comm child cards)"`
	SinceActivityID int64 `json:"since_activity_id,string,omitempty" mcp:"desc=latest activity id the client has; new_count counts rows with id > this (0/omitted = count all)"`
}

// PollOutput reports the latest activity id across the task + its comm children
// and how many are newer than SinceActivityID.
type PollOutput struct {
	LatestActivityID int64 `json:"latest_activity_id,string" mcp:"desc=max activity id across the task + its comm child cards (0 when none / not visible)"`
	NewCount         int   `json:"new_count" mcp:"desc=count of activity rows newer than since_activity_id"`
}

// Register installs the handlers.
func Register(p *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "activity",
		Action:       "select",
		Doc:          "Read paged activity for one card (chronological) or a project (newest first), with actor names, card titles and card_ref labels resolved; comments include their body inline. Filter by actor / kind / card type / text; ask for facets to get counts per option.",
		InputType:    reflect.TypeFor[SelectInput](),
		OutputType:   reflect.TypeFor[SelectOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		IsRead:       true,
		// Unified handler — body lives in
		// db/schema/functions/activity_select_batch.sql.
		SQLFunc: "activity_select_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "activity",
		Action:       "actors",
		Doc:          "List the accounts that can make changes in a project (role holders and the agents they own), named the way activity rows name them — for picking whose changes an activity filter includes or excludes. Pass ids to name accounts a saved filter already holds.",
		InputType:    reflect.TypeFor[ActorsInput](),
		OutputType:   reflect.TypeFor[ActorsOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		IsRead:       true,
		// Unified handler — body lives in
		// db/schema/functions/activity_actors_batch.sql.
		SQLFunc: "activity_actors_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "activity",
		Action:       "poll",
		Doc:          "Cheap newer-activity check for the task-detail background poll: latest activity id + new_count across the task and its comm child cards.",
		InputType:    reflect.TypeFor[PollInput](),
		OutputType:   reflect.TypeFor[PollOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		IsRead:       true,
		// Unified handler — body lives in
		// db/schema/functions/activity_poll_batch.sql.
		SQLFunc: "activity_poll_batch",
	})
	_ = p
}
