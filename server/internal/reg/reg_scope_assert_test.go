// reg_scope_assert_test.go: startup-assertion coverage for the
// per-row scope guard (BE-H3 / A2).
//
// A project-scoped (worker/manager) handler must let the dispatcher
// resolve a card id to scope-check against — either via a ScopeCardID
// resolver or a `card_id`/`target_card_id` input field. reg.Register
// panics at startup otherwise so the gap can't ship silently.
package reg

import (
	"context"
	"reflect"
	"testing"
)

// inputNoCardID has no card_id / target_card_id field — a gated
// handler using it must supply ScopeCardID or registration panics.
type inputNoCardID struct {
	CommID int64 `json:"comm_id,string"`
}

// inputWithCardID carries a card_id field, so the reflection-based
// extractor can resolve it without a ScopeCardID resolver.
type inputWithCardID struct {
	CardID int64 `json:"card_id,string"`
}

type dummyOut struct{}

func okCardType(context.Context, ValidationPool, any) (int64, error) { return 1, nil }
func okScope(context.Context, ValidationPool, any) (int64, error)    { return 1, nil }

func mustPanic(t *testing.T, name string, fn func()) {
	t.Helper()
	defer func() {
		if r := recover(); r == nil {
			t.Fatalf("%s: expected reg.Register to panic, it did not", name)
		}
	}()
	fn()
}

// TestRegister_GatedHandlerWithoutResolvableCardID_Panics proves the
// A2 assertion fires: a manager-gated handler whose input has no
// card_id field and no ScopeCardID resolver must panic at register.
func TestRegister_GatedHandlerWithoutResolvableCardID_Panics(t *testing.T) {
	Reset()
	t.Cleanup(Reset)
	mustPanic(t, "no card id + no ScopeCardID", func() {
		Register(Handler{
			Endpoint:     "test_scope",
			Action:       "no_card",
			Doc:          "x",
			InputType:    reflect.TypeFor[inputNoCardID](),
			OutputType:   reflect.TypeFor[dummyOut](),
			AllowedRoles: []string{"manager", "admin"},
			ProcessName:  "card.update",
			CardTypeID:   okCardType,
			SQLFunc:      "noop_batch",
		})
	})
}

// TestRegister_GatedHandlerWithScopeCardID_OK: the same handler with a
// ScopeCardID resolver registers cleanly.
func TestRegister_GatedHandlerWithScopeCardID_OK(t *testing.T) {
	Reset()
	t.Cleanup(Reset)
	Register(Handler{
		Endpoint:     "test_scope",
		Action:       "with_resolver",
		Doc:          "x",
		InputType:    reflect.TypeFor[inputNoCardID](),
		OutputType:   reflect.TypeFor[dummyOut](),
		AllowedRoles: []string{"manager", "admin"},
		ProcessName:  "card.update",
		CardTypeID:   okCardType,
		ScopeCardID:  okScope,
		SQLFunc:      "noop_batch",
	})
	if _, ok := Lookup("test_scope", "with_resolver"); !ok {
		t.Fatal("handler with ScopeCardID should register")
	}
}

// TestRegister_GatedHandlerWithCardIDField_OK: a card_id field is
// enough; no ScopeCardID needed.
func TestRegister_GatedHandlerWithCardIDField_OK(t *testing.T) {
	Reset()
	t.Cleanup(Reset)
	Register(Handler{
		Endpoint:     "test_scope",
		Action:       "with_field",
		Doc:          "x",
		InputType:    reflect.TypeFor[inputWithCardID](),
		OutputType:   reflect.TypeFor[dummyOut](),
		AllowedRoles: []string{"worker", "admin"},
		ProcessName:  "card.update",
		CardTypeID:   okCardType,
		SQLFunc:      "noop_batch",
	})
	if _, ok := Lookup("test_scope", "with_field"); !ok {
		t.Fatal("handler with card_id field should register")
	}
}
