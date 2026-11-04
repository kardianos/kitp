package comm_test

// Regression tests for the mail findings of the third 2026-11-03 review.

import (
	"context"
	"encoding/json"
	"fmt"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/dom/comm"
)

// nestedMultipart is a message of depth nested multipart/mixed parts, none
// of them closed, with a text part at the bottom.
func nestedMultipart(depth int) []byte {
	var b strings.Builder
	b.WriteString("From: Eve <eve@evil.example>\r\nTo: support@example.com\r\nSubject: hi\r\nMessage-ID: <nest@evil.example>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b0\r\n\r\n")
	for i := range depth {
		fmt.Fprintf(&b, "--b%d\r\nContent-Type: multipart/mixed; boundary=b%d\r\n\r\n", i, i+1)
	}
	fmt.Fprintf(&b, "--b%d\r\nContent-Type: text/plain\r\n\r\nhello\r\n", depth)
	return []byte(b.String())
}

// TestNestedMultipartIsBounded (round 3 #1): a deeply nested message parses
// in memory proportional to its size (each level used to copy the rest of
// the message, and keep the copy), and real nesting still finds the body.
func TestNestedMultipartIsBounded(t *testing.T) {
	raw := nestedMultipart(4000) // 224 KB; peaked at 600 MB before
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	if _, err := comm.ParseInboundMessage(1, raw); err != nil {
		t.Fatalf("parse: %v", err)
	}
	runtime.ReadMemStats(&after)
	if alloc := after.TotalAlloc - before.TotalAlloc; alloc > 64<<20 {
		t.Errorf("parsing a %d KB message allocated %d MB", len(raw)>>10, alloc>>20)
	}
	m, err := comm.ParseInboundMessage(1, nestedMultipart(3))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if m.Body != "hello" {
		t.Errorf("body three levels down = %q, want hello", m.Body)
	}
}

// TestQuotedLocalPartIsRefused (round 3 #9): an address whose quoted local
// part net/mail hands back as two addresses is refused by the parsers kitp
// checks allow lists with and stores people from; an apostrophe is fine.
func TestQuotedLocalPartIsRefused(t *testing.T) {
	odd := `"eve@evil.example, x"@ourco.example`
	if _, err := comm.ParseAddressList(odd); err == nil {
		t.Errorf("ParseAddressList(%s) took it", odd)
	}
	if _, err := comm.ParseAddress("Eve <" + odd + ">"); err == nil {
		t.Errorf("ParseAddress(%s) took it", odd)
	}
	if _, err := comm.ParseAddressList("O'Brien <o'brien@example.com>, ada@example.com"); err != nil {
		t.Errorf("plain addresses refused: %v", err)
	}
	for addr, want := range map[string]bool{
		"ada@example.com": true, "o'brien@example.org": true, "jürgen@beispiel.de": true,
		"eve@evil.example, x@ourco.example": false, "a b@c.d": false, "a@[1.2.3.4]": false,
		"a@b@c.d": false, "@c.d": false, "a@": false, `a"b@c.d`: false,
	} {
		if got := comm.PlainAddress(addr); got != want {
			t.Errorf("PlainAddress(%q) = %v, want %v", addr, got, want)
		}
	}
}

// TestQuotedLocalPartMakesNoPerson (round 3 #9): mail from such an address
// files, but makes no person and puts nobody on the thread; and a stored
// person email of that shape is left off a staff reply's To.
func TestQuotedLocalPartMakesNoPerson(t *testing.T) {
	r := newRelayFixture(t, "kitp_test_r3_quoted", "")
	before := listThread(t, r.f, r.thread).Recipients
	r.reply(t, 50, func(m *comm.InboundMessage) {
		m.MessageID = "<quoted@evil.example>"
		m.From = `"eve@evil.example, x"@ourco.example`
	})
	if got := listThread(t, r.f, r.thread).Recipients; len(got) != len(before) {
		t.Errorf("recipients %v → %v: the odd address was added", before, got)
	}
	var n int
	if err := r.f.sp.P.QueryRow(context.Background(), `
		SELECT count(*) FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE ad.name = 'email' AND av.value #>> '{}' LIKE '%evil.example%'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("%d people made from the odd address", n)
	}
	// A person whose stored email already holds two addresses.
	var bob int64
	if err := r.f.sp.P.QueryRow(context.Background(), `
		UPDATE attribute_value av SET value = to_jsonb('eve@evil.example, bob@example.com'::text)
		FROM attribute_def ad
		WHERE ad.id = av.attribute_def_id AND ad.name = 'email' AND av.value #>> '{}' = 'bob@example.com'
		RETURNING av.card_id`).Scan(&bob); err != nil {
		t.Fatal(err)
	}
	var out comm.ReplyPostOutput
	dispatch(t, r.f, api.SubRequest{ID: "rp", Endpoint: "reply", Action: "post",
		Data: json.RawMessage(fmt.Sprintf(`{"comm_id":"%d","body":"ok"}`, r.thread))}, &out)
	var to string
	if err := r.f.sp.P.QueryRow(context.Background(), `
		SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1 AND ad.name = 'reply_to'`, out.ReplyID).Scan(&to); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(to, "evil.example") {
		t.Errorf("staff reply To = %q, still reaches the odd address", to)
	}
}

// confirmedEmails is the thread's comm_confirmed people's emails, sorted.
func confirmedEmails(t *testing.T, r relayFixture) string {
	t.Helper()
	rows, err := r.f.sp.P.Query(context.Background(), `
		SELECT pav.value #>> '{}'
		FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'comm_confirmed'
		CROSS JOIN LATERAL jsonb_array_elements(av.value) AS e(v)
		JOIN attribute_value pav ON pav.card_id = (e.v #>> '{}')::bigint
		JOIN attribute_def pad ON pad.id = pav.attribute_def_id AND pad.name = 'email'
		WHERE av.card_id = $1 ORDER BY 1`, r.thread)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			t.Fatal(err)
		}
		out = append(out, s)
	}
	return strings.Join(out, ",")
}

// TestStaffReplyConfirmsNobody (round 3 #5): an outsider Cc's an address,
// staff reply as usual (to everyone on the thread), and the outsider's
// next message is still not sent on to it.
func TestStaffReplyConfirmsNobody(t *testing.T) {
	r := newRelayFixture(t, "kitp_test_r3_staff_reply", "")
	send := func(uid uint32, cc string) {
		r.reply(t, uid, func(m *comm.InboundMessage) {
			m.MessageID = fmt.Sprintf("<r3-%d@evil.example>", uid)
			m.From = "IT Security Desk <eve@evil.example>"
			m.Cc = cc
		})
	}
	send(201, "victim@ourco.example")
	var out comm.ReplyPostOutput
	dispatch(t, r.f, api.SubRequest{ID: "rp", Endpoint: "reply", Action: "post",
		Data: json.RawMessage(fmt.Sprintf(`{"comm_id":"%d","body":"Thanks, looking into it."}`, r.thread))}, &out)
	send(202, "")
	if got := relayCopies(t, r); len(got) != 0 {
		t.Errorf("an outsider's message was sent on after a staff reply: %v", got)
	}
	if d := logDetail(t, r.f, r.ch, "relay_skipped"); d["reason"] != "sender_unconfirmed" {
		t.Errorf("relay_skipped %v, want sender_unconfirmed", d)
	}
	if got := confirmedEmails(t, r); got != "ada@example.com,bob@example.com,carol@ourco.example" {
		t.Errorf("confirmed = %s, want only the starter and the people added in kitp", got)
	}
}

// TestRemovedPersonStaysOff (round 3 #8): staff take Bob off the thread;
// his later mail files but doesn't put him back on, isn't sent on, and he
// is no longer confirmed. Adding him again in kitp puts him back.
func TestRemovedPersonStaysOff(t *testing.T) {
	r := newRelayFixture(t, "kitp_test_r3_removed", "")
	var bob int64
	if err := r.f.sp.P.QueryRow(context.Background(), `
		SELECT av.card_id FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE ad.name = 'email' AND av.value #>> '{}' = 'bob@example.com'`).Scan(&bob); err != nil {
		t.Fatal(err)
	}
	setRecipients := func(ids []int64) {
		quoted := make([]string, len(ids))
		for i, id := range ids {
			quoted[i] = fmt.Sprintf("%q", fmt.Sprint(id))
		}
		dispatch(t, r.f, api.SubRequest{ID: "r", Endpoint: "comm", Action: "set_recipients",
			Data: json.RawMessage(fmt.Sprintf(`{"comm_id":"%d","recipient_person_ids":[%s]}`, r.thread, strings.Join(quoted, ",")))}, &comm.CommSetRecipientsOutput{})
	}
	all := listThread(t, r.f, r.thread).Recipients
	var keep []int64
	for _, id := range all {
		if id != bob {
			keep = append(keep, id)
		}
	}
	setRecipients(keep)
	before := len(listThread(t, r.f, r.thread).Replies)
	for i := range 2 {
		uid := uint32(300 + i)
		r.reply(t, uid, func(m *comm.InboundMessage) {
			m.MessageID = fmt.Sprintf("<bob-back-%d@example.com>", uid)
			m.From = "Bob <bob@example.com>"
		})
	}
	row := listThread(t, r.f, r.thread)
	if len(row.Replies) != before+2 {
		t.Errorf("messages %d → %d, want Bob's two filed", before, len(row.Replies))
	}
	for _, id := range row.Recipients {
		if id == bob {
			t.Errorf("Bob is back on the thread: %v", row.Recipients)
		}
	}
	if got := relayCopies(t, r); len(got) != 0 {
		t.Errorf("a removed person's mail was sent on: %v", got)
	}
	if got := confirmedEmails(t, r); strings.Contains(got, "bob@") {
		t.Errorf("Bob still confirmed: %s", got)
	}
	setRecipients(all)
	if got := confirmedEmails(t, r); !strings.Contains(got, "bob@") {
		t.Errorf("Bob added again isn't confirmed: %s", got)
	}
	r.reply(t, 310, func(m *comm.InboundMessage) {
		m.MessageID = "<bob-after@example.com>"
		m.From = "Bob <bob@example.com>"
	})
	if got := relayCopies(t, r); len(got) != 1 {
		t.Errorf("Bob added again: copies %v, want one", got)
	}
}

// TestLongThreadKeepsFiling (round 3 #6): a thread whose replies list is
// far past what one btree entry holds still takes mail and staff replies.
func TestLongThreadKeepsFiling(t *testing.T) {
	r := newRelayFixture(t, "kitp_test_r3_long_thread", "")
	ctx := context.Background()
	if _, err := r.f.sp.P.Exec(ctx, `
		UPDATE attribute_value av SET value = jsonb_build_array(av.value->0) || (
			SELECT jsonb_agg(1000000 + g * 37 ORDER BY g) FROM generate_series(1, 1500) g)
		FROM attribute_def ad
		WHERE ad.id = av.attribute_def_id AND ad.name = 'replies' AND av.card_id = $1`, r.thread); err != nil {
		t.Fatalf("a long replies list: %v", err)
	}
	r.reply(t, 900, func(m *comm.InboundMessage) { m.MessageID = "<long-1@example.com>" })
	var fileErrs int
	if err := r.f.sp.P.QueryRow(ctx, `SELECT count(*) FROM comm_log WHERE channel_id = $1 AND kind = 'file_error'`, r.ch).Scan(&fileErrs); err != nil {
		t.Fatal(err)
	}
	if fileErrs != 0 {
		t.Errorf("%d messages to a long thread were unfileable", fileErrs)
	}
	var out comm.ReplyPostOutput
	dispatch(t, r.f, api.SubRequest{ID: "rp", Endpoint: "reply", Action: "post",
		Data: json.RawMessage(fmt.Sprintf(`{"comm_id":"%d","body":"staff reply"}`, r.thread))}, &out)
	if out.ReplyID == 0 {
		t.Error("reply.post on a long thread made no message")
	}
}

// TestManyCcIsCapped: one message naming hundreds of addresses puts at most
// maxSyncPeople of them on the thread.
func TestManyCcIsCapped(t *testing.T) {
	r := newRelayFixture(t, "kitp_test_r3_many_cc", "")
	before := len(listThread(t, r.f, r.thread).Recipients)
	var cc []string
	for i := range 500 {
		cc = append(cc, fmt.Sprintf("x%d@spam.example", i))
	}
	start := time.Now()
	r.reply(t, 400, func(m *comm.InboundMessage) {
		m.MessageID = "<manycc@evil.example>"
		m.Cc = strings.Join(cc, ", ")
	})
	got := len(listThread(t, r.f, r.thread).Recipients) - before
	if got > comm.MaxSyncPeople {
		t.Errorf("one message added %d people, want at most %d", got, comm.MaxSyncPeople)
	}
	t.Logf("filing took %v", time.Since(start))
}
