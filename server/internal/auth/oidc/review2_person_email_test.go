package oidc_test

// Regression test for review 2026-11-03 round 2 #5: a person card's email
// that a worker edited doesn't decide who signs in as that person, and
// person.grant_account never copies it.

import (
	"context"
	"strconv"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/kitp/kitp/server/internal/auth/oidc"
	"github.com/kitp/kitp/server/internal/store"
)

func TestSignInIgnoresAWorkerSetPersonEmail(t *testing.T) {
	op := newFakeOP(t)
	pool := store.TestPool(t, "kitp_test_r2_oidc_person_email")
	v := oidc.NewValidator(&oidc.Config{Issuer: op.server.URL, Audience: "kitp-web"}, pool)
	ctx := context.Background()
	now := time.Now()

	var worker, admin int64
	if err := pool.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ('Mallory') RETURNING id`).Scan(&worker); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ('Admin') RETURNING id`).Scan(&admin); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO user_role (user_id, role_id) SELECT $1, id FROM role WHERE name = 'admin'`, admin); err != nil {
		t.Fatal(err)
	}
	// setEmail writes a person's email as actor does through attribute.update.
	setEmail := func(person, actor int64, email string) {
		t.Helper()
		if _, err := pool.Exec(ctx, `
			WITH a AS (
				INSERT INTO activity (card_id, kind, attribute_def_id, value_new, actor_id)
				SELECT $1, 'attr_update', id, to_jsonb($3::text), $2 FROM attribute_def WHERE name = 'email'
				RETURNING id, attribute_def_id)
			UPDATE attribute_value av SET value = to_jsonb($3::text), last_activity_id = a.id
			FROM a WHERE av.card_id = $1 AND av.attribute_def_id = a.attribute_def_id`, person, actor, email); err != nil {
			t.Fatal(err)
		}
	}
	signIn := func(sub, email string) int64 {
		t.Helper()
		tok := op.signToken(t, jwt.MapClaims{
			"iss": op.server.URL, "aud": "kitp-web", "sub": sub, "name": sub,
			"email": email, "email_verified": true, "exp": now.Add(time.Hour).Unix(),
		})
		uid, _, err := v.Resolve(ctx, tok)
		if err != nil {
			t.Fatal(err)
		}
		var linked int64
		if err := pool.QueryRow(ctx, `SELECT person_card_id FROM user_account_person WHERE user_account_id = $1`, uid).Scan(&linked); err != nil {
			t.Fatal(err)
		}
		return linked
	}

	// A worker points a login-less approver at an identity of theirs.
	bob := seedPersonCard(t, pool, map[string]string{"title": "Bob", "email": "bob@corp.example", "person_kind": "member"})
	setEmail(bob, worker, "mallory.alt@gmail.example")
	if linked := signIn("mallory-alt", "mallory.alt@gmail.example"); linked == bob {
		t.Error("a sign-in took over a person through an email a worker set")
	}

	// An email an admin set is trusted, as is one kitp wrote itself.
	carol := seedPersonCard(t, pool, map[string]string{"title": "Carol", "email": "x@corp.example", "person_kind": "member"})
	setEmail(carol, admin, "carol@corp.example")
	if linked := signIn("carol-sub", "carol@corp.example"); linked != carol {
		t.Errorf("Carol's sign-in linked person %d, want her card %d (email set by an admin)", linked, carol)
	}

	// person.grant_account: the email is the request's, never the card's.
	dave := seedPersonCard(t, pool, map[string]string{"title": "Dave", "email": "dave@corp.example"})
	grant := func(body string) (bool, string) {
		t.Helper()
		var ok bool
		var code string
		if err := pool.QueryRow(ctx, `SELECT ok, code FROM person_grant_account_batch($1, $2::jsonb)`, admin, body).Scan(&ok, &code); err != nil {
			t.Fatal(err)
		}
		return ok, code
	}
	if ok, code := grant(`[{"person_card_id":"` + strconv.FormatInt(dave, 10) + `"}]`); ok || code != "validation" {
		t.Errorf("grant_account without an email: ok=%v code=%q, want validation", ok, code)
	}
	if ok, _ := grant(`[{"person_card_id":"` + strconv.FormatInt(dave, 10) + `","email":"dave@corp.example"}]`); !ok {
		t.Fatal("grant_account with an email failed")
	}
	if ok, code := grant(`[{"person_card_id":"` + strconv.FormatInt(dave, 10) + `","email":"other@corp.example"}]`); ok || code != "already_linked" {
		t.Errorf("grant_account with another email for a linked person: ok=%v code=%q, want already_linked", ok, code)
	}
}
