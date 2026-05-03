package auth_test

import (
	"context"
	"errors"
	"testing"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

// TestProductionRefusesOff covers N-SEC-5 / phase 4 deliverable: when env=
// production and mode=off, NewSystemUser returns the well-known refusal
// error without touching the DB.
func TestProductionRefusesOff(t *testing.T) {
	// We pass nil as pool because the guard fires before any DB access.
	_, err := auth.NewSystemUser(context.Background(), nil, "production", auth.ModeOff)
	if !errors.Is(err, auth.ProductionRefusalError) {
		t.Fatalf("got %v, want ProductionRefusalError", err)
	}
}

// TestSystemUserLoaded confirms the System User row is found and injected
// into a derived context.
func TestSystemUserLoaded(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_auth")
	u, err := auth.NewSystemUser(context.Background(), pool, "dev", auth.ModeOff)
	if err != nil {
		t.Fatalf("NewSystemUser: %v", err)
	}
	if u == nil || u.DisplayName != "System" || u.ID == 0 {
		t.Fatalf("System User not loaded correctly: %+v", u)
	}

	ctx := auth.WithUser(context.Background(), u)
	got, ok := auth.FromContext(ctx)
	if !ok || got == nil || got.ID != u.ID {
		t.Errorf("FromContext: %+v ok=%v", got, ok)
	}
}
