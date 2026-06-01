// Direct PL/pgSQL test for comm_set_ack_batch — the per-thread ACK toggle.
// Mirrors comm_set_recipients_batch_test.go: calls the function over
// pool.Query and asserts per-row outputs + the stored bool value.
package comm_test

import (
	"context"
	"encoding/json"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

type setAckResult struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callCommSetAckBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []setAckResult {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM comm_set_ack_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var out []setAckResult
	for rows.Next() {
		var r setAckResult
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

func readCommAcked(t *testing.T, pool *pgxpool.Pool, commID int64) (val bool, present bool) {
	t.Helper()
	var stored []byte
	err := pool.QueryRow(context.Background(), `
		SELECT av.value FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1 AND ad.name = 'acked'
	`, commID).Scan(&stored)
	if err != nil {
		return false, false // no row
	}
	if err := json.Unmarshal(stored, &val); err != nil {
		t.Fatalf("decode acked: %v: %s", err, stored)
	}
	return val, true
}

// TestCommSetAckBatch_Toggle — set acked true (default), then false, then
// back to true; the stored bool tracks each write.
func TestCommSetAckBatch_Toggle(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_set_ack_batch_toggle")
	commID := seedCommCardDirect(t, pool, "comm")

	// Omitted acked defaults to true ("mark handled").
	rows := callCommSetAckBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"comm_id": strconv.FormatInt(commID, 10)},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("default-ack row: %+v", rows)
	}
	var got struct {
		Acked bool `json:"acked"`
	}
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !got.Acked {
		t.Errorf("default acked=%v want true", got.Acked)
	}
	if v, ok := readCommAcked(t, pool, commID); !ok || !v {
		t.Errorf("stored acked=(%v,%v) want (true,true)", v, ok)
	}

	// Explicit false re-opens the thread.
	rows = callCommSetAckBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"comm_id": strconv.FormatInt(commID, 10), "acked": false},
	})
	if !rows[0].OK {
		t.Fatalf("reopen row: %+v", rows[0])
	}
	if v, ok := readCommAcked(t, pool, commID); !ok || v {
		t.Errorf("stored acked=(%v,%v) want (false,true)", v, ok)
	}

	// Explicit true marks it handled again.
	rows = callCommSetAckBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"comm_id": strconv.FormatInt(commID, 10), "acked": true},
	})
	if !rows[0].OK {
		t.Fatalf("re-ack row: %+v", rows[0])
	}
	if v, ok := readCommAcked(t, pool, commID); !ok || !v {
		t.Errorf("stored acked=(%v,%v) want (true,true)", v, ok)
	}
}

// TestCommSetAckBatch_Validation — missing comm_id is a per-row validation
// failure; a non-comm card is wrong_card_type.
func TestCommSetAckBatch_Validation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_set_ack_batch_validation")
	taskID := seedCommCardDirect(t, pool, "task")

	rows := callCommSetAckBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"comm_id": "0", "acked": true},
		{"comm_id": strconv.FormatInt(taskID, 10), "acked": true},
	})
	if len(rows) != 2 {
		t.Fatalf("rows: %d", len(rows))
	}
	if rows[0].OK || rows[0].Code != "validation" {
		t.Errorf("row 0 want validation; got %+v", rows[0])
	}
	if rows[1].OK || rows[1].Code != "wrong_card_type" {
		t.Errorf("row 1 want wrong_card_type; got %+v", rows[1])
	}
}
