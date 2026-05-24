// Direct PL/pgSQL test for activity_sink_list_batch — Phase 5 of
// docs/UNIFIED_HANDLER_PLAN.md. Reuses callActivitySinkSetBatch's
// resultRow / seedSinkBatchFixture / jsonInt helpers from
// activity_sink_set_batch_test.go (same _test package).
package activitysink_test

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

func callActivitySinkListBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []resultRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM activity_sink_list_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var out []resultRow
	for rows.Next() {
		var r resultRow
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

type sinkListRow struct {
	ID                 string `json:"id"`
	Name               string `json:"name"`
	SinkKind           string `json:"sink_kind"`
	MSGraphTenantID    string `json:"msgraph_tenant_id"`
	MSGraphClientID    string `json:"msgraph_client_id"`
	MSGraphTeamID      string `json:"msgraph_team_id"`
	MSGraphChannelID   string `json:"msgraph_channel_id"`
	ActivityFilter     string `json:"activity_filter"`
	ChannelStatus      string `json:"channel_status"`
	ChannelFaultReason string `json:"channel_fault_reason"`
	HasClientSecret    bool   `json:"has_client_secret"`
	LastActivityID     string `json:"last_activity_id"`
	LastPushedAt       string `json:"last_pushed_at"`
	LastPushedCount    string `json:"last_pushed_count"`
	LastError          string `json:"last_error"`
	CreatedAt          string `json:"created_at"`
}

type sinkListOut struct {
	Rows []sinkListRow `json:"rows"`
}

// Insert a sink via the set_batch path so the test fixture matches what
// activity_sink.list would actually be reading in production.
func seedSinkViaSet(t *testing.T, pool *pgxpool.Pool, projectID int64, name, secret string) string {
	t.Helper()
	rows := callActivitySinkSetBatch(t, pool, auth.SystemUserID, []map[string]any{
		{
			"project_id":            jsonInt(projectID),
			"name":                  name,
			"sink_kind":             "msgraph_teams",
			"msgraph_tenant_id":     "tenant",
			"msgraph_client_id":     "client",
			"msgraph_client_secret": secret,
			"msgraph_team_id":       "team",
			"msgraph_channel_id":    "channel",
		},
	})
	if !rows[0].OK {
		t.Fatalf("seed sink: %+v", rows[0])
	}
	var got struct {
		SinkID string `json:"sink_id"`
	}
	_ = json.Unmarshal(rows[0].Result, &got)
	return got.SinkID
}

func TestActivitySinkListBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_activity_sink_list_happy")
	f := seedSinkBatchFixture(t, pool)
	sinkID := seedSinkViaSet(t, pool, f.projectID, "Teams A", "secret-A")

	rows := callActivitySinkListBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"project_id": strconv.FormatInt(f.projectID, 10)},
	})
	if !rows[0].OK {
		t.Fatalf("want ok=true; got %+v", rows[0])
	}
	var out sinkListOut
	if err := json.Unmarshal(rows[0].Result, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(out.Rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(out.Rows))
	}
	r := out.Rows[0]
	if r.ID != sinkID {
		t.Errorf("id: got %q, want %q", r.ID, sinkID)
	}
	if r.Name != "Teams A" {
		t.Errorf("name: got %q", r.Name)
	}
	if !r.HasClientSecret {
		t.Errorf("has_client_secret should be true")
	}
	// CRITICAL: the encrypted bytes must never leak.
	if strings.Contains(string(rows[0].Result), "secret-A") {
		t.Errorf("client_secret cleartext leaked into result")
	}
	if r.ChannelStatus != "enabled" {
		t.Errorf("channel_status default: got %q, want enabled", r.ChannelStatus)
	}
}

func TestActivitySinkListBatch_EmptyProject(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_activity_sink_list_empty")
	f := seedSinkBatchFixture(t, pool)
	rows := callActivitySinkListBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"project_id": strconv.FormatInt(f.projectID, 10)},
	})
	if !rows[0].OK {
		t.Fatalf("want ok=true; got %+v", rows[0])
	}
	var out sinkListOut
	_ = json.Unmarshal(rows[0].Result, &out)
	if out.Rows == nil {
		t.Errorf("rows should be [] (empty array), not null")
	}
	if len(out.Rows) != 0 {
		t.Errorf("rows: got %d, want 0", len(out.Rows))
	}
}

func TestActivitySinkListBatch_PerRowValidation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_activity_sink_list_validation")
	_ = seedSinkBatchFixture(t, pool)
	rows := callActivitySinkListBatch(t, pool, auth.SystemUserID, []map[string]any{
		{}, // missing project_id
	})
	if rows[0].OK {
		t.Fatalf("row should fail")
	}
	if rows[0].Code != "validation" {
		t.Errorf("code=%q", rows[0].Code)
	}
}

func TestActivitySinkListBatch_MultiInput(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_activity_sink_list_multi")
	f := seedSinkBatchFixture(t, pool)
	_ = seedSinkViaSet(t, pool, f.projectID, "Teams M1", "s1")
	_ = seedSinkViaSet(t, pool, f.projectID, "Teams M2", "s2")
	rows := callActivitySinkListBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"project_id": strconv.FormatInt(f.projectID, 10)},
		{"project_id": strconv.FormatInt(f.projectID, 10)},
	})
	if len(rows) != 2 {
		t.Fatalf("rows: got %d", len(rows))
	}
	for i, r := range rows {
		if !r.OK {
			t.Errorf("row %d: %+v", i, r)
		}
		var out sinkListOut
		_ = json.Unmarshal(r.Result, &out)
		if len(out.Rows) != 2 {
			t.Errorf("row %d: got %d sinks, want 2", i, len(out.Rows))
		}
	}
}
