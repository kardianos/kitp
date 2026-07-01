package api

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

type kInput struct {
	Tag string `json:"tag"`
}

// TestDedupReadSubrequestsKeying covers the eligibility rules of the dedup
// keyer directly: only registered reads, exact data match, no key/ref.
func TestDedupReadSubrequestsKeying(t *testing.T) {
	reg.Reset()
	t.Cleanup(reg.Reset)
	noop := func(context.Context, store.Querier, []any) ([]any, error) { return nil, nil }
	reg.Register(reg.Handler{
		Endpoint: "ref", Action: "read",
		InputType: reflect.TypeFor[kInput](), OutputType: reflect.TypeFor[kInput](),
		AllowedRoles: []string{reg.RolePublic}, IsRead: true, Run: noop,
	})
	reg.Register(reg.Handler{
		Endpoint: "ref", Action: "write",
		InputType: reflect.TypeFor[kInput](), OutputType: reflect.TypeFor[kInput](),
		AllowedRoles: []string{reg.RolePublic}, Run: noop,
	})

	d := func(s string) json.RawMessage { return json.RawMessage(s) }
	subs := []SubRequest{
		{ID: "0", Endpoint: "ref", Action: "read", Data: d(`{"tag":"x"}`)},                // leader
		{ID: "1", Endpoint: "ref", Action: "read", Data: d(`{"tag":"x"}`)},                // dup of 0
		{ID: "2", Endpoint: "ref", Action: "read", Data: d(`{"tag":"y"}`)},                // distinct data
		{ID: "3", Endpoint: "ref", Action: "write", Data: d(`{"tag":"x"}`)},               // write: not deduped
		{ID: "4", Endpoint: "ref", Action: "write", Data: d(`{"tag":"x"}`)},               // write dup: not deduped
		{ID: "5", Endpoint: "ref", Action: "read", Data: d(`{"tag":"x"}`), Key: d(`"k"`)}, // has key: excluded
		{ID: "6", Endpoint: "nope", Action: "read", Data: d(`{"tag":"x"}`)},               // unknown handler
		{ID: "7", Endpoint: "ref", Action: "read", Data: d(`{"tag":"x"}`)},                // dup of 0 again
	}
	got := dedupReadSubrequests(subs)
	want := map[int]int{1: 0, 7: 0}
	if len(got) != len(want) {
		t.Fatalf("dedup map = %v; want %v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("dedup map = %v; want %v", got, want)
		}
	}
}
