package api_test

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// TestDispatchDedupReads verifies that identical READ sub-requests within one
// batch run once (leader) and mirror their result into the duplicate slots,
// while identical WRITES are never deduped.
func TestDispatchDedupReads(t *testing.T) {
	srv, log := setupServer(t, "kitp_test_api_dedup")

	counting := func(sign int) func(context.Context, store.Querier, []any) ([]any, error) {
		return func(_ context.Context, _ store.Querier, ins []any) ([]any, error) {
			log.Note(sign * len(ins))
			outs := make([]any, len(ins))
			for i, raw := range ins {
				outs[i] = echoCountingOutput{Tag: raw.(echoCountingInput).Tag}
			}
			return outs, nil
		}
	}
	reg.Register(reg.Handler{
		Endpoint: "ref", Action: "read",
		InputType: reflect.TypeFor[echoCountingInput](), OutputType: reflect.TypeFor[echoCountingOutput](),
		AllowedRoles: []string{reg.RolePublic}, IsRead: true, Run: counting(1),
	})
	reg.Register(reg.Handler{
		Endpoint: "ref", Action: "write",
		InputType: reflect.TypeFor[echoCountingInput](), OutputType: reflect.TypeFor[echoCountingOutput](),
		AllowedRoles: []string{reg.RolePublic}, Run: counting(-1),
	})

	rd := func(id, tag string) api.SubRequest {
		return api.SubRequest{ID: id, Type: "data", Endpoint: "ref", Action: "read",
			Data: json.RawMessage(`{"tag":"` + tag + `"}`)}
	}
	wr := func(id, tag string) api.SubRequest {
		return api.SubRequest{ID: id, Type: "data", Endpoint: "ref", Action: "write",
			Data: json.RawMessage(`{"tag":"` + tag + `"}`)}
	}
	req := api.BatchRequest{Subrequests: []api.SubRequest{
		rd("a", "x"), rd("b", "x"), rd("c", "x"), // b,c dedup to a
		rd("d", "y"),               // distinct data → runs
		wr("e", "x"), wr("f", "x"), // identical writes → both run
	}}

	resp := srv.Dispatch(context.Background(), req)

	// Every slot OK, IDs preserved in order.
	wantIDs := []string{"a", "b", "c", "d", "e", "f"}
	if len(resp.Subresponses) != len(wantIDs) {
		t.Fatalf("len=%d", len(resp.Subresponses))
	}
	for i, want := range wantIDs {
		sr := resp.Subresponses[i]
		if sr.ID != want || !sr.OK {
			t.Fatalf("slot %d: id=%q ok=%v err=%+v", i, sr.ID, sr.OK, sr.Error)
		}
	}
	// Duplicate read slots mirror the leader's data.
	for _, i := range []int{0, 1, 2} {
		if got := resp.Subresponses[i].Data.(echoCountingOutput).Tag; got != "x" {
			t.Errorf("read slot %d tag=%q want x", i, got)
		}
	}
	if got := resp.Subresponses[3].Data.(echoCountingOutput).Tag; got != "y" {
		t.Errorf("slot d tag=%q want y", got)
	}

	// Execution proof: reads collapsed from 4 sub-requests to 2 executed inputs
	// (x-leader + y) in one coalesced Run (+2); both writes ran (-2). Without
	// dedup the read call would carry 4 inputs.
	calls := log.Calls()
	if len(calls) != 2 || calls[0] != 2 || calls[1] != -2 {
		t.Fatalf("execution log = %v; want [2 -2] (reads deduped 4→2, writes not)", calls)
	}
}
