package obs_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/obs"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// TestIdempotencyKey_Replay verifies that two POST /api/v1/batch with
// the same Idempotency-Key (and the same body) return identical
// responses and the underlying side-effect (card insert) only happens
// once.
func TestIdempotencyKey_Replay(t *testing.T) {
	pool, srv, pgPool := setup(t, "kitp_test_idem_replay")

	body := batchBody(t, []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P-idem"}`)},
	})

	// First call.
	resp1 := mustHTTP(t, srv, body, "k-1")
	if resp1.StatusCode != http.StatusOK {
		t.Fatalf("first status: %d", resp1.StatusCode)
	}
	body1, _ := io.ReadAll(resp1.Body)
	resp1.Body.Close()
	// Second call (same key, same body).
	resp2 := mustHTTP(t, srv, body, "k-1")
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("second status: %d", resp2.StatusCode)
	}
	if got := resp2.Header.Get("Idempotency-Replay"); got != "true" {
		t.Errorf("expected Idempotency-Replay=true, got %q", got)
	}
	body2, _ := io.ReadAll(resp2.Body)
	resp2.Body.Close()

	// Compare semantically — the stored response is round-tripped via
	// jsonb so whitespace can differ from the live response. Re-encode
	// both to canonical compact JSON and assert byte equality.
	c1, c2 := canonicalJSON(t, body1), canonicalJSON(t, body2)
	if !bytes.Equal(c1, c2) {
		t.Fatalf("bodies differ:\n--- first ---\n%s\n--- second ---\n%s", c1, c2)
	}

	// Verify the card row was inserted exactly once.
	var n int
	if err := pgPool.QueryRow(context.Background(),
		`SELECT count(*) FROM card c JOIN attribute_value av ON av.card_id=c.id
		 JOIN attribute_def ad ON ad.id=av.attribute_def_id
		 WHERE ad.name='title' AND av.value='"P-idem"'::jsonb`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("card count: got %d, want 1", n)
	}
	_ = pool
}

// TestIdempotencyKey_BodyMismatchRejected verifies that reusing the same
// key with a different body returns 422.
func TestIdempotencyKey_BodyMismatchRejected(t *testing.T) {
	_, srv, _ := setup(t, "kitp_test_idem_mismatch")

	body1 := batchBody(t, []api.SubRequest{
		{ID: "p", Endpoint: "echo", Action: "ping", Data: json.RawMessage(`{"x":1,"message":"a"}`)},
	})
	body2 := batchBody(t, []api.SubRequest{
		{ID: "p", Endpoint: "echo", Action: "ping", Data: json.RawMessage(`{"x":2,"message":"b"}`)},
	})

	r1 := mustHTTP(t, srv, body1, "k-x")
	r1.Body.Close()
	if r1.StatusCode != http.StatusOK {
		t.Fatalf("first: %d", r1.StatusCode)
	}
	r2 := mustHTTP(t, srv, body2, "k-x")
	defer r2.Body.Close()
	if r2.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("second status: got %d, want 422", r2.StatusCode)
	}
}

// TestIdempotencyKey_NoKeyPassthrough confirms that omitting
// Idempotency-Key bypasses the middleware entirely.
func TestIdempotencyKey_NoKeyPassthrough(t *testing.T) {
	_, srv, _ := setup(t, "kitp_test_idem_none")

	body := batchBody(t, []api.SubRequest{
		{ID: "p", Endpoint: "echo", Action: "ping", Data: json.RawMessage(`{"x":7}`)},
	})

	r := mustHTTP(t, srv, body, "")
	defer r.Body.Close()
	if r.StatusCode != http.StatusOK {
		t.Fatalf("status: %d", r.StatusCode)
	}
	if r.Header.Get("Idempotency-Replay") != "" {
		t.Errorf("unexpected Idempotency-Replay header without a key")
	}
}

// TestIdempotency_WrapAuthed_PartitionsByUser is the regression
// test for the original cache-cross-user bug (issues/backend/
// 01-critical-idempotency-cross-user.md). Two distinct users post
// the same key+body. With the wrong implementation (the legacy
// Middleware path that reads auth.ActorOrSystem(ctx) before the
// router has resolved the user), both calls partition under
// SystemUserID and the second user sees the first user's cached
// response. With WrapAuthed, the user is supplied directly, so the
// keys partition correctly.
func TestIdempotency_WrapAuthed_PartitionsByUser(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_idem_partition")
	logger := obs.NewLoggerTo("warn", io.Discard)
	idem := obs.NewIdempotencyStore(pool, logger)

	alice := &auth.UserCtx{ID: 9001, DisplayName: "alice"}
	bob := &auth.UserCtx{ID: 9002, DisplayName: "bob"}

	// Inner handler echoes the calling user's id so the test can
	// tell whose cached body it's getting back.
	calls := 0
	inner := api.AuthedHandler(func(_ context.Context, w http.ResponseWriter, _ *http.Request, u *auth.UserCtx) error {
		calls++
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = fmt.Fprintf(w, `{"user_id":%d}`, u.ID)
		return nil
	})
	wrapped := idem.WrapAuthed(inner)

	body := []byte(`{"shared":"body"}`)

	doPost := func(u *auth.UserCtx) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest("POST", "/api/v1/batch", bytes.NewReader(body))
		req.Header.Set("Idempotency-Key", "shared-key")
		rec := httptest.NewRecorder()
		if err := wrapped(context.Background(), rec, req, u); err != nil {
			t.Fatalf("wrapped: %v", err)
		}
		return rec
	}

	// Alice POSTs first — miss, handler runs, response stored under
	// Alice's user_id.
	r1 := doPost(alice)
	if r1.Code != http.StatusOK {
		t.Fatalf("alice first: status %d", r1.Code)
	}
	if !bytes.Contains(r1.Body.Bytes(), []byte(`9001`)) {
		t.Fatalf("alice first: body %q", r1.Body.String())
	}
	if r1.Header().Get("Idempotency-Replay") == "true" {
		t.Fatal("alice first should NOT be a replay")
	}

	// Bob POSTs the same key+body. Different user — must NOT replay
	// alice's stored body. Must run the handler against Bob and emit
	// Bob's user_id.
	r2 := doPost(bob)
	if r2.Code != http.StatusOK {
		t.Fatalf("bob: status %d", r2.Code)
	}
	if r2.Header().Get("Idempotency-Replay") == "true" {
		t.Fatal("bob saw alice's cached response — cross-user partition broken")
	}
	if !bytes.Contains(r2.Body.Bytes(), []byte(`9002`)) {
		t.Fatalf("bob: expected user_id=9002 in body, got %q", r2.Body.String())
	}

	// Alice POSTs again — same key+body, same user. SHOULD replay.
	r3 := doPost(alice)
	if r3.Code != http.StatusOK {
		t.Fatalf("alice second: status %d", r3.Code)
	}
	if r3.Header().Get("Idempotency-Replay") != "true" {
		t.Fatal("alice second: expected replay, got fresh response")
	}
	if !bytes.Contains(r3.Body.Bytes(), []byte(`9001`)) {
		t.Fatalf("alice second: replay body wrong: %q", r3.Body.String())
	}

	// Handler should have run exactly TWICE: once for alice's first
	// call, once for bob's call. Alice's second call replays without
	// invoking the inner.
	if calls != 2 {
		t.Errorf("inner handler ran %d times; want 2 (alice + bob, no replay-invocation)", calls)
	}
}

// setup wires a TestPool, registers handlers, and returns an httptest
// server with the full middleware chain installed.
func setup(t *testing.T, schema string) (*store.Pool, *httptest.Server, *pgxpool.Pool) {
	t.Helper()
	reg.Reset()
	pgPool := store.TestPool(t, schema)
	sp := store.NewPool(pgPool)
	echo.Register()
	cardtype.Register()
	card.Register(sp)

	logger := obs.NewLoggerTo("warn", io.Discard)
	user, err := auth.NewSystemUser(context.Background(), pgPool, "dev", auth.ModeOff)
	if err != nil {
		t.Fatal(err)
	}

	srv := api.NewServer(sp)
	srv.Logger = logger

	mux := http.NewServeMux()
	srv.Mount(mux, "")

	idem := obs.NewIdempotencyStore(pgPool, logger)

	handler := obs.RequestIDMiddleware(
		obs.LoggingMiddleware(logger,
			idem.Middleware(srv,
				auth.Middleware(user)(mux),
			),
		),
	)
	httpSrv := httptest.NewServer(handler)
	t.Cleanup(httpSrv.Close)
	return sp, httpSrv, pgPool
}

// canonicalJSON re-encodes b as a compact JSON object so two responses
// with semantically-equal content but different whitespace compare
// equal.
func canonicalJSON(t *testing.T, b []byte) []byte {
	t.Helper()
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("canonicalJSON: %v: %s", err, b)
	}
	out, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("canonicalJSON marshal: %v", err)
	}
	return out
}

func batchBody(t *testing.T, subs []api.SubRequest) []byte {
	t.Helper()
	buf, err := json.Marshal(api.BatchRequest{Subrequests: subs})
	if err != nil {
		t.Fatal(err)
	}
	return buf
}

func mustHTTP(t *testing.T, srv *httptest.Server, body []byte, idemKey string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/v1/batch", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if idemKey != "" {
		req.Header.Set("Idempotency-Key", idemKey)
	}
	r, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return r
}
