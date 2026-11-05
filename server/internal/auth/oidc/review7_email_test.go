package oidc_test

// A sign-in's email joins the person's addresses (docs/EMAIL_ADDRESSES.md).

import (
	"context"
	"testing"

	"github.com/golang-jwt/jwt/v5"

	"github.com/kitp/kitp/server/internal/auth/oidc"
)

// TestRenamedSignInEmail: after the IdP renames someone's email, their next
// sign-in adds the new address and makes it the primary (the old one was
// the primary), keeping the old one on the list.
func TestRenamedSignInEmail(t *testing.T) {
	f := newR4OIDCTrusting(t, "kitp_test_r7_renamed_email", oidc.EmailUnlessRefused)
	ctx := context.Background()
	uid, err := f.signInWith("sub-ada", jwt.MapClaims{"email": "ada@corp.example"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.signInWith("sub-ada", jwt.MapClaims{"email": "ada.lovelace@corp.example"}); err != nil {
		t.Fatal(err)
	}
	var primary, login string
	var addrs []string
	if err := f.pool.QueryRow(ctx, `
		SELECT COALESCE((SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
		                 WHERE av.card_id = uap.person_card_id AND ad.name = 'email'), ''),
		       ua.email,
		       ARRAY(SELECT pe.email FROM person_email pe WHERE pe.person_card_id = uap.person_card_id AND pe.verified_at IS NOT NULL ORDER BY pe.email)
		FROM user_account ua JOIN user_account_person uap ON uap.user_account_id = ua.id WHERE ua.id = $1`, uid).Scan(&primary, &login, &addrs); err != nil {
		t.Fatal(err)
	}
	if primary != "ada.lovelace@corp.example" || login != "ada.lovelace@corp.example" {
		t.Errorf("after the rename: primary %q, login %q; want the new address for both", primary, login)
	}
	if len(addrs) != 2 {
		t.Errorf("verified addresses %v, want the old and the new", addrs)
	}
}
