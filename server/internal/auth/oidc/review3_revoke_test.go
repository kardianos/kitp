package oidc_test

// Regression tests for review 2026-11-03 round 3 #3 and #4: a login an
// admin took away stays away; an empty OIDC_DEFAULT_ROLE grants nothing.

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/kitp/kitp/server/internal/auth/oidc"
	"github.com/kitp/kitp/server/internal/store"
)

func TestRevokedLoginStaysRevoked(t *testing.T) {
	op := newFakeOP(t)
	pool := store.TestPool(t, "kitp_test_r3_oidc_revoke")
	v := oidc.NewValidator(&oidc.Config{Issuer: op.server.URL, Audience: "kitp-web", DefaultRole: "worker"}, pool)
	ctx := context.Background()
	now := time.Now()
	signIn := func(sub, email string) (int64, error) {
		t.Helper()
		tok := op.signToken(t, jwt.MapClaims{
			"iss": op.server.URL, "aud": "kitp-web", "sub": sub, "name": sub,
			"email": email, "email_verified": true, "exp": now.Add(time.Hour).Unix(),
		})
		uid, _, err := v.Resolve(ctx, tok)
		return uid, err
	}
	uid, err := signIn("sub-contractor", "con@example.com")
	if err != nil {
		t.Fatal(err)
	}
	var person int64
	if err := pool.QueryRow(ctx, `SELECT person_card_id FROM user_account_person WHERE user_account_id = $1`, uid).Scan(&person); err != nil {
		t.Fatal(err)
	}
	// The admin takes the login away (user.revoke_login's SQL).
	var ok bool
	if err := pool.QueryRow(ctx, `
		SELECT ok FROM user_revoke_login_batch(1, jsonb_build_array(jsonb_build_object('user_account_id', $1::bigint::text)))`, uid).Scan(&ok); err != nil || !ok {
		t.Fatalf("revoke: ok=%v err=%v", ok, err)
	}
	// Within the sub cache, and after it: refused.
	if _, err := signIn("sub-contractor", "con@example.com"); !errors.Is(err, oidc.ErrLoginRevoked) {
		t.Errorf("sign-in after revoke: %v, want ErrLoginRevoked", err)
	}
	// Another IdP subject with the same verified email: refused too.
	if _, err := signIn("sub-contractor-2", "con@example.com"); !errors.Is(err, oidc.ErrLoginRevoked) {
		t.Errorf("sign-in by another subject with the revoked email: %v, want ErrLoginRevoked", err)
	}
	var accounts, roles int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM user_account WHERE email = 'con@example.com' OR oidc_sub LIKE 'sub-contractor%'`).Scan(&accounts); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM user_role WHERE user_id = $1`, uid).Scan(&roles); err != nil {
		t.Fatal(err)
	}
	if accounts != 1 || roles != 0 {
		t.Errorf("after refused sign-ins: %d accounts, revoked one has %d roles; want 1 and 0", accounts, roles)
	}
	// An admin gives them a login again: the next sign-in reaches it.
	var granted string
	if err := pool.QueryRow(ctx, `
		SELECT result->>'user_account_id' FROM person_grant_account_batch(1,
			jsonb_build_array(jsonb_build_object('person_card_id', $1::bigint::text, 'email', 'con@example.com')))`, person).Scan(&granted); err != nil {
		t.Fatal(err)
	}
	again, err := signIn("sub-contractor", "con@example.com")
	if err != nil {
		t.Fatalf("sign-in after a new grant: %v", err)
	}
	if again == uid || granted == "" {
		t.Errorf("sign-in after a new grant reached account %d (revoked %d, granted %s)", again, uid, granted)
	}
}

func TestDefaultRoleEmptyMeansNone(t *testing.T) {
	for _, c := range []struct {
		env  map[string]string
		want string
	}{
		{map[string]string{"OIDC_ISSUER": "https://op.example"}, "worker"},
		{map[string]string{"OIDC_ISSUER": "https://op.example", "OIDC_DEFAULT_ROLE": ""}, ""},
		{map[string]string{"OIDC_ISSUER": "https://op.example", "OIDC_DEFAULT_ROLE": "none"}, ""},
		{map[string]string{"OIDC_ISSUER": "https://op.example", "OIDC_DEFAULT_ROLE": "viewer"}, "viewer"},
	} {
		cfg := oidc.FromEnv(func(k string) (string, bool) { v, ok := c.env[k]; return v, ok })
		if cfg.DefaultRole != c.want {
			t.Errorf("FromEnv(%v).DefaultRole = %q, want %q", c.env, cfg.DefaultRole, c.want)
		}
	}
}
