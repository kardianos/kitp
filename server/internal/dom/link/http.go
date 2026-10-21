package link

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/reg"
)

// HTTPConfig wires the forge hook route.
type HTTPConfig struct {
	// Dispatcher runs link.set for each task, as the bearer token's actor.
	Dispatcher *api.Server
}

// maxHookBytes caps the hook body. A link is a URL plus a few short
// strings; 64 KiB is far beyond any legitimate payload.
const maxHookBytes = 64 << 10

// maxHookTasks caps how many tasks one hook call may link — a change
// description naming more than this is almost certainly a mistake.
const maxHookTasks = 50

// HookInput is the body of POST /api/v1/links: ONE URL linked to every
// task in TaskIDs — the shape a code change has (one CL / pull request
// that mentions several tasks). Title / Kind / State follow link.set's
// PATCH semantics (absent = unchanged, "" = clear).
type HookInput struct {
	TaskIDs reg.IDs `json:"task_ids"`
	URL     string  `json:"url"`
	Title   *string `json:"title,omitempty"`
	Kind    *string `json:"kind,omitempty"`
	State   *string `json:"state,omitempty"`
}

// HookResult is the outcome for one task. Each task is linked in its own
// transaction, so a mistyped task id in a commit message fails just that
// row (OK=false + Code / Message) without blocking the others.
type HookResult struct {
	TaskID  int64  `json:"task_id,string"`
	OK      bool   `json:"ok"`
	LinkID  int64  `json:"link_id,string,omitempty"`
	Created bool   `json:"created"`
	Changed bool   `json:"changed"`
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

// HookOutput is the response body: one result per distinct task id, in
// request order.
type HookOutput struct {
	Results []HookResult `json:"results"`
}

// Mount registers POST /api/v1/links on the bearer tier: a code forge
// (the Gerrit plugin in integrations/gerrit) authenticates with a
// user_token minted for its agent account and links a change to the
// tasks it mentions. Repeats are idempotent — link.set keys the link on
// (task, url), so re-delivering an event (or a later event carrying a
// new state) updates the one link rather than adding another.
//
// The route also admits LINKS-ONLY tokens (auth.TokenScopeLinks) — the
// credential a forge should hold: it can link changes to tasks and
// nothing else (MCP and every other bearer route refuse it).
func Mount(rt *api.Router, cfg HTTPConfig) {
	rt.BearerScoped("POST /api/v1/links", auth.TokenScopeLinks, func(ctx context.Context, w http.ResponseWriter, r *http.Request, _ *auth.UserCtx) error {
		return handleHook(ctx, w, r, cfg)
	})
}

func handleHook(ctx context.Context, w http.ResponseWriter, r *http.Request, cfg HTTPConfig) error {
	if cfg.Dispatcher == nil {
		return api.Internal(errors.New("link hook: dispatcher not configured"))
	}
	defer r.Body.Close()
	dec := json.NewDecoder(io.LimitReader(r.Body, maxHookBytes))
	dec.DisallowUnknownFields()
	var in HookInput
	if err := dec.Decode(&in); err != nil {
		return api.BadRequest("bad_request", "body must be a JSON object: {task_ids, url, title?, kind?, state?}")
	}
	taskIDs := distinctPositive(in.TaskIDs)
	if len(taskIDs) == 0 {
		return api.BadRequest("validation", "task_ids must name at least one task")
	}
	if len(taskIDs) > maxHookTasks {
		return api.BadRequest("validation", fmt.Sprintf("task_ids may name at most %d tasks", maxHookTasks))
	}
	if in.URL == "" {
		return api.BadRequest("validation", "url is required")
	}

	out := HookOutput{Results: make([]HookResult, 0, len(taskIDs))}
	for _, taskID := range taskIDs {
		res := HookResult{TaskID: taskID}
		var set SetOutput
		err := cfg.Dispatcher.DispatchOne(ctx, "link", "set", SetInput{
			TaskID: taskID,
			URL:    in.URL,
			Title:  in.Title,
			Kind:   in.Kind,
			State:  in.State,
		}, &set)
		var he *reg.HandlerError
		switch {
		case err == nil:
			res.OK = true
			res.LinkID = set.LinkID
			res.Created = set.Created
			res.Changed = set.Changed
		case errors.As(err, &he):
			res.Code = he.Code
			res.Message = he.Message
		default:
			return api.Internal(fmt.Errorf("link hook: task %d: %w", taskID, err))
		}
		out.Results = append(out.Results, res)
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(out); err != nil {
		// Status + headers are already on the wire; returning err would
		// make the router attempt a second status. The links are written.
		return nil
	}
	return nil
}

// distinctPositive drops non-positive ids and repeats, keeping first-seen
// order (a commit message may mention the same task twice).
func distinctPositive(ids []int64) []int64 {
	seen := make(map[int64]bool, len(ids))
	out := make([]int64, 0, len(ids))
	for _, id := range ids {
		if id <= 0 || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}
