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
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/kitp/kitp/server/internal/store"
)

// Handler is the canonical descriptor for a single batch action.
//
// Authz runs once per sub-request before the batch transaction opens
// (F-ROLE-2).
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
	ProcessName  string
	CardTypeID   func(ctx context.Context, pool ValidationPool, in any) (int64, error)
	// ScopeCardID returns the card id the dispatcher's per-row scope
	// pass (internal/api/authz.go) should walk up from to find the
	// target project. Set it on gated (worker/manager) handlers whose
	// input does NOT carry a plain `card_id` / `target_card_id` field —
	// e.g. comm.set_recipients (comm_id), reply.post (comm_id),
	// comment.update (activity_id → the activity's card). It may query
	// the DB via the ValidationPool to dereference an indirect id.
	//
	// When nil, the dispatcher falls back to reflecting a
	// `card_id` / `target_card_id` field off the input. A gated handler
	// that has neither a resolvable field NOR a ScopeCardID resolver
	// would fail scope-matching closed (tProj=0 → only global grants
	// pass), silently denying scoped managers — so reg.Register panics
	// at startup in that case (BE-H3 / A2). Returning (0, nil) is a
	// legitimate "no card context, skip scope" answer; the panic only
	// fires when the handler can't resolve a card id at all.
	ScopeCardID func(ctx context.Context, pool ValidationPool, in any) (int64, error)
	// GlobalScope marks a handler as intentionally NOT subject to the
	// per-row scope check. Set true ONLY when the handler operates on
	// rows that have no project anchor (CAS chunks, person cards
	// before they're attached to a project, file rows before they
	// attach to a card). Without this opt-out the register-time
	// guard panics on any handler that lists `worker` or `manager` in
	// AllowedRoles without supplying CardTypeID + ProcessName — the
	// bug class spelled out in
	// DI-5 in docs/DESIGN_INVARIANTS.md.
	GlobalScope bool
	// Timeout caps the wall-clock time the dispatcher allows for one
	// invocation of Run (the entire arrayPath batch — every input
	// in the group). Zero means "use the dispatcher's default"
	// (currently 6s). Heavy handlers (`project.import.commit`,
	// `project.stamp`, `project.export.*`) override with a larger
	// value; cheap reads stay at the default. The pool-wide
	// `statement_timeout=600s` is the absolute hard cap. See
	// DI-10 in docs/DESIGN_INVARIANTS.md.
	Timeout time.Duration
	// SQLFunc is the name of the PL/pgSQL function that implements
	// this handler under the unified shape (see
	// docs/UNIFIED_HANDLER_PLAN.md). When set, the dispatcher calls
	// `<SQLFunc>(actor_id bigint, inputs jsonb)` and decodes the
	// returned `(idx, ok, code, message, result)` rows directly;
	// Run is ignored. Handlers that genuinely can't move to PL/pgSQL
	// (help.*, proc.search, echo.ping, config.get) keep Run instead.
	SQLFunc string
	// IsRead marks an SQLFunc handler as read-shaped. The dispatcher
	// notes the round-trip on Pool.NoteRead instead of NoteWrite so
	// LATERAL-read benches that assert `LastReads()==1` keep working
	// across the migration. Ignored for Run-style handlers (whose
	// bodies own their own NoteRead / NoteWrite calls).
	IsRead bool
	// PostRun runs AFTER the SQL function returns successfully,
	// inside the same request tx. Used for Go-side side effects
	// that can't move to PL/pgSQL — image decode (attachment.create
	// thumbnails), future indexing or webhook fan-out, etc. The
	// hook receives the original inputs and the decoded outputs;
	// it may mutate output values in place (e.g. fill in a
	// thumb_file_id) but MUST NOT modify the inputs.
	//
	// Errors from PostRun abort the batch and roll back the tx —
	// same semantics as a SQL function failure.
	//
	// Only invoked when SQLFunc is set AND the function call
	// succeeded. Ignored for Run-style handlers.
	PostRun func(ctx context.Context, tx store.Querier, ins []any, outs []any) error
	// PreRun runs BEFORE the SQL function is invoked, inside the
	// same request tx. Used for Go-side input normalisation that
	// genuinely needs DB access (e.g. project.import reading CSV
	// bytes from file_chunk + parsing them before the SQL function
	// walks the rows). The hook receives the typed inputs and
	// returns a transformed slice — same length, same order, same
	// types — that the dispatcher then JSONB-encodes for the SQL
	// function. Hooks that don't need DB access should use
	// UnmarshalJSON on the input type instead (cheaper, runs
	// pre-tx).
	//
	// Errors from PreRun abort the batch and roll back the tx —
	// a returned *reg.HandlerError pins the failure to its InputIndex.
	//
	// Only invoked when SQLFunc is set. Ignored for Run-style
	// handlers.
	PreRun func(ctx context.Context, tx store.Querier, ins []any) ([]any, error)
	Run    func(ctx context.Context, tx store.Querier, ins []any) (outs []any, err error)
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
	if h.Run == nil && h.SQLFunc == "" {
		panic(fmt.Sprintf("reg.Register: %s.%s needs either Run or SQLFunc", h.Endpoint, h.Action))
	}
	if h.Run != nil && h.SQLFunc != "" {
		panic(fmt.Sprintf("reg.Register: %s.%s sets both Run and SQLFunc — exactly one", h.Endpoint, h.Action))
	}
	if len(h.AllowedRoles) == 0 {
		panic(fmt.Sprintf(
			"reg.Register: %s.%s missing AllowedRoles — declare reg.RolePublic / reg.RoleAuthenticated / explicit role names",
			h.Endpoint, h.Action))
	}
	// Per-row scope guard: if AllowedRoles names a non-admin tier
	// (worker / manager), the handler MUST supply CardTypeID and
	// ProcessName so the dispatcher can compare the actor's scoped
	// grant against the target's project. Admin-only handlers and
	// the special role tokens ($public / $authenticated / system)
	// are exempt — admin is conventionally a global grant, and the
	// special tokens skip the row-scope pass by design.
	//
	// Set GlobalScope=true on handlers that legitimately operate on
	// rows without a project anchor (CAS chunks, persons before
	// they're attached, file rows). Anything else risks the bug
	// class in DI-5 (docs/DESIGN_INVARIANTS.md).
	if needsRowScope(h.AllowedRoles) && !h.GlobalScope {
		if h.CardTypeID == nil || h.ProcessName == "" {
			panic(fmt.Sprintf(
				"reg.Register: %s.%s has worker/manager in AllowedRoles but no CardTypeID + ProcessName (and GlobalScope is false). "+
					"Per-row scope check would silently skip — see DI-5 in docs/DESIGN_INVARIANTS.md.",
				h.Endpoint, h.Action))
		}
		// The scope pass must also be able to locate the *card* to walk
		// up from. It uses ScopeCardID when set, otherwise reflects a
		// `card_id` / `target_card_id` field off the input. A gated
		// handler with neither would fail scope-matching closed (tProj=0
		// → only global grants pass), silently denying project-scoped
		// managers — the BE-H3 / A2 bug. Assert the guarantee at startup
		// rather than implying it.
		//
		// card.insert is the one documented exception: it has no card_id
		// (the card doesn't exist yet) — the dispatcher resolves its
		// scope from parent_card_id via a dedicated special case
		// (internal/api/authz.go targetProjectForLeaf). Exempt it here so
		// the guard stays a tight invariant for every other handler.
		isCardInsert := h.Endpoint == "card" && h.Action == "insert"
		if !isCardInsert && h.ScopeCardID == nil && !inputHasScopeCardField(h.InputType) {
			panic(fmt.Sprintf(
				"reg.Register: %s.%s is project-scoped (worker/manager) but the dispatcher can't resolve a card id for it — "+
					"its input type has no `card_id`/`target_card_id` field and no ScopeCardID resolver is set. "+
					"Add a ScopeCardID func that returns the card to scope-check against (BE-H3 / A2).",
				h.Endpoint, h.Action))
		}
	}
	mu.Lock()
	defer mu.Unlock()
	k := key{h.Endpoint, h.Action}
	if _, dup := handlers[k]; dup {
		panic(fmt.Sprintf("reg.Register: duplicate handler %s.%s", h.Endpoint, h.Action))
	}
	handlers[k] = h
}

// inputHasScopeCardField reports whether the handler's input struct
// carries a field the dispatcher's reflection-based card-id extractor
// (internal/api/authz_input.go cardIDFromInput) recognises — a
// `json:"card_id,..."` or `json:"target_card_id,..."` field. Kept in
// lockstep with that extractor's field set; if cardIDFromInput grows a
// new field name, add it here too.
func inputHasScopeCardField(t reflect.Type) bool {
	if t == nil {
		return false
	}
	if t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	if t.Kind() != reflect.Struct {
		return false
	}
	for i := 0; i < t.NumField(); i++ {
		switch jsonTagName(t.Field(i).Tag.Get("json")) {
		case "card_id", "target_card_id":
			return true
		}
	}
	return false
}

// jsonTagName extracts the name from a `json:"name,opts..."` struct
// tag. Mirrors api.jsonName; duplicated here to keep reg import-light
// (reg must not import api — that would invert the dependency).
func jsonTagName(tag string) string {
	for i := 0; i < len(tag); i++ {
		if tag[i] == ',' {
			return tag[:i]
		}
	}
	return tag
}

// needsRowScope returns true if AllowedRoles names a tier whose
// access is scoped per-project (worker, manager). The bare role
// gate doesn't verify scope; the dispatcher's row-level pass in
// internal/api/authz.go does — but only when CardTypeID and
// ProcessName are wired up. Admin is treated as conventionally
// global; the special role tokens are pass-through.
func needsRowScope(roles []string) bool {
	for _, r := range roles {
		switch r {
		case "worker", "manager":
			return true
		}
	}
	return false
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
//
// Detail is an optional structured payload the dispatcher serialises
// verbatim into the sub-response error envelope alongside `code` and
// `message`. Gate 5 (FLOW_AND_SCREEN_KERNEL §V13) uses it to carry the
// `from / attempted_to / available[]` positive-feedback payload on a
// `flow_disallowed` / `flow_role_required` rejection. Any
// JSON-marshallable value works; nil omits the field entirely.
type HandlerError struct {
	InputIndex int
	Code       string
	Message    string
	Detail     any
}

func (e *HandlerError) Error() string { return e.Message }
