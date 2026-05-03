package api_test

import (
	"context"
	"encoding/json"
	"reflect"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// runCallLog records every Run invocation so coalescing can be asserted.
type runCallLog struct {
	mu    sync.Mutex
	calls []int // each entry is len(inputs) for one Run
}

func (r *runCallLog) Note(n int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, n)
}
func (r *runCallLog) Calls() []int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]int(nil), r.calls...)
}

type echoCountingInput struct {
	Tag string `json:"tag"`
}
type echoCountingOutput struct {
	Tag string `json:"tag"`
}

// otherInput is a separate handler used to break coalescing.
type otherInput struct {
	N int `json:"n"`
}
type otherOutput struct {
	N int `json:"n"`
}

func registerCoalescingHandlers(t *testing.T, log *runCallLog) {
	t.Helper()
	reg.Register(reg.Handler{
		Endpoint:   "echo",
		Action:     "count",
		InputType:  reflect.TypeFor[echoCountingInput](),
		OutputType: reflect.TypeFor[echoCountingOutput](),
		Run: func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
			log.Note(len(ins))
			outs := make([]any, len(ins))
			for i, raw := range ins {
				outs[i] = echoCountingOutput{Tag: raw.(echoCountingInput).Tag}
			}
			return outs, nil
		},
	})
	reg.Register(reg.Handler{
		Endpoint:   "other",
		Action:     "count",
		InputType:  reflect.TypeFor[otherInput](),
		OutputType: reflect.TypeFor[otherOutput](),
		Run: func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
			log.Note(-len(ins)) // negative so we can tell which handler ran
			outs := make([]any, len(ins))
			for i, raw := range ins {
				outs[i] = otherOutput{N: raw.(otherInput).N}
			}
			return outs, nil
		},
	})
}

func setupServer(t *testing.T, schema string) (*api.Server, *runCallLog) {
	t.Helper()
	reg.Reset()
	echo.Register() // echo.ping for general round-trip
	pool := store.TestPool(t, schema)
	srv := api.NewServer(store.NewPool(pool))
	log := &runCallLog{}
	registerCoalescingHandlers(t, log)
	return srv, log
}

// TestRoundTripEcho exercises the full decode/run/encode path on a single
// echo.ping. It also confirms the response order matches the request order.
func TestRoundTripEcho(t *testing.T) {
	srv, _ := setupServer(t, "kitp_test_api_round")
	req := api.BatchRequest{
		Subrequests: []api.SubRequest{
			{ID: "a", Type: "data", Endpoint: "echo", Action: "ping",
				Data: json.RawMessage(`{"x":1,"message":"hi"}`)},
			{ID: "b", Type: "data", Endpoint: "echo", Action: "ping",
				Data: json.RawMessage(`{"x":2,"message":"bye"}`)},
		},
	}
	resp := srv.Dispatch(context.Background(), req)
	if len(resp.Subresponses) != 2 {
		t.Fatalf("len: %d", len(resp.Subresponses))
	}
	for i, want := range []string{"a", "b"} {
		if resp.Subresponses[i].ID != want {
			t.Errorf("slot %d: got id %q want %q", i, resp.Subresponses[i].ID, want)
		}
		if !resp.Subresponses[i].OK {
			t.Errorf("slot %d: not OK: %+v", i, resp.Subresponses[i].Error)
		}
	}

	// Re-encode and decode to confirm wire shape round-trips.
	wire, err := json.Marshal(resp)
	if err != nil {
		t.Fatal(err)
	}
	var got api.BatchResponse
	if err := json.Unmarshal(wire, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Subresponses) != 2 || got.Subresponses[0].ID != "a" {
		t.Fatalf("decoded: %+v", got)
	}
}

// TestUnknownHandlerAborts checks N-API-4: an unknown (endpoint, action)
// produces a structured error and every other slot is "aborted".
func TestUnknownHandlerAborts(t *testing.T) {
	srv, _ := setupServer(t, "kitp_test_api_unknown")
	req := api.BatchRequest{
		Subrequests: []api.SubRequest{
			{ID: "a", Endpoint: "echo", Action: "ping", Data: json.RawMessage(`{"x":1}`)},
			{ID: "b", Endpoint: "nonsense", Action: "blah", Data: json.RawMessage(`{}`)},
			{ID: "c", Endpoint: "echo", Action: "ping", Data: json.RawMessage(`{"x":3}`)},
		},
	}
	resp := srv.Dispatch(context.Background(), req)
	if len(resp.Subresponses) != 3 {
		t.Fatalf("len: %d", len(resp.Subresponses))
	}
	if resp.Subresponses[0].OK || resp.Subresponses[0].Error == nil ||
		resp.Subresponses[0].Error.Code != "aborted" {
		t.Errorf("slot 0 should be aborted: %+v", resp.Subresponses[0])
	}
	if resp.Subresponses[1].OK || resp.Subresponses[1].Error == nil ||
		resp.Subresponses[1].Error.Code != "unknown_handler" {
		t.Errorf("slot 1 should be unknown_handler: %+v", resp.Subresponses[1])
	}
	if resp.Subresponses[2].OK || resp.Subresponses[2].Error == nil ||
		resp.Subresponses[2].Error.Code != "aborted" {
		t.Errorf("slot 2 should be aborted: %+v", resp.Subresponses[2])
	}
}

// TestCoalescingSameKey: three identical (endpoint, action) sub-requests
// turn into ONE Run invocation with len(inputs)==3 (N-SRV-2, N-SRV-4).
func TestCoalescingSameKey(t *testing.T) {
	srv, log := setupServer(t, "kitp_test_api_coalesce")
	req := api.BatchRequest{
		Subrequests: []api.SubRequest{
			{ID: "1", Endpoint: "echo", Action: "count", Data: json.RawMessage(`{"tag":"a"}`)},
			{ID: "2", Endpoint: "echo", Action: "count", Data: json.RawMessage(`{"tag":"b"}`)},
			{ID: "3", Endpoint: "echo", Action: "count", Data: json.RawMessage(`{"tag":"c"}`)},
		},
	}
	resp := srv.Dispatch(context.Background(), req)
	for i, sr := range resp.Subresponses {
		if !sr.OK {
			t.Errorf("slot %d failed: %+v", i, sr.Error)
		}
	}
	calls := log.Calls()
	if len(calls) != 1 || calls[0] != 3 {
		t.Fatalf("expected 1 Run call with 3 inputs; got %v", calls)
	}
}

// TestCoalescingInterleaved: echo / other / echo produces three Run calls
// of one input each, preserving order (N-SRV-3).
func TestCoalescingInterleaved(t *testing.T) {
	srv, log := setupServer(t, "kitp_test_api_inter")
	req := api.BatchRequest{
		Subrequests: []api.SubRequest{
			{ID: "1", Endpoint: "echo", Action: "count", Data: json.RawMessage(`{"tag":"a"}`)},
			{ID: "2", Endpoint: "other", Action: "count", Data: json.RawMessage(`{"n":7}`)},
			{ID: "3", Endpoint: "echo", Action: "count", Data: json.RawMessage(`{"tag":"c"}`)},
		},
	}
	resp := srv.Dispatch(context.Background(), req)
	for i, sr := range resp.Subresponses {
		if !sr.OK {
			t.Errorf("slot %d failed: %+v", i, sr.Error)
		}
	}
	calls := log.Calls()
	if len(calls) != 3 || calls[0] != 1 || calls[1] != -1 || calls[2] != 1 {
		t.Fatalf("expected [1 -1 1], got %v", calls)
	}
}

// TestBadInputAborts: malformed data for one sub-request fails decode and
// aborts the whole batch.
func TestBadInputAborts(t *testing.T) {
	srv, _ := setupServer(t, "kitp_test_api_bad")
	req := api.BatchRequest{
		Subrequests: []api.SubRequest{
			{ID: "a", Endpoint: "echo", Action: "ping", Data: json.RawMessage(`{"x":1}`)},
			{ID: "b", Endpoint: "echo", Action: "ping", Data: json.RawMessage(`not json`)},
		},
	}
	resp := srv.Dispatch(context.Background(), req)
	if resp.Subresponses[0].OK || resp.Subresponses[0].Error.Code != "aborted" {
		t.Errorf("slot 0: %+v", resp.Subresponses[0])
	}
	if resp.Subresponses[1].OK || resp.Subresponses[1].Error.Code != "bad_input" {
		t.Errorf("slot 1: %+v", resp.Subresponses[1])
	}
}
