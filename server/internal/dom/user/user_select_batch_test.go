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
