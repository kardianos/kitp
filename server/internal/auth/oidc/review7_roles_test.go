package oidc_test

// OIDC_ROLE_CLAIM=none (2026-11-05): kitp manages roles, the IdP only signs
// people in.

import (
	"context"
	"fmt"
	"sort"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/kitp/kitp/server/internal/auth/oidc"
	"github.com/kitp/kitp/server/internal/store"
)

func TestRoleClaimNoneSetting(t *testing.T) {
	cfg := oidc.FromEnv(func(k string) (string, bool) {
		switch k {
		case "OIDC_ISSUER":
			return "https://idp.example", true
		case "OIDC_ROLE_CLAIM":
			return "None", true
		}
		return "", false
	})
	if !cfg.KitpRoles || cfg.RoleClaim != "" {
		t.Errorf("OIDC_ROLE_CLAIM=None: KitpRoles %v, RoleClaim %q", cfg.KitpRoles, cfg.RoleClaim)
	}
	cfg = oidc.FromEnv(func(k string) (string, bool) {
		if k == "OIDC_ISSUER" {
			return "https://idp.example", true
		}
		return "", false
	})
	if cfg.KitpRoles || cfg.RoleClaim != "groups" {
		t.Errorf("default: KitpRoles %v, RoleClaim %q", cfg.KitpRoles, cfg.RoleClaim)
	}
}

// TestKitpManagedRoles: with KitpRoles a sign-in neither grants what its
// claims map to nor takes away what kitp gave; a first sign-in gets the
// default role as a kitp grant; AdoptIdPRoles keeps the roles earlier
// sign-ins brought.
func TestKitpManagedRoles(t *testing.T) {
	op := newFakeOP(t)
	pool := store.TestPool(t, "kitp_test_r7_kitp_roles")
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		INSERT INTO role_mapping (claim_value, role_id) SELECT 'kitp.admin', id FROM role WHERE name = 'admin'
		ON CONFLICT DO NOTHING`); err != nil {
		t.Fatal(err)
	}
	v := oidc.NewValidator(&oidc.Config{Issuer: op.server.URL, Audience: "kitp-web", DefaultRole: "worker", KitpRoles: true}, pool)
	now := time.Now()
	signIn := func(sub string, extra jwt.MapClaims) int64 {
		t.Helper()
		claims := jwt.MapClaims{"iss": op.server.URL, "aud": "kitp-web", "sub": sub, "name": sub, "exp": now.Add(time.Hour).Unix()}
		for k, val := range extra {
			claims[k] = val
		}
		uid, _, err := v.Resolve(ctx, op.signToken(t, claims))
		if err != nil {
			t.Fatal(err)
		}
		return uid
	}
	roles := func(uid int64) string {
		t.Helper()
		rows, err := pool.Query(ctx, `
			SELECT r.name || ':' || ur.granted_via FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = $1`, uid)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for rows.Next() {
			var s string
			if err := rows.Scan(&s); err != nil {
				t.Fatal(err)
			}
			out = append(out, s)
		}
		sort.Strings(out)
		return fmt.Sprint(out)
	}

	ada := signIn("sub-ada", jwt.MapClaims{"groups": []any{"kitp.admin"}})
	if got := roles(ada); got != "[worker:manual]" {
		t.Errorf("first sign-in: %s, want only the default role, as kitp's", got)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE user_role SET role_id = (SELECT id FROM role WHERE name = 'viewer') WHERE user_id = $1`, ada); err != nil {
		t.Fatal(err)
	}
	signIn("sub-ada", jwt.MapClaims{"groups": []any{}})
	if got := roles(ada); got != "[viewer:manual]" {
		t.Errorf("after kitp changed the role and Ada signed in again: %s, want [viewer:manual]", got)
	}

	// A role an earlier sign-in brought from the IdP.
	if _, err := pool.Exec(ctx, `
		INSERT INTO user_role (user_id, role_id, granted_via) SELECT $1, id, 'oidc' FROM role WHERE name = 'manager'`, ada); err != nil {
		t.Fatal(err)
	}
	n, err := oidc.AdoptIdPRoles(ctx, pool)
	if err != nil || n != 1 {
		t.Fatalf("AdoptIdPRoles: %d, %v; want 1", n, err)
	}
	signIn("sub-ada", jwt.MapClaims{"groups": []any{}})
	if got := roles(ada); got != "[manager:manual viewer:manual]" {
		t.Errorf("after adopting: %s, want both kept as kitp's", got)
	}
}
