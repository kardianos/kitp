package auth_test

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

// resetToInitMode wipes any non-System admin grants seeded by the
// demo data so the bootstrap helper sees a fresh "init mode" state
// regardless of which test pool fixture is in use.
func resetToInitMode(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		DELETE FROM user_role ur USING role r
		WHERE ur.role_id = r.id
		  AND r.name = 'admin'
		  AND ur.user_id <> $1
	`, auth.SystemUserID); err != nil {
		t.Fatalf("reset to init mode: %v", err)
	}
}

// TestBootstrapInitAdmin_EmptyEmailNoOp confirms an empty email
// short-circuits without touching the DB.
func TestBootstrapInitAdmin_EmptyEmailNoOp(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_init_admin_empty")
	if err := auth.BootstrapInitAdmin(context.Background(), pool, ""); err != nil {
		t.Fatalf("BootstrapInitAdmin(empty): %v", err)
	}
	if err := auth.BootstrapInitAdmin(context.Background(), pool, "   "); err != nil {
		t.Fatalf("BootstrapInitAdmin(blank): %v", err)
	}
}

// TestBootstrapInitAdmin_CreatesUserAndGrants exercises the
// happy-path init-mode bootstrap: empty DB → new user_account,
// person card, link, admin grant.
func TestBootstrapInitAdmin_CreatesUserAndGrants(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_init_admin_create")
	resetToInitMode(t, pool)
	ctx := context.Background()
	const email = "boot@example.com"

	if err := auth.BootstrapInitAdmin(ctx, pool, email); err != nil {
		t.Fatalf("BootstrapInitAdmin: %v", err)
	}

	// user_account row exists with the email and a NULL oidc_sub.
	var userID int64
	var oidcSub *string
	if err := pool.QueryRow(ctx, `
		SELECT id, oidc_sub FROM user_account WHERE email = $1
	`, email).Scan(&userID, &oidcSub); err != nil {
		t.Fatalf("lookup user_account: %v", err)
	}
	if oidcSub != nil {
		t.Errorf("oidc_sub should be NULL after bootstrap; got %q", *oidcSub)
	}

	// Linked person card exists.
	var personCardID int64
	if err := pool.QueryRow(ctx, `
		SELECT person_card_id FROM user_account_person WHERE user_account_id = $1
	`, userID).Scan(&personCardID); err != nil {
		t.Fatalf("lookup link: %v", err)
	}

	// Person card carries the expected attrs.
	var personKind string
	if err := pool.QueryRow(ctx, `
		SELECT av.value #>> '{}' FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1 AND ad.name = 'person_kind'
	`, personCardID).Scan(&personKind); err != nil {
		t.Fatalf("lookup person_kind: %v", err)
	}
	if personKind != "member" {
		t.Errorf("person_kind: got %q, want 'member'", personKind)
	}

	// Admin role granted globally.
	var n int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM user_role ur
		JOIN role r ON r.id = ur.role_id
		WHERE ur.user_id = $1 AND r.name = 'admin' AND ur.scope_card_id IS NULL
	`, userID).Scan(&n); err != nil {
		t.Fatalf("count admin grant: %v", err)
	}
	if n != 1 {
		t.Errorf("admin role grants: got %d, want 1", n)
	}
}

// TestBootstrapInitAdmin_Idempotent confirms a second call with the
// same email after the first succeeded is a no-op (no second user_role
// row, no duplicate person card).
func TestBootstrapInitAdmin_Idempotent(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_init_admin_idem")
	resetToInitMode(t, pool)
	ctx := context.Background()
	const email = "boot@example.com"

	if err := auth.BootstrapInitAdmin(ctx, pool, email); err != nil {
		t.Fatalf("first BootstrapInitAdmin: %v", err)
	}
	if err := auth.BootstrapInitAdmin(ctx, pool, email); err != nil {
		t.Fatalf("second BootstrapInitAdmin: %v", err)
	}

	// Exactly one user_account with this email.
	var nUsers int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM user_account WHERE email = $1`, email).Scan(&nUsers); err != nil {
		t.Fatalf("count users: %v", err)
	}
	if nUsers != 1 {
		t.Errorf("user_account rows for %q: got %d, want 1", email, nUsers)
	}

	// Exactly one admin role grant.
	var nGrants int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM user_role ur
		JOIN role r ON r.id = ur.role_id
		JOIN user_account ua ON ua.id = ur.user_id
		WHERE ua.email = $1 AND r.name = 'admin'
	`, email).Scan(&nGrants); err != nil {
		t.Fatalf("count grants: %v", err)
	}
	if nGrants != 1 {
		t.Errorf("admin role grants for %q: got %d, want 1", email, nGrants)
	}
}

// TestBootstrapInitAdmin_SkipsWhenAdminExists confirms that once any
// non-System admin exists, a second bootstrap with a *different*
// email is a no-op (we don't seed a second admin behind the
// operator's back).
func TestBootstrapInitAdmin_SkipsWhenAdminExists(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_init_admin_skip")
	resetToInitMode(t, pool)
	ctx := context.Background()

	if err := auth.BootstrapInitAdmin(ctx, pool, "first@example.com"); err != nil {
		t.Fatalf("first BootstrapInitAdmin: %v", err)
	}
	if err := auth.BootstrapInitAdmin(ctx, pool, "second@example.com"); err != nil {
		t.Fatalf("second BootstrapInitAdmin: %v", err)
	}

	// "second" user_account should NOT exist.
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM user_account WHERE email = $1`, "second@example.com").Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Errorf("expected no user_account for second email; got %d", n)
	}
}

// TestBootstrapInitAdmin_PreExistingUserAccount confirms that when
// the People admin UI already created the user_account (tier='user'
// path), bootstrap reuses it and just grants the admin role rather
// than inserting a duplicate person card.
func TestBootstrapInitAdmin_PreExistingUserAccount(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_init_admin_pre")
	resetToInitMode(t, pool)
	ctx := context.Background()
	const email = "pre@example.com"

	// Simulate an admin who has been pre-created via person.create
	// (tier='user'): just the user_account row, no person link yet.
	// We intentionally skip the person card so the test verifies that
	// bootstrap doesn't crash when the link is absent.
	var preID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO user_account (display_name, email) VALUES ($1, $1) RETURNING id
	`, email).Scan(&preID); err != nil {
		t.Fatalf("pre-create user_account: %v", err)
	}

	if err := auth.BootstrapInitAdmin(ctx, pool, email); err != nil {
		t.Fatalf("BootstrapInitAdmin: %v", err)
	}

	// Same user_account row got the admin grant (no second row created).
	var matchedID int64
	if err := pool.QueryRow(ctx, `SELECT id FROM user_account WHERE email = $1`, email).Scan(&matchedID); err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if matchedID != preID {
		t.Errorf("user_account id changed; pre=%d after=%d (bootstrap should reuse)", preID, matchedID)
	}

	var nGrants int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM user_role ur
		JOIN role r ON r.id = ur.role_id
		WHERE ur.user_id = $1 AND r.name = 'admin'
	`, preID).Scan(&nGrants); err != nil {
		t.Fatalf("count grants: %v", err)
	}
	if nGrants != 1 {
		t.Errorf("admin grants on pre-existing user: got %d, want 1", nGrants)
	}
}
