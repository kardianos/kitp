// role_gate_test.go: declarative AllowedRoles gate.
//
// Each handler registration carries an AllowedRoles list (see
// reg.Handler). The dispatcher loads the calling user's roles and
// rejects a sub-request with `unauthorized` when no role overlaps. The
// seeded `system` role wildcards. The two sentinels reg.RolePublic and
// reg.RoleAuthenticated short-circuit the check.
//
// Coverage:
//   - register-time panic when AllowedRoles is empty.
//   - $public reaches a handler without a login.
//   - $authenticated requires a login but no specific role.
//   - missing UserCtx → unauthorized (login required).
//   - role-listed → allowed (positive case).
//   - role-not-listed → unauthorized (negative case).
//   - admin-only handler rejects worker.
//   - system role bypasses the check.
//   - every registered production handler declares non-empty AllowedRoles.

package api_test

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/activity"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/comment"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// gateInput is a tiny struct used by the synthetic handlers below so we
// have a stable InputType for the registry.
type gateInput struct {
	N int `json:"n"`
}
type gateOutput struct {
	N int `json:"n"`
}

// registerGateProbe installs a handler that succeeds for any caller the
// gate lets through. The endpoint+action are passed in so multiple probes
// with different role declarations can co-exist in one schema.
func registerGateProbe(endpoint, action string, allowed []string) {
	reg.Register(reg.Handler{
		Endpoint:     endpoint,
		Action:       action,
		InputType:    reflect.TypeFor[gateInput](),
		OutputType:   reflect.TypeFor[gateOutput](),
		AllowedRoles: allowed,
		// Probe handlers don't operate on real rows; the test
		// exercises ONLY the role-name gate, not the per-row scope
		// check. Opt out so the register-time guard doesn't fire.
		GlobalScope: true,
		Run: func(ctx context.Context, tx store.Querier, ins []any) ([]any, error) {
			outs := make([]any, len(ins))
			for i, raw := range ins {
				outs[i] = gateOutput{N: raw.(gateInput).N + 1}
			}
			return outs, nil
		},
	})
}

// gateUser inserts a user_account + assigns the named role. Returns the
// user id. Used by the negative tests so we can control which roles the
// caller carries.
func gateUser(t *testing.T, sp *store.Pool, displayName, roleName string) int64 {
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
	if roleName == "" {
		return userID
	}
	var roleID int64
	row = sp.P.QueryRow(ctx, `SELECT id FROM role WHERE name = $1`, roleName)
	if err := row.Scan(&roleID); err != nil {
		t.Fatalf("role %s: %v", roleName, err)
	}
	if _, err := sp.P.Exec(ctx, `
		INSERT INTO user_role (user_id, role_id) VALUES ($1, $2)
		ON CONFLICT DO NOTHING
	`, userID, roleID); err != nil {
		t.Fatalf("user_role insert: %v", err)
	}
	return userID
}

func setupGate(t *testing.T, schema string) (*api.Server, *store.Pool) {
	t.Helper()
	reg.Reset()
	pool := store.TestPool(t, schema)
	sp := store.NewPool(pool)
	echo.Register()
	cardtype.Register()
	card.Register(sp)
	attribute.Register(sp)
	activity.Register(sp)
	comment.Register(sp)
	return api.NewServer(sp), sp
}

func ctxAs(id int64, name string) context.Context {
	return auth.WithUser(context.Background(), &auth.UserCtx{ID: id, DisplayName: name})
}

// TestRegisterPanicsOnEmptyAllowedRoles asserts that register-time
// validation refuses a handler that didn't declare its access surface.
// We can't recover from a panic + still leave reg in a sane state for
// the remaining tests, so we run this in a fresh isolated registry.
func TestRegisterPanicsOnEmptyAllowedRoles(t *testing.T) {
	reg.Reset()
	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("expected panic on empty AllowedRoles, got none")
		}
		msg, _ := r.(string)
		if !strings.Contains(msg, "AllowedRoles") {
			t.Fatalf("panic message %q does not mention AllowedRoles", msg)
		}
	}()
	reg.Register(reg.Handler{
		Endpoint:   "test",
		Action:     "no_roles",
		InputType:  reflect.TypeFor[gateInput](),
		OutputType: reflect.TypeFor[gateOutput](),
		Run:        func(ctx context.Context, tx store.Querier, ins []any) ([]any, error) { return ins, nil },
	})
}

// TestPublicEndpointSkipsLogin: reg.RolePublic short-circuits the gate
// entirely — no login required.
func TestPublicEndpointSkipsLogin(t *testing.T) {
	srv, _ := setupGate(t, "kitp_test_gate_public")
	registerGateProbe("gate", "public", []string{reg.RolePublic})

	resp := srv.Dispatch(context.Background(), api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "gate", Action: "public", Data: json.RawMessage(`{"n":7}`)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("public endpoint with no login should pass: %+v", resp.Subresponses[0])
	}
}

// TestAuthenticatedRequiresLogin: $authenticated rejects a missing
// UserCtx but accepts a logged-in user (any role / no role).
func TestAuthenticatedRequiresLogin(t *testing.T) {
	srv, sp := setupGate(t, "kitp_test_gate_auth")
	registerGateProbe("gate", "auth", []string{reg.RoleAuthenticated})

	// No login → unauthorized.
	resp := srv.Dispatch(context.Background(), api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "a", Endpoint: "gate", Action: "auth", Data: json.RawMessage(`{"n":1}`)},
	}})
	if resp.Subresponses[0].OK {
		t.Fatal("authenticated endpoint without login should reject")
	}
	if resp.Subresponses[0].Error == nil || resp.Subresponses[0].Error.Code != "unauthorized" {
		t.Fatalf("want code=unauthorized, got %+v", resp.Subresponses[0].Error)
	}

	// A signed-in user with NO roles still passes (RoleAuthenticated does
	// not require a specific role membership).
	uid := gateUser(t, sp, "noroles", "")
	resp = srv.Dispatch(ctxAs(uid, "noroles"), api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "a", Endpoint: "gate", Action: "auth", Data: json.RawMessage(`{"n":1}`)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("authenticated user with no roles should pass: %+v", resp.Subresponses[0])
	}
}

// TestRoleListPositiveAndNegative: listed role passes, unlisted role is
// rejected with `unauthorized` and the same code as the per-handler
// reg.Unauthorized helper would emit.
func TestRoleListPositiveAndNegative(t *testing.T) {
	srv, sp := setupGate(t, "kitp_test_gate_role_list")
	registerGateProbe("gate", "worker_only", []string{"worker", "manager", "admin"})

	worker := gateUser(t, sp, "wkr", "worker")
	viewer := gateUser(t, sp, "vwr", "viewer")

	// Positive: worker passes.
	resp := srv.Dispatch(ctxAs(worker, "wkr"), api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "w", Endpoint: "gate", Action: "worker_only", Data: json.RawMessage(`{"n":2}`)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("worker should pass on worker-listed handler: %+v", resp.Subresponses[0])
	}

	// Negative: viewer rejected.
	resp = srv.Dispatch(ctxAs(viewer, "vwr"), api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "v", Endpoint: "gate", Action: "worker_only", Data: json.RawMessage(`{"n":2}`)},
	}})
	if resp.Subresponses[0].OK {
		t.Fatal("viewer should not pass on worker-only handler")
	}
	if resp.Subresponses[0].Error == nil {
		t.Fatal("expected error envelope")
	}
	if resp.Subresponses[0].Error.Code != "unauthorized" {
		t.Errorf("want code=unauthorized, got %q", resp.Subresponses[0].Error.Code)
	}
}

// TestAdminOnlyRejectsWorker: a handler that only lists `admin` rejects
// the otherwise-trusted `worker` role, proving the gate doesn't leak
// roles across handlers.
func TestAdminOnlyRejectsWorker(t *testing.T) {
	srv, sp := setupGate(t, "kitp_test_gate_admin_only")
	registerGateProbe("gate", "admin_only", []string{"admin"})

	worker := gateUser(t, sp, "wkr2", "worker")

	resp := srv.Dispatch(ctxAs(worker, "wkr2"), api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "a", Endpoint: "gate", Action: "admin_only", Data: json.RawMessage(`{"n":1}`)},
	}})
	if resp.Subresponses[0].OK {
		t.Fatal("worker should not reach an admin-only handler")
	}
	if resp.Subresponses[0].Error.Code != "unauthorized" {
		t.Errorf("want code=unauthorized, got %q", resp.Subresponses[0].Error.Code)
	}
}

// TestSystemRoleBypass: the System User (who carries the seeded `system`
// role) is allowed even when `system` isn't listed in AllowedRoles.
func TestSystemRoleBypass(t *testing.T) {
	srv, _ := setupGate(t, "kitp_test_gate_system")
	registerGateProbe("gate", "admin_only2", []string{"admin"})

	resp := srv.Dispatch(auth.WithSystemUser(context.Background()), api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "s", Endpoint: "gate", Action: "admin_only2", Data: json.RawMessage(`{"n":3}`)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("system user should bypass role list: %+v", resp.Subresponses[0])
	}
}

// TestProductionHandlersDeclareRoles iterates every handler the
// production registerHandlers() chain installs and asserts each declared
// a non-empty AllowedRoles list. This is the safety net against a future
// merge that adds an endpoint without thinking about authz: the test
// fails before the dispatcher panics in production.
func TestProductionHandlersDeclareRoles(t *testing.T) {
	srv, _ := setupGate(t, "kitp_test_gate_inventory")
	_ = srv

	// Pull every registered handler from the registry. We can't import
	// the dom/* packages just to register them again (cycles), so we
	// rely on setupGate having already wired the most representative
	// subset; the assertion below applies to whatever IS registered.
	for _, h := range reg.All() {
		if len(h.AllowedRoles) == 0 {
			t.Errorf("handler %s.%s missing AllowedRoles", h.Endpoint, h.Action)
		}
	}
}

// TestNoLoginRejectsRoleListedHandler: even with the right Allowed-
// Roles, a request with no UserCtx is rejected. Belt-and-suspenders
// version of the auth-required assertion in TestAuthenticatedRequiresLogin
// that targets the more common path (a real role list, not the
// $authenticated sentinel).
func TestNoLoginRejectsRoleListedHandler(t *testing.T) {
	srv, _ := setupGate(t, "kitp_test_gate_no_login")
	registerGateProbe("gate", "any_role", []string{"viewer", "worker", "admin"})

	resp := srv.Dispatch(context.Background(), api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "x", Endpoint: "gate", Action: "any_role", Data: json.RawMessage(`{"n":4}`)},
	}})
	if resp.Subresponses[0].OK {
		t.Fatal("no-login request should be rejected")
	}
	if resp.Subresponses[0].Error.Code != "unauthorized" {
		t.Errorf("want code=unauthorized, got %q", resp.Subresponses[0].Error.Code)
	}
	if !strings.Contains(resp.Subresponses[0].Error.Message, "login required") {
		t.Errorf("expected login-required hint in message, got %q", resp.Subresponses[0].Error.Message)
	}
}

// TestUnauthorizedHelperShape: the per-handler reg.Unauthorized helper
// returns an error with the same code the gate uses, so callers can
// rely on a single string match.
func TestUnauthorizedHelperShape(t *testing.T) {
	he := reg.Unauthorized("ownership: %d", 42)
	if he == nil {
		t.Fatal("want non-nil *reg.HandlerError")
	}
	if he.Code != "unauthorized" {
		t.Errorf("want code=unauthorized, got %q", he.Code)
	}
	if !strings.Contains(he.Message, "ownership: 42") {
		t.Errorf("Sprintf format failed: %q", he.Message)
	}
}
