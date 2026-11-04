package session_test

// A revoked login's sessions and tokens stop working, even ones made after
// the revoke (a sign-in in flight), and so do its agents' tokens (review
// 2026-11-03 round 4).

import (
	"context"
	"testing"

	"github.com/kitp/kitp/server/internal/auth/session"
	"github.com/kitp/kitp/server/internal/auth/token"
	"github.com/kitp/kitp/server/internal/store"
)

func TestRevokedLoginCredentialsStopWorking(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_r5_revoked_creds")
	ctx := context.Background()
	var owner, agent int64
	if err := pool.QueryRow(ctx, `INSERT INTO user_account (display_name, oidc_sub) VALUES ('Leaver', 'sub-leaver') RETURNING id`).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO user_account (display_name, is_agent, parent_user_id) VALUES ('bot', true, $1) RETURNING id`, owner).Scan(&agent); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE user_account SET login_revoked_at = now() WHERE id = $1`, owner); err != nil {
		t.Fatal(err)
	}
	sm := session.New(pool, session.Config{})
	cookie, err := sm.Create(ctx, owner, "sub-leaver") // made after the revoke
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sm.Lookup(ctx, cookie); err == nil {
		t.Error("a session of a revoked login works")
	}
	tm := token.New(pool, token.Config{})
	own, err := tm.Create(ctx, owner, "laptop", nil)
	if err != nil {
		t.Fatal(err)
	}
	bot, err := tm.Create(ctx, agent, "ci", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tm.Lookup(ctx, own); err == nil {
		t.Error("a token of a revoked login works")
	}
	if _, err := tm.Lookup(ctx, bot); err == nil {
		t.Error("a token of an agent whose owner's login was revoked works")
	}
}
