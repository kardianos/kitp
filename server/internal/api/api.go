// Package api wires the single batch endpoint, decoder, dispatcher, and
// response shaping. Everything the HTTP layer touches goes through here.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"time"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/process"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// DefaultHandlerTimeout caps the wall-clock time the dispatcher
// allows for any one handler's Run call when the handler doesn't
// override via `reg.Handler.Timeout`. 6s is generous for the
// typical sub-second batch shapes; heavy handlers (import.commit,
// project.stamp, export) declare a larger Timeout explicitly.
// Pool-wide `statement_timeout=600s` is the absolute hard cap.
// See issues/sql/01-med-no-statement-timeout.md.
const DefaultHandlerTimeout = 6 * time.Second

// requestIDKeyT is a context key for the request id. The obs package
// stores the same value under the same key (see internal/obs/logger.go);
// using a shared, exported key lets both packages read/write without
// an import cycle.
type requestIDKeyT struct{}

// RequestIDKey is the context key under which obs.RequestIDMiddleware
// stashes the X-Request-ID. Exposed so test code and the obs package
// can share access without creating an import cycle.
var RequestIDKey = requestIDKeyT{}

// requestIDFromContext returns the request id stored on ctx, or "".
func requestIDFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(RequestIDKey).(string); ok {
		return v
	}
	return ""
}

// SubRequest is one element of the request envelope (REQUIREMENTS §4.1 N-API-2).
type SubRequest struct {
	ID       string          `json:"id"`
	Type     string          `json:"type"`
	Endpoint string          `json:"endpoint"`
	Action   string          `json:"action"`
	Ref      json.RawMessage `json:"ref,omitempty"`
	Key      json.RawMessage `json:"key,omitempty"`
	Data     json.RawMessage `json:"data,omitempty"`
}

// BatchRequest is the wire-level envelope.
type BatchRequest struct {
	Subrequests []SubRequest `json:"subrequests"`
}

// ErrorEnvelope rides on a sub-response when something went wrong with that
// individual sub-request.
//
// Detail is an optional structured payload the dispatcher carries over
// verbatim from `reg.HandlerError.Detail`. The flow-aware
// `attribute.update` rejection envelope (V13) populates it with
// `from / attempted_to / available[]` so the client and MCP renderers
// can surface positive-feedback affordances ("you can do X; ask a
// manager for Y") without making another round-trip.
type ErrorEnvelope struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Detail  any    `json:"detail,omitempty"`
}

// SubResponse is the per-sub-request reply. Order in BatchResponse mirrors
// the SubRequest order in BatchRequest exactly.
type SubResponse struct {
	ID    string         `json:"id"`
	OK    bool           `json:"ok"`
	Data  any            `json:"data,omitempty"`
	Error *ErrorEnvelope `json:"error,omitempty"`
}

// BatchResponse is the top-level reply.
type BatchResponse struct {
	Subresponses []SubResponse `json:"subresponses"`
}

// Server holds the dependencies the dispatcher needs.
//
// Logger is optional; when set, the dispatcher emits one info line per
// batch (with request_id, user_id, subrequest_count, duration_ms,
// outcome) and one debug line per sub-request (Phase 21).
type Server struct {
	Pool   *store.Pool
	Logger *slog.Logger
}

// NewServer constructs a dispatcher.
func NewServer(p *store.Pool) *Server {
	return &Server{Pool: p}
}

// logBatch emits the per-batch info line if a Logger is configured.
func (s *Server) logBatch(ctx context.Context, n int, dur time.Duration, outcome string) {
	if s.Logger == nil {
		return
	}
	s.Logger.LogAttrs(ctx, slog.LevelInfo, "batch",
		slog.String("request_id", requestIDFromContext(ctx)),
		slog.Int64("user_id", auth.ActorOrSystem(ctx)),
		slog.Int("subrequest_count", n),
		slog.Int64("duration_ms", dur.Milliseconds()),
		slog.String("outcome", outcome),
	)
}

// logSubrequest emits the per-sub-request debug line if a Logger is configured.
func (s *Server) logSubrequest(ctx context.Context, sr SubResponse, endpoint, action string) {
	if s.Logger == nil {
		return
	}
	code := ""
	if sr.Error != nil {
		code = sr.Error.Code
	}
	s.Logger.LogAttrs(ctx, slog.LevelDebug, "subrequest",
		slog.String("request_id", requestIDFromContext(ctx)),
		slog.String("endpoint", endpoint),
		slog.String("action", action),
		slog.Bool("ok", sr.OK),
		slog.String("code", code),
	)
}

// Mount registers the API routes on mux:
//   - POST /api/v1/batch — the only real API endpoint.
//   - GET  /healthz      — liveness probe.
//
// If webDir is non-empty and points at an existing directory, kitpd also
// serves the Flutter web bundle at the root with SPA fallback (any GET
// that doesn't match a real file is routed to index.html so client-side
// routes like /project/42 work). When webDir is empty, GET / returns a
// small JSON describing the service.
//
// Production uses the split mount points below (MountBatch on the
// apiRouter, MountSPA on the top-level mux). This `Mount` helper
// keeps the previous mux-based contract intact for tests that wire a
// dispatcher up to a plain http.ServeMux without an apiRouter — they
// hit HandleBatch directly so they don't need a session resolver.
func (s *Server) Mount(mux *http.ServeMux, webDir string) {
	mux.HandleFunc("POST /api/v1/batch", s.HandleBatch)
	s.MountSPA(mux, webDir)
}

// AuthedDecorator wraps an AuthedHandler with cross-cutting
// behaviour (idempotency, rate-limiting, …) without baking the
// dependency into the api package. main.go passes the active set to
// MountBatch as a variadic tail; decorators apply in the order
// given so the first is the outermost wrap.
type AuthedDecorator = func(AuthedHandler) AuthedHandler

// MountBatch installs POST /api/v1/batch on the apiRouter. The router
// resolves the session cookie and attaches the user to the context
// before the handler runs, so the dispatcher's per-handler authz
// hooks (role_gate.go, authz.go) see the authenticated actor exactly
// as they did under the old session.Middleware chain.
//
// Body decode errors collapse into a 400 via api.BadRequest; everything
// else flows through Dispatch as before.
//
// Optional `decorators` wrap the batch handler from outside-in: the
// first decorator runs outermost, the last innermost. Used by main.go
// to apply idempotency caching scoped to the batch route only.
func (s *Server) MountBatch(rt *Router, decorators ...AuthedDecorator) {
	h := AuthedHandler(func(ctx context.Context, w http.ResponseWriter, r *http.Request, _ *auth.UserCtx) error {
		defer r.Body.Close()
		var req BatchRequest
		dec := json.NewDecoder(r.Body)
		dec.DisallowUnknownFields()
		if err := dec.Decode(&req); err != nil {
			return BadRequest("bad_request", fmt.Sprintf("malformed json: %v", err))
		}
		resp := s.Dispatch(ctx, req)
		writeJSON(w, http.StatusOK, resp)
		return nil
	})
	// Apply in reverse so decorators[0] ends up outermost — caller
	// intuition is "decorator order matches request flow direction".
	for i := len(decorators) - 1; i >= 0; i-- {
		h = decorators[i](h)
	}
	rt.Authed("POST /api/v1/batch", h)
}

// MountSPA installs the SPA fallback (or the JSON root when webDir is
// empty / missing) and /healthz on the top-level mux. These do not go
// through the apiRouter — they're outside /api/* and don't need a
// session.
//
// Pointer receiver kept for symmetry with the other Mount methods even
// though this one doesn't touch *Server state — keeping the receiver
// preserves the existing `srv.Mount(...)` test ergonomics.
func (s *Server) MountSPA(mux *http.ServeMux, webDir string) {
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, struct {
			OK bool `json:"ok"`
		}{OK: true})
	})

	if webDir != "" {
		if st, err := os.Stat(webDir); err == nil && st.IsDir() {
			// Pattern "/" (no method restriction) so it doesn't
			// conflict with "/api/" — Go 1.22's mux treats
			// "GET /" + "/api/" as ambiguous (different methods +
			// different paths, neither dominates). spaHandler
			// itself rejects non-GET methods with 405.
			mux.Handle("/", spaHandler(webDir))
			return
		}
		// webDir was set but missing — fall through to the JSON root and
		// log once at startup; main.go is the place that logs.
	}
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, struct {
			Service   string            `json:"service"`
			Endpoints map[string]string `json:"endpoints"`
		}{
			Service: "kitp",
			Endpoints: map[string]string{
				"batch":  "POST /api/v1/batch",
				"health": "GET /healthz",
				"mcp":    "run kitpd mcp (stdio)",
			},
		})
	})
}

// spaHandler serves files from webDir, falling back to index.html for any
// GET that doesn't match a real file (so the SPA client-side router owns
// paths like /projects, /project/42/screen/inbox, and /task/7).
func spaHandler(webDir string) http.Handler {
	fs := http.FileServer(http.Dir(webDir))
	indexPath := filepath.Join(webDir, "index.html")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Static bundle is GET-only. The pattern dropped its method
		// restriction (see MountSPA) to side-step Go 1.22 mux's
		// "GET / vs /api/" ambiguity, so the method gate moved here.
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		// Map the URL path to a filesystem path under webDir.
		clean := filepath.Clean(strings.TrimPrefix(r.URL.Path, "/"))
		if clean == "." || clean == "/" {
			http.ServeFile(w, r, indexPath)
			return
		}
		full := filepath.Join(webDir, clean)
		if !strings.HasPrefix(full, webDir) {
			http.NotFound(w, r)
			return
		}
		if st, err := os.Stat(full); err == nil && !st.IsDir() {
			fs.ServeHTTP(w, r)
			return
		}
		// Not a real file: fall back to index.html (SPA route).
		http.ServeFile(w, r, indexPath)
	})
}

// HandleBatch is the only HTTP handler in v1.
func (s *Server) HandleBatch(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close()

	var req BatchRequest
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": map[string]any{
				"code":    "bad_request",
				"message": fmt.Sprintf("malformed json: %v", err),
			},
		})
		return
	}
	resp := s.Dispatch(r.Context(), req)
	writeJSON(w, http.StatusOK, resp)
}

// prepared captures one effective sub-request: a leaf handler invocation
// pinned to a specific outer slot. Process expansions may emit multiple
// preparedRecord entries for the same outer slot — the leader carries the
// outer slot, followers attach to the same outer slot.
type prepared struct {
	OuterIdx       int          // index in BatchRequest.Subrequests
	Endpoint       string       // effective endpoint
	Action         string       // effective action
	Handler        reg.Handler  // resolved leaf handler
	Input          any          // decoded value of Handler.InputType
	IsLast         bool         // last step of a process; outputs go to the outer slot
	IsLeader       bool         // first step of a process; used for process logging only
	ProcessName    string       // resolved process name (informational)
}

// Dispatch is exposed for tests so they can drive the dispatcher without
// going through the HTTP boundary. It performs decode, group, run, encode.
func (s *Server) Dispatch(ctx context.Context, req BatchRequest) BatchResponse {
	start := time.Now()
	n := len(req.Subrequests)
	out := BatchResponse{Subresponses: make([]SubResponse, n)}
	for i, sr := range req.Subrequests {
		out.Subresponses[i] = SubResponse{ID: sr.ID}
	}
	if n == 0 {
		s.logBatch(ctx, 0, time.Since(start), "ok")
		return out
	}
	defer func() {
		// Determine outcome by inspecting the result slots.
		outcome := "ok"
		for _, sr := range out.Subresponses {
			if sr.Error != nil {
				if sr.Error.Code == "aborted" {
					outcome = "aborted"
				} else {
					outcome = "error"
					break
				}
			}
		}
		s.logBatch(ctx, n, time.Since(start), outcome)
		for i, sr := range out.Subresponses {
			if i >= len(req.Subrequests) {
				break
			}
			s.logSubrequest(ctx, sr, req.Subrequests[i].Endpoint, req.Subrequests[i].Action)
		}
	}()

	// Pass 1: expand processes and decode every leaf sub-request. A failure
	// here aborts the whole batch (N-API-4). Role-based authorization is
	// deferred to pass 2 so we can preload referenced cards in one query.
	var prepped []prepared
	for i, sr := range req.Subrequests {
		expanded, err := s.expandSubrequest(ctx, i, sr)
		if err != nil {
			code := errCode(err, "unknown_handler")
			abortAllWithDetail(out.Subresponses, i, code, err.Error(), errDetail(err))
			return out
		}
		prepped = append(prepped, expanded...)
	}

	// Pass 1.5: declarative role gate (Handler.AllowedRoles). Requires a
	// valid login (unless the leaf is reg.RolePublic) and at least one
	// of the listed roles. Runs before Pass 2 because it's strictly
	// cheaper: one role lookup per HTTP request, no card-graph walk.
	if err := s.runRoleGate(ctx, prepped, out.Subresponses); err != nil {
		return out
	}

	// Pass 2: scope-aware authorization. Loads the actor's grants once, then
	// resolves each leaf's target project (single batched card lookup) and
	// matches grants. On deny, abort the whole batch.
	if err := s.runAuthzPass(ctx, prepped, out.Subresponses); err != nil {
		return out
	}

	// One transaction per HTTP request (N-SRV-1).
	tx, err := s.Pool.BeginTx(ctx)
	if err != nil {
		abortAll(out.Subresponses, 0, "tx_begin", err.Error())
		return out
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()

	flush := func(group []prepared) error {
		if len(group) == 0 {
			return nil
		}
		ins := make([]any, len(group))
		for i, p := range group {
			ins[i] = p.Input
		}
		// Per-handler wall-clock cap (S1). Zero Timeout means
		// DefaultHandlerTimeout (6s). pgx's Query/Exec accept the
		// derived ctx natively; on expiry it sends a wire-protocol
		// CancelRequest on a side channel, so the backend stops
		// processing rather than the client just walking away. The
		// pool-wide `statement_timeout=600s` is a hard upper bound
		// even when a handler's Timeout is larger.
		timeout := group[0].Handler.Timeout
		if timeout <= 0 {
			timeout = DefaultHandlerTimeout
		}
		runCtx, runCancel := context.WithTimeout(ctx, timeout)
		var outs []any
		var err error
		if group[0].Handler.SQLFunc != "" {
			// Unified handler path (docs/UNIFIED_HANDLER_PLAN.md):
			// one PL/pgSQL function call per group, returns one
			// row per input.
			outs, err = s.runSQLFunc(runCtx, tx, group, ins)
		} else {
			outs, err = group[0].Handler.Run(runCtx, tx, ins)
		}
		runCancel()
		if err != nil {
			offender := group[0].OuterIdx
			code := "handler_error"
			var detail any
			if he, ok := err.(*reg.HandlerError); ok {
				if he.InputIndex >= 0 && he.InputIndex < len(group) {
					offender = group[he.InputIndex].OuterIdx
				}
				if he.Code != "" {
					code = he.Code
				}
				detail = he.Detail
			}
			abortAllWithDetail(out.Subresponses, offender, code, err.Error(), detail)
			return err
		}
		if len(outs) != len(group) {
			err := fmt.Errorf("handler %s.%s returned %d outputs for %d inputs",
				group[0].Handler.Endpoint, group[0].Handler.Action, len(outs), len(group))
			abortAll(out.Subresponses, group[0].OuterIdx, "handler_protocol", err.Error())
			return err
		}
		for i, p := range group {
			if !p.IsLast {
				continue // intermediate process step; result is dropped
			}
			out.Subresponses[p.OuterIdx] = SubResponse{
				ID:   req.Subrequests[p.OuterIdx].ID,
				OK:   true,
				Data: outs[i],
			}
		}
		return nil
	}

	var group []prepared
	for _, p := range prepped {
		if len(group) > 0 {
			head := group[0]
			if head.Endpoint != p.Endpoint || head.Action != p.Action {
				if err := flush(group); err != nil {
					return out
				}
				group = group[:0]
			}
		}
		group = append(group, p)
	}
	if err := flush(group); err != nil {
		return out
	}

	if err := tx.Commit(ctx); err != nil {
		abortAll(out.Subresponses, 0, "tx_commit", err.Error())
		return out
	}
	committed = true
	return out
}

// expandSubrequest resolves a SubRequest to one or more prepared records.
// If (endpoint, action) hits a registered handler directly, returns one
// record; if it matches a process row instead, returns one record per
// process_step (the last record IsLast=true). Decoding and authorization
// hooks all run here, before any tx opens.
func (s *Server) expandSubrequest(ctx context.Context, outerIdx int, sr SubRequest) ([]prepared, error) {
	// Direct handler lookup.
	if h, ok := reg.Lookup(sr.Endpoint, sr.Action); ok {
		p, err := s.prepareLeaf(ctx, outerIdx, h, sr.Data, "" /*processName*/, true /*isLast*/, true /*isLeader*/)
		if err != nil {
			return nil, err
		}
		return []prepared{p}, nil
	}

	// Process expansion: look up by name "<endpoint>.<action>".
	procName := sr.Endpoint + "." + sr.Action
	proc, err := process.LookupValidation(ctx, s.Pool.P, procName)
	if err != nil {
		return nil, fmt.Errorf("process lookup: %w", err)
	}
	if proc == nil || len(proc.Steps) == 0 {
		return nil, &reg.HandlerError{
			Code:    "unknown_handler",
			Message: fmt.Sprintf("no handler or process registered for %s.%s", sr.Endpoint, sr.Action),
		}
	}

	out := make([]prepared, 0, len(proc.Steps))
	for i, step := range proc.Steps {
		h, ok := reg.Lookup(step.Endpoint, step.Action)
		if !ok {
			return nil, &reg.HandlerError{
				Code:    "unknown_step",
				Message: fmt.Sprintf("process %s step %d targets unknown handler %s.%s",
					procName, step.Ordinal, step.Endpoint, step.Action),
			}
		}
		p, err := s.prepareLeaf(ctx, outerIdx, h, sr.Data, procName,
			i == len(proc.Steps)-1, /* IsLast */
			i == 0,                  /* IsLeader */
		)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, nil
}

// prepareLeaf runs the standard pre-tx hooks for one (handler, data) pair:
// decode, authz, role_grant, validate. Each of these can fail and abort
// the whole batch.
func (s *Server) prepareLeaf(ctx context.Context, outerIdx int, h reg.Handler, data json.RawMessage, processName string, isLast, isLeader bool) (prepared, error) {
	v := reflect.New(h.InputType).Interface()
	if len(data) > 0 {
		if err := json.Unmarshal(data, v); err != nil {
			return prepared{}, &reg.HandlerError{
				Code:    "bad_input",
				Message: fmt.Sprintf("decode %s.%s data: %v", h.Endpoint, h.Action, err),
			}
		}
	}
	input := reflect.ValueOf(v).Elem().Interface()

	if h.Authz != nil {
		if err := h.Authz(ctx, input); err != nil {
			return prepared{}, &reg.HandlerError{Code: "unauthorized", Message: err.Error()}
		}
	}

	return prepared{
		OuterIdx:    outerIdx,
		Endpoint:    h.Endpoint,
		Action:      h.Action,
		Handler:     h,
		Input:       input,
		IsLast:      isLast,
		IsLeader:    isLeader,
		ProcessName: processName,
	}, nil
}

// runAuthzPass walks every prepared leaf, preloads the cards referenced by
// scope-relevant inputs in a single query, then matches each leaf against
// the actor's effective grants. On deny it sets up an `unauthorized` /
// `aborted` response on every slot and returns a non-nil error so the
// caller can short-circuit.
func (s *Server) runAuthzPass(ctx context.Context, prepped []prepared, slots []SubResponse) error {
	if len(prepped) == 0 {
		return nil
	}
	userID := auth.ActorOrSystem(ctx)

	// Pre-collect every card id that a scope walk needs to start from. We
	// walk transitively; expandCardLookup fans out as deep as scopeWalkDepth.
	seedIDs := map[int64]struct{}{}
	for _, p := range prepped {
		if p.Handler.Endpoint == "card" && p.Handler.Action == "insert" {
			parent, _, _ := cardInsertParent(p.Input)
			if parent != nil {
				seedIDs[*parent] = struct{}{}
			}
			continue
		}
		if cid := cardIDFromInput(p.Handler, p.Input); cid != 0 {
			seedIDs[cid] = struct{}{}
		}
	}
	ids := make([]int64, 0, len(seedIDs))
	for id := range seedIDs {
		ids = append(ids, id)
	}
	lookup, err := preloadCards(ctx, s.Pool, ids)
	if err != nil {
		abortAll(slots, prepped[0].OuterIdx, "validation", err.Error())
		return err
	}
	if err := expandCardLookup(ctx, s.Pool, lookup); err != nil {
		abortAll(slots, prepped[0].OuterIdx, "validation", err.Error())
		return err
	}

	projTypeID, err := projectCardTypeID(ctx, s.Pool)
	if err != nil {
		abortAll(slots, prepped[0].OuterIdx, "validation", err.Error())
		return err
	}

	grants, err := loadActorGrants(ctx, s.Pool, userID)
	if err != nil {
		abortAll(slots, prepped[0].OuterIdx, "validation", err.Error())
		return err
	}

	for _, p := range prepped {
		if err := s.authorizeLeaf(ctx, p.Handler, p.Input, grants, lookup, projTypeID); err != nil {
			he, _ := err.(*reg.HandlerError)
			code := "unauthorized"
			msg := err.Error()
			var detail any
			if he != nil {
				if he.Code != "" {
					code = he.Code
				}
				msg = he.Message
				detail = he.Detail
			}
			abortAllWithDetail(slots, p.OuterIdx, code, msg, detail)
			return err
		}
	}
	return nil
}

// abortAll marks the offender slot with err and every other slot with "aborted".
// Slots that were already filled with success data are also overwritten so the
// transactional all-or-nothing contract holds.
func abortAll(slots []SubResponse, offender int, code, msg string) {
	abortAllWithDetail(slots, offender, code, msg, nil)
}

// abortAllWithDetail is the same shape with an additional Detail payload
// that rides on the offender's error envelope. Used by the flow-aware
// `attribute.update` rejection path (V13) to surface
// `from / attempted_to / available[]` alongside `code / message`.
func abortAllWithDetail(slots []SubResponse, offender int, code, msg string, detail any) {
	for i := range slots {
		id := slots[i].ID
		if i == offender {
			slots[i] = SubResponse{ID: id, OK: false,
				Error: &ErrorEnvelope{Code: code, Message: msg, Detail: detail}}
		} else {
			slots[i] = SubResponse{ID: id, OK: false,
				Error: &ErrorEnvelope{Code: "aborted", Message: "batch aborted by sibling sub-request"}}
		}
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

// errCode extracts a HandlerError's code if present, otherwise returns
// the supplied default.
func errCode(err error, def string) string {
	if he, ok := err.(*reg.HandlerError); ok && he.Code != "" {
		return he.Code
	}
	return def
}

// errDetail extracts a HandlerError's optional structured Detail payload
// when present. Returns nil for plain errors. Used by the dispatcher's
// expand / authz paths so a structured rejection (Gate 5's flow
// envelope) survives the round-trip into the ErrorEnvelope.
func errDetail(err error) any {
	if he, ok := err.(*reg.HandlerError); ok {
		return he.Detail
	}
	return nil
}
