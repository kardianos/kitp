package projectstamp_test

// Regression test for the fifth 2026-11-03 review, #14.

import (
	"context"
	"strconv"
	"testing"

	"github.com/kitp/kitp/server/internal/store"
)

// TestTemplateCopyLeavesThreads (#14): a template's own mail thread (intake
// mode 'thread' puts one under the project) isn't copied into a new
// project — not its correspondents, acked or thread_id — while its mail
// account is.
func TestTemplateCopyLeavesThreads(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_r5_copy_threads")
	ctx := context.Background()
	ex := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	id := func(sql string, args ...any) int64 {
		t.Helper()
		var v int64
		if err := pool.QueryRow(ctx, sql, args...).Scan(&v); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
		return v
	}
	ct := func(name string) int64 { return id(`SELECT id FROM card_type WHERE name = $1`, name) }
	setAV := func(card int64, attr, v string) {
		ex(`INSERT INTO attribute_value (card_id, attribute_def_id, value)
		    SELECT $1, id, $3::jsonb FROM attribute_def WHERE name = $2
		    ON CONFLICT (card_id, attribute_def_id) DO UPDATE SET value = EXCLUDED.value`, card, attr, v)
	}
	tpl := id(`INSERT INTO card (card_type_id) VALUES ($1) RETURNING id`, ct("project"))
	setAV(tpl, "title", `"Tpl"`)
	setAV(tpl, "is_template", `true`)
	ch := id(`INSERT INTO card (card_type_id, parent_card_id) VALUES ($1, $2) RETURNING id`, ct("comm_channel"), tpl)
	setAV(ch, "title", `"Support mailbox"`)
	cust := id(`INSERT INTO card (card_type_id) VALUES ($1) RETURNING id`, ct("person"))
	setAV(cust, "email", `"customer@example.org"`)
	comm := id(`INSERT INTO card (card_type_id, parent_card_id) VALUES ($1, $2) RETURNING id`, ct("comm"), tpl)
	setAV(comm, "title", `"Re: refund"`)
	setAV(comm, "thread_id", `"AbCdEf1234"`)
	setAV(comm, "channel_ref", strconv.FormatInt(ch, 10))
	setAV(comm, "comm_recipients", "["+strconv.FormatInt(cust, 10)+"]")

	np := id(`INSERT INTO card (card_type_id) VALUES ($1) RETURNING id`, ct("project"))
	setAV(np, "title", `"New"`)
	ex(`SELECT copy_project_template($1, $2, 1)`, tpl, np)
	var comms, channels int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE ct.name = 'comm'), count(*) FILTER (WHERE ct.name = 'comm_channel')
		FROM card c JOIN card_type ct ON ct.id = c.card_type_id WHERE c.parent_card_id = $1`, np).Scan(&comms, &channels); err != nil {
		t.Fatal(err)
	}
	if comms != 0 || channels != 1 {
		t.Errorf("the copy has %d threads and %d mail accounts, want 0 and 1", comms, channels)
	}
	var dup int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE ad.name = 'thread_id' AND av.value = '"AbCdEf1234"'`).Scan(&dup); err != nil {
		t.Fatal(err)
	}
	if dup != 1 {
		t.Errorf("%d threads carry the template's thread_id, want 1", dup)
	}
}
