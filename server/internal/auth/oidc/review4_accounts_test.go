package oidc_test

// Regression tests for the account findings of the fourth 2026-11-03
// review (#5, #12).

import (
	"context"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/auth/oidc"
	"github.com/kitp/kitp/server/internal/store"
)

type r4OIDC struct {
	pool   *pgxpool.Pool
	signIn func(sub, email string, verified bool) (int64, error)
}

func newR4OIDC(t *testing.T, schema string) r4OIDC {
	t.Helper()
	op := newFakeOP(t)
	pool := store.TestPool(t, schema)
	v := oidc.NewValidator(&oidc.Config{Issuer: op.server.URL, Audience: "kitp-web", DefaultRole: "worker"}, pool)
	ctx := context.Background()
	// The workspace had an admin once (no first-sign-in bootstrap), and has
	// none now.
	for _, q := range []string{
		`INSERT INTO admin_bootstrap (singleton, user_id) VALUES (true, 1) ON CONFLICT DO NOTHING`,
		`DELETE FROM user_role ur USING role r WHERE r.id = ur.role_id AND r.name = 'admin' AND ur.user_id <> 1`,
	} {
		if _, err := pool.Exec(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now()
	return r4OIDC{pool: pool, signIn: func(sub, email string, verified bool) (int64, error) {
		claims := jwt.MapClaims{"iss": op.server.URL, "aud": "kitp-web", "sub": sub, "name": sub, "exp": now.Add(time.Hour).Unix()}
		if email != "" {
			claims["email"] = email
			claims["email_verified"] = verified
		}
		uid, _, err := v.Resolve(ctx, op.signToken(t, claims))
		return uid, err
	}}
}

func (f r4OIDC) isAdmin(t *testing.T, uid int64) bool {
	t.Helper()
	var ok bool
	if err := f.pool.QueryRow(context.Background(), `
		SELECT EXISTS (SELECT 1 FROM user_role ur JOIN role r ON r.id = ur.role_id
		               WHERE ur.user_id = $1 AND r.name = 'admin' AND ur.scope_card_id IS NULL)`, uid).Scan(&ok); err != nil {
		t.Fatal(err)
	}
	return ok
}

func (f r4OIDC) revoke(t *testing.T, uid int64) {
	t.Helper()
	var ok bool
	if err := f.pool.QueryRow(context.Background(), `
		SELECT ok FROM user_revoke_login_batch(1, jsonb_build_array(jsonb_build_object('user_account_id', $1::bigint::text)))`, uid).Scan(&ok); err != nil || !ok {
		t.Fatalf("revoke: %v %v", ok, err)
	}
}

// TestInitAdminRecoversARevokedLogin (round 4 #5): recovery naming the email
// of a revoked login gives that person a working admin login, and doesn't
// leave a dead admin row that stalls the next recovery.
func TestInitAdminRecoversARevokedLogin(t *testing.T) {
	f := newR4OIDC(t, "kitp_test_r4_initadmin_revoked")
	ctx := context.Background()
	boss, err := f.signIn("sub-boss", "boss@example.com", true)
	if err != nil {
		t.Fatal(err)
	}
	f.revoke(t, boss)
	if err := auth.BootstrapInitAdmin(ctx, f.pool, "boss@example.com"); err != nil {
		t.Fatal(err)
	}
	if f.isAdmin(t, boss) {
		t.Error("recovery made the revoked login admin")
	}
	uid, err := f.signIn("sub-boss", "boss@example.com", true)
	if err != nil {
		t.Fatalf("the named person can't sign in after recovery: %v", err)
	}
	if !f.isAdmin(t, uid) {
		t.Errorf("the named person's sign-in (account %d) isn't admin", uid)
	}
}

// TestInitAdminIgnoresProjectAdminsAndUnverifiedEmails (round 4 #5): a
// project-scoped admin doesn't stop recovery, and an older login that only
// claimed the email unverified isn't the one made admin.
func TestInitAdminIgnoresProjectAdminsAndUnverifiedEmails(t *testing.T) {
	f := newR4OIDC(t, "kitp_test_r4_initadmin_unverified")
	ctx := context.Background()
	mal, err := f.signIn("sub-mallory", "boss@example.com", false)
	if err != nil {
		t.Fatal(err)
	}
	var proj int64
	if err := f.pool.QueryRow(ctx, `INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'project' RETURNING id`).Scan(&proj); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT $1, id, $2 FROM role WHERE name = 'admin'`, mal, proj); err != nil {
		t.Fatal(err)
	}
	if err := auth.BootstrapInitAdmin(ctx, f.pool, "boss@example.com"); err != nil {
		t.Fatal(err)
	}
	if f.isAdmin(t, mal) {
		t.Error("recovery made the login with the unverified email admin")
	}
	boss, err := f.signIn("sub-boss", "boss@example.com", true)
	if err != nil {
		t.Fatal(err)
	}
	if boss == mal || !f.isAdmin(t, boss) {
		t.Errorf("the verified owner of the email (account %d) isn't admin", boss)
	}
}

// TestRegrantAfterRevokeWithANewEmail (round 4 #12): a person whose login was
// revoked gets back in through a new grant with another email, or by the
// admin letting the old login sign in again.
func TestRegrantAfterRevokeWithANewEmail(t *testing.T) {
	f := newR4OIDC(t, "kitp_test_r4_regrant")
	ctx := context.Background()
	ann, err := f.signIn("sub-ann", "ann@old.example", true)
	if err != nil {
		t.Fatal(err)
	}
	var person int64
	if err := f.pool.QueryRow(ctx, `SELECT person_card_id FROM user_account_person WHERE user_account_id = $1`, ann).Scan(&person); err != nil {
		t.Fatal(err)
	}
	f.revoke(t, ann)
	var ok bool
	if err := f.pool.QueryRow(ctx, `
		SELECT ok FROM person_grant_account_batch(1,
			jsonb_build_array(jsonb_build_object('person_card_id', $1::bigint::text, 'email', 'ann@new.example')))`, person).Scan(&ok); err != nil || !ok {
		t.Fatalf("grant: %v %v", ok, err)
	}
	uid, err := f.signIn("sub-ann", "ann@new.example", true)
	if err != nil {
		t.Fatalf("sign-in after a grant with a new email: %v", err)
	}
	if uid == ann {
		t.Error("the sign-in reached the revoked login")
	}

	// Revoke again; this time the admin lets that login sign in again.
	f.revoke(t, uid)
	var restored bool
	if err := f.pool.QueryRow(ctx, `
		SELECT ok FROM user_restore_login_batch(1, jsonb_build_array(jsonb_build_object('user_account_id', $1::bigint::text)))`, uid).Scan(&restored); err != nil || !restored {
		t.Fatalf("restore: %v %v", restored, err)
	}
	again, err := f.signIn("sub-ann", "ann@new.example", true)
	if err != nil || again != uid {
		t.Fatalf("sign-in after restore: account %d, %v; want %d", again, err, uid)
	}
	var linked int64
	if err := f.pool.QueryRow(ctx, `SELECT person_card_id FROM user_account_person WHERE user_account_id = $1`, uid).Scan(&linked); err != nil || linked != person {
		t.Errorf("restored login linked to person %d (%v), want %d", linked, err, person)
	}
}
