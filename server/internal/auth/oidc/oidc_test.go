package oidc_test

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth/oidc"
	"github.com/kitp/kitp/server/internal/store"
)

// fakeOP serves /.well-known/openid-configuration and /jwks for a single
// in-memory RSA key pair. signToken returns a freshly-minted JWT signed by
// the key, with the requested claims.
type fakeOP struct {
	server *httptest.Server
	priv   *rsa.PrivateKey
	kid    string
}

func newFakeOP(t *testing.T) *fakeOP {
	t.Helper()
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	op := &fakeOP{priv: priv, kid: "test-key-1"}
	mux := http.NewServeMux()
	op.server = httptest.NewServer(mux)
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"issuer":   op.server.URL,
			"jwks_uri": op.server.URL + "/jwks",
		})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, r *http.Request) {
		n := base64.RawURLEncoding.EncodeToString(priv.N.Bytes())
		eBytes := big.NewInt(int64(priv.E)).Bytes()
		e := base64.RawURLEncoding.EncodeToString(eBytes)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"keys": []map[string]any{
				{"kid": op.kid, "kty": "RSA", "alg": "RS256", "n": n, "e": e},
			},
		})
	})
	t.Cleanup(op.server.Close)
	return op
}

func (op *fakeOP) signToken(t *testing.T, claims jwt.MapClaims) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	tok.Header["kid"] = op.kid
	signed, err := tok.SignedString(op.priv)
	if err != nil {
		t.Fatal(err)
	}
	return signed
}

func TestValidateGoodToken(t *testing.T) {
	op := newFakeOP(t)
	pool := store.TestPool(t, "kitp_test_oidc_good")
	v := oidc.NewValidator(&oidc.Config{
		Issuer:      op.server.URL,
		Audience:    "kitp-web",
		RoleClaim:   "groups",
		DefaultRole: "worker",
	}, pool)

	ctx := context.Background()
	now := time.Now()
	tok := op.signToken(t, jwt.MapClaims{
		"iss":    op.server.URL,
		"aud":    "kitp-web",
		"sub":    "user-1",
		"email":  "user1@example.invalid",
		"name":   "Real Name",
		"groups": []string{"kitp.worker"},
		"exp":    now.Add(time.Hour).Unix(),
		"nbf":    now.Add(-time.Minute).Unix(),
		"iat":    now.Unix(),
	})

	id, name, err := v.Resolve(ctx, tok)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if id == 0 {
		t.Errorf("user id should be non-zero")
	}
	if name != "Real Name" {
		t.Errorf("name: %q want %q", name, "Real Name")
	}

	// Re-resolve hits the cache; same id.
	id2, _, err := v.Resolve(ctx, tok)
	if err != nil {
		t.Fatal(err)
	}
	if id2 != id {
		t.Errorf("re-resolve mismatch: %d vs %d", id2, id)
	}

	// Worker role should be present.
	var n int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM user_role ur
		JOIN role r ON r.id = ur.role_id
		WHERE ur.user_id = $1 AND r.name = 'worker'
	`, id).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("expected 1 worker grant; got %d", n)
	}
}

func TestValidateBadIssuer(t *testing.T) {
	op := newFakeOP(t)
	pool := store.TestPool(t, "kitp_test_oidc_iss")
	v := oidc.NewValidator(&oidc.Config{
		Issuer:    op.server.URL,
		Audience:  "kitp-web",
		RoleClaim: "groups",
	}, pool)

	now := time.Now()
	tok := op.signToken(t, jwt.MapClaims{
		"iss": "https://wrong-issuer.invalid",
		"aud": "kitp-web",
		"sub": "user-2",
		"exp": now.Add(time.Hour).Unix(),
	})
	if _, _, err := v.Resolve(context.Background(), tok); err == nil {
		t.Errorf("expected error for bad issuer")
	}
}

func TestValidateExpired(t *testing.T) {
	op := newFakeOP(t)
	pool := store.TestPool(t, "kitp_test_oidc_exp")
	v := oidc.NewValidator(&oidc.Config{
		Issuer:    op.server.URL,
		Audience:  "kitp-web",
		RoleClaim: "groups",
	}, pool)
	now := time.Now()
	tok := op.signToken(t, jwt.MapClaims{
		"iss": op.server.URL,
		"aud": "kitp-web",
		"sub": "user-3",
		"exp": now.Add(-time.Minute).Unix(),
	})
	if _, _, err := v.Resolve(context.Background(), tok); err == nil {
		t.Errorf("expected error for expired token")
	}
}

// TestProvisionCreatesPersonCard exercises the assignee-as-card branch of
// OIDC provisioning: first-sight of an oidc_sub creates a user_account row,
// a person card (with title + optional email attribute_values), and the
// user_account_person link in one tx. Table-driven over (with email,
// without email) to cover both branches of the optional email path.
func TestProvisionCreatesPersonCard(t *testing.T) {
	op := newFakeOP(t)
	pool := store.TestPool(t, "kitp_test_oidc_person")
	v := oidc.NewValidator(&oidc.Config{
		Issuer:   op.server.URL,
		Audience: "kitp-web",
	}, pool)
	ctx := context.Background()
	now := time.Now()

	cases := []struct {
		name      string
		sub       string
		display   string
		email     string
		wantEmail bool
	}{
		{name: "with email", sub: "p-with-email", display: "Person A", email: "p@example.invalid", wantEmail: true},
		{name: "no email", sub: "p-no-email", display: "Person B", email: "", wantEmail: false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			tok := op.signToken(t, jwt.MapClaims{
				"iss":  op.server.URL,
				"aud":  "kitp-web",
				"sub":  c.sub,
				"name": c.display,
				"email": c.email,
				"exp":  now.Add(time.Hour).Unix(),
			})
			userID, _, err := v.Resolve(ctx, tok)
			if err != nil {
				t.Fatalf("resolve: %v", err)
			}

			var personCardID int64
			if err := pool.QueryRow(ctx, `
				SELECT person_card_id FROM user_account_person WHERE user_account_id = $1
			`, userID).Scan(&personCardID); err != nil {
				t.Fatalf("link missing: %v", err)
			}

			var ctName, gotTitle string
			if err := pool.QueryRow(ctx, `
				SELECT ct.name, (av.value #>> '{}')
				FROM card c
				JOIN card_type ct ON ct.id = c.card_type_id
				LEFT JOIN attribute_value av ON av.card_id = c.id
				  AND av.attribute_def_id = (SELECT id FROM attribute_def WHERE name='title')
				WHERE c.id = $1
			`, personCardID).Scan(&ctName, &gotTitle); err != nil {
				t.Fatalf("person card: %v", err)
			}
			if ctName != "person" {
				t.Errorf("card_type = %q, want person", ctName)
			}
			if gotTitle != c.display {
				t.Errorf("title = %q, want %q", gotTitle, c.display)
			}

			var gotEmail *string
			if err := pool.QueryRow(ctx, `
				SELECT av.value #>> '{}'
				FROM attribute_value av
				WHERE av.card_id = $1
				  AND av.attribute_def_id = (SELECT id FROM attribute_def WHERE name='email')
			`, personCardID).Scan(&gotEmail); err != nil {
				if c.wantEmail {
					t.Fatalf("expected email row: %v", err)
				}
				// no-email branch: absent row is correct.
				return
			}
			if !c.wantEmail {
				t.Errorf("expected no email row; found %v", gotEmail)
			} else if gotEmail == nil || *gotEmail != c.email {
				t.Errorf("email = %v, want %q", gotEmail, c.email)
			}
		})
	}
}

// TestReloginPreservesInAppRename guards the rule that OIDC sets display_name
// only at first provision: once a user renames themselves in-app
// (user.set_display_name → user_account.display_name), a later login with a
// different IdP name claim must NOT clobber it. Email still syncs from the
// claim on re-login.
func TestReloginPreservesInAppRename(t *testing.T) {
	op := newFakeOP(t)
	pool := store.TestPool(t, "kitp_test_oidc_rename")
	v := oidc.NewValidator(&oidc.Config{
		Issuer:   op.server.URL,
		Audience: "kitp-web",
	}, pool)
	ctx := context.Background()
	now := time.Now()

	// First login provisions the row with the IdP-claimed name.
	first := op.signToken(t, jwt.MapClaims{
		"iss":   op.server.URL,
		"aud":   "kitp-web",
		"sub":   "rename-sub",
		"name":  "Idp Original",
		"email": "rename@example.invalid",
		"exp":   now.Add(time.Hour).Unix(),
	})
	userID, _, err := v.Resolve(ctx, first)
	if err != nil {
		t.Fatalf("first resolve: %v", err)
	}
	var got string
	if err := pool.QueryRow(ctx, `SELECT display_name FROM user_account WHERE id = $1`, userID).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != "Idp Original" {
		t.Fatalf("after first login display_name = %q, want %q", got, "Idp Original")
	}

	// Simulate an in-app rename (what user.set_display_name does).
	if _, err := pool.Exec(ctx, `UPDATE user_account SET display_name = 'My Custom Name' WHERE id = $1`, userID); err != nil {
		t.Fatal(err)
	}

	// Re-login with a DIFFERENT name + email claim. The changed claims miss
	// the sub cache, so provisionUser runs its re-login branch.
	second := op.signToken(t, jwt.MapClaims{
		"iss":   op.server.URL,
		"aud":   "kitp-web",
		"sub":   "rename-sub",
		"name":  "Idp Changed",
		"email": "rename2@example.invalid",
		"exp":   now.Add(time.Hour).Unix(),
	})
	id2, _, err := v.Resolve(ctx, second)
	if err != nil {
		t.Fatalf("second resolve: %v", err)
	}
	if id2 != userID {
		t.Fatalf("re-login resolved to a different user: %d vs %d", id2, userID)
	}

	var name, email string
	if err := pool.QueryRow(ctx, `SELECT display_name, coalesce(email, '') FROM user_account WHERE id = $1`, userID).Scan(&name, &email); err != nil {
		t.Fatal(err)
	}
	if name != "My Custom Name" {
		t.Errorf("re-login clobbered in-app name: display_name = %q, want %q", name, "My Custom Name")
	}
	if email != "rename2@example.invalid" {
		t.Errorf("re-login should still sync email: email = %q, want %q", email, "rename2@example.invalid")
	}
}

func TestProvisionAppliesMultipleRoles(t *testing.T) {
	op := newFakeOP(t)
	pool := store.TestPool(t, "kitp_test_oidc_roles")
	v := oidc.NewValidator(&oidc.Config{
		Issuer:    op.server.URL,
		Audience:  "kitp-web",
		RoleClaim: "groups",
	}, pool)

	ctx := context.Background()
	now := time.Now()
	tok := op.signToken(t, jwt.MapClaims{
		"iss":    op.server.URL,
		"aud":    "kitp-web",
		"sub":    "multi-role",
		"groups": []string{"kitp.admin", "kitp.worker"},
		"exp":    now.Add(time.Hour).Unix(),
	})
	id, _, err := v.Resolve(ctx, tok)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	var n int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM user_role WHERE user_id = $1
	`, id).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Errorf("expected 2 user_role rows for multi-role; got %d", n)
	}
}

// rolesOf returns the set of GLOBAL role names a user holds.
func rolesOf(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID int64) map[string]bool {
	t.Helper()
	rows, err := pool.Query(ctx, `
		SELECT r.name FROM user_role ur JOIN role r ON r.id = ur.role_id
		WHERE ur.user_id = $1 AND ur.scope_card_id IS NULL
	`, userID)
	if err != nil {
		t.Fatalf("rolesOf query: %v", err)
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("rolesOf scan: %v", err)
		}
		out[name] = true
	}
	return out
}

// TestProvisionRevokesUnmappedRoles is the authoritative-role-sync contract:
// when the OP sends the role claim, OIDC-granted roles the current claims no
// longer justify are revoked, while manual/admin grants survive; and when the
// claim is ABSENT the OP isn't asserting roles, so nothing is revoked.
func TestProvisionRevokesUnmappedRoles(t *testing.T) {
	op := newFakeOP(t)
	pool := store.TestPool(t, "kitp_test_oidc_revoke")
	v := oidc.NewValidator(&oidc.Config{
		Issuer:    op.server.URL,
		Audience:  "kitp-web",
		RoleClaim: "groups",
		// DefaultRole left empty so the claim-absent case grants nothing and
		// the only question under test is whether existing roles are kept.
	}, pool)
	ctx := context.Background()
	now := time.Now()
	const sub = "role-sync"

	resolve := func(groups any) int64 {
		t.Helper()
		claims := jwt.MapClaims{
			"iss": op.server.URL,
			"aud": "kitp-web",
			"sub": sub,
			"exp": now.Add(time.Hour).Unix(),
		}
		// A nil `groups` means "omit the claim entirely" (claim absent);
		// otherwise set it (present, used to map roles).
		if groups != nil {
			claims["groups"] = groups
		}
		id, _, err := v.Resolve(ctx, op.signToken(t, claims))
		if err != nil {
			t.Fatalf("resolve: %v", err)
		}
		return id
	}

	// 1) First login as a worker (claim present → role granted via OIDC).
	uid := resolve([]string{"kitp.worker"})
	if got := rolesOf(t, ctx, pool, uid); !got["worker"] || got["admin"] {
		t.Fatalf("after worker login: roles=%v, want {worker}", got)
	}

	// 2) Admin manually grants this user the 'manager' role (granted_via
	//    defaults to 'manual'). It must survive OIDC reconciliation.
	if _, err := pool.Exec(ctx, `
		INSERT INTO user_role (user_id, role_id, scope_card_id)
		SELECT $1, id, NULL FROM role WHERE name = 'manager'
	`, uid); err != nil {
		t.Fatalf("manual manager grant: %v", err)
	}

	// 3) Re-login with a DIFFERENT group (admin, worker removed). The OIDC
	//    'worker' grant must be revoked, 'admin' granted, 'manager' (manual)
	//    untouched.
	resolve([]string{"kitp.admin"})
	got := rolesOf(t, ctx, pool, uid)
	if got["worker"] {
		t.Error("worker role survived after the worker group was removed (not revoked)")
	}
	if !got["admin"] {
		t.Error("admin role not granted on re-login")
	}
	if !got["manager"] {
		t.Error("manual 'manager' grant was revoked by OIDC reconciliation")
	}

	// 4) Re-login with the role claim ABSENT. The OP isn't asserting roles,
	//    so reconciliation must NOT run — the OIDC 'admin' role survives.
	resolve(nil)
	got = rolesOf(t, ctx, pool, uid)
	if !got["admin"] {
		t.Error("admin (OIDC) role revoked on a login with no role claim — must be left alone")
	}
	if !got["manager"] {
		t.Error("manual 'manager' grant lost on claim-absent login")
	}
}

