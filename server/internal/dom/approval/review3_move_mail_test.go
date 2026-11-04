package approval_test

// Regression test for the third 2026-11-03 review, finding 10: mail queued
// on a thread whose task moves.

import (
	"context"
	"fmt"
	"testing"
)

// TestTaskMovePicksASendingAccountAndFailsStrandedMail (round 3 #10): a
// moved thread gets the destination's enabled account, not merely its
// lowest-id one; moved to a project with no account, its queued mail is
// marked failed rather than left pending for good.
func TestTaskMovePicksASendingAccountAndFailsStrandedMail(t *testing.T) {
	f := setup(t, "kitp_test_r3_move_mail")
	ctx := context.Background()
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := f.sp.P.Exec(ctx, q, args...); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	newChannel := func(project int64, status, smtp string) int64 {
		t.Helper()
		var id int64
		if err := f.sp.P.QueryRow(ctx, `
			INSERT INTO card (card_type_id, parent_card_id)
			SELECT id, $1 FROM card_type WHERE name = 'comm_channel' RETURNING id`, project).Scan(&id); err != nil {
			t.Fatal(err)
		}
		exec(`INSERT INTO attribute_value (card_id, attribute_def_id, value)
		      SELECT $1, id, to_jsonb($2::text) FROM attribute_def WHERE name = 'channel_status'`, id, status)
		if smtp != "" {
			exec(`INSERT INTO attribute_value (card_id, attribute_def_id, value)
			      SELECT $1, id, to_jsonb($2::text) FROM attribute_def WHERE name = 'smtp_host'`, id, smtp)
		}
		return id
	}
	src := newChannel(f.project, "enabled", "smtp.src.example")
	var thread, pending int64
	if err := f.sp.P.QueryRow(ctx, `
		WITH c AS (INSERT INTO card (card_type_id, parent_card_id)
		           SELECT id, $1 FROM card_type WHERE name = 'comm' RETURNING id),
		     r AS (INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'reply_body' RETURNING id),
		     a AS (INSERT INTO attribute_value (card_id, attribute_def_id, value)
		           SELECT c.id, ad.id, to_jsonb($2::bigint) FROM c, attribute_def ad WHERE ad.name = 'channel_ref'),
		     b AS (INSERT INTO attribute_value (card_id, attribute_def_id, value)
		           SELECT c.id, ad.id, jsonb_build_array(r.id) FROM c, r, attribute_def ad WHERE ad.name = 'replies'),
		     d AS (INSERT INTO attribute_value (card_id, attribute_def_id, value)
		           SELECT r.id, ad.id, to_jsonb('pending'::text) FROM r, attribute_def ad WHERE ad.name = 'delivery_status')
		SELECT c.id, r.id FROM c, r`, f.task, src).Scan(&thread, &pending); err != nil {
		t.Fatal(err)
	}
	read := func(card int64, attr string) string {
		t.Helper()
		var v string
		if err := f.sp.P.QueryRow(ctx, `
			SELECT COALESCE((SELECT av.value #>> '{}' FROM attribute_value av
			                 JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = $2
			                 WHERE av.card_id = $1), '')`, card, attr).Scan(&v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	move := func(project int64) {
		t.Helper()
		sr := call(f, sysCtx(), "task", "move", fmt.Sprintf(`{"card_id":"%d","new_project_id":"%d"}`, f.task, project))
		if !sr.OK {
			t.Fatalf("task.move: %+v", sr.Error)
		}
	}
	p2 := insertCard(t, f, `{"card_type_name":"project","title":"With mail"}`)
	newChannel(p2, "disabled-fault", "smtp.broken.example") // lower id, faulted
	good := newChannel(p2, "enabled", "smtp.p2.example")
	move(p2)
	if got := read(thread, "channel_ref"); got != fmt.Sprint(good) {
		t.Errorf("thread account after the move = %s, want the enabled one %d", got, good)
	}
	if got := read(pending, "delivery_status"); got != "pending" {
		t.Errorf("queued mail after a move to an account: %s, want pending", got)
	}
	p3 := insertCard(t, f, `{"card_type_name":"project","title":"No mail"}`)
	move(p3)
	if got := read(pending, "delivery_status"); got != "failed" {
		t.Errorf("queued mail on a thread moved to a project with no account: %s, want failed", got)
	}
}
