// Direct PL/pgSQL tests for user_select_batch and
// user_list_with_roles_batch — Phase 5 of
// docs/UNIFIED_HANDLER_PLAN.md. Calls the functions over pool.Query and
// asserts per-row outputs independent of the dispatcher-driven
// integration tests in user_test.go.
package user_test

import (
	"context"
	"encoding/json"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

type batchRow struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callBatch(t *testing.T, pool *pgxpool.Pool, fn string, actorID int64, inputs any) []batchRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(),
		`SELECT idx, ok, code, message, result FROM `+fn+`($1::bigint, $2::jsonb) ORDER BY idx`,
		actorID, body)
	if err != nil {
		t.Fatalf("query %s: %v", fn, err)
	}
	defer rows.Close()
	var out []batchRow
	for rows.Next() {
		var r batchRow
		var resJSON []byte
		if err := rows.Scan(&r.Idx, &r.OK, &r.Code, &r.Message, &resJSON); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if len(resJSON) > 0 {
			r.Result = json.RawMessage(append([]byte(nil), resJSON...))
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows.Err: %v", err)
	}
	return out
}

type selectUserRow struct {
	ID             string  `json:"id"`
	DisplayName    string  `json:"display_name"`
	ParentUserID   *string `json:"parent_user_id"`
	ParentUserName *string `json:"parent_user_name"`
	IsAgent        bool    `json:"is_agent"`
}

type selectOut struct {
	Rows []selectUserRow `json:"rows"`
}

func seedAgent(t *testing.T, pool *pgxpool.Pool, name string, parent int64) int64 {
	t.Helper()
	var uid int64
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO user_account (display_name, parent_user_id, is_agent) VALUES ($1,$2,TRUE) RETURNING id`,
		name, parent,
	).Scan(&uid); err != nil {
		t.Fatalf("seed agent %s: %v", name, err)
	}
	return uid
}

func TestUserSelectBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_user_select_happy")
	rows := callBatch(t, pool, "user_select_batch", auth.SystemUserID, []map[string]any{{}})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d", len(rows))
	}
	if !rows[0].OK {
		t.Fatalf("want ok=true; got %+v", rows[0])
	}
	var out selectOut
	if err := json.Unmarshal(rows[0].Result, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(out.Rows) == 0 {
		t.Fatalf("expected at least the System user in the result")
	}
	// id should be string-encoded.
	if _, err := strconv.ParseInt(out.Rows[0].ID, 10, 64); err != nil {
		t.Errorf("id is not a decimal string: %q", out.Rows[0].ID)
	}
}

func TestUserSelectBatch_FilterIsAgent(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_user_select_isagent")
	parent := auth.SystemUserID
	agent := seedAgent(t, pool, "agent-a", parent)
	rows := callBatch(t, pool, "user_select_batch", parent, []map[string]any{
		{"is_agent": true},
	})
	var out selectOut
	if err := json.Unmarshal(rows[0].Result, &out); err != nil {
		t.Fatal(err)
	}
	for _, r := range out.Rows {
		if !r.IsAgent {
			t.Errorf("is_agent=true filter leaked human row: %+v", r)
		}
	}
	found := false
	for _, r := range out.Rows {
		if r.ID == strconv.FormatInt(agent, 10) {
			found = true
		}
	}
	if !found {
		t.Errorf("agent %d not in is_agent=true result", agent)
	}
}

func TestUserSelectBatch_FilterParentUserID(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_user_select_parent")
	parent := auth.SystemUserID
	agent := seedAgent(t, pool, "agent-p", parent)
	rows := callBatch(t, pool, "user_select_batch", parent, []map[string]any{
		{"parent_user_id": strconv.FormatInt(parent, 10)},
	})
	var out selectOut
	_ = json.Unmarshal(rows[0].Result, &out)
	for _, r := range out.Rows {
		if r.ParentUserID == nil || *r.ParentUserID != strconv.FormatInt(parent, 10) {
			t.Errorf("filter leaked row with mismatched parent: %+v", r)
		}
	}
	found := false
	for _, r := range out.Rows {
		if r.ID == strconv.FormatInt(agent, 10) {
			found = true
			// The owner's display_name must resolve via the self-join so
			// the Agents screen can show a name instead of a bare id.
			if r.ParentUserName == nil || *r.ParentUserName != "System" {
				t.Errorf("agent %d parent_user_name: got %v, want \"System\"", agent, r.ParentUserName)
			}
		}
	}
	if !found {
		t.Errorf("agent %d not in parent_user_id filter result", agent)
	}
}

func TestUserSelectBatch_FilterIDs(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_user_select_ids")
	parent := auth.SystemUserID
	a := seedAgent(t, pool, "agent-id-1", parent)
	b := seedAgent(t, pool, "agent-id-2", parent)
	rows := callBatch(t, pool, "user_select_batch", parent, []map[string]any{
		{"ids": []int64{a, b}},
	})
	var out selectOut
	_ = json.Unmarshal(rows[0].Result, &out)
	if len(out.Rows) != 2 {
		t.Fatalf("rows: got %d, want 2", len(out.Rows))
	}
	got := map[string]bool{}
	for _, r := range out.Rows {
		got[r.ID] = true
	}
	if !got[strconv.FormatInt(a, 10)] || !got[strconv.FormatInt(b, 10)] {
		t.Errorf("want ids %d/%d, got %+v", a, b, out.Rows)
	}
}

func TestUserSelectBatch_MultiInputDifferentFilters(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_user_select_multi")
	parent := auth.SystemUserID
	agent := seedAgent(t, pool, "agent-multi", parent)
	rows := callBatch(t, pool, "user_select_batch", parent, []map[string]any{
		{},
		{"is_agent": true},
		{"is_agent": false},
	})
	if len(rows) != 3 {
		t.Fatalf("rows: got %d", len(rows))
	}
	for i, r := range rows {
		if !r.OK {
			t.Errorf("row %d: %+v", i, r)
		}
	}
	var all, agents, humans selectOut
	_ = json.Unmarshal(rows[0].Result, &all)
	_ = json.Unmarshal(rows[1].Result, &agents)
	_ = json.Unmarshal(rows[2].Result, &humans)
	if len(all.Rows) != len(agents.Rows)+len(humans.Rows) {
		t.Errorf("all != agents+humans (%d vs %d+%d)", len(all.Rows), len(agents.Rows), len(humans.Rows))
	}
	found := false
	for _, r := range agents.Rows {
		if r.ID == strconv.FormatInt(agent, 10) {
			found = true
		}
	}
	if !found {
		t.Errorf("agent missing from is_agent=true result")
	}
}

// seedUser inserts a plain human user_account with no role grants — i.e. a
// non-admin (the System user, by contrast, holds the global admin role).
func seedUser(t *testing.T, pool *pgxpool.Pool, name string) int64 {
	t.Helper()
	var uid int64
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO user_account (display_name) VALUES ($1) RETURNING id`, name,
	).Scan(&uid); err != nil {
		t.Fatalf("seed user %s: %v", name, err)
	}
	return uid
}

func unmarshalSelect(t *testing.T, raw json.RawMessage) map[string]bool {
	t.Helper()
	var out selectOut
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal select: %v", err)
	}
	ids := map[string]bool{}
	for _, r := range out.Rows {
		ids[r.ID] = true
	}
	return ids
}

// TestUserSelectBatch_AgentVisibilityScoping pins the per-row floor enforced
// in the function (not just the UI): a non-admin caller sees ONLY the agents
// they parent — even when they ask for another user's via parent_user_id — an
// admin sees every agent, and human rows stay fully listable for everyone so
// assignee pickers are unaffected.
func TestUserSelectBatch_AgentVisibilityScoping(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_user_select_agent_scope")
	userA := seedUser(t, pool, "human-a")
	userB := seedUser(t, pool, "human-b")
	agentA := seedAgent(t, pool, "agent-of-a", userA)
	agentB := seedAgent(t, pool, "agent-of-b", userB)
	aStr := strconv.FormatInt(agentA, 10)
	bStr := strconv.FormatInt(agentB, 10)

	// Non-admin userA asks for ALL agents → gets only their own.
	rows := callBatch(t, pool, "user_select_batch", userA, []map[string]any{{"is_agent": true}})
	got := unmarshalSelect(t, rows[0].Result)
	if !got[aStr] {
		t.Errorf("userA should see their own agent %s", aStr)
	}
	if got[bStr] {
		t.Errorf("userA must NOT see userB's agent %s", bStr)
	}

	// Non-admin userA tries to widen via parent_user_id=userB → still nothing.
	rows = callBatch(t, pool, "user_select_batch", userA, []map[string]any{
		{"is_agent": true, "parent_user_id": strconv.FormatInt(userB, 10)},
	})
	if unmarshalSelect(t, rows[0].Result)[bStr] {
		t.Errorf("userA widened to userB's agent %s via parent_user_id; floor leaked", bStr)
	}

	// Admin (System) sees every agent.
	rows = callBatch(t, pool, "user_select_batch", auth.SystemUserID, []map[string]any{{"is_agent": true}})
	got = unmarshalSelect(t, rows[0].Result)
	if !got[aStr] || !got[bStr] {
		t.Errorf("admin should see both agents; got %+v", got)
	}

	// Humans stay fully listable for a non-admin (assignee-picker path).
	rows = callBatch(t, pool, "user_select_batch", userA, []map[string]any{{"is_agent": false}})
	if !unmarshalSelect(t, rows[0].Result)[strconv.FormatInt(userB, 10)] {
		t.Errorf("non-admin should still see human userB")
	}
}

// =============================================================
// user_list_with_roles_batch
// =============================================================

type lwrRoleAssign struct {
	RoleName          string  `json:"role_name"`
	ScopeProjectID    *string `json:"scope_project_id"`
	ScopeProjectTitle *string `json:"scope_project_title"`
}

type lwrRow struct {
	ID           string          `json:"id"`
	DisplayName  string          `json:"display_name"`
	Email        *string         `json:"email"`
	OIDCSub      *string         `json:"oidc_sub"`
	ParentUserID *string         `json:"parent_user_id"`
	IsAgent      bool            `json:"is_agent"`
	PersonCardID *string         `json:"person_card_id"`
	Roles        []lwrRoleAssign `json:"roles"`
}

type lwrOut struct {
	Rows []lwrRow `json:"rows"`
}

func TestUserListWithRolesBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_user_list_with_roles_happy")
	rows := callBatch(t, pool, "user_list_with_roles_batch", auth.SystemUserID,
		[]map[string]any{{}})
	if !rows[0].OK {
		t.Fatalf("want ok=true; got %+v", rows[0])
	}
	var out lwrOut
	if err := json.Unmarshal(rows[0].Result, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(out.Rows) == 0 {
		t.Fatalf("expected at least System user")
	}
	// System user has the system role globally.
	var system *lwrRow
	for i := range out.Rows {
		if out.Rows[i].ID == strconv.FormatInt(auth.SystemUserID, 10) {
			system = &out.Rows[i]
		}
	}
	if system == nil {
		t.Fatalf("System user not in result")
	}
	hasAdmin := false
	for _, r := range system.Roles {
		if r.RoleName == "admin" && r.ScopeProjectID == nil {
			hasAdmin = true
		}
	}
	if !hasAdmin {
		t.Errorf("System user should hold global 'admin' role; got %+v", system.Roles)
	}
}

func TestUserListWithRolesBatch_MultiInput(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_user_list_with_roles_multi")
	rows := callBatch(t, pool, "user_list_with_roles_batch", auth.SystemUserID,
		[]map[string]any{{}, {}, {}})
	if len(rows) != 3 {
		t.Fatalf("rows: got %d", len(rows))
	}
	for i, r := range rows {
		if !r.OK {
			t.Errorf("row %d: %+v", i, r)
		}
	}
	var a, c lwrOut
	_ = json.Unmarshal(rows[0].Result, &a)
	_ = json.Unmarshal(rows[2].Result, &c)
	if len(a.Rows) != len(c.Rows) {
		t.Errorf("snapshot mismatch across inputs: %d vs %d", len(a.Rows), len(c.Rows))
	}
}

func TestUserSetDisplayNameBatch(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_user_set_display_name")
	ctx := context.Background()
	var uid int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO user_account (display_name) VALUES ('before') RETURNING id`,
	).Scan(&uid); err != nil {
		t.Fatal(err)
	}

	// First call: actually updates → updated=true. Reads back the new value.
	rows := callBatch(t, pool, "user_set_display_name_batch", auth.SystemUserID,
		[]map[string]any{{"user_account_id": strconv.FormatInt(uid, 10), "display_name": "after"}})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("first call: %+v", rows)
	}
	var first struct{ Updated bool `json:"updated"` }
	_ = json.Unmarshal(rows[0].Result, &first)
	if !first.Updated {
		t.Errorf("first call should report updated=true; got %+v", first)
	}
	var got string
	if err := pool.QueryRow(ctx, `SELECT display_name FROM user_account WHERE id=$1`, uid).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != "after" {
		t.Errorf("display_name not persisted: got %q want %q", got, "after")
	}

	// Idempotent repeat: same payload → updated=false.
	rows = callBatch(t, pool, "user_set_display_name_batch", auth.SystemUserID,
		[]map[string]any{{"user_account_id": strconv.FormatInt(uid, 10), "display_name": "after"}})
	var second struct{ Updated bool `json:"updated"` }
	_ = json.Unmarshal(rows[0].Result, &second)
	if second.Updated {
		t.Errorf("repeat call should report updated=false; got %+v", second)
	}

	// Validation: empty display_name rejects.
	rows = callBatch(t, pool, "user_set_display_name_batch", auth.SystemUserID,
		[]map[string]any{{"user_account_id": strconv.FormatInt(uid, 10), "display_name": "   "}})
	if rows[0].OK {
		t.Errorf("empty (whitespace-only) display_name should reject; got %+v", rows[0])
	}
	if rows[0].Code != "validation" {
		t.Errorf("want validation code; got %q", rows[0].Code)
	}

	// Validation: missing user_account_id rejects.
	rows = callBatch(t, pool, "user_set_display_name_batch", auth.SystemUserID,
		[]map[string]any{{"display_name": "x"}})
	if rows[0].OK {
		t.Errorf("missing user_account_id should reject; got %+v", rows[0])
	}
}

func TestUserListWithRolesBatch_EmptyRoles(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_user_list_with_roles_empty")
	ctx := context.Background()
	// Create a brand-new user with no role assignments.
	var uid int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO user_account (display_name) VALUES ('no-roles') RETURNING id`,
	).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	rows := callBatch(t, pool, "user_list_with_roles_batch", auth.SystemUserID,
		[]map[string]any{{}})
	var out lwrOut
	_ = json.Unmarshal(rows[0].Result, &out)
	for _, r := range out.Rows {
		if r.ID == strconv.FormatInt(uid, 10) {
			if r.Roles == nil {
				t.Errorf("roles should be [] (empty array), not null for user %d", uid)
			}
			if len(r.Roles) != 0 {
				t.Errorf("user %d should have 0 roles, got %d", uid, len(r.Roles))
			}
			return
		}
	}
	t.Errorf("user %d missing from result", uid)
}
