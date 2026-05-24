// Package proc exposes meta-introspection over the registered handler
// catalogue. It exists to keep the MCP tool surface small for clients
// (LLMs especially) with tight per-conversation tool budgets — instead
// of listing every endpoint up front, an MCP server can advertise just
// proc.search and let the model discover + call the rest on demand.
//
// One JSON dispatcher endpoint:
//
//   - proc.search — return matching handler descriptors (name, doc,
//     input/output JSON Schemas). Filter by query (substring across
//     name/doc), exact endpoint, exact action, or `all=true` to dump
//     the entire catalogue. With no filters, the result is empty —
//     callers must opt into a return shape.
//
// proc.search reads the in-memory handler registry; it never touches
// the database or the dispatcher tx. Schema generation uses the same
// internal/mcp/schema.go path the MCP `tools/list` response does, so a
// client sees exactly the same input/output shapes either way.
package proc

import (
	"context"
	"reflect"
	"slices"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/mcp"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// SearchInput filters the catalogue. Empty struct + All=false returns
// zero rows — the caller must declare intent. This keeps an LLM that
// fires `proc.search({})` from accidentally pulling the entire schema
// catalogue into context.
//
// By default the result is further trimmed to handlers the calling
// user can actually invoke (see role gate in api/role_gate.go); the
// LLM use case prefers a smaller, immediately-callable surface over
// a "what could I do with admin?" full listing. Set
// `include_unavailable: true` when an admin UI wants every row
// regardless of caller's roles.
type SearchInput struct {
	// Query is a case-insensitive substring matched against tool name,
	// endpoint, action, and doc. Empty disables the substring filter.
	Query string `json:"query,omitempty" mcp:"desc=case-insensitive substring match against name/endpoint/action/doc"`
	// Endpoint, when set, restricts the result to handlers under this
	// endpoint (exact match). Combined with Action it yields a single
	// row, matching reg.Lookup's contract.
	Endpoint string `json:"endpoint,omitempty" mcp:"desc=filter to handlers with this exact endpoint"`
	// Action, when set, restricts to handlers with this exact action.
	Action string `json:"action,omitempty" mcp:"desc=filter to handlers with this exact action"`
	// All=true returns every registered handler, ignoring the other
	// filter fields. Use it sparingly — full catalogue dumps are
	// large.
	All bool `json:"all,omitempty" mcp:"desc=true to return every registered handler"`
	// IncludeUnavailable=true disables the per-caller role filter so
	// the response includes handlers the current user CANNOT actually
	// invoke. Defaults false; useful for admin UIs that want to render
	// "you'd need role X to call this" hints.
	IncludeUnavailable bool `json:"include_unavailable,omitempty" mcp:"desc=true to include handlers the calling user lacks the role to invoke"`
}

// HandlerDescriptor is the shape one search result takes. Mirrors what
// the MCP layer puts on the wire so an MCP client gets a familiar
// payload either way.
type HandlerDescriptor struct {
	Name         string      `json:"name" mcp:"desc=tool name in <endpoint>__<action> form"`
	Endpoint     string      `json:"endpoint" mcp:"desc=dispatcher endpoint (e.g. card)"`
	Action       string      `json:"action" mcp:"desc=dispatcher action (e.g. insert)"`
	Doc          string      `json:"doc,omitempty" mcp:"desc=human description of the handler"`
	AllowedRoles []string    `json:"allowed_roles,omitempty" mcp:"desc=role names that may invoke this handler"`
	InputSchema  *mcp.Schema `json:"input_schema,omitempty" mcp:"desc=JSON Schema describing the handler's input"`
	OutputSchema *mcp.Schema `json:"output_schema,omitempty" mcp:"desc=JSON Schema describing the handler's output"`
}

// SearchOutput wraps the descriptors. We always emit a non-nil slice
// so the wire shape is stable when the result is empty (no `null`).
type SearchOutput struct {
	Handlers []HandlerDescriptor `json:"handlers" mcp:"desc=matching handlers, sorted by name"`
}

// Register installs proc.search. The pool is needed so the handler
// can resolve the caller's roles for the default callable-only filter;
// pass nil to skip role-aware filtering (used in tests where the
// fixture registry isn't backed by a real DB — IncludeUnavailable
// behaves as if true in that case).
func Register(p *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "proc",
		Action:       "search",
		Doc:          "Search the registered handler catalogue. Defaults to handlers the caller can actually invoke; pass include_unavailable=true to see every match regardless of role. Combine with {all:true} or {query, endpoint, action} filters.",
		InputType:    reflect.TypeFor[SearchInput](),
		OutputType:   reflect.TypeFor[SearchOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Run:          runSearch(p),
	})
}

// runSearch reads the registry snapshot and applies the filter. We
// rebuild from reg.All() on every call rather than cache: registrations
// are immutable post-startup and reg.All() returns ~35 rows today, so
// the cost is trivial.
//
// Role-aware filtering loads the caller's role set once per Run via
// auth.LoadUserRoles and reuses it across every input slot in the
// dispatcher's coalesced batch.
func runSearch(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		all := reg.All()

		// Lazy-load the role set: Tests + IncludeUnavailable=true skip
		// it entirely; a typical "give me everything I can call" hits
		// it once for the whole batch.
		var (
			rolesLoaded bool
			roles       map[string]struct{}
			rolesErr    error
		)
		loadRoles := func() (map[string]struct{}, error) {
			if rolesLoaded {
				return roles, rolesErr
			}
			rolesLoaded = true
			if p == nil {
				roles = nil
				return nil, nil
			}
			user, ok := auth.FromContext(ctx)
			if !ok || user == nil || user.ID == 0 {
				roles = map[string]struct{}{}
				return roles, nil
			}
			names, err := auth.LoadUserRoles(ctx, p.P, user.ID)
			if err != nil {
				rolesErr = err
				return nil, err
			}
			roles = make(map[string]struct{}, len(names))
			for _, n := range names {
				roles[n] = struct{}{}
			}
			return roles, nil
		}

		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(SearchInput)
			matched := filterHandlers(all, in)

			// Role-aware narrowing. Skipped when the caller opted into
			// the full listing OR when no pool is wired (tests).
			if !in.IncludeUnavailable && p != nil {
				rs, err := loadRoles()
				if err != nil {
					return nil, err
				}
				narrow := matched[:0]
				for _, h := range matched {
					if callerCanInvoke(ctx, h, rs) {
						narrow = append(narrow, h)
					}
				}
				matched = narrow
			}

			descriptors := make([]HandlerDescriptor, 0, len(matched))
			for _, h := range matched {
				descriptors = append(descriptors, descriptorFor(h))
			}
			// Sort for stability so MCP clients can rely on order across
			// calls — same query → same result list order.
			sort.Slice(descriptors, func(a, b int) bool {
				return descriptors[a].Name < descriptors[b].Name
			})
			outs[i] = SearchOutput{Handlers: descriptors}
		}
		return outs, nil
	}
}

// callerCanInvoke mirrors the dispatcher's role gate logic
// (api/role_gate.go) so the search filter and the actual invocation
// stay in lock-step. Any divergence would ship handlers in proc.search
// results that 401 on the next call.
//
//   - $public: anyone (login optional).
//   - $authenticated: only when a UserCtx is on ctx.
//   - 'system' role: wildcard bypass.
//   - any listed role intersects the caller's set: allow.
//
// `roles` is the caller's role set; nil-or-empty means "not logged in
// or the gate hasn't loaded yet".
func callerCanInvoke(ctx context.Context, h reg.Handler, roles map[string]struct{}) bool {
	if slices.Contains(h.AllowedRoles, reg.RolePublic) {
		return true
	}
	user, ok := auth.FromContext(ctx)
	loggedIn := ok && user != nil && user.ID != 0
	if !loggedIn {
		return false
	}
	if slices.Contains(h.AllowedRoles, reg.RoleAuthenticated) {
		return true
	}
	for _, r := range h.AllowedRoles {
		if _, ok := roles[r]; ok {
			return true
		}
	}
	return false
}

// filterHandlers applies the SearchInput filters in priority order:
// All > exact (Endpoint, Action) > substring Query > everything-else.
//
// "Everything else" — i.e. an empty input — yields the empty slice.
// That's the explicit-intent guard: a tool-call without arguments
// shouldn't dump the entire catalogue by accident.
func filterHandlers(in []reg.Handler, q SearchInput) []reg.Handler {
	if q.All {
		out := make([]reg.Handler, len(in))
		copy(out, in)
		return out
	}
	hasEndpoint := q.Endpoint != ""
	hasAction := q.Action != ""
	hasQuery := q.Query != ""
	if !hasEndpoint && !hasAction && !hasQuery {
		return nil
	}
	needle := strings.ToLower(q.Query)
	out := make([]reg.Handler, 0, len(in))
	for _, h := range in {
		if hasEndpoint && h.Endpoint != q.Endpoint {
			continue
		}
		if hasAction && h.Action != q.Action {
			continue
		}
		if hasQuery && !matchesQuery(h, needle) {
			continue
		}
		out = append(out, h)
	}
	return out
}

// matchesQuery returns true when needle (already lower-cased) appears
// in any of: tool name, endpoint, action, doc.
func matchesQuery(h reg.Handler, needle string) bool {
	if needle == "" {
		return true
	}
	name := h.Endpoint + "__" + h.Action
	if strings.Contains(strings.ToLower(name), needle) {
		return true
	}
	if strings.Contains(strings.ToLower(h.Endpoint), needle) {
		return true
	}
	if strings.Contains(strings.ToLower(h.Action), needle) {
		return true
	}
	if strings.Contains(strings.ToLower(h.Doc), needle) {
		return true
	}
	return false
}

// descriptorFor assembles one HandlerDescriptor from a reg.Handler.
// Calls into the same SchemaForType path mcp.Tools() uses so the
// shapes a search client sees match what `tools/list` would have
// returned for the same handler.
func descriptorFor(h reg.Handler) HandlerDescriptor {
	return HandlerDescriptor{
		Name:         h.Endpoint + "__" + h.Action,
		Endpoint:     h.Endpoint,
		Action:       h.Action,
		Doc:          h.Doc,
		AllowedRoles: append([]string(nil), h.AllowedRoles...),
		InputSchema:  mcp.SchemaForType(h.InputType, true),
		OutputSchema: mcp.SchemaForType(h.OutputType, false),
	}
}
