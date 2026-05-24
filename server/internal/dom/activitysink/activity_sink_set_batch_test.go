// Direct PL/pgSQL test for activity_sink_set_batch — Phase 3 of
// docs/UNIFIED_HANDLER_PLAN.md. Calls the function over tx.Query and
// asserts per-row outputs, independent of the dispatcher-driven
// integration tests in handlers_test.go.
package activitysink_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

// resultRow mirrors the function's RETURNS TABLE shape.
type resultRow struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callActivitySinkSetBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []resultRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM activity_sink_set_batch($1::bigint, $2::jsonb)
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

// sinkBatchFixture is a minimal seed for the function tests: one project
// card we can use as parent. The dispatcher-driven `setupSink` fixture
// is too heavy for these tests since it bootstraps the whole server.
type sinkBatchFixture struct {
	pool      *pgxpool.Pool
	projectID int64
}

func seedSinkBatchFixture(t *testing.T, pool *pgxpool.Pool) *sinkBatchFixture {
	t.Helper()
	ctx := context.Background()
	var projectCTID int64
	if err := pool.QueryRow(ctx, `SELECT id FROM card_type WHERE name='project'`).Scan(&projectCTID); err != nil {
		t.Fatalf("project ct: %v", err)
	}
	var projectID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO card (card_type_id, phase) VALUES ($1, 'triage') RETURNING id
	`, projectCTID).Scan(&projectID); err != nil {
		t.Fatalf("project card: %v", err)
	}
	// The secret upsert calls pgp_sym_encrypt(current_setting('app.comm_secret_key')).
	// Set the per-session GUC so the function's encrypt call doesn't trip
	// "unrecognized configuration parameter".
	if _, err := pool.Exec(ctx, `SET app.comm_secret_key = 'test-key'`); err != nil {
		t.Fatalf("set guc: %v", err)
	}
	return &sinkBatchFixture{pool: pool, projectID: projectID}
}

func TestActivitySinkSetBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_activity_sink_set_batch_happy")
	f := seedSinkBatchFixture(t, pool)

	rows := callActivitySinkSetBatch(t, pool, auth.SystemUserID, []map[string]any{
		{
			"project_id":            jsonInt(f.projectID),
			"name":                  "Teams sink",
			"sink_kind":             "msgraph_teams",
			"msgraph_tenant_id":     "tenant-uuid",
			"msgraph_client_id":     "client-uuid",
			"msgraph_client_secret": "super-secret",
			"msgraph_team_id":       "team-id",
			"msgraph_channel_id":    "channel-id",
		},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("happy: %+v", rows)
	}
	var got struct {
		SinkID string `json:"sink_id"`
	}
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.SinkID == "" {
		t.Fatal("missing sink_id")
	}

	// activity_sink_secret should hold the encrypted bytes.
	var hasSecret bool
	if err := pool.QueryRow(context.Background(), `
		SELECT client_secret IS NOT NULL FROM activity_sink_secret WHERE sink_card_id = $1::bigint
	`, got.SinkID).Scan(&hasSecret); err != nil {
		t.Fatalf("read secret: %v", err)
	}
	if !hasSecret {
		t.Error("activity_sink_secret.client_secret is null after insert")
	}

	// Decrypting via the same GUC must round-trip the cleartext.
	var decrypted string
	if err := pool.QueryRow(context.Background(), `
		SELECT pgp_sym_decrypt(client_secret, current_setting('app.comm_secret_key'))
		FROM activity_sink_secret WHERE sink_card_id = $1::bigint
	`, got.SinkID).Scan(&decrypted); err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if decrypted != "super-secret" {
		t.Errorf("decrypted=%q want super-secret", decrypted)
	}
}

func TestActivitySinkSetBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_activity_sink_set_batch_multi")
	f := seedSinkBatchFixture(t, pool)

	rows := callActivitySinkSetBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"project_id": jsonInt(f.projectID), "name": "Sink A", "sink_kind": "msgraph_teams"},
		{"project_id": jsonInt(f.projectID), "name": "Sink B", "sink_kind": "msgraph_teams"},
	})
	if len(rows) != 2 {
		t.Fatalf("rows: got %d", len(rows))
	}
	seen := map[string]bool{}
	for i, r := range rows {
		if !r.OK {
			t.Errorf("row %d: %+v", i, r)
			continue
		}
		var got struct {
			SinkID string `json:"sink_id"`
		}
		if err := json.Unmarshal(r.Result, &got); err != nil {
			t.Fatalf("row %d unmarshal: %v", i, err)
		}
		if seen[got.SinkID] {
			t.Errorf("row %d: duplicate sink_id %s", i, got.SinkID)
		}
		seen[got.SinkID] = true
	}
}

func TestActivitySinkSetBatch_PerRowValidation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_activity_sink_set_batch_validation")
	f := seedSinkBatchFixture(t, pool)

	rows := callActivitySinkSetBatch(t, pool, auth.SystemUserID, []map[string]any{
		// row 0: ok
		{"project_id": jsonInt(f.projectID), "name": "OK", "sink_kind": "msgraph_teams"},
		// row 1: missing name
		{"project_id": jsonInt(f.projectID), "name": "", "sink_kind": "msgraph_teams"},
		// row 2: unknown sink_kind
		{"project_id": jsonInt(f.projectID), "name": "X", "sink_kind": "webhook"},
		// row 3: project_id is missing
		{"project_id": "0", "name": "Y", "sink_kind": "msgraph_teams"},
	})
	if !rows[0].OK {
		t.Errorf("row 0: %+v", rows[0])
	}
	if rows[1].OK || rows[1].Code != "validation" {
		t.Errorf("row 1: %+v", rows[1])
	}
	if !strings.Contains(rows[1].Message, "name is required") {
		t.Errorf("row 1 msg=%q", rows[1].Message)
	}
	if rows[2].OK || rows[2].Code != "validation" {
		t.Errorf("row 2: %+v", rows[2])
	}
	if !strings.Contains(rows[2].Message, "not supported") {
		t.Errorf("row 2 msg=%q", rows[2].Message)
	}
	if rows[3].OK || rows[3].Code != "validation" {
		t.Errorf("row 3: %+v", rows[3])
	}
}

// TestActivitySinkSetBatch_UpdatePreservesSecret — handler-specific
// case: omitting msgraph_client_secret on update leaves the stored
// encrypted bytes intact (mirrors the legacy upsertSinkSecret
// nil-pointer = preserve semantics).
func TestActivitySinkSetBatch_UpdatePreservesSecret(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_activity_sink_set_batch_secret_preserve")
	f := seedSinkBatchFixture(t, pool)

	// Insert with a secret.
	rows := callActivitySinkSetBatch(t, pool, auth.SystemUserID, []map[string]any{
		{
			"project_id":            jsonInt(f.projectID),
			"name":                  "Sink",
			"sink_kind":             "msgraph_teams",
			"msgraph_client_secret": "initial-secret",
		},
	})
	if !rows[0].OK {
		t.Fatalf("insert: %+v", rows[0])
	}
	var ins struct {
		SinkID string `json:"sink_id"`
	}
	if err := json.Unmarshal(rows[0].Result, &ins); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	var before []byte
	if err := pool.QueryRow(context.Background(),
		`SELECT client_secret FROM activity_sink_secret WHERE sink_card_id = $1::bigint`,
		ins.SinkID).Scan(&before); err != nil {
		t.Fatalf("read before: %v", err)
	}

	// Update without msgraph_client_secret — preserve the existing bytes.
	rows = callActivitySinkSetBatch(t, pool, auth.SystemUserID, []map[string]any{
		{
			"id":         ins.SinkID,
			"project_id": jsonInt(f.projectID),
			"name":       "Sink renamed",
			"sink_kind":  "msgraph_teams",
		},
	})
	if !rows[0].OK {
		t.Fatalf("update: %+v", rows[0])
	}

	var after []byte
	if err := pool.QueryRow(context.Background(),
		`SELECT client_secret FROM activity_sink_secret WHERE sink_card_id = $1::bigint`,
		ins.SinkID).Scan(&after); err != nil {
		t.Fatalf("read after: %v", err)
	}
	if string(before) != string(after) {
		t.Errorf("secret bytes changed across update without msgraph_client_secret: before=%d after=%d", len(before), len(after))
	}

	// Decryption still works.
	var decrypted string
	if err := pool.QueryRow(context.Background(), `
		SELECT pgp_sym_decrypt(client_secret, current_setting('app.comm_secret_key'))
		FROM activity_sink_secret WHERE sink_card_id = $1::bigint
	`, ins.SinkID).Scan(&decrypted); err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if decrypted != "initial-secret" {
		t.Errorf("decrypted=%q want initial-secret", decrypted)
	}
}

// jsonInt formats an int64 as a decimal string — matches the
// dispatcher's `json:",string"` wire convention.
func jsonInt(v int64) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
