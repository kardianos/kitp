// Direct PL/pgSQL test for card_set_phase_batch — Phase 2 of
// docs/UNIFIED_HANDLER_PLAN.md.
package card_test

import (
	"context"
	"encoding/json"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

type cardSetPhaseRow struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callCardSetPhaseBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []cardSetPhaseRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM card_set_phase_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var out []cardSetPhaseRow
	for rows.Next() {
		var r cardSetPhaseRow
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

// TestCardSetPhaseBatch_Happy — single happy path; phase column lands.
func TestCardSetPhaseBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_set_phase_batch_happy")
	p := seedCardUnder(t, pool, "project", 0)
	s := seedCardUnder(t, pool, "status", p)
	rows := callCardSetPhaseBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": strconv.FormatInt(s, 10), "phase": "active"},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("set_phase failed: %+v", rows)
	}
	var phase string
	if err := pool.QueryRow(context.Background(),
		`SELECT phase FROM card WHERE id = $1`, s).Scan(&phase); err != nil {
		t.Fatalf("read phase: %v", err)
	}
	if phase != "active" {
		t.Errorf("phase=%q, want 'active'", phase)
	}
}

// TestCardSetPhaseBatch_MultiRow — N inputs, all ok.
func TestCardSetPhaseBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_set_phase_batch_multi")
	p := seedCardUnder(t, pool, "project", 0)
	ids := []int64{
		seedCardUnder(t, pool, "status", p),
		seedCardUnder(t, pool, "status", p),
	}
	rows := callCardSetPhaseBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": strconv.FormatInt(ids[0], 10), "phase": "active"},
		{"card_id": strconv.FormatInt(ids[1], 10), "phase": "terminal"},
	})
	if len(rows) != 2 {
		t.Fatalf("rows: got %d", len(rows))
	}
	for i, r := range rows {
		if r.Idx != i || !r.OK {
			t.Errorf("row %d: %+v", i, r)
		}
	}
}

// TestCardSetPhaseBatch_BadPhase — value not in (triage,active,terminal)
// → 'validation'.
func TestCardSetPhaseBatch_BadPhase(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_set_phase_batch_bad")
	p := seedCardUnder(t, pool, "project", 0)
	s := seedCardUnder(t, pool, "status", p)
	rows := callCardSetPhaseBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": strconv.FormatInt(s, 10), "phase": "bogus"},
	})
	if len(rows) != 1 || rows[0].OK {
		t.Fatalf("want fail: %+v", rows)
	}
	if rows[0].Code != "validation" {
		t.Errorf("code=%q, want 'validation'", rows[0].Code)
	}
}

// TestCardSetPhaseBatch_NotFound — missing card → 'card_not_found'.
func TestCardSetPhaseBatch_NotFound(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_set_phase_batch_404")
	rows := callCardSetPhaseBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": "9999999", "phase": "active"},
	})
	if len(rows) != 1 || rows[0].OK {
		t.Fatalf("want fail: %+v", rows)
	}
	if rows[0].Code != "card_not_found" {
		t.Errorf("code=%q, want 'card_not_found'", rows[0].Code)
	}
}
