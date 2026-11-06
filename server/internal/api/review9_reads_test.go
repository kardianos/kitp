// review9_reads_test.go: round-8 L14 — person_referable's "already named"
// rule, one index lookup per storage class.
package api_test

import (
	"context"
	"testing"
)

// TestPersonReferableFindsBothKindsOfReference (round 8 L14): the "already
// named in the project" rule, split into one lookup per storage class, still
// finds a person named by a card_ref (an originator) and by a card_ref[] (a
// thread's recipients), and only in that project.
func TestPersonReferableFindsBothKindsOfReference(t *testing.T) {
	srv, sp := r9wSetup(t, "kitp_test_r9w_person_ref")
	ctx := context.Background()
	projA, taskA := makeProjectAndTask(t, srv, "A")
	projB, taskB := makeProjectAndTask(t, srv, "B")
	worker := grantRole(t, sp, "worker-A", "worker", &projA)
	byRef, byList, nowhere := r9wCard(t, sp, "person", 0, "by ref"), r9wCard(t, sp, "person", 0, "by list"), r9wCard(t, sp, "person", 0, "nowhere")
	thread := r9wCard(t, sp, "comm", taskB, "thread in B")
	if _, err := sp.P.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		SELECT $1, id, to_jsonb($2::bigint) FROM attribute_def WHERE name = 'originator'`, taskB, byRef); err != nil {
		t.Fatal(err)
	}
	if _, err := sp.P.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		SELECT $1, id, jsonb_build_array($2::bigint, $3::bigint) FROM attribute_def WHERE name = 'comm_recipients'`, thread, nowhere+1000, byList); err != nil {
		t.Fatal(err)
	}
	referable := func(person, project int64) bool {
		t.Helper()
		var ok bool
		if err := sp.P.QueryRow(ctx, `SELECT person_referable($1, $2, $3)`, worker, person, project).Scan(&ok); err != nil {
			t.Fatal(err)
		}
		return ok
	}
	for _, c := range []struct {
		name    string
		person  int64
		project int64
		want    bool
	}{
		{"originator in B, asked about B", byRef, projB, true},
		{"recipient in B, asked about B", byList, projB, true},
		{"originator in B, asked about A", byRef, projA, false},
		{"recipient in B, asked about A", byList, projA, false},
		{"named nowhere", nowhere, projB, false},
	} {
		if got := referable(c.person, c.project); got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
	_ = taskA
}
