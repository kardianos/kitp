package obs_test

import (
	"context"
	"encoding/json"
	"io"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

type mintIn struct{}
type mintOut struct {
	Token string `json:"token"`
}

// TestIdempotencyKeepsNoSecrets (review 2026-11-03 round 4): a keyed batch
// that mints a secret (reg.Handler Secret) isn't kept in the replay table,
// which holds responses in plain text for 24 h; a retry with the key runs
// again.
func TestIdempotencyKeepsNoSecrets(t *testing.T) {
	_, srv, pgPool := setup(t, "kitp_test_idem_secret")
	var n atomic.Int64
	reg.Register(reg.Handler{
		Endpoint: "test_secret", Action: "mint",
		Doc:          "test: mint a token",
		InputType:    reflect.TypeFor[mintIn](),
		OutputType:   reflect.TypeFor[mintOut](),
		AllowedRoles: []string{reg.RolePublic},
		Secret:       true,
		Run: func(ctx context.Context, tx store.Querier, ins []any) ([]any, error) {
			outs := make([]any, len(ins))
			for i := range ins {
				outs[i] = mintOut{Token: "tok-" + strconv.FormatInt(n.Add(1), 10)}
			}
			return outs, nil
		},
	})
	body := batchBody(t, []api.SubRequest{
		{ID: "e", Endpoint: "echo", Action: "ping", Data: json.RawMessage(`{"x":1,"message":"hi"}`)},
		{ID: "m", Endpoint: "test_secret", Action: "mint", Data: json.RawMessage(`{}`)},
	})
	read := func() (string, string) {
		r := mustHTTP(t, srv, body, "k-secret")
		defer r.Body.Close()
		b, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		return string(b), r.Header.Get("Idempotency-Replay")
	}
	first, _ := read()
	second, replay := read()
	if replay == "true" || !strings.Contains(first, "tok-1") || !strings.Contains(second, "tok-2") {
		t.Errorf("a secret was replayed (replay %q):\nfirst  %s\nsecond %s", replay, first, second)
	}
	var kept int
	if err := pgPool.QueryRow(context.Background(), `SELECT count(*) FROM idempotency_response WHERE key = 'k-secret'`).Scan(&kept); err != nil {
		t.Fatal(err)
	}
	if kept != 0 {
		t.Errorf("%d responses holding a secret kept", kept)
	}
}
