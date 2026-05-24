// Direct PL/pgSQL test for attribute_def_select_batch — Phase 5 of
// docs/UNIFIED_HANDLER_PLAN.md. Reuses callSQLFunc + cardTypeID from
// attributedef_insert_batch_test.go (same _test package).
package attributedef_test

import (
	"context"
	"encoding/json"
	"strconv"
	"testing"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

type adBound struct {
	CardTypeID   string `json:"card_type_id"`
	CardTypeName string `json:"card_type_name"`
	IsRequired   bool   `json:"is_required"`
	IsBuiltIn    bool   `json:"is_built_in"`
	Ordering     int32  `json:"ordering"`
}

type adSelectRow struct {
	ID                 string    `json:"id"`
	Name               string    `json:"name"`
	ValueType          string    `json:"value_type"`
	TargetCardTypeName string    `json:"target_card_type_name"`
	IsBuiltIn          bool      `json:"is_built_in"`
	BoundTo            []adBound `json:"bound_to"`
}

type adSelectOut struct {
	Rows []adSelectRow `json:"rows"`
}

func TestAttributeDefSelectBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_ad_select_batch_happy")
	rows := callSQLFunc(t, pool, "attribute_def_select_batch",
		auth.SystemUserID, []map[string]any{{}})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d", len(rows))
	}
	if !rows[0].OK {
		t.Fatalf("want ok=true; got %+v", rows[0])
	}
	var out adSelectOut
	if err := json.Unmarshal(rows[0].Result, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(out.Rows) == 0 {
		t.Fatalf("expected built-in attribute_defs from the install seed")
	}
	// 'title' is one of the install-seeded built-in defs and is bound
	// to a number of card_types. Use it to assert the row shape.
	var title *adSelectRow
	for i := range out.Rows {
		if out.Rows[i].Name == "title" {
			title = &out.Rows[i]
		}
	}
	if title == nil {
		t.Fatalf("title def missing from result")
	}
	if !title.IsBuiltIn {
		t.Errorf("title.is_built_in should be true")
	}
	if title.ID == "" {
		t.Errorf("title.id should be string-encoded bigint")
	}
	if _, err := strconv.ParseInt(title.ID, 10, 64); err != nil {
		t.Errorf("title.id is not a decimal string: %q", title.ID)
	}
	if len(title.BoundTo) == 0 {
		t.Errorf("title should have at least one bound card_type")
	}
}

func TestAttributeDefSelectBatch_FilterByName(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_ad_select_batch_byname")
	rows := callSQLFunc(t, pool, "attribute_def_select_batch",
		auth.SystemUserID, []map[string]any{
			{"name": "title"},
		})
	if !rows[0].OK {
		t.Fatalf("want ok=true; got %+v", rows[0])
	}
	var out adSelectOut
	_ = json.Unmarshal(rows[0].Result, &out)
	if len(out.Rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(out.Rows))
	}
	if out.Rows[0].Name != "title" {
		t.Errorf("name: got %q", out.Rows[0].Name)
	}
}

func TestAttributeDefSelectBatch_EmptyOnUnknownFilter(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_ad_select_batch_empty")
	rows := callSQLFunc(t, pool, "attribute_def_select_batch",
		auth.SystemUserID, []map[string]any{
			{"name": "no-such-attribute-def"},
		})
	if !rows[0].OK {
		t.Fatalf("want ok=true; got %+v", rows[0])
	}
	var out adSelectOut
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

func TestAttributeDefSelectBatch_FilterByID(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_ad_select_batch_byid")
	// Snapshot title's id from the seed.
	var titleID int64
	if err := pool.QueryRow(context.Background(),
		`SELECT id FROM attribute_def WHERE name = 'title'`,
	).Scan(&titleID); err != nil {
		t.Fatal(err)
	}
	rows := callSQLFunc(t, pool, "attribute_def_select_batch",
		auth.SystemUserID, []map[string]any{
			{"id": strconv.FormatInt(titleID, 10)},
		})
	if !rows[0].OK {
		t.Fatalf("want ok=true; got %+v", rows[0])
	}
	var out adSelectOut
	_ = json.Unmarshal(rows[0].Result, &out)
	if len(out.Rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(out.Rows))
	}
	if out.Rows[0].ID != strconv.FormatInt(titleID, 10) {
		t.Errorf("id: got %q, want %d", out.Rows[0].ID, titleID)
	}
}

func TestAttributeDefSelectBatch_MultiInput(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_ad_select_batch_multi")
	rows := callSQLFunc(t, pool, "attribute_def_select_batch",
		auth.SystemUserID, []map[string]any{{}, {}, {}})
	if len(rows) != 3 {
		t.Fatalf("rows: got %d", len(rows))
	}
	for i, r := range rows {
		if !r.OK {
			t.Errorf("row %d: %+v", i, r)
		}
	}
	var a, c adSelectOut
	_ = json.Unmarshal(rows[0].Result, &a)
	_ = json.Unmarshal(rows[2].Result, &c)
	if len(a.Rows) != len(c.Rows) {
		t.Errorf("snapshot mismatch: %d vs %d", len(a.Rows), len(c.Rows))
	}
}
