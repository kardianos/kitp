// proc_test.go: dispatcher-side coverage for proc.search.
//
// We use the in-process registry directly rather than spinning up the
// HTTP layer — the search handler doesn't need a transaction or a
// pool, so we feed inputs straight into Run and assert the descriptor
// shape. Each subtest installs a tiny fixed registry so order doesn't
// flake across packages.
package proc_test

import (
	"context"
	"reflect"
	"sort"
	"testing"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/proc"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

type fakeIn struct {
	X int `json:"x"`
}
type fakeOut struct {
	X int `json:"x"`
}

// installFixtureRegistry resets the global registry and installs a
// known set of handlers + proc.search. Returns the search handler so
// the test can call Run directly.
func installFixtureRegistry(t *testing.T) reg.Handler {
	t.Helper()
	reg.Reset()

	register := func(endpoint, action, doc string, allowed []string) {
		reg.Register(reg.Handler{
			Endpoint:     endpoint,
			Action:       action,
			Doc:          doc,
			InputType:    reflect.TypeFor[fakeIn](),
			OutputType:   reflect.TypeFor[fakeOut](),
			AllowedRoles: allowed,
			// Fixture handler — no row-level authz exercised here.
			GlobalScope: true,
			Run: func(ctx context.Context, tx store.Querier, ins []any) ([]any, error) {
				return ins, nil
			},
		})
	}
	register("card", "insert", "Insert a new card.", []string{"worker", "manager", "admin"})
	register("card", "delete", "Soft-delete a card.", []string{"worker", "manager", "admin"})
	register("attribute", "update", "Set an attribute value on a card.", []string{"worker", "manager", "admin"})
	register("comment", "insert", "Post a comment on a card.", []string{"worker", "manager", "admin"})
	register("role", "list", "List every role.", []string{reg.RoleAuthenticated})

	// Pass nil so the search handler skips role-aware filtering — the
	// fixture registry isn't backed by a real DB and these tests
	// exercise the structural filter logic. Role-aware narrowing is
	// covered separately in TestSearchFiltersByCallerRoles below.
	proc.Register(nil)
	h, ok := reg.Lookup("proc", "search")
	if !ok {
		t.Fatal("proc.search did not register")
	}
	return h
}

// callSearch is a small wrapper that builds a one-element batch
// payload, runs the handler, and returns the SearchOutput.
func callSearch(t *testing.T, h reg.Handler, in proc.SearchInput) proc.SearchOutput {
	t.Helper()
	outs, err := h.Run(context.Background(), nil, []any{in})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(outs) != 1 {
		t.Fatalf("expected 1 output, got %d", len(outs))
	}
	out, ok := outs[0].(proc.SearchOutput)
	if !ok {
		t.Fatalf("output type %T, want proc.SearchOutput", outs[0])
	}
	return out
}

func names(out proc.SearchOutput) []string {
	got := make([]string, 0, len(out.Handlers))
	for _, h := range out.Handlers {
		got = append(got, h.Name)
	}
	sort.Strings(got)
	return got
}

// TestSearchAllReturnsEverything: All=true wins over any filter and
// returns the full registry, including proc.search itself (so a
// client can introspect the meta endpoint too).
func TestSearchAllReturnsEverything(t *testing.T) {
	h := installFixtureRegistry(t)
	out := callSearch(t, h, proc.SearchInput{All: true})
	got := names(out)
	want := []string{
		"attribute__update",
		"card__delete",
		"card__insert",
		"comment__insert",
		"proc__search",
		"role__list",
	}
	if !equalSlices(got, want) {
		t.Errorf("All=true names = %v, want %v", got, want)
	}
}

// TestSearchEmptyInputYieldsEmpty: no filters and All=false returns
// zero rows. This is the explicit-intent guard — a tool-call without
// arguments shouldn't accidentally pull the entire catalogue into the
// model's context.
func TestSearchEmptyInputYieldsEmpty(t *testing.T) {
	h := installFixtureRegistry(t)
	out := callSearch(t, h, proc.SearchInput{})
	if len(out.Handlers) != 0 {
		t.Errorf("empty input should yield zero rows, got %d (%+v)",
			len(out.Handlers), out.Handlers)
	}
}

// TestSearchByEndpoint pulls every action under a single endpoint.
func TestSearchByEndpoint(t *testing.T) {
	h := installFixtureRegistry(t)
	out := callSearch(t, h, proc.SearchInput{Endpoint: "card"})
	got := names(out)
	want := []string{"card__delete", "card__insert"}
	if !equalSlices(got, want) {
		t.Errorf("endpoint=card names = %v, want %v", got, want)
	}
}

// TestSearchByEndpointAndAction is the (endpoint, action) lookup —
// a single-row response equivalent to reg.Lookup with a JSON shape.
func TestSearchByEndpointAndAction(t *testing.T) {
	h := installFixtureRegistry(t)
	out := callSearch(t, h, proc.SearchInput{Endpoint: "card", Action: "insert"})
	if len(out.Handlers) != 1 {
		t.Fatalf("expected 1 row, got %d", len(out.Handlers))
	}
	got := out.Handlers[0]
	if got.Name != "card__insert" || got.Endpoint != "card" || got.Action != "insert" {
		t.Errorf("descriptor = %+v", got)
	}
	if got.InputSchema == nil {
		t.Error("expected non-nil InputSchema")
	}
	if got.OutputSchema == nil {
		t.Error("expected non-nil OutputSchema")
	}
}

// TestSearchByQuerySubstring matches the query against name, doc,
// endpoint, action — all four. The fixture's only handler whose doc
// contains "soft-delete" is card.delete, but "delete" appears in both
// the action name and the doc; both should yield the same row.
func TestSearchByQuerySubstring(t *testing.T) {
	h := installFixtureRegistry(t)

	// Doc-only match.
	out := callSearch(t, h, proc.SearchInput{Query: "soft-delete"})
	if len(out.Handlers) != 1 || out.Handlers[0].Name != "card__delete" {
		t.Errorf("query=soft-delete = %v", names(out))
	}

	// Action-name match.
	out = callSearch(t, h, proc.SearchInput{Query: "comment"})
	got := names(out)
	want := []string{"comment__insert"}
	if !equalSlices(got, want) {
		t.Errorf("query=comment names = %v, want %v", got, want)
	}

	// Case-insensitive.
	out = callSearch(t, h, proc.SearchInput{Query: "ATTRIBUTE"})
	got = names(out)
	want = []string{"attribute__update"}
	if !equalSlices(got, want) {
		t.Errorf("query=ATTRIBUTE names = %v, want %v", got, want)
	}
}

// TestSearchCombinesFiltersAsAnd: Endpoint AND Action AND Query are
// all conjunctive — every filter must hold.
func TestSearchCombinesFiltersAsAnd(t *testing.T) {
	h := installFixtureRegistry(t)
	out := callSearch(t, h, proc.SearchInput{
		Endpoint: "card",
		Query:    "delete",
	})
	if len(out.Handlers) != 1 || out.Handlers[0].Name != "card__delete" {
		t.Errorf("endpoint=card,query=delete = %v", names(out))
	}

	// Query that doesn't match the endpoint scope → empty.
	out = callSearch(t, h, proc.SearchInput{
		Endpoint: "card",
		Query:    "comment",
	})
	if len(out.Handlers) != 0 {
		t.Errorf("expected empty intersection, got %v", names(out))
	}
}

// TestSearchDescriptorsCarryRoles: a returned row's AllowedRoles
// reflects the registration so a client can preview which roles may
// invoke a proc before dispatching it.
func TestSearchDescriptorsCarryRoles(t *testing.T) {
	h := installFixtureRegistry(t)
	out := callSearch(t, h, proc.SearchInput{Endpoint: "role", Action: "list"})
	if len(out.Handlers) != 1 {
		t.Fatalf("expected 1 row, got %d", len(out.Handlers))
	}
	got := out.Handlers[0]
	want := []string{reg.RoleAuthenticated}
	if !equalSlices(got.AllowedRoles, want) {
		t.Errorf("role.list AllowedRoles = %v, want %v", got.AllowedRoles, want)
	}
}

// TestSearchFiltersByCallerRoles is the role-aware variant. We back
// proc.search with a real test pool so auth.LoadUserRoles can run, then
// check that:
//   - a viewer-only user sees handlers tagged with viewer roles only
//     (here we lean on the seeded `system` and the new `viewer` rows
//     from migration 0010);
//   - a user with no roles still sees handlers gated on the
//     $authenticated sentinel;
//   - IncludeUnavailable=true bypasses the filter.
func TestSearchFiltersByCallerRoles(t *testing.T) {
	reg.Reset()
	pool := store.TestPool(t, "kitp_test_proc_role_filter")
	sp := store.NewPool(pool)

	// Two probe handlers: one $authenticated (read-style), one
	// admin-only (write-style). Each user role we test below should
	// see the first; only the admin should see the second.
	reg.Register(reg.Handler{
		Endpoint:     "probe",
		Action:       "read",
		Doc:          "Anyone signed in.",
		InputType:    reflect.TypeFor[fakeIn](),
		OutputType:   reflect.TypeFor[fakeOut](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Run:          func(ctx context.Context, tx store.Querier, ins []any) ([]any, error) { return ins, nil },
	})
	reg.Register(reg.Handler{
		Endpoint:     "probe",
		Action:       "admin_write",
		Doc:          "Admin only.",
		InputType:    reflect.TypeFor[fakeIn](),
		OutputType:   reflect.TypeFor[fakeOut](),
		AllowedRoles: []string{"admin"},
		Run:          func(ctx context.Context, tx store.Querier, ins []any) ([]any, error) { return ins, nil },
	})
	proc.Register(sp)

	h, ok := reg.Lookup("proc", "search")
	if !ok {
		t.Fatal("proc.search did not register")
	}

	// Helper to seed a user with a role + run search as them.
	asUserWithRole := func(displayName, roleName string, in proc.SearchInput) proc.SearchOutput {
		t.Helper()
		ctx := context.Background()
		var userID int64
		row := sp.P.QueryRow(ctx, `SELECT id FROM user_account WHERE display_name = $1`, displayName)
		if err := row.Scan(&userID); err != nil {
			row = sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ($1) RETURNING id`, displayName)
			if err := row.Scan(&userID); err != nil {
				t.Fatalf("user insert: %v", err)
			}
		}
		if roleName != "" {
			var roleID int64
			if err := sp.P.QueryRow(ctx, `SELECT id FROM role WHERE name = $1`, roleName).Scan(&roleID); err != nil {
				t.Fatalf("role lookup %q: %v", roleName, err)
			}
			if _, err := sp.P.Exec(ctx, `
				INSERT INTO user_role (user_id, role_id) VALUES ($1, $2)
				ON CONFLICT DO NOTHING
			`, userID, roleID); err != nil {
				t.Fatalf("user_role insert: %v", err)
			}
		}
		callCtx := auth.WithUser(ctx, &auth.UserCtx{ID: userID, DisplayName: displayName})
		outs, err := h.Run(callCtx, nil, []any{in})
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		return outs[0].(proc.SearchOutput)
	}

	// 1. viewer (no admin grant) sees probe.read but NOT probe.admin_write.
	out := asUserWithRole("filter_viewer", "viewer", proc.SearchInput{Endpoint: "probe"})
	if got := names(out); !equalSlices(got, []string{"probe__read"}) {
		t.Errorf("viewer search = %v, want [probe__read]", got)
	}

	// 2. admin sees both.
	out = asUserWithRole("filter_admin", "admin", proc.SearchInput{Endpoint: "probe"})
	if got := names(out); !equalSlices(got, []string{"probe__admin_write", "probe__read"}) {
		t.Errorf("admin search = %v, want [probe__admin_write probe__read]", got)
	}

	// 3. viewer with IncludeUnavailable=true sees both — opt-in
	//    surfaces the full picture for admin UIs.
	out = asUserWithRole("filter_viewer", "", proc.SearchInput{
		Endpoint:           "probe",
		IncludeUnavailable: true,
	})
	if got := names(out); !equalSlices(got, []string{"probe__admin_write", "probe__read"}) {
		t.Errorf("viewer+include_unavailable search = %v, want [probe__admin_write probe__read]", got)
	}

}

func equalSlices(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
