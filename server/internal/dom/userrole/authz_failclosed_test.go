// authz_failclosed_test.go: SEC-7 / A6 — the user_role authz hooks must
// fail CLOSED (deny) when no DB pool is wired in production, instead of
// the historical fail-open that would let an unauthenticated/unscoped
// caller through.
//
// Internal test (package userrole) so it can null out the package-level
// authzPool directly and exercise the nil-pool branch without standing
// up a DB.
package userrole

import (
	"context"
	"testing"
)

func TestAuthzAdmin_NilPool_FailsClosedInProduction(t *testing.T) {
	prev := authzPool
	authzPool = nil
	t.Cleanup(func() { authzPool = prev })

	t.Setenv("ENV", "production")
	if err := authzAdmin(context.Background()); err == nil {
		t.Fatal("authzAdmin with nil pool in production must DENY (fail closed), got nil")
	}
}

func TestAuthzAdmin_NilPool_FailsOpenInDev(t *testing.T) {
	prev := authzPool
	authzPool = nil
	t.Cleanup(func() { authzPool = prev })

	t.Setenv("ENV", "dev")
	if err := authzAdmin(context.Background()); err != nil {
		t.Fatalf("authzAdmin with nil pool in dev should fail open (tests bypass Register): %v", err)
	}
}

// All four hooks share missingPoolDeny; assert the set wired into it
// denies under production so no hook is left fail-open by omission.
func TestAuthzHooks_NilPool_DenyInProduction(t *testing.T) {
	prev := authzPool
	authzPool = nil
	t.Cleanup(func() { authzPool = prev })

	t.Setenv("ENV", "production")
	ctx := context.Background()
	cases := map[string]func() error{
		"list":   func() error { return authzList(ctx, ListInput{UserID: 99}) },
		"set":    func() error { return authzSet(ctx, SetInput{UserID: 99, RoleName: "worker"}) },
		"revoke": func() error { return authzRevoke(ctx, RevokeInput{UserID: 99, RoleName: "worker"}) },
	}
	for name, fn := range cases {
		if err := fn(); err == nil {
			t.Errorf("authz%s with nil pool in production must deny, got nil", name)
		}
	}
}
