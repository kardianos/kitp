package api_test

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// TestBatchHasOneDeadline (review 2026-11-03 round 5 #1): groups that each
// stay inside their own timeout don't add up past the batch's budget —
// twice its longest handler's timeout — when interleaved with another
// handler.
func TestBatchHasOneDeadline(t *testing.T) {
	srv, _ := setupServer(t, "kitp_test_api_batch_deadline")
	slow := func(ctx context.Context, _ store.Querier, ins []any) ([]any, error) {
		select {
		case <-time.After(5 * time.Second):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		outs := make([]any, len(ins))
		for i := range ins {
			outs[i] = echoCountingOutput{Tag: "slow"}
		}
		return outs, nil
	}
	fast := func(_ context.Context, _ store.Querier, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i := range ins {
			outs[i] = echoCountingOutput{Tag: "fast"}
		}
		return outs, nil
	}
	for _, h := range []struct {
		action string
		run    func(context.Context, store.Querier, []any) ([]any, error)
	}{{"slow", slow}, {"fast", fast}} {
		reg.Register(reg.Handler{
			Endpoint: "deadline", Action: h.action,
			InputType: reflect.TypeFor[echoCountingInput](), OutputType: reflect.TypeFor[echoCountingOutput](),
			AllowedRoles: []string{reg.RolePublic}, Run: h.run,
		})
	}
	sub := func(id, action string) api.SubRequest {
		return api.SubRequest{ID: id, Type: "data", Endpoint: "deadline", Action: action, Data: json.RawMessage(`{"tag":"` + id + `"}`)}
	}
	req := api.BatchRequest{Subrequests: []api.SubRequest{
		sub("s1", "slow"), sub("f1", "fast"), sub("s2", "slow"), sub("f2", "fast"), sub("s3", "slow"),
	}}
	start := time.Now()
	resp := srv.Dispatch(context.Background(), req)
	d := time.Since(start)
	ok := true
	for _, sr := range resp.Subresponses {
		ok = ok && sr.OK
	}
	if ok {
		t.Errorf("three 5-second groups in one batch all ran (%v); want the batch's 12-second budget to stop it", d)
	}
	if d > 14*time.Second {
		t.Errorf("the batch ran %v, past its budget", d)
	}
}
