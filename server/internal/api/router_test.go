package api_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/reg"
)

// silentLogger keeps test output clean while still exercising the
// router's log calls.
func silentLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelError + 1}))
}

func fakeUser(id int64, name string) *auth.UserCtx {
	return &auth.UserCtx{ID: id, DisplayName: name}
}

// resolverReturning is a Resolver that produces a fixed user (or
// error) regardless of the request. Used to pin the auth outcome per
// test without spinning up a real Manager.
func resolverReturning(u *auth.UserCtx, err error) api.Resolver {
	return func(_ *http.Request) (*auth.UserCtx, error) {
		return u, err
	}
}

func newRouter(session, bearer api.Resolver) *api.Router {
	return api.NewRouter(api.RouterConfig{
		SessionResolver: session,
		BearerResolver:  bearer,
		Logger:          silentLogger(),
	})
}

func doRequest(t *testing.T, rt *api.Router, method, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	rec := httptest.NewRecorder()
	rt.Mux().ServeHTTP(rec, req)
	return rec
}

func decodeErr(t *testing.T, body string) (string, string) {
	t.Helper()
	var j struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal([]byte(body), &j); err != nil {
		t.Fatalf("decode body: %v (raw=%q)", err, body)
	}
	return j.Code, j.Message
}

func TestRouter_Public_RunsWithoutAuth(t *testing.T) {
	rt := newRouter(nil, nil)
	called := false
	rt.Public("/api/v1/public", func(_ context.Context, w http.ResponseWriter, _ *http.Request) error {
		called = true
		w.WriteHeader(http.StatusNoContent)
		return nil
	})

	rec := doRequest(t, rt, "GET", "/api/v1/public")
	if !called {
		t.Fatal("public handler not invoked")
	}
	if rec.Code != http.StatusNoContent {
		t.Errorf("status: got %d, want 204", rec.Code)
	}
}

func TestRouter_Authed_RejectsMissingSession(t *testing.T) {
	rt := newRouter(resolverReturning(nil, nil), nil)
	rt.Authed("/api/v1/authed", func(_ context.Context, w http.ResponseWriter, _ *http.Request, _ *auth.UserCtx) error {
		t.Fatal("handler should not run when resolver returns nil user")
		return nil
	})

	rec := doRequest(t, rt, "GET", "/api/v1/authed")
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status: got %d, want 401", rec.Code)
	}
	code, _ := decodeErr(t, rec.Body.String())
	if code != "unauthenticated" {
		t.Errorf("code: got %q, want unauthenticated", code)
	}
}

func TestRouter_Authed_RejectsBadSession(t *testing.T) {
	// Resolver returns an error → 401 + cause is logged.
	rt := newRouter(resolverReturning(nil, errors.New("session expired")), nil)
	rt.Authed("/api/v1/authed", func(_ context.Context, _ http.ResponseWriter, _ *http.Request, _ *auth.UserCtx) error {
		t.Fatal("handler should not run on resolver error")
		return nil
	})

	rec := doRequest(t, rt, "GET", "/api/v1/authed")
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status: got %d, want 401", rec.Code)
	}
}

func TestRouter_Authed_RunsWithResolvedUser(t *testing.T) {
	want := fakeUser(42, "Alice")
	rt := newRouter(resolverReturning(want, nil), nil)

	var got *auth.UserCtx
	var ctxUser *auth.UserCtx
	rt.Authed("/api/v1/authed", func(ctx context.Context, w http.ResponseWriter, _ *http.Request, u *auth.UserCtx) error {
		got = u
		// Also confirm the user is attached to the context the
		// handler sees — existing handler code that reads
		// auth.FromContext should keep working.
		if c, ok := auth.FromContext(ctx); ok {
			ctxUser = c
		}
		w.WriteHeader(http.StatusOK)
		return nil
	})

	rec := doRequest(t, rt, "GET", "/api/v1/authed")
	if rec.Code != http.StatusOK {
		t.Errorf("status: got %d, want 200", rec.Code)
	}
	if got == nil || got.ID != want.ID {
		t.Errorf("user arg: got %+v, want %+v", got, want)
	}
	if ctxUser == nil || ctxUser.ID != want.ID {
		t.Errorf("user on ctx: got %+v, want %+v", ctxUser, want)
	}
}

func TestRouter_Bearer_UsesBearerResolver(t *testing.T) {
	// Bearer resolver returns a user; session resolver would reject —
	// the bearer route should pick the bearer resolver only.
	bearerUser := fakeUser(7, "AgentSmith")
	rt := newRouter(
		resolverReturning(nil, errors.New("no session")),
		resolverReturning(bearerUser, nil),
	)

	var got *auth.UserCtx
	rt.Bearer("/api/v1/mcp", func(_ context.Context, w http.ResponseWriter, _ *http.Request, u *auth.UserCtx) error {
		got = u
		w.WriteHeader(http.StatusOK)
		return nil
	})

	rec := doRequest(t, rt, "POST", "/api/v1/mcp")
	if rec.Code != http.StatusOK {
		t.Errorf("status: got %d, want 200", rec.Code)
	}
	if got == nil || got.ID != bearerUser.ID {
		t.Errorf("user arg: got %+v, want %+v", got, bearerUser)
	}
}

func TestRouter_Authed_PanicsWithoutSessionResolver(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected panic when SessionResolver is nil and Authed is registered")
		}
	}()
	rt := newRouter(nil, nil) // intentional: no session resolver
	rt.Authed("/api/v1/x", func(_ context.Context, _ http.ResponseWriter, _ *http.Request, _ *auth.UserCtx) error {
		return nil
	})
}

func TestRouter_Bearer_PanicsWithoutBearerResolver(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected panic when BearerResolver is nil and Bearer is registered")
		}
	}()
	rt := newRouter(nil, nil)
	rt.Bearer("/api/v1/x", func(_ context.Context, _ http.ResponseWriter, _ *http.Request, _ *auth.UserCtx) error {
		return nil
	})
}

func TestRouter_ErrorTranslation_HTTPError(t *testing.T) {
	rt := newRouter(resolverReturning(fakeUser(1, "x"), nil), nil)
	rt.Authed("/api/v1/forbidden", func(_ context.Context, _ http.ResponseWriter, _ *http.Request, _ *auth.UserCtx) error {
		return api.ErrForbidden
	})
	rt.Authed("/api/v1/notfound", func(_ context.Context, _ http.ResponseWriter, _ *http.Request, _ *auth.UserCtx) error {
		return api.NotFound("project not found")
	})

	rec := doRequest(t, rt, "GET", "/api/v1/forbidden")
	if rec.Code != http.StatusForbidden {
		t.Errorf("forbidden status: got %d, want 403", rec.Code)
	}
	code, _ := decodeErr(t, rec.Body.String())
	if code != "forbidden" {
		t.Errorf("forbidden code: got %q", code)
	}

	rec = doRequest(t, rt, "GET", "/api/v1/notfound")
	if rec.Code != http.StatusNotFound {
		t.Errorf("notfound status: got %d, want 404", rec.Code)
	}
	code, msg := decodeErr(t, rec.Body.String())
	if code != "not_found" || msg != "project not found" {
		t.Errorf("notfound payload: code=%q msg=%q", code, msg)
	}
}

func TestRouter_ErrorTranslation_WrappedHTTPError(t *testing.T) {
	rt := newRouter(resolverReturning(fakeUser(1, "x"), nil), nil)
	rt.Authed("/api/v1/wrapped", func(_ context.Context, _ http.ResponseWriter, _ *http.Request, _ *auth.UserCtx) error {
		// Regression: errors.As must climb the wrap chain. A handler
		// that adds context with fmt.Errorf must still surface the
		// embedded HTTPError's status + code.
		return fmt.Errorf("checking access to project 42: %w", api.ErrForbidden)
	})

	rec := doRequest(t, rt, "GET", "/api/v1/wrapped")
	if rec.Code != http.StatusForbidden {
		t.Errorf("status: got %d, want 403", rec.Code)
	}
	code, _ := decodeErr(t, rec.Body.String())
	if code != "forbidden" {
		t.Errorf("code: got %q, want forbidden", code)
	}
}

func TestRouter_ErrorTranslation_InternalCollapsesTo500(t *testing.T) {
	rt := newRouter(resolverReturning(fakeUser(1, "x"), nil), nil)
	rt.Authed("/api/v1/boom", func(_ context.Context, _ http.ResponseWriter, _ *http.Request, _ *auth.UserCtx) error {
		return errors.New("db is on fire")
	})

	rec := doRequest(t, rt, "GET", "/api/v1/boom")
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status: got %d, want 500", rec.Code)
	}
	code, msg := decodeErr(t, rec.Body.String())
	if code != "internal" {
		t.Errorf("code: got %q, want internal", code)
	}
	// Don't leak the inner error to the client.
	if strings.Contains(msg, "db is on fire") {
		t.Errorf("inner error leaked to wire: %q", msg)
	}
}

func TestRouter_ErrorTranslation_HandlerErrorBridge(t *testing.T) {
	// A handler bubbling a *reg.HandlerError (the dispatcher's wire
	// shape) up to writeErr should map cleanly to an HTTP status
	// instead of collapsing to 500.
	rt := newRouter(resolverReturning(fakeUser(1, "x"), nil), nil)
	rt.Authed("/api/v1/handler-err", func(_ context.Context, _ http.ResponseWriter, _ *http.Request, _ *auth.UserCtx) error {
		return &reg.HandlerError{Code: "validation", Message: "card_id is required"}
	})

	rec := doRequest(t, rt, "GET", "/api/v1/handler-err")
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status: got %d, want 400", rec.Code)
	}
	code, msg := decodeErr(t, rec.Body.String())
	if code != "validation" || msg != "card_id is required" {
		t.Errorf("payload: code=%q msg=%q", code, msg)
	}
}

func TestRouter_NilReturn_DoesNotWriteAgain(t *testing.T) {
	// Handler wrote its own response and returned nil. Router must
	// not stomp on it.
	rt := newRouter(resolverReturning(fakeUser(1, "x"), nil), nil)
	rt.Authed("/api/v1/ok", func(_ context.Context, w http.ResponseWriter, _ *http.Request, _ *auth.UserCtx) error {
		w.Header().Set("X-Custom", "hi")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"ok":true}`))
		return nil
	})

	rec := doRequest(t, rt, "POST", "/api/v1/ok")
	if rec.Code != http.StatusCreated {
		t.Errorf("status: got %d, want 201", rec.Code)
	}
	if got := rec.Header().Get("X-Custom"); got != "hi" {
		t.Errorf("custom header lost: got %q", got)
	}
	if !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Errorf("body: got %q", rec.Body.String())
	}
}
