package oidc_test

// Email trust by default (2026-11-05): an email the IdP doesn't mark
// unverified is believed unless KITP_OIDC_TRUST_UNVERIFIED_EMAIL=0.

import (
	"context"
	"testing"

	"github.com/golang-jwt/jwt/v5"

	"github.com/kitp/kitp/server/internal/auth/oidc"
)

func TestEmailTrustSetting(t *testing.T) {
	for _, c := range []struct {
		set  bool
		v    string
		want oidc.EmailTrust
	}{
		{false, "", oidc.EmailUnlessRefused},
		{true, "", oidc.EmailUnlessRefused},
		{true, "0", oidc.EmailVerifiedOnly},
		{true, "false", oidc.EmailVerifiedOnly},
		{true, "1", oidc.EmailAlways},
	} {
		cfg := oidc.FromEnv(func(k string) (string, bool) {
			switch k {
			case "OIDC_ISSUER":
				return "https://idp.example", true
			case "KITP_OIDC_TRUST_UNVERIFIED_EMAIL":
				return c.v, c.set
			}
			return "", false
		})
		if cfg.EmailTrust != c.want {
			t.Errorf("KITP_OIDC_TRUST_UNVERIFIED_EMAIL set=%v %q: %v, want %v", c.set, c.v, cfg.EmailTrust, c.want)
		}
	}
	if _, err := oidc.ParseEmailTrust("maybe"); err == nil {
		t.Error("KITP_OIDC_TRUST_UNVERIFIED_EMAIL=maybe accepted")
	}
}

// TestSilentEmailLinksByDefault: with the default trust, a first sign-in
// whose IdP says nothing of its email (Entra ID) attaches to the account an
// admin set up with that email; one the IdP marks unverified doesn't, and
// with 0 neither does the silent one.
func TestSilentEmailLinksByDefault(t *testing.T) {
	for _, c := range []struct {
		name   string
		trust  oidc.EmailTrust
		claims jwt.MapClaims
		attach bool
	}{
		{"default, silent", oidc.EmailUnlessRefused, jwt.MapClaims{"email": "ada@example.com"}, true},
		{"default, marked unverified", oidc.EmailUnlessRefused, jwt.MapClaims{"email": "ada@example.com", "email_verified": false}, false},
		{"0, silent", oidc.EmailVerifiedOnly, jwt.MapClaims{"email": "ada@example.com"}, false},
		// Entra ID saying the domain isn't verified for the tenant (review
		// 2026-11-05 round 6 #8).
		{"default, xms_edov false", oidc.EmailUnlessRefused, jwt.MapClaims{"email": "ada@example.com", "xms_edov": false}, false},
		{"default, xms_edov true", oidc.EmailUnlessRefused, jwt.MapClaims{"email": "ada@example.com", "xms_edov": true}, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newR4OIDCTrusting(t, "kitp_test_r7_trust_default", c.trust)
			ctx := context.Background()
			var pre int64
			if err := f.pool.QueryRow(ctx, `INSERT INTO user_account (display_name, email) VALUES ('Ada', 'ada@example.com') RETURNING id`).Scan(&pre); err != nil {
				t.Fatal(err)
			}
			uid, err := f.signInWith("sub-ada", c.claims)
			if err != nil {
				t.Fatal(err)
			}
			if got := uid == pre; got != c.attach {
				t.Errorf("attached to the set-up account: %v, want %v", got, c.attach)
			}
		})
	}
}
