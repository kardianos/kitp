package oidc_test

// Regression tests for the account findings of the fifth 2026-11-03
// review (#6).

import (
	"context"
	"testing"

	"github.com/golang-jwt/jwt/v5"

	"github.com/kitp/kitp/server/internal/auth"
)

// storedEmail reads a login's user_account.email ("" when NULL).
func storedEmail(t *testing.T, f r4OIDC, uid int64) string {
	t.Helper()
	var email *string
	if err := f.pool.QueryRow(context.Background(), `SELECT email FROM user_account WHERE id = $1`, uid).Scan(&email); err != nil {
		t.Fatal(err)
	}
	if email == nil {
		return ""
	}
	return *email
}

// TestSilentIdPKeepsStoredEmail (#6): an IdP that sends no email_verified
// (Entra ID by default) doesn't take a login's stored email away; one that
// says email_verified: false does (TestUnverifiedStoredEmailIsCleared).
func TestSilentIdPKeepsStoredEmail(t *testing.T) {
	f := newR4OIDC(t, "kitp_test_r5_silent_idp")
	var uid int64
	if err := f.pool.QueryRow(context.Background(), `INSERT INTO user_account (display_name, oidc_sub, email) VALUES ('Boss', 'sub-boss', 'boss@example.com') RETURNING id`).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	if _, err := f.signInWith("sub-boss", jwt.MapClaims{"email": "boss@example.com"}); err != nil {
		t.Fatal(err)
	}
	if got := storedEmail(t, f, uid); got != "boss@example.com" {
		t.Errorf("stored email %q after a sign-in with no email_verified, want it kept", got)
	}
}

// TestEntraDomainVerifiedEmailIsTrusted (#6): Entra ID's xms_edov claim
// vouches for the email when email_verified is absent; a string "true"
// counts as true.
func TestEntraDomainVerifiedEmailIsTrusted(t *testing.T) {
	f := newR4OIDC(t, "kitp_test_r5_xms_edov")
	for _, c := range []struct {
		name  string
		extra jwt.MapClaims
		want  string
	}{
		{"xms_edov true", jwt.MapClaims{"email": "a@example.com", "xms_edov": true}, "a@example.com"},
		{"email_verified as a string", jwt.MapClaims{"email": "b@example.com", "email_verified": "true"}, "b@example.com"},
		{"xms_edov false", jwt.MapClaims{"email": "c@example.com", "xms_edov": false}, ""},
		{"nothing said", jwt.MapClaims{"email": "d@example.com"}, ""},
		{"email_verified false wins over xms_edov", jwt.MapClaims{"email": "e@example.com", "email_verified": false, "xms_edov": true}, ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			uid, err := f.signInWith("sub-"+c.name, c.extra)
			if err != nil {
				t.Fatal(err)
			}
			if got := storedEmail(t, f, uid); got != c.want {
				t.Errorf("stored email %q, want %q", got, c.want)
			}
		})
	}
}

// TestRecoveryReachesThePersonsOwnLogin (#6): a row recovery pre-created
// for KITP_INIT_ADMIN_EMAIL that nobody could sign in to doesn't stop
// recovery; once the person's own login holds the email (a trusted sign-in
// stores it), the next recovery makes that login admin.
func TestRecoveryReachesThePersonsOwnLogin(t *testing.T) {
	f := newR4OIDC(t, "kitp_test_r5_recovery_heals")
	ctx := context.Background()
	own, err := f.signIn("sub-boss", "", false)
	if err != nil {
		t.Fatal(err)
	}
	// Recovery, with the person's login holding no email: a pre-created row.
	if err := auth.BootstrapInitAdmin(ctx, f.pool, "boss@example.com"); err != nil {
		t.Fatal(err)
	}
	if f.isAdmin(t, own) {
		t.Fatal("the login with no email was made admin")
	}
	// The person signs in with a trusted email: their own login takes it.
	if _, err := f.signInWith("sub-boss", jwt.MapClaims{"email": "boss@example.com", "xms_edov": true}); err != nil {
		t.Fatal(err)
	}
	if err := auth.BootstrapInitAdmin(ctx, f.pool, "boss@example.com"); err != nil {
		t.Fatal(err)
	}
	if !f.isAdmin(t, own) {
		t.Error("recovery stayed stuck on the row nobody can sign in to")
	}
	// A changed recovery email still doesn't add a second admin.
	if err := auth.BootstrapInitAdmin(ctx, f.pool, "other@example.com"); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM user_account WHERE email = 'other@example.com'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Error("a second recovery email made another admin")
	}
}
