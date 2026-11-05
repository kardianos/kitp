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
	// signInWith signs in with sub plus exactly the extra claims given.
	signInWith func(sub string, extra jwt.MapClaims) (int64, error)
}

func newR4OIDC(t *testing.T, schema string) r4OIDC {
	t.Helper()
	return newR4OIDCTrusting(t, schema, oidc.EmailVerifiedOnly)
}

// newR4OIDCTrusting is newR4OIDC with the given email trust.
func newR4OIDCTrusting(t *testing.T, schema string, trust oidc.EmailTrust) r4OIDC {
	t.Helper()
	op := newFakeOP(t)
	pool := store.TestPool(t, schema)
	v := oidc.NewValidator(&oidc.Config{Issuer: op.server.URL, Audience: "kitp-web", DefaultRole: "worker", EmailTrust: trust}, pool)
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
	signInWith := func(sub string, extra jwt.MapClaims) (int64, error) {
		claims := jwt.MapClaims{"iss": op.server.URL, "aud": "kitp-web", "sub": sub, "name": sub, "exp": now.Add(time.Hour).Unix()}
		for k, v := range extra {
			claims[k] = v
		}
		uid, _, err := v.Resolve(ctx, op.signToken(t, claims))
		return uid, err
	}
	return r4OIDC{pool: pool, signInWith: signInWith, signIn: func(sub, email string, verified bool) (int64, error) {
		extra := jwt.MapClaims{}
		if email != "" {
			extra["email"] = email
			extra["email_verified"] = verified
		}
		return signInWith(sub, extra)
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

// TestEmailTrustIsJudgedWhenWritten (round 4 follow-up): a person email a
// worker set stays untrusted after that worker is made admin.
func TestEmailTrustIsJudgedWhenWritten(t *testing.T) {
	f := newR4OIDC(t, "kitp_test_r5_trust_at_write")
	ctx := context.Background()
	var worker, person int64
	if err := f.pool.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ('Mallory') RETURNING id`).Scan(&worker); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(ctx, `
		WITH p AS (INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'person' RETURNING id),
		     a AS (INSERT INTO activity (card_id, kind, attribute_def_id, value_new, actor_id)
		           SELECT p.id, 'attr_update', ad.id, to_jsonb('victim@example.com'::text), $1
		           FROM p, attribute_def ad WHERE ad.name = 'email' RETURNING id, card_id, attribute_def_id)
		INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
		SELECT a.card_id, a.attribute_def_id, to_jsonb('victim@example.com'::text), a.id FROM a
		RETURNING card_id`, worker).Scan(&person); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `INSERT INTO user_role (user_id, role_id) SELECT $1, id FROM role WHERE name = 'admin'`, worker); err != nil {
		t.Fatal(err)
	}
	uid, err := f.signIn("sub-victim", "victim@example.com", true)
	if err != nil {
		t.Fatal(err)
	}
	var linked int64
	if err := f.pool.QueryRow(ctx, `SELECT person_card_id FROM user_account_person WHERE user_account_id = $1`, uid).Scan(&linked); err != nil {
		t.Fatal(err)
	}
	if linked == person {
		t.Error("a sign-in reused a person by an email a worker set before being made admin")
	}
}

// TestUnverifiedStoredEmailIsCleared (round 4 follow-up): a login whose
// stored email came from an unverified claim loses it on its next sign-in
// with that claim.
func TestUnverifiedStoredEmailIsCleared(t *testing.T) {
	f := newR4OIDC(t, "kitp_test_r5_clear_unverified")
	ctx := context.Background()
	var uid int64
	if err := f.pool.QueryRow(ctx, `INSERT INTO user_account (display_name, oidc_sub, email) VALUES ('Mal', 'sub-mal', 'boss@example.com') RETURNING id`).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	if _, err := f.signIn("sub-mal", "boss@example.com", false); err != nil {
		t.Fatal(err)
	}
	var email *string
	if err := f.pool.QueryRow(ctx, `SELECT email FROM user_account WHERE id = $1`, uid).Scan(&email); err != nil {
		t.Fatal(err)
	}
	if email != nil {
		t.Errorf("stored email %q survived a sign-in with it unverified", *email)
	}
}

// TestMailMadeContactIsRetitled (round 4 follow-up): a contact card kitp
// made from mail takes the sign-in's name when its owner signs in.
func TestMailMadeContactIsRetitled(t *testing.T) {
	f := newR4OIDC(t, "kitp_test_r5_retitle")
	ctx := context.Background()
	var person int64
	if err := f.pool.QueryRow(ctx, `
		WITH p AS (INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'person' RETURNING id),
		     v AS (INSERT INTO attribute_value (card_id, attribute_def_id, value)
		           SELECT p.id, ad.id, x.v FROM p, attribute_def ad,
		                  (VALUES ('email', to_jsonb('real@example.com'::text)),
		                          ('title', to_jsonb('IT Security Desk'::text)),
		                          ('person_kind', to_jsonb('contact'::text))) AS x(n, v)
		           WHERE ad.name = x.n)
		SELECT id FROM p`).Scan(&person); err != nil {
		t.Fatal(err)
	}
	uid, err := f.signIn("sub-real", "real@example.com", true)
	if err != nil {
		t.Fatal(err)
	}
	var linked int64
	var title string
	if err := f.pool.QueryRow(ctx, `
		SELECT uap.person_card_id, (SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
		                            WHERE av.card_id = uap.person_card_id AND ad.name = 'title')
		FROM user_account_person uap WHERE uap.user_account_id = $1`, uid).Scan(&linked, &title); err != nil {
		t.Fatal(err)
	}
	if linked != person || title != "sub-real" {
		t.Errorf("linked %d (want %d), title %q (want the sign-in's name)", linked, person, title)
	}
}
