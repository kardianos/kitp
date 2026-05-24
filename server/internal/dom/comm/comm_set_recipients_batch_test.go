// Direct PL/pgSQL test for comm_set_recipients_batch — Phase 3 of
// docs/UNIFIED_HANDLER_PLAN.md. Tests call the function over
// `pool.Query` and assert per-row outputs, independent of the
// dispatcher-driven integration test in comm_test.go.
package comm_test

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

// setRecipientsResult mirrors the function's RETURNS TABLE shape.
type setRecipientsResult struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callCommSetRecipientsBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []setRecipientsResult {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM comm_set_recipients_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var out []setRecipientsResult
	for rows.Next() {
		var r setRecipientsResult
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

// seedCommCardDirect inserts a card of the supplied card_type_name
// directly, bypassing the dispatcher so the function test is independent
// of card.insert. Returns the new card id.
func seedCommCardDirect(t *testing.T, pool *pgxpool.Pool, cardTypeName string) int64 {
	t.Helper()
	var id int64
	if err := pool.QueryRow(context.Background(), `
		INSERT INTO card (card_type_id)
		SELECT id FROM card_type WHERE name = $1
		RETURNING id
	`, cardTypeName).Scan(&id); err != nil {
		t.Fatalf("seed %s card: %v", cardTypeName, err)
	}
	return id
}

// TestCommSetRecipientsBatch_Happy — one comm + two person cards, one
// happy row returns count=2 and writes the canonical numeric jsonb
// array on the comm.
func TestCommSetRecipientsBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_set_recipients_batch_happy")
	commID := seedCommCardDirect(t, pool, "comm")
	p1 := seedCommCardDirect(t, pool, "person")
	p2 := seedCommCardDirect(t, pool, "person")

	rows := callCommSetRecipientsBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"comm_id": strconv.FormatInt(commID, 10),
			"recipient_person_ids": []string{
				strconv.FormatInt(p1, 10), strconv.FormatInt(p2, 10)}},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(rows))
	}
	r := rows[0]
	if !r.OK || r.Code != "" {
		t.Fatalf("want ok=true; got ok=%v code=%q msg=%q", r.OK, r.Code, r.Message)
	}
	var got struct {
		Count int `json:"count"`
	}
	if err := json.Unmarshal(r.Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Count != 2 {
		t.Errorf("count=%d want 2", got.Count)
	}

	// The function writes a canonical NUMERIC jsonb array; verify the
	// stored value uses numbers, not strings, so the read paths that
	// expect `jsonb_typeof(value)='array'` + numeric elements stay
	// consistent with attribute_update_batch's canonicaliser.
	var stored []byte
	if err := pool.QueryRow(context.Background(), `
		SELECT av.value FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1 AND ad.name = 'comm_recipients'
	`, commID).Scan(&stored); err != nil {
		t.Fatalf("read attribute_value: %v", err)
	}
	var ids []int64
	if err := json.Unmarshal(stored, &ids); err != nil {
		t.Fatalf("decode stored: %v: %s", err, stored)
	}
	if len(ids) != 2 || ids[0] != p1 || ids[1] != p2 {
		t.Errorf("stored=%v want [%d, %d] (numeric)", ids, p1, p2)
	}
}

// TestCommSetRecipientsBatch_MultiRow — N independent comms, all ok.
func TestCommSetRecipientsBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_set_recipients_batch_multi")
	commA := seedCommCardDirect(t, pool, "comm")
	commB := seedCommCardDirect(t, pool, "comm")
	p1 := seedCommCardDirect(t, pool, "person")
	p2 := seedCommCardDirect(t, pool, "person")

	rows := callCommSetRecipientsBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"comm_id": strconv.FormatInt(commA, 10),
			"recipient_person_ids": []string{strconv.FormatInt(p1, 10)}},
		{"comm_id": strconv.FormatInt(commB, 10),
			"recipient_person_ids": []string{
				strconv.FormatInt(p1, 10), strconv.FormatInt(p2, 10)}},
	})
	if len(rows) != 2 {
		t.Fatalf("rows: got %d want 2", len(rows))
	}
	for i, r := range rows {
		if r.Idx != i {
			t.Errorf("row %d: idx=%d want %d", i, r.Idx, i)
		}
		if !r.OK {
			t.Errorf("row %d: ok=false code=%q msg=%q", i, r.Code, r.Message)
		}
	}
	var aCount, bCount int
	_ = json.Unmarshal(rows[0].Result, &struct {
		Count *int `json:"count"`
	}{Count: &aCount})
	_ = json.Unmarshal(rows[1].Result, &struct {
		Count *int `json:"count"`
	}{Count: &bCount})
	if aCount != 1 || bCount != 2 {
		t.Errorf("counts=(%d,%d) want (1,2)", aCount, bCount)
	}
}

// TestCommSetRecipientsBatch_PerRowFailure — three inputs: one happy,
// one missing comm_id, one referencing a non-person id. Each surfaces
// its own per-row code without aborting the function.
func TestCommSetRecipientsBatch_PerRowFailure(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_set_recipients_batch_perrow")
	comm1 := seedCommCardDirect(t, pool, "comm")
	comm2 := seedCommCardDirect(t, pool, "comm")
	notPerson := seedCommCardDirect(t, pool, "task")
	p1 := seedCommCardDirect(t, pool, "person")

	rows := callCommSetRecipientsBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"comm_id": strconv.FormatInt(comm1, 10),
			"recipient_person_ids": []string{strconv.FormatInt(p1, 10)}},
		{"comm_id": "0",
			"recipient_person_ids": []string{}},
		{"comm_id": strconv.FormatInt(comm2, 10),
			"recipient_person_ids": []string{strconv.FormatInt(notPerson, 10)}},
	})
	if len(rows) != 3 {
		t.Fatalf("rows: %d", len(rows))
	}
	if !rows[0].OK {
		t.Errorf("row 0 should be ok; got %+v", rows[0])
	}
	if rows[1].OK || rows[1].Code != "validation" {
		t.Errorf("row 1 want validation; got %+v", rows[1])
	}
	if !strings.Contains(rows[1].Message, "comm_id is required") {
		t.Errorf("row 1 message: %q", rows[1].Message)
	}
	if rows[2].OK || rows[2].Code != "invalid_recipient" {
		t.Errorf("row 2 want invalid_recipient; got %+v", rows[2])
	}
	if !strings.Contains(rows[2].Message, "not person") {
		t.Errorf("row 2 message: %q", rows[2].Message)
	}
}

// TestCommSetRecipientsBatch_NonCommRejects — a comm_id pointing at a
// non-comm card returns wrong_card_type, mirroring the legacy code
// path's response.
func TestCommSetRecipientsBatch_NonCommRejects(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_set_recipients_batch_non_comm")
	taskID := seedCommCardDirect(t, pool, "task")
	rows := callCommSetRecipientsBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"comm_id": strconv.FormatInt(taskID, 10),
			"recipient_person_ids": []string{}},
	})
	if len(rows) != 1 || rows[0].OK {
		t.Fatalf("row should fail: %+v", rows)
	}
	if rows[0].Code != "wrong_card_type" {
		t.Errorf("code=%q want wrong_card_type", rows[0].Code)
	}
}

// TestCommSetRecipientsBatch_EmptyClears — passing an empty list clears
// the attribute (count=0) and stores `[]` as the canonical value.
func TestCommSetRecipientsBatch_EmptyClears(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_set_recipients_batch_empty")
	commID := seedCommCardDirect(t, pool, "comm")
	p1 := seedCommCardDirect(t, pool, "person")

	// Seed one recipient.
	_ = callCommSetRecipientsBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"comm_id": strconv.FormatInt(commID, 10),
			"recipient_person_ids": []string{strconv.FormatInt(p1, 10)}},
	})
	// Clear it.
	rows := callCommSetRecipientsBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"comm_id": strconv.FormatInt(commID, 10),
			"recipient_person_ids": []string{}},
	})
	if !rows[0].OK {
		t.Fatalf("clear: %+v", rows[0])
	}
	var got struct {
		Count int `json:"count"`
	}
	_ = json.Unmarshal(rows[0].Result, &got)
	if got.Count != 0 {
		t.Errorf("count=%d want 0", got.Count)
	}
	var stored []byte
	if err := pool.QueryRow(context.Background(), `
		SELECT av.value FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1 AND ad.name = 'comm_recipients'
	`, commID).Scan(&stored); err != nil {
		t.Fatalf("read: %v", err)
	}
	if strings.TrimSpace(string(stored)) != "[]" {
		t.Errorf("stored=%q want []", stored)
	}
}
