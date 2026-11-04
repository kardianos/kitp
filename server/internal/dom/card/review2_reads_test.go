package card_test

// Regression test for review 2026-11-03 round 2 #21: a snippet leaf only
// uses a snippet its viewer can see.

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/auth"
)

func TestSnippetLeavesNeedAVisibleSnippet(t *testing.T) {
	f := setupVisibility(t, "kitp_test_r2_snippet_visible")
	ctx := context.Background()
	pred, err := json.Marshal(fmt.Sprintf(`{"attr":"title","op":"contains","values":["x"]}`))
	if err != nil {
		t.Fatal(err)
	}
	snip := insertedID(t, reviewCall(t, f, auth.SystemUserID, "card", "insert", fmt.Sprintf(
		`{"card_type_name":"predicate_snippet","parent_card_id":"%d","title":"B's filter","attributes":{"predicate":%s}}`, f.projectB, pred)))
	worker := reviewPerson(t, f, f.worker) // a worker on project A only
	admin := reviewPerson(t, f, f.admin)
	compiled := func(viewer int64) string {
		t.Helper()
		var sql string
		if err := f.sp.P.QueryRow(ctx, `
			SELECT card_compile_predicate(jsonb_build_object('attr', '_snippet', 'op', 'snippet', 'values', jsonb_build_array($1::bigint)),
			                              '[]'::jsonb, ARRAY[]::bigint[], $2::bigint)->>'sql'`, snip, viewer).Scan(&sql); err != nil {
			t.Fatal(err)
		}
		return sql
	}
	if got := compiled(worker); got != "FALSE" {
		t.Errorf("another project's snippet compiled for a worker who can't see it: %s", got)
	}
	if got := compiled(admin); got == "FALSE" {
		t.Error("a snippet the viewer can see compiled to FALSE")
	}
}
