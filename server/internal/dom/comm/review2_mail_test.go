package comm_test

// Regression tests for the mail findings of the second 2026-11-03 review.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/dom/comm"
)

// TestRelayConfirmsOnlyFromKitp (round 2 #1): a stranger can't make herself
// or anyone she Cc'd "confirmed" by writing, or by forging a message from
// them; nothing is sent on.
func TestRelayConfirmsOnlyFromKitp(t *testing.T) {
	r := newRelayFixture(t, "kitp_test_r2_relay_confirm", "")
	n := 0
	send := func(from, cc string) {
		n++
		uid := uint32(100 + n)
		r.reply(t, uid, func(m *comm.InboundMessage) {
			m.MessageID = fmt.Sprintf("<r2-%d@evil.example>", uid)
			m.From = from
			m.Cc = cc
		})
	}
	send("IT Security Desk <eve@evil.example>", "victim@ourco.example")
	send("victim@ourco.example", "")
	if d := logDetail(t, r.f, r.ch, "relay_skipped"); d["reason"] != "sender_unconfirmed" {
		t.Errorf("a forged message from a Cc'd address: relay_skipped %v, want sender_unconfirmed", d)
	}
	send("IT Security Desk <eve@evil.example>", "")
	if got := relayCopies(t, r); len(got) != 0 {
		t.Fatalf("a stranger's messages were sent on: %v", got)
	}
	var emails []string
	rows, err := r.f.sp.P.Query(context.Background(), `
		SELECT pav.value #>> '{}'
		FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'comm_confirmed'
		CROSS JOIN LATERAL jsonb_array_elements(av.value) AS e(v)
		JOIN attribute_value pav ON pav.card_id = (e.v #>> '{}')::bigint
		JOIN attribute_def pad ON pad.id = pav.attribute_def_id AND pad.name = 'email'
		WHERE av.card_id = $1
		ORDER BY 1`, r.thread)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var e string
		if err := rows.Scan(&e); err != nil {
			t.Fatal(err)
		}
		emails = append(emails, e)
	}
	if got := strings.Join(emails, ","); got != "ada@example.com,bob@example.com,carol@ourco.example" {
		t.Errorf("confirmed = %s, want the starter and the two people added in kitp", got)
	}
}

// TestRelayAddedPersonKeepsWriting: someone added in kitp stays confirmed
// after they write (their own From doesn't unconfirm them), so each of
// their replies is sent on to the person who started the thread.
func TestRelayAddedPersonKeepsWriting(t *testing.T) {
	r := newRelayFixture(t, "kitp_test_r2_relay_added", "")
	for i := range 2 {
		uid := uint32(10 + i)
		r.reply(t, uid, func(m *comm.InboundMessage) {
			m.MessageID = fmt.Sprintf("<bob-%d@example.com>", uid)
			m.From = "Bob <bob@example.com>"
		})
	}
	got := relayCopies(t, r)
	if len(got) != 2 || got[0] != "ada@example.com" || got[1] != "ada@example.com" {
		t.Fatalf("Bob's two replies were sent on to %v, want ada@example.com twice", got)
	}
}

// TestCommConfirmedIsKitpSet: nobody writes comm_confirmed by hand.
func TestCommConfirmedIsKitpSet(t *testing.T) {
	r := newRelayFixture(t, "kitp_test_r2_confirmed_kitp_set", "")
	env := dispatchExpectErr(t, r.f, api.SubRequest{ID: "u", Endpoint: "attribute", Action: "update",
		Data: json.RawMessage(fmt.Sprintf(`{"card_id":"%d","attribute_name":"comm_confirmed","value":[]}`, r.thread))})
	if env.Code != "validation" {
		t.Errorf("attribute.update comm_confirmed: code %q, want validation", env.Code)
	}
}

// TestNulInMailFiles (round 2 #2): a NUL anywhere in a message — raw or in an
// encoded word, in the subject, a Cc name or the body — is dropped and the
// message files; nothing wedges.
func TestNulInMailFiles(t *testing.T) {
	f := setupAdmin(t, "kitp_test_r2_nul")
	ch := seedChannelWith(t, f, `"intake_mode":"thread"`)

	m := inbound(7, "Invoice\x00 attached", "body with a \x00 in it")
	m.MessageID = "<nul-imap@example.com>"
	m.Cc = "=?utf-8?Q?x=00y?= <fresh-nul@example.net>"
	stub := &stubIMAPClient{messages: []comm.InboundMessage{m}}
	p := comm.NewIMAPPollerForTest(f.sp, ch, 5*time.Second)
	p.SetDialFunc(func(context.Context, comm.IMAPConfig) (comm.InboundClient, error) { return stub, nil })
	if err := p.RunOnce(context.Background()); err != nil {
		t.Fatalf("poll: %v", err)
	}
	if len(stub.markedSeen) != 1 {
		t.Errorf("marked seen %v, want the message", stub.markedSeen)
	}
	comms := commsUnder(t, f, f.projectID)
	if len(comms) != 1 {
		t.Fatalf("threads = %d, want 1", len(comms))
	}
	row := listThread(t, f, comms[0])
	if len(row.Replies) != 1 || strings.Contains(row.Replies[0].BodyText, "\x00") {
		t.Errorf("filed message = %+v", row.Replies)
	}
	if len(row.Recipients) != 2 {
		t.Errorf("recipients = %v, want Ada and the Cc'd address", row.Recipients)
	}

	in := &comm.Intake{Pool: f.sp}
	raw := []byte("From: Ada <ada@example.com>\r\nTo: support@example.com\r\nSubject: =?utf-8?Q?Invoice=00?=\r\nMessage-ID: <nul-raw@example.com>\r\n\r\nhello\x00\r\n")
	filed, err := in.FileRaw(context.Background(), ch, comm.TransportPOST, 0, raw)
	if err != nil {
		t.Fatalf("FileRaw: %v", err)
	}
	if filed.CardID == 0 {
		t.Errorf("FileRaw = %+v, want it filed", filed)
	}
}

// TestUnfileableAnswersEvenIfTheLogFails: a permanent filing error is
// ErrUnfileable even when its Comm log row can't be written.
func TestUnfileableAnswersEvenIfTheLogFails(t *testing.T) {
	f := setupAdmin(t, "kitp_test_r2_unfileable_log")
	ch := seedChannelWith(t, f, `"intake_mode":"thread"`)
	ctx := context.Background()
	// A trigger that fails every filed reply_body with a CHECK-class error,
	// and every comm_log insert: the message can't be filed or logged.
	for _, stmt := range []string{
		`CREATE FUNCTION zz_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'no' USING ERRCODE = '23514'; END $$`,
		`CREATE TRIGGER zz_fail_card BEFORE INSERT ON card FOR EACH ROW EXECUTE FUNCTION zz_fail()`,
		`CREATE TRIGGER zz_fail_log BEFORE INSERT ON comm_log FOR EACH ROW EXECUTE FUNCTION zz_fail()`,
	} {
		if _, err := f.sp.P.Exec(ctx, stmt); err != nil {
			t.Fatal(err)
		}
	}
	in := &comm.Intake{Pool: f.sp}
	raw := []byte("From: Ada <ada@example.com>\r\nTo: support@example.com\r\nSubject: Hi\r\nMessage-ID: <cant@example.com>\r\n\r\nhello\r\n")
	if _, err := in.FileRaw(ctx, ch, comm.TransportPOST, 0, raw); !errors.Is(err, comm.ErrUnfileable) {
		t.Errorf("FileRaw = %v, want ErrUnfileable", err)
	}
}

// TestOutgoingHeaders (round 2 #21): a message kitp sends has a Date and a
// Message-ID, and a subject outside ASCII is encoded.
func TestOutgoingHeaders(t *testing.T) {
	msg := string(comm.BuildMIMEForTest("support@example.com", "bob@example.com", "Ünïcode subject", "body", "abc123"))
	head, _, _ := strings.Cut(msg, "\r\n\r\n")
	for _, want := range []string{"\r\nDate: ", "\r\nMessage-ID: <kitp.", "@example.com>", "Subject:\r\n =?utf-8?q?"} {
		if !strings.Contains(head, want) {
			t.Errorf("headers lack %q:\n%s", want, head)
		}
	}
	for _, r := range head {
		if r > 127 {
			t.Errorf("raw non-ASCII in the headers:\n%s", head)
			break
		}
	}
}

// TestCommCreateRefusedWhenConversationsIsOff (round 2 #21): no thread is
// started, nor its first message sent, through an account whose area is
// off — approval.set's email request calls comm_create_batch the same way.
func TestCommCreateRefusedWhenConversationsIsOff(t *testing.T) {
	f := setupAdmin(t, "kitp_test_r2_comm_create_area_off")
	ch := seedChannelWith(t, f, `"intake_mode":"thread"`)
	ctx := context.Background()
	if _, err := f.sp.P.Exec(ctx, `
		INSERT INTO project_area (project_id, area_key, state) VALUES ($1, 'conversations', 'off')`, f.projectID); err != nil {
		t.Fatal(err)
	}
	var bob comm.PersonCreateOutput
	dispatch(t, f, api.SubRequest{ID: "p", Endpoint: "person", Action: "create",
		Data: json.RawMessage(`{"title":"Bob","email":"bob@example.com","tier":"contact"}`)}, &bob)
	in := fmt.Sprintf(`[{"task_id":"%d","channel_id":"%d","subject":"x","initial_message":"hello","recipient_person_ids":["%d"]}]`,
		f.taskID, ch, bob.PersonCardID)
	var ok bool
	var code string
	if err := f.sp.P.QueryRow(ctx, `SELECT ok, code FROM comm_create_batch($1, $2::jsonb)`, f.adminID, in).Scan(&ok, &code); err != nil {
		t.Fatal(err)
	}
	if ok || code != "area_off" {
		t.Errorf("comm_create_batch with Conversations off: ok=%v code=%q, want area_off", ok, code)
	}
}
