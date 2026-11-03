package session_test

// Review B10: the session table holds the cookie's hash, never the cookie.

import (
	"context"
	"errors"
	"testing"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/auth/session"
	"github.com/kitp/kitp/server/internal/auth/token"
	"github.com/kitp/kitp/server/internal/store"
)

func TestSecretsAreStoredHashed(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_hashed_secrets")
	ctx := context.Background()

	sm := session.New(pool, session.Config{})
	cookie, err := sm.Create(ctx, auth.SystemUserID, "")
	if err != nil {
		t.Fatal(err)
	}
	tm := token.New(pool, token.Config{})
	bearer, err := tm.Create(ctx, auth.SystemUserID, "laptop", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ table, secret string }{{"session", cookie}, {"user_token", bearer}} {
		var raw, hashed int
		if err := pool.QueryRow(ctx, `SELECT count(*) FILTER (WHERE id = $1), count(*) FILTER (WHERE id = $2) FROM `+c.table,
			c.secret, auth.HashSecret(c.secret)).Scan(&raw, &hashed); err != nil {
			t.Fatal(err)
		}
		if raw != 0 || hashed != 1 {
			t.Errorf("%s: %d rows hold the secret, %d its hash; want 0 and 1", c.table, raw, hashed)
		}
	}

	if _, err := sm.Lookup(ctx, cookie); err != nil {
		t.Errorf("session lookup by its cookie: %v", err)
	}
	if _, err := tm.Lookup(ctx, bearer); err != nil {
		t.Errorf("token lookup by its value: %v", err)
	}
	// What a reader of the table sees doesn't work as a credential.
	if _, err := sm.Lookup(ctx, auth.HashSecret(cookie)); !errors.Is(err, session.ErrNotFound) {
		t.Errorf("the stored hash as a cookie: %v, want not found", err)
	}
	if _, err := tm.Lookup(ctx, auth.HashSecret(bearer)); !errors.Is(err, token.ErrNotFound) {
		t.Errorf("the stored hash as a token: %v, want not found", err)
	}

	// Touch, revoke: both by the hash.
	if err := sm.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	if err := tm.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	if err := sm.Revoke(ctx, cookie); err != nil {
		t.Fatal(err)
	}
	if err := tm.Revoke(ctx, bearer); err != nil {
		t.Fatal(err)
	}
	if _, err := sm.Lookup(ctx, cookie); !errors.Is(err, session.ErrExpired) {
		t.Errorf("a revoked session: %v, want expired", err)
	}
	if _, err := tm.Lookup(ctx, bearer); !errors.Is(err, token.ErrExpired) {
		t.Errorf("a revoked token: %v, want expired", err)
	}
}
