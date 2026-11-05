package comm_test

// Regression tests for the writes area of the fifth 2026-11-03 review:
// the size caps on comments, messages and a thread's recipients.

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/dom/comm"
)

// TestMessageAndRecipientCaps: comments and messages are at most 100,000
// characters, a thread has at most 100 recipients, and a reply goes to at
// most 100 people.
func TestMessageAndRecipientCaps(t *testing.T) {
	f := setupAdmin(t, "kitp_test_r5_caps")
	ctx := context.Background()
	_, reply := seedPendingReply(t, f, "support@example.com")
	var thread int64
	if err := f.sp.P.QueryRow(ctx, `
		SELECT av.card_id FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'replies'
		WHERE av.value @> to_jsonb($1::bigint)`, reply).Scan(&thread); err != nil {
		t.Fatal(err)
	}
	long := strings.Repeat("x", 100001)

	for _, fn := range []struct{ name, input string }{
		{"comment_insert_batch", fmt.Sprintf(`[{"card_id":"%d","body":%q}]`, f.taskID, long)},
		{"comment_update_batch", fmt.Sprintf(`[{"activity_id":"1","body":%q}]`, long)},
	} {
		var ok bool
		var code string
		if err := f.sp.P.QueryRow(ctx, `SELECT ok, code FROM `+fn.name+`($1::bigint, $2::jsonb)`, f.adminID, fn.input).Scan(&ok, &code); err != nil {
			t.Fatalf("%s: %v", fn.name, err)
		}
		if ok || code != "validation" {
			t.Errorf("%s with a 100,001-character body: ok=%v code=%q, want validation", fn.name, ok, code)
		}
	}

	post := func(body string) *api.ErrorEnvelope {
		return dispatchExpectErr(t, f, api.SubRequest{ID: "r", Endpoint: "reply", Action: "post",
			Data: json.RawMessage(fmt.Sprintf(`{"comm_id":"%d","body":%q}`, thread, body))})
	}
	if e := post(long); e.Code != "validation" {
		t.Errorf("reply.post with a 100,001-character body: %q, want validation", e.Code)
	}

	// 101 people with addresses.
	rows, err := f.sp.P.Query(ctx, `
		WITH p AS (
			INSERT INTO card (card_type_id)
			SELECT ct.id FROM card_type ct, generate_series(1, 101) WHERE ct.name = 'person'
			RETURNING id),
		e AS (
			INSERT INTO attribute_value (card_id, attribute_def_id, value)
			SELECT p.id, ad.id, to_jsonb('cap' || p.id || '@example.com') FROM p, attribute_def ad WHERE ad.name = 'email'
			RETURNING card_id)
		SELECT card_id FROM e ORDER BY card_id`)
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	var people []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, fmt.Sprintf("%q", fmt.Sprint(id)))
		people = append(people, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	e := dispatchExpectErr(t, f, api.SubRequest{ID: "s", Endpoint: "comm", Action: "set_recipients",
		Data: json.RawMessage(fmt.Sprintf(`{"comm_id":"%d","recipient_person_ids":[%s]}`, thread, strings.Join(ids, ",")))})
	if e.Code != "validation" {
		t.Errorf("comm.set_recipients with 101 people: %q, want validation", e.Code)
	}

	// A thread that has more (mail adds the people it is from and to).
	all, err := json.Marshal(people)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.sp.P.Exec(ctx, `
		UPDATE attribute_value SET value = $2::jsonb
		WHERE card_id = $1 AND attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'comm_recipients')`, thread, string(all)); err != nil {
		t.Fatal(err)
	}
	if e := post("hello"); e.Code != "too_many_recipients" {
		t.Errorf("reply.post to 101 people: %q, want too_many_recipients", e.Code)
	}
}

// TestRecipientCapsEverywhere (round 5 #2): comm.create keeps both caps,
// attribute.update can't write a thread's recipients, a thread already
// past 100 can be trimmed one at a time but not grown, and a reply's
// author doesn't make a full thread 101.
func TestRecipientCapsEverywhere(t *testing.T) {
	f := setupAdmin(t, "kitp_test_r5b_recipient_caps")
	ctx := context.Background()
	ch, reply := seedPendingReply(t, f, "support@example.com")
	var thread int64
	if err := f.sp.P.QueryRow(ctx, `
		SELECT av.card_id FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'replies'
		WHERE av.value @> to_jsonb($1::bigint)`, reply).Scan(&thread); err != nil {
		t.Fatal(err)
	}
	rows, err := f.sp.P.Query(ctx, `
		WITH p AS (
			INSERT INTO card (card_type_id)
			SELECT ct.id FROM card_type ct, generate_series(1, 102) WHERE ct.name = 'person'
			RETURNING id),
		e AS (
			INSERT INTO attribute_value (card_id, attribute_def_id, value)
			SELECT p.id, ad.id, to_jsonb('cap5_' || p.id || '@example.com') FROM p, attribute_def ad WHERE ad.name = 'email'
			RETURNING card_id)
		SELECT card_id FROM e ORDER BY card_id`)
	if err != nil {
		t.Fatal(err)
	}
	var people []string
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		people = append(people, fmt.Sprintf("%q", fmt.Sprint(id)))
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	list := func(ids []string) string { return "[" + strings.Join(ids, ",") + "]" }

	e := dispatchExpectErr(t, f, api.SubRequest{ID: "c", Endpoint: "comm", Action: "create", Data: json.RawMessage(fmt.Sprintf(
		`{"task_id":"%d","channel_id":"%d","subject":"Many","recipient_person_ids":%s}`, f.taskID, ch, list(people[:101])))})
	if e.Code != "validation" {
		t.Errorf("comm.create to 101 people: %q, want validation", e.Code)
	}
	e = dispatchExpectErr(t, f, api.SubRequest{ID: "c", Endpoint: "comm", Action: "create", Data: json.RawMessage(fmt.Sprintf(
		`{"task_id":"%d","channel_id":"%d","subject":"Long","recipient_person_ids":%s,"initial_message":%q}`,
		f.taskID, ch, list(people[:1]), strings.Repeat("x", 100001)))})
	if e.Code != "validation" {
		t.Errorf("comm.create with a 100,001-character message: %q, want validation", e.Code)
	}
	e = dispatchExpectErr(t, f, api.SubRequest{ID: "a", Endpoint: "attribute", Action: "update", Data: json.RawMessage(fmt.Sprintf(
		`{"card_id":"%d","attribute_name":"comm_recipients","value":%s}`, thread, list(people[:3])))})
	if e.Code != "validation" {
		t.Errorf("attribute.update of comm_recipients: %q, want validation", e.Code)
	}

	// A thread with 101 (from before the caps): one off works, one on doesn't.
	raw := "[" + strings.ReplaceAll(strings.Join(people[:101], ","), `"`, "") + "]"
	if _, err := f.sp.P.Exec(ctx, `
		UPDATE attribute_value SET value = $2::jsonb
		WHERE card_id = $1 AND attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'comm_recipients')`, thread, raw); err != nil {
		t.Fatal(err)
	}
	set := func(ids []string) api.SubResponse {
		return f.srv.Dispatch(f.ctx, api.BatchRequest{Subrequests: []api.SubRequest{{ID: "s", Endpoint: "comm", Action: "set_recipients",
			Data: json.RawMessage(fmt.Sprintf(`{"comm_id":"%d","recipient_person_ids":%s}`, thread, list(ids)))}}}).Subresponses[0]
	}
	if r := set(people[:101]); !r.OK {
		t.Errorf("the same 101 again: %+v", r.Error)
	}
	if r := set(append(append([]string{}, people[1:101]...), people[101])); r.OK {
		t.Error("a list of 101 that adds someone was taken")
	}
	if r := set(people[1:101]); !r.OK {
		t.Errorf("taking one off a thread of 101: %+v", r.Error)
	}
	// 100 people now: a reply goes, and its author doesn't join.
	var out comm.ReplyPostOutput
	dispatch(t, f, api.SubRequest{ID: "r", Endpoint: "reply", Action: "post",
		Data: json.RawMessage(fmt.Sprintf(`{"comm_id":"%d","body":"to everyone"}`, thread))}, &out)
	var n int
	if err := f.sp.P.QueryRow(ctx, `
		SELECT jsonb_array_length(value) FROM attribute_value
		WHERE card_id = $1 AND attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'comm_recipients')`, thread).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n > 100 {
		t.Errorf("after a reply the thread has %d recipients, want at most 100", n)
	}
}
