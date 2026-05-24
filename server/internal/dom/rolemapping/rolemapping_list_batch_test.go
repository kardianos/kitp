// Direct PL/pgSQL test for role_mapping_list_batch — Phase 5 of
// docs/UNIFIED_HANDLER_PLAN.md. Calls the function over pool.Query and
// asserts the rows aggregate matches what the legacy runList surfaced.
package rolemapping_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

type listMappingRow struct {
	ClaimValue string `json:"claim_value"`
	RoleID     string `json:"role_id"`
	RoleName   string `json:"role_name"`
}

type listMappingOut struct {
	Rows []listMappingRow `json:"rows"`
}

func TestRoleMappingListBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_role_mapping_list_happy")
	ctx := context.Background()
	// Add a uniquely-named row alongside the install seed so we can
	// assert the function surfaces it.
	if _, err := pool.Exec(ctx, `
		INSERT INTO role_mapping (claim_value, role_id)
		SELECT 'kitp.list-test', id FROM role WHERE name = 'worker'
	`); err != nil {
		t.Fatal(err)
	}
	rows := callBatch(t, pool, "role_mapping_list_batch", auth.SystemUserID, []map[string]any{{}})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(rows))
	}
	if !rows[0].OK {
		t.Fatalf("want ok=true; got %+v", rows[0])
	}
	var out listMappingOut
	if err := json.Unmarshal(rows[0].Result, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	found := false
	for _, r := range out.Rows {
		if r.ClaimValue == "kitp.list-test" && r.RoleName == "worker" {
			found = true
			if r.RoleID == "" {
				t.Errorf("role_id should be string-encoded bigint, got empty")
			}
		}
	}
	if !found {
		t.Errorf("did not find seeded (kitp.list-test, worker) row in %+v", out.Rows)
	}
}

func TestRoleMappingListBatch_Empty(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_role_mapping_list_empty")
	// Strip the install-seeded mappings to verify the function returns
	// `rows: []` (empty array, not null) on an empty table.
	if _, err := pool.Exec(context.Background(), `DELETE FROM role_mapping`); err != nil {
		t.Fatal(err)
	}
	rows := callBatch(t, pool, "role_mapping_list_batch", auth.SystemUserID, []map[string]any{{}})
	if !rows[0].OK {
		t.Fatalf("want ok=true; got %+v", rows[0])
	}
	var out listMappingOut
	if err := json.Unmarshal(rows[0].Result, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Rows == nil {
		t.Errorf("rows should be [] (empty array), not null")
	}
	if len(out.Rows) != 0 {
		t.Errorf("rows: got %d, want 0", len(out.Rows))
	}
}

func TestRoleMappingListBatch_MultiInput(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_role_mapping_list_multi")
	rows := callBatch(t, pool, "role_mapping_list_batch", auth.SystemUserID,
		[]map[string]any{{}, {}, {}})
	if len(rows) != 3 {
		t.Fatalf("rows: got %d, want 3", len(rows))
	}
	for i, r := range rows {
		if !r.OK {
			t.Errorf("row %d: ok=false code=%q msg=%q", i, r.Code, r.Message)
		}
	}
}
