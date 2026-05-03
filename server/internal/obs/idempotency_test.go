package obs_test

import (
	"bytes"
	"context"
	"encoding/json"
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
