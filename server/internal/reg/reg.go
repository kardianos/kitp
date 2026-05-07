// Package reg holds the central handler registry for kitp.
//
// Each handler binds an (endpoint, action) pair to a typed Input/Output and
// a Run function that takes a slice of inputs (always a slice, even for
// single-row calls — see N-SRV-4) and returns a slice of outputs in the
// same order. Authz is invoked per sub-request before the batch transaction
// opens (see F-ROLE-2 in REQUIREMENTS.md).
package reg

import (
	"context"
	"fmt"
	"reflect"
	"sort"
	"sync"

	"github.com/jackc/pgx/v5"
)

// Handler is the canonical descriptor for a single batch action.
//
// Authz runs once per sub-request before the batch transaction opens
// (F-ROLE-2). Validate also runs before the transaction opens, but unlike
// Authz it gets a pgxpool.Pool so it can do read-only metadata lookups —
// e.g. F-ATTR-3 ("Attribute writes that violate the EDGE schema … are
// rejected at sub-request validation, before the transaction opens").
//
// AllowedRoles is the declarative role gate. The dispatcher loads the
// calling user's roles from `user_role` and rejects the sub-request with
// `unauthorized` unless at least one of `AllowedRoles` matches. Roles are
// not hierarchical — list every role that should reach the handler. Two
// special values are recognised:
//
//   - reg.RolePublic        — no login required (echo.ping only).
//   - reg.RoleAuthenticated — any signed-in user, no specific role check.
//
// The slice MUST be non-empty; the registry panics at startup otherwise
// so a newly-introduced handler can't accidentally ship without an authz
// declaration. The seeded `system` role bypasses the check entirely so
// dev-mode (AUTH_MODE=off, System User) keeps working without having to
// thread "system" through every list.
//
// ProcessName is the name of the process row in the database for this
// handler (e.g. "card.create"). Combined with CardTypeID it drives the
// older row-level role_grant check the dispatcher runs before opening
// the transaction. Empty ProcessName disables that legacy check (test
// handlers, echo, …) — the new AllowedRoles gate is independent.
//
// CardTypeID extracts the card_type_id the sub-request operates on so the
// dispatcher can authorize it. May query the database via the supplied
// ValidationPool (for handlers like attribute.update where the type lives
// behind a card_id reference).
//
// Run receives a slice of inputs (always slice — N-SRV-4) and returns a
// matching slice of outputs.
//
// Doc is a one-sentence description of the handler. Phase 19 (MCP
// auto-publish) uses it as the description of the generated MCP tool;
// see docs/mcp-tags.md for the full tag schema.
type Handler struct {
	Endpoint     string
	Action       string
	Doc          string
	InputType    reflect.Type
	OutputType   reflect.Type
	AllowedRoles []string
	Authz        func(ctx context.Context, in any) error
	Validate     func(ctx context.Context, pool ValidationPool, in any) error
	ProcessName  string
	CardTypeID   func(ctx context.Context, pool ValidationPool, in any) (int32, error)
	Run          func(ctx context.Context, tx pgx.Tx, ins []any) (outs []any, err error)
}

// Sentinel role names recognised by the dispatcher's gate. They are not
// real `role.name` values — they would fail an FK check if anyone tried
// to insert them — but they let a registration declare access without
// inventing a fake role row.
const (
	// RolePublic disables the login + role check entirely. Reserved for
	// echo / health endpoints; production handlers should never use it.
	RolePublic = "$public"
	// RoleAuthenticated requires a valid login but no specific role.
	RoleAuthenticated = "$authenticated"
	// RoleSystem is the seeded dev-mode role; the gate hard-codes a
	// bypass for it so dev-mode (AUTH_MODE=off) hits every endpoint
	// without listing it in every handler's AllowedRoles. Exported as
	// a constant so tests can reference the same string.
	RoleSystem = "system"
)

// Unauthorized returns a *HandlerError with the canonical permission
// code so per-handler ownership / scope checks emit responses that look
// the same as the dispatcher-level role gate. Handlers should call this
// instead of building their own "unauthorized" errors so the wire shape
// stays consistent.
func Unauthorized(format string, args ...any) *HandlerError {
	return &HandlerError{
		Code:    "unauthorized",
		Message: fmt.Sprintf(format, args...),
	}
}

// ValidationPool is the read-only surface a Validate hook gets. Anything
// pgxpool.Pool implements naturally; an interface keeps the registry
// import-light and lets tests pass mocks.
type ValidationPool interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

type key struct {
	Endpoint, Action string
}

var (
	mu       sync.RWMutex
	handlers = map[key]Handler{}
)

// Register installs a handler. Duplicate (endpoint, action) panics — that
// catches double-registration at process start, which is when init() runs.
//
// Empty AllowedRoles also panics: every handler must declare its access
// surface explicitly. Use reg.RolePublic for unauthenticated endpoints,
// reg.RoleAuthenticated for any-signed-in-user endpoints.
func Register(h Handler) {
	if h.Endpoint == "" || h.Action == "" {
		panic("reg.Register: empty endpoint or action")
	}
	if h.Run == nil {
		panic(fmt.Sprintf("reg.Register: nil Run for %s.%s", h.Endpoint, h.Action))
	}
	if len(h.AllowedRoles) == 0 {
		panic(fmt.Sprintf(
			"reg.Register: %s.%s missing AllowedRoles — declare reg.RolePublic / reg.RoleAuthenticated / explicit role names",
			h.Endpoint, h.Action))
	}
	mu.Lock()
	defer mu.Unlock()
	k := key{h.Endpoint, h.Action}
	if _, dup := handlers[k]; dup {
		panic(fmt.Sprintf("reg.Register: duplicate handler %s.%s", h.Endpoint, h.Action))
	}
	handlers[k] = h
}

// Lookup fetches the handler by (endpoint, action).
func Lookup(endpoint, action string) (Handler, bool) {
	mu.RLock()
	defer mu.RUnlock()
	h, ok := handlers[key{endpoint, action}]
	return h, ok
}

// All returns a snapshot of every registered handler, sorted by
// "endpoint+action" for stable ordering. Used by MCP auto-publish (Phase
// 19) and by debug tooling.
func All() []Handler {
	mu.RLock()
	defer mu.RUnlock()
	out := make([]Handler, 0, len(handlers))
	for _, h := range handlers {
		out = append(out, h)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Endpoint != out[j].Endpoint {
			return out[i].Endpoint < out[j].Endpoint
		}
		return out[i].Action < out[j].Action
	})
	return out
}

// Reset is for tests: it wipes the registry. Production code never calls this.
func Reset() {
	mu.Lock()
	defer mu.Unlock()
	handlers = map[key]Handler{}
}

// HandlerError is what a Run implementation returns when it wants the
// dispatcher to pin the failure to a specific input within its coalesced
// batch. InputIndex is the position inside the slice handed to Run (not
// the submission slot — the dispatcher maps it back). Code is the
// machine-readable label that surfaces in the sub-response.
type HandlerError struct {
	InputIndex int
	Code       string
	Message    string
}

func (e *HandlerError) Error() string { return e.Message }
