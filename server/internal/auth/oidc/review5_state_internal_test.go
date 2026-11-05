package oidc

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/kitp/kitp/server/internal/store"
)

// TestStateIsReaped (review 2026-11-03 round 5 #7): expired sign-in state
// rows are deleted by ReapState (the oidc.state_reap job); live ones stay.
func TestStateIsReaped(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_r5_state_reap")
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		INSERT INTO oidc_state (state, verifier, redirect, nonce, expires_at)
		SELECT 'old-' || g, 'v', '/', 'n', now() - interval '1 minute' FROM generate_series(1, 50) g
		UNION ALL
		SELECT 'live', 'v', '/', 'n', now() + interval '5 minutes'`); err != nil {
		t.Fatal(err)
	}
	if err := ReapState(ctx, pool); err != nil {
		t.Fatal(err)
	}
	var left []string
	rows, err := pool.Query(ctx, `SELECT state FROM oidc_state ORDER BY state`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			t.Fatal(err)
		}
		left = append(left, s)
	}
	if len(left) != 1 || left[0] != "live" {
		t.Errorf("after the reap: %v, want only the live row", left)
	}
}

// TestStartsAreLimited (#7): one address gets its burst of starts, then is
// refused; another address still starts.
func TestStartsAreLimited(t *testing.T) {
	g := newStartGate(nil)
	req := func(addr string) *http.Request {
		r := httptest.NewRequest(http.MethodGet, "/api/v1/auth/oidc/start", nil)
		r.RemoteAddr = addr
		return r
	}
	for i := 0; i < startsPerAddressBurst; i++ {
		if !g.allow(req("203.0.113.7:4000")) {
			t.Fatalf("start %d refused within the burst", i+1)
		}
	}
	if g.allow(req("203.0.113.7:4001")) {
		t.Error("a start past the burst went through")
	}
	if !g.allow(req("198.51.100.9:4000")) {
		t.Error("another address was refused")
	}
}
