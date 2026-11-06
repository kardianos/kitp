package approval_test

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

// TestARefusedApproverIsNamedOnlyIfYouMayNameThem (review 2026-11-06 round
// 8 #9): approval.set's refusal names each person it can't ask by title —
// only one the caller may name in the project (person_referable). Anyone
// else is "person N": a contact's title is often its address, and ids are
// sequential.
func TestARefusedApproverIsNamedOnlyIfYouMayNameThem(t *testing.T) {
	f := setup(t, "kitp_test_r9_appr_names")
	ctx := context.Background()
	var zed int64
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'person' RETURNING id`).Scan(&zed); err != nil {
		t.Fatal(err)
	}
	for name, v := range map[string]string{"title": "zed.secret@clinic.example", "email": "zed.secret@clinic.example", "person_kind": "contact"} {
		if _, err := f.sp.P.Exec(ctx, `INSERT INTO attribute_value (card_id, attribute_def_id, value) SELECT $1, id, to_jsonb($2::text) FROM attribute_def WHERE name = $3`, zed, v, name); err != nil {
			t.Fatal(err)
		}
	}
	ask := func(ids ...int64) (string, string) {
		quoted := make([]string, len(ids))
		for i, id := range ids {
			quoted[i] = fmt.Sprintf(`"%d"`, id)
		}
		sr := call(f, f.dana.ctx, "approval", "set", fmt.Sprintf(
			`{"task_id":"%d","from_status_id":"%d","to_status_id":"%d","approver_ids":[%s]}`,
			f.task, f.statuses["Review"], f.statuses["Done"], strings.Join(quoted, ",")))
		if sr.OK || sr.Error == nil {
			t.Fatalf("approval.set %v: ok", ids)
		}
		return sr.Error.Code, sr.Error.Message
	}
	code, msg := ask(zed, f.sam.personID)
	if code != "approver_invalid" {
		t.Errorf("code %q, want approver_invalid", code)
	}
	if strings.Contains(msg, "zed.secret") || strings.Contains(msg, "Sam") {
		t.Errorf("the refusal names people Dana may not name here: %q", msg)
	}
	for _, id := range []int64{zed, f.sam.personID} {
		if !strings.Contains(msg, fmt.Sprintf("person %d", id)) {
			t.Errorf("the refusal doesn't say which id it refused (%d): %q", id, msg)
		}
	}
	// Someone Dana may name (named on one of the project's tasks) is named.
	if _, err := f.sp.P.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		SELECT $1, id, to_jsonb($2::bigint) FROM attribute_def WHERE name = 'originator'
		ON CONFLICT (card_id, attribute_def_id) DO UPDATE SET value = EXCLUDED.value`, f.task, zed); err != nil {
		t.Fatal(err)
	}
	if _, msg := ask(zed); !strings.Contains(msg, "zed.secret@clinic.example") {
		t.Errorf("a contact named on the project's task isn't named: %q", msg)
	}
}
