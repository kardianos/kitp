package card_test

// Regression test for the fourth 2026-11-03 review, finding 18.

import (
	"context"
	"fmt"
	"testing"
)

// TestAssignToMe (round 4 #18): a person who signs in can make a task
// assigned to themselves.
func TestAssignToMe(t *testing.T) {
	f := setupVisibility(t, "kitp_test_r4_assign_to_me")
	ctx := context.Background()
	person := reviewPerson(t, f, f.worker)
	var st int64
	if err := f.sp.P.QueryRow(ctx, `SELECT (value #>> '{}')::bigint FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = $1 AND ad.name = 'status'`, f.taskA).Scan(&st); err != nil {
		t.Fatal(err)
	}
	r := reviewCall(t, f, f.worker, "card", "insert", fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"mine","attributes":{"status":"%d"},"assign_to_me":true}`, f.projectA, st))
	if !r.OK {
		t.Fatalf("assign_to_me: %+v", r.Error)
	}
	id := insertedID(t, r)
	var assignee int64
	if err := f.sp.P.QueryRow(ctx, `SELECT (value #>> '{}')::bigint FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = $1 AND ad.name = 'assignee'`, id).Scan(&assignee); err != nil {
		t.Fatal(err)
	}
	if assignee != person {
		t.Errorf("assignee %d, want the caller's person %d", assignee, person)
	}
}
