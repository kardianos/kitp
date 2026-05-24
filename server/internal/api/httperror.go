// Package api — HTTPError + sentinels for the apiRouter.
//
// Handlers register via Router.Authed/Public/Bearer return `error` and
// the router translates it into an HTTP response. To carry a specific
// status + wire code, return an `*HTTPError` (directly or wrapped via
// fmt.Errorf("...: %w", …)). Anything else collapses to 500 and is
// logged with the request id.
//
// Goal: every "this is a 403", "this is a 404" decision lives next to
// the failing check, not as a bespoke `http.Error(w, ..., 403)` call
// scattered across handlers. The wire shape ({code, message}) matches
// the existing reg.HandlerError envelope so the client doesn't notice
// the migration.
package api

import (
	"errors"
	"fmt"
)

// HTTPError is the single error shape an http handler returns when it
// wants a specific HTTP status / wire code. The router's writeErr
// recognises both bare returns (`return ErrForbidden`) and wrapped
// ones (`return fmt.Errorf("checking access: %w", ErrForbidden)`) via
// errors.As.
//
// Fields:
//   - Status  — HTTP status code to send.
//   - Code    — stable wire key ("not_found", "forbidden", …). The
//               client switches on this, so callers shouldn't invent
//               new codes ad-hoc; reuse one of the sentinels below or
//               add a new sentinel here.
//   - Message — human-readable summary. Surfaced to the client as-is;
//               keep it safe to display.
//   - Err     — optional wrapped cause. Never returned to the client;
//               logged by the router so operators can trace.
type HTTPError struct {
	Status  int
	Code    string
	Message string
	Err     error
}

func (e *HTTPError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%s: %s: %v", e.Code, e.Message, e.Err)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *HTTPError) Unwrap() error { return e.Err }

// Sentinel errors. Returned directly (`return ErrForbidden`) or
// wrapped (`fmt.Errorf("can't read project %d: %w", id, ErrNotFound)`).
// Both forms produce the documented status + wire code.
//
// When you need a custom Message at a call site, prefer the helper
// constructors below over modifying these in place (they're shared,
// so a struct-mutate would race).
var (
	ErrUnauthenticated = &HTTPError{Status: 401, Code: "unauthenticated", Message: "unauthenticated"}
	ErrForbidden       = &HTTPError{Status: 403, Code: "forbidden", Message: "not authorized"}
	ErrNotFound        = &HTTPError{Status: 404, Code: "not_found", Message: "not found"}
	ErrConflict        = &HTTPError{Status: 409, Code: "conflict", Message: "conflict"}
	ErrUnsupported     = &HTTPError{Status: 415, Code: "unsupported_media_type", Message: "unsupported media type"}
	ErrTooLarge        = &HTTPError{Status: 413, Code: "request_too_large", Message: "request too large"}
)

// BadRequest builds a 400 with the supplied wire code + message.
// `code` is required because "bad input" is too broad to be useful —
// the client should be able to switch on the specific failure
// ("validation", "missing_field", "bad_format", …).
func BadRequest(code, message string) *HTTPError {
	return &HTTPError{Status: 400, Code: code, Message: message}
}

// Internal wraps an underlying error as a 500. The message ("internal
// error") is fixed because we never want to leak server internals to
// the client; the wrapped err is logged by the router.
func Internal(err error) *HTTPError {
	return &HTTPError{Status: 500, Code: "internal", Message: "internal error", Err: err}
}

// Forbidden builds a 403 with a custom message. Use when the default
// "not authorized" isn't specific enough (e.g. "not authorized to
// export this project") — but keep the message safe to display.
func Forbidden(message string) *HTTPError {
	return &HTTPError{Status: 403, Code: "forbidden", Message: message}
}

// NotFound builds a 404 with a context-specific message
// (e.g. "project not found"). The wire code stays "not_found" so the
// client can switch on it uniformly.
func NotFound(message string) *HTTPError {
	return &HTTPError{Status: 404, Code: "not_found", Message: message}
}

// AsHTTPError unwraps `err` looking for an HTTPError anywhere in the
// chain. Returns nil, false when there isn't one — the router treats
// that as a 500.
func AsHTTPError(err error) (*HTTPError, bool) {
	var he *HTTPError
	if errors.As(err, &he) {
		return he, true
	}
	return nil, false
}
