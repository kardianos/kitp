// error_redaction_test.go: A5 (BE-M1 / BE-M2 / SEC-2) — the dispatcher
// must never copy raw Postgres / wrapped error text onto the wire.
//
// Internal test (package api) so it can reach the unexported
// mapPGError + errEnvelope choke points directly; the higher-level
// dispatcher tests in authz_test.go cover the end-to-end deny path.
package api

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/kitp/kitp/server/internal/reg"
)

// TestMapPGError_RedactsConstraintText proves a unique / fk / check
// violation maps to a stable client code with a GENERIC message — the
// raw pgErr.Message (which names the table, column and constraint) must
// not survive onto the HandlerError that becomes the wire envelope.
func TestMapPGError_RedactsConstraintText(t *testing.T) {
	h := reg.Handler{Endpoint: "card", Action: "insert"}
	// A realistic unique-violation as pgx would surface it: the Message
	// names the constraint, the Detail names the column + value.
	pgErr := &pgconn.PgError{
		Code:           "23505",
		Message:        `duplicate key value violates unique constraint "attribute_value_pkey"`,
		Detail:         `Key (card_id, attribute_def_id)=(42, 7) already exists.`,
		TableName:      "attribute_value",
		ConstraintName: "attribute_value_pkey",
	}
	mapped := mapPGError(h, pgErr)
	var he *reg.HandlerError
	if !errors.As(mapped, &he) {
		t.Fatalf("expected *reg.HandlerError, got %T (%v)", mapped, mapped)
	}
	if he.Code != "conflict" {
		t.Errorf("code: got %q want conflict", he.Code)
	}
	for _, leak := range []string{"attribute_value", "_pkey", "card_id", "duplicate key", "constraint", "42"} {
		if strings.Contains(he.Message, leak) {
			t.Errorf("wire message leaks %q: %q", leak, he.Message)
		}
	}
}

// TestMapPGError_PreservesRaiseException: P0001 (RAISE EXCEPTION) is the
// one author-controlled SQLSTATE; its message is curated, display-safe
// text and surfaces as-is.
func TestMapPGError_PreservesRaiseException(t *testing.T) {
	h := reg.Handler{Endpoint: "attribute", Action: "update"}
	pgErr := &pgconn.PgError{Code: "P0001", Message: "must be triage|active|terminal"}
	var he *reg.HandlerError
	if !errors.As(mapPGError(h, pgErr), &he) {
		t.Fatalf("expected *reg.HandlerError")
	}
	if he.Message != "must be triage|active|terminal" {
		t.Errorf("RAISE text should pass through: %q", he.Message)
	}
}

// TestMapPGError_WrapsUnmappedSQLSTATE: an unmapped SQLSTATE is NOT
// turned into a HandlerError with the raw text; it's wrapped so the
// dispatcher's errEnvelope can redact it downstream.
func TestMapPGError_WrapsUnmappedSQLSTATE(t *testing.T) {
	h := reg.Handler{Endpoint: "card", Action: "insert"}
	pgErr := &pgconn.PgError{Code: "42P01", Message: `relation "secret_table" does not exist`}
	mapped := mapPGError(h, pgErr)
	var he *reg.HandlerError
	if errors.As(mapped, &he) {
		t.Fatalf("unmapped SQLSTATE should NOT become a curated HandlerError, got %+v", he)
	}
	// And when run through errEnvelope it must redact to internal error.
	s := &Server{}
	code, msg, _ := s.errEnvelope(context.Background(), mapped, "handler_error")
	if code != "internal" || msg != "internal error" {
		t.Errorf("errEnvelope should redact unmapped pgError: got (%q,%q)", code, msg)
	}
	if strings.Contains(msg, "secret_table") {
		t.Errorf("wire message leaks table name: %q", msg)
	}
}

// TestErrEnvelope_RedactsWrappedError: any non-HandlerError (a wrapped
// scan / DB failure) collapses to the generic internal pair; a curated
// HandlerError passes through unchanged.
func TestErrEnvelope_RedactsWrappedError(t *testing.T) {
	s := &Server{}
	ctx := context.Background()

	// Wrapped internal error → redacted.
	wrapped := fmt.Errorf("authz: resolve card_type for card.insert: %w",
		errors.New(`pq: column "parent_user_id" does not exist`))
	code, msg, _ := s.errEnvelope(ctx, wrapped, "validation")
	if code != "internal" || msg != "internal error" {
		t.Errorf("wrapped error should redact: got (%q,%q)", code, msg)
	}
	if strings.Contains(msg, "parent_user_id") || strings.Contains(msg, "column") {
		t.Errorf("wire message leaks wrapped chain: %q", msg)
	}

	// Curated HandlerError → preserved.
	he := &reg.HandlerError{Code: "unauthorized", Message: "not authorized"}
	code, msg, _ = s.errEnvelope(ctx, he, "validation")
	if code != "unauthorized" || msg != "not authorized" {
		t.Errorf("curated HandlerError should pass through: got (%q,%q)", code, msg)
	}

	// HandlerError with empty code picks up the default.
	he2 := &reg.HandlerError{Message: "denied"}
	code, _, _ = s.errEnvelope(ctx, he2, "unauthorized")
	if code != "unauthorized" {
		t.Errorf("empty code should default: got %q", code)
	}
}
