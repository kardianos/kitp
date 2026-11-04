package comm_test

// Regression tests for the mail findings of the fourth 2026-11-03 review.

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
	"github.com/kitp/kitp/server/internal/schema/hcsv"
	"github.com/kitp/kitp/server/internal/store"
)

// encodedNested is depth nested multiparts, each claiming a transfer
// encoding, over filler bytes of an attachment at the bottom.
func encodedNested(depth int, cte string, filler int) []byte {
	var b strings.Builder
	b.WriteString("From: Eve <eve@evil.example>\r\nTo: support@example.com\r\nSubject: hi\r\nMessage-ID: <enc@evil.example>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b0\r\n\r\n")
	for i := range depth {
		fmt.Fprintf(&b, "--b%d\r\nContent-Type: multipart/mixed; boundary=b%d\r\nContent-Transfer-Encoding: %s\r\n\r\n", i, i+1, cte)
	}
	fmt.Fprintf(&b, "--b%d\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=x.bin\r\n\r\n", depth)
	line := strings.Repeat("A", 70) + "\r\n"
	for b.Len() < filler {
		b.WriteString(line)
	}
	return []byte(b.String())
}

// TestEncodedNestedPartsAreStreamed (round 4 #1): nested parts that claim
// an encoding are decoded as a stream, not copied whole at every level.
func TestEncodedNestedPartsAreStreamed(t *testing.T) {
	for _, cte := range []string{"base64", "quoted-printable"} {
		raw := encodedNested(7, cte, 8<<20)
		var before, after runtime.MemStats
		runtime.GC()
		runtime.ReadMemStats(&before)
		if _, err := comm.ParseInboundMessage(1, raw); err != nil {
			t.Fatalf("%s: parse: %v", cte, err)
		}
		runtime.ReadMemStats(&after)
		if alloc := after.TotalAlloc - before.TotalAlloc; alloc > 6*uint64(len(raw)) {
			t.Errorf("%s: parsing an %d MB message allocated %d MB", cte, len(raw)>>20, alloc>>20)
		}
	}
}

// TestBase64AttachmentDecodes: a leaf part is decoded as it is read, with
// the line breaks and blanks mail puts in base64.
func TestBase64AttachmentDecodes(t *testing.T) {
	raw := "From: a@example.com\r\nTo: b@example.com\r\nSubject: s\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=s\r\n\r\n" +
		"--s\r\nContent-Type: text/plain\r\n\r\nsee attached\r\n" +
		"--s\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=a.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n" +
		"aGVs bG8g\r\nd29y\tbGQ=\r\n--s--\r\n"
	m, err := comm.ParseInboundMessage(1, []byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Attachments) != 1 || string(m.Attachments[0].Bytes) != "hello world" {
		t.Fatalf("attachments = %+v", m.Attachments)
	}
	if m.Body != "see attached" {
		t.Errorf("body = %q", m.Body)
	}
}

// TestIMAPSetsAsideAMessageThatStoppedKitp (round 4 #1): a message a poll
// started reading too often without finishing — kitpd stopped while
// reading it — is logged and marked read without being fetched again; the
// messages after it are filed.
func TestIMAPSetsAsideAMessageThatStoppedKitp(t *testing.T) {
	f := setupAdmin(t, "kitp_test_r4_imap_inflight")
	ch := seedChannelWith(t, f, `"intake_mode":"thread"`)
	ctx := context.Background()
	if _, err := f.sp.P.Exec(ctx, `INSERT INTO comm_imap_inflight (channel_id, uid_validity, uid, attempts) VALUES ($1, 1, 77, 2)`, ch); err != nil {
		t.Fatal(err)
	}
	poison := inbound(77, "Poison", "never read")
	poison.MessageID = "<poison@example.com>"
	good := inbound(78, "Fine", "read me")
	good.MessageID = "<fine@example.com>"
	stub := &stubIMAPClient{messages: []comm.InboundMessage{poison, good}}
	p := comm.NewIMAPPollerForTest(f.sp, ch, 5*time.Second)
	p.SetDialFunc(func(context.Context, comm.IMAPConfig) (comm.InboundClient, error) { return stub, nil })
	if err := p.RunOnce(ctx); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if fmt.Sprint(stub.fetched) != "[78]" {
		t.Errorf("fetched %v, want only 78", stub.fetched)
	}
	if fmt.Sprint(stub.marks()) != "[77 78]" {
		t.Errorf("marked seen %v, want 77 and 78", stub.marks())
	}
	if d := logDetail(t, f, ch, "parse_error"); !strings.Contains(fmt.Sprint(d["error"]), "set aside") {
		t.Errorf("parse_error detail = %v, want it set aside", d)
	}
	var left int
	if err := f.sp.P.QueryRow(ctx, `SELECT count(*) FROM comm_imap_inflight WHERE channel_id = $1`, ch).Scan(&left); err != nil {
		t.Fatal(err)
	}
	if left != 0 {
		t.Errorf("%d in-flight records left after the poll", left)
	}
	if n := len(commsUnder(t, f, f.projectID)); n != 1 {
		t.Errorf("threads = %d, want the good message filed", n)
	}
}

// TestOddCcKeepsTheRestOfTheHeader (round 4 #9): one odd address in a Cc
// drops only itself; everyone else on it joins the thread.
func TestOddCcKeepsTheRestOfTheHeader(t *testing.T) {
	r := newRelayFixture(t, "kitp_test_r4_odd_cc", "")
	before := len(listThread(t, r.f, r.thread).Recipients)
	r.reply(t, 60, func(m *comm.InboundMessage) {
		m.MessageID = "<oddcc@example.com>"
		m.Cc = `dora@example.com, "x y"@example.com, erin@example.com`
	})
	if got := len(listThread(t, r.f, r.thread).Recipients) - before; got != 2 {
		t.Errorf("one message with an odd Cc added %d people, want the two plain ones", got)
	}
	if got := comm.PeopleIn(`a@example.com, "x y"@example.com`); len(got) != 1 || got[0].Address != "a@example.com" {
		t.Errorf("PeopleIn = %v", got)
	}
}

// TestLegacyThreadsRelayAgain (round 4 #7): a thread from before migration
// 0032 gets its starter and the people added in kitp confirmed by 0038, and
// relays again.
func TestLegacyThreadsRelayAgain(t *testing.T) {
	r := newRelayFixture(t, "kitp_test_r4_legacy_relay", "")
	ctx := context.Background()
	for _, q := range []string{
		`DELETE FROM attribute_value WHERE attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'comm_confirmed')`,
		`DELETE FROM schema_version WHERE name = '0038_comm_confirmed_backfill'`,
	} {
		if _, err := r.f.sp.P.Exec(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.ApplySchema(ctx, r.f.sp.P, hcsv.GenerateOptions{Demo: false}); err != nil {
		t.Fatalf("re-apply: %v", err)
	}
	if got := confirmedEmails(t, r); got != "ada@example.com,bob@example.com,carol@ourco.example" {
		t.Errorf("confirmed after the backfill = %q, want the starter and the two people added in kitp", got)
	}
	r.reply(t, 61, func(m *comm.InboundMessage) {
		m.MessageID = "<bob-legacy@example.com>"
		m.From = "Bob <bob@example.com>"
	})
	if got := relayCopies(t, r); len(got) != 1 || got[0] != "ada@example.com" {
		t.Errorf("copies = %v, want Bob's reply sent on to Ada", got)
	}
}

// TestDisplayNamedAccountAddress (round 4 #8): an account address with a
// display name sends from its bare address, and comm_channel.set takes
// only a bare one.
func TestDisplayNamedAccountAddress(t *testing.T) {
	r := newRelayFixture(t, "kitp_test_r4_from_name", "")
	env := dispatchExpectErr(t, r.f, api.SubRequest{ID: "c", Endpoint: "comm_channel", Action: "set",
		Data: json.RawMessage(fmt.Sprintf(`{"id":"%d","project_id":"%d","name":"Support","channel_type":"email","from_address":"Support <support@example.com>"}`, r.ch, r.f.projectID))})
	if env.Code != "validation" || !strings.Contains(env.Message, "from_address") {
		t.Errorf("comm_channel.set with a display-named from_address: %q %q, want a from_address validation", env.Code, env.Message)
	}
}
