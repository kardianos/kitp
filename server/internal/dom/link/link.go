// Package link exposes task LINKS — code changes (a Gerrit CL, a pull
// request), issues, or any URL worth keeping next to the work. A link is
// a `link` card parented under its task carrying title / link_url /
// link_kind / link_state; see db/schema/functions/link_set_batch.sql.
//
// Three dispatcher endpoints, shared by the task-detail UI, MCP and the
// forge hook:
//   - link.set    — idempotent upsert keyed on (task_id, url): the first
//     call creates the link, every repeat PATCHes its title / kind /
//     state. A forge re-reporting an unchanged CL is a no-op.
//   - link.list   — the live links on one task.
//   - link.delete — soft-delete one link.
//
// Plus one HTTP route outside the batch envelope (http.go): POST
// /api/v1/links, bearer-token authenticated, so a code forge can link one
// URL to every task a change mentions with a single request.
//
// Authz: link.set / link.delete gate on card.update of the PARENT TASK —
// the same gate attachments use — so anyone who can edit a task can link
// to it, and a forge's agent account needs exactly a worker grant on the
// projects whose tasks its changes reference. link.list is readable by
// any authenticated user; the SQL applies the task's visibility.
package link

import (
	"context"
	"errors"
	"fmt"
	"reflect"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

// SetInput is the wire payload for link.set. Title / Kind / State are
// pointers so omit (leave unchanged) and clear ("") stay distinguishable
// on the JSONB the dispatcher hands the SQL function.
type SetInput struct {
	TaskID int64   `json:"task_id,string" mcp:"required,desc=task card id to link from"`
	URL    string  `json:"url" mcp:"required,desc=absolute http(s) URL of the code change / issue / page. It is the link's identity on the task: linking the same URL again updates the existing link instead of adding a second one"`
	Title  *string `json:"title,omitempty" mcp:"desc=display text; defaults to the url when the link is created; omit to leave unchanged"`
	Kind   *string `json:"kind,omitempty" mcp:"desc=short slug naming the source, e.g. 'gerrit', 'github', 'issue' (letters, digits, - or _); '' clears; omit to leave unchanged"`
	State  *string `json:"state,omitempty" mcp:"desc=short slug for the source's status, e.g. 'open', 'reviewed', 'approved', 'merged', 'abandoned'; '' clears; omit to leave unchanged"`
}

// SetOutput surfaces the link card id and what the call did.
type SetOutput struct {
	LinkID  int64 `json:"link_id,string" mcp:"desc=id of the created or updated link card"`
	Created bool  `json:"created" mcp:"desc=true when this call created the link; false when the URL was already linked to the task"`
	Changed bool  `json:"changed" mcp:"desc=true when anything was written (the link was created, or its title / kind / state changed)"`
}

// ListInput names the task whose links to list.
type ListInput struct {
	TaskID int64 `json:"task_id,string" mcp:"required,desc=task card id whose links to list"`
}

// Row is one live link on a task.
type Row struct {
	ID          int64  `json:"id,string" mcp:"desc=link card id"`
	TaskID      int64  `json:"task_id,string" mcp:"desc=task the link hangs off"`
	URL         string `json:"url" mcp:"desc=the linked URL"`
	Title       string `json:"title" mcp:"desc=display text (the url when none was given)"`
	Kind        string `json:"kind" mcp:"desc=source slug, e.g. 'gerrit'; empty for a plain URL"`
	State       string `json:"state" mcp:"desc=source status slug, e.g. 'merged'; empty when the source reports none"`
	CreatedAt   string `json:"created_at" mcp:"desc=RFC3339 time the link was added"`
	UpdatedAt   string `json:"updated_at" mcp:"desc=RFC3339 time of the link's last change (title / kind / state)"`
	CreatedByID int64  `json:"created_by_id,string" mcp:"desc=user_account that added the link (a person, or a forge's agent account)"`
	CreatedBy   string `json:"created_by" mcp:"desc=display name of that account"`
}

// ListOutput wraps the rows in a stable envelope.
type ListOutput struct {
	Rows []Row `json:"rows" mcp:"desc=live links on the task, oldest first"`
}

// DeleteInput names one link to remove.
type DeleteInput struct {
	ID int64 `json:"id,string" mcp:"required,desc=link card id to delete (from link.list)"`
}

// DeleteOutput acknowledges the soft-delete.
type DeleteOutput struct {
	Deleted bool `json:"deleted" mcp:"desc=true once the link is removed"`
}

// Register installs the link.* dispatcher endpoints.
func Register(_ *store.Pool) {
	writers := []string{"worker", "manager", "admin"}
	reg.Register(reg.Handler{
		Endpoint:     "link",
		Action:       "set",
		Doc:          "Link a URL — a code change (Gerrit CL, pull request), an issue, any page — to a task, or update an existing link. Idempotent: the URL is the link's identity on the task, so linking it again PATCHes the same link (title / kind / state) instead of adding a duplicate, and re-sending unchanged values writes nothing. kind / state are short slugs (e.g. kind 'gerrit', state 'open' | 'reviewed' | 'approved' | 'merged' | 'abandoned'). Requires edit rights on the task.",
		InputType:    reflect.TypeFor[SetInput](),
		OutputType:   reflect.TypeFor[SetOutput](),
		AllowedRoles: writers,
		// Gate on the parent TASK's card.update (like attachment.create):
		// the card_type is the task's, and the per-row scope pass walks
		// task → project from task_id.
		ProcessName: "card.update",
		CardTypeID: func(ctx context.Context, pool reg.ValidationPool, in any) (int64, error) {
			return schema.CardTypeIDByCardID(ctx, pool, in.(SetInput).TaskID)
		},
		ScopeCardID: func(_ context.Context, _ reg.ValidationPool, in any) (int64, error) {
			return in.(SetInput).TaskID, nil
		},
		// Unified handler — body lives in
		// db/schema/functions/link_set_batch.sql.
		SQLFunc: "link_set_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "link",
		Action:       "list",
		Doc:          "List the links on a task (oldest first): url, title, kind / state slugs, when it was added and last changed, and who added it.",
		InputType:    reflect.TypeFor[ListInput](),
		OutputType:   reflect.TypeFor[ListOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		IsRead:       true,
		// Unified handler — body lives in
		// db/schema/functions/link_list_batch.sql.
		SQLFunc: "link_list_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "link",
		Action:       "delete",
		Doc:          "Remove a link from its task (id from link.list). Requires edit rights on the task. Not sticky: linking the same URL again adds it back.",
		InputType:    reflect.TypeFor[DeleteInput](),
		OutputType:   reflect.TypeFor[DeleteOutput](),
		AllowedRoles: writers,
		ProcessName:  "card.update",
		// Input carries only the link id: dereference link → parent task
		// for the grant's card_type; the scope pass walks link → task →
		// project on its own.
		CardTypeID: parentCardTypeOfLink,
		ScopeCardID: func(_ context.Context, _ reg.ValidationPool, in any) (int64, error) {
			return in.(DeleteInput).ID, nil
		},
		// Unified handler — body lives in
		// db/schema/functions/link_delete_batch.sql.
		SQLFunc: "link_delete_batch",
	})
}

// parentCardTypeOfLink resolves the card_type of the link's parent task so
// link.delete is gated on (task, card.update) like link.set. Returns 0
// (skip the grant check) when the id doesn't resolve; the SQL function
// then reports link_not_found.
func parentCardTypeOfLink(ctx context.Context, pool reg.ValidationPool, in any) (int64, error) {
	b := named.New()
	b.Set("id", in.(DeleteInput).ID)
	sql, args, err := b.Compile(`
		SELECT p.card_type_id
		FROM card l
		JOIN card p ON p.id = l.parent_card_id
		WHERE l.id = :id
	`)
	if err != nil {
		return 0, fmt.Errorf("link.delete: compile: %w", err)
	}
	var ctID int64
	if err := pool.QueryRow(ctx, sql, args...).Scan(&ctID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, nil
		}
		return 0, fmt.Errorf("link.delete: card_type lookup: %w", err)
	}
	return ctID, nil
}
