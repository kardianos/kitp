package comm_test

// Round 8 of the 2026-11-06 review, the mail findings: a thread's lists
// under concurrent writers (#2), an account that doesn't poll (#3), the
// relay's name (#6), a Cc of a private address (L3), receive-only accounts
// (L5), a retry's Message-ID (L7) and the sender's claim (L16).

import (
	"context"
	"encoding/json"
	"fmt"
	"net/mail"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/dom/comm"
)

// r9WaitBlockedBy waits until a backend waits on a lock pid holds, and
// returns it.
func r9WaitBlockedBy(t *testing.T, pool *pgxpool.Pool, pid int32) int32 {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		var blocked int32
		err := pool.QueryRow(context.Background(),
			`SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid)) LIMIT 1`, pid).Scan(&blocked)
		if err == nil {
			return blocked
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("nobody waited on pid %d", pid)
	return 0
}

func r9Replies(t *testing.T, f *fixture, commID int64) []int64 {
	t.Helper()
	var raw []byte
	if err := f.sp.P.QueryRow(context.Background(), `
		SELECT av.value FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1 AND ad.name = 'replies'`, commID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var ids []int64
	if err := json.Unmarshal(raw, &ids); err != nil {
		t.Fatal(err)
	}
	return ids
}

func r9Has(ids []int64, id int64) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

func r9CommOfReply(t *testing.T, f *fixture, replyID int64) int64 {
	t.Helper()
	var commID int64
	if err := f.sp.P.QueryRow(context.Background(), `
		SELECT av.card_id FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE ad.name = 'replies' AND av.value @> to_jsonb($1::bigint)`, replyID).Scan(&commID); err != nil {
		t.Fatal(err)
	}
	return commID
}

func r9Post(t *testing.T, f *fixture, commID int64, body string) (int64, *api.ErrorEnvelope) {
	resp := f.srv.Dispatch(f.ctx, api.BatchRequest{Subrequests: []api.SubRequest{{
		ID: "r", Endpoint: "reply", Action: "post",
		Data: json.RawMessage(fmt.Sprintf(`{"comm_id":"%d","body":%q}`, commID, body)),
	}}})
	if !resp.Subresponses[0].OK {
		return 0, resp.Subresponses[0].Error
	}
	var out comm.ReplyPostOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	if err := json.Unmarshal(buf, &out); err != nil {
		t.Errorf("reply.post output: %v", err)
	}
	return out.ReplyID, nil
}

// TestAThreadKeepsEverythingWrittenToItAtOnce (#2): the thread's lists are
// read, changed and written back whole, so writers take the thread's list
// lock first (card_list_lock) and none loses another's message or change.
func TestAThreadKeepsEverythingWrittenToItAtOnce(t *testing.T) {
	f := setupAdmin(t, "kitp_test_r9_thread_lists")
	ctx := context.Background()
	channelID, firstReply := seedPendingReply(t, f, "support@example.com")
	commID := r9CommOfReply(t, f, firstReply)
	threadID := threadIDOf(t, f, commID)

	t.Run("staff_replies_at_once", func(t *testing.T) {
		const n = 8
		var wg sync.WaitGroup
		start := make(chan struct{})
		ids := make([]int64, n)
		for i := 0; i < n; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				<-start
				id, e := r9Post(t, f, commID, fmt.Sprintf("reply %d", i))
				if e != nil {
					t.Errorf("reply.post %d: %+v", i, e)
				}
				ids[i] = id
			}(i)
		}
		close(start)
		wg.Wait()
		list := r9Replies(t, f, commID)
		for i, id := range ids {
			if id != 0 && !r9Has(list, id) {
				t.Errorf("reply %d (%d) answered ok but isn't on the thread %v", i, id, list)
			}
		}
	})

	t.Run("mail_filed_while_staff_reply", func(t *testing.T) {
		// Filing writes the thread's `acked` after appending its message:
		// holding that row keeps the filing open past its append.
		if _, err := f.sp.P.Exec(ctx, `
			INSERT INTO attribute_value (card_id, attribute_def_id, value)
			SELECT $1, id, 'true'::jsonb FROM attribute_def WHERE name = 'acked'
			ON CONFLICT (card_id, attribute_def_id) DO NOTHING`, commID); err != nil {
			t.Fatal(err)
		}
		hold, err := f.sp.P.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = hold.Rollback(ctx) }() // a no-op after the commit below
		var holdPID int32
		if err := hold.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&holdPID); err != nil {
			t.Fatal(err)
		}
		if _, err := hold.Exec(ctx, `
			SELECT 1 FROM attribute_value WHERE card_id = $1
			  AND attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'acked') FOR UPDATE`, commID); err != nil {
			t.Fatal(err)
		}
		in := &comm.Intake{Pool: f.sp}
		raw := []byte("From: Alice <alice@example.com>\r\nTo: support@example.com\r\n" +
			"Subject: Re: Bug report [#" + threadID + "]\r\nDate: Tue, 3 Nov 2026 10:00:00 +0000\r\n" +
			"Message-ID: <customer-r9@example.com>\r\n\r\nCUSTOMER: here is the log.\r\n")
		var inErr error
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			_, inErr = in.FileRaw(ctx, channelID, comm.TransportPOST, 0, raw)
		}()
		filer := r9WaitBlockedBy(t, f.sp.P, holdPID)
		var staffReply int64
		var staffErr *api.ErrorEnvelope
		go func() {
			defer wg.Done()
			staffReply, staffErr = r9Post(t, f, commID, "STAFF: looking now")
		}()
		r9WaitBlockedBy(t, f.sp.P, filer) // reply.post waits for the filing's list lock
		if err := hold.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		wg.Wait()
		if inErr != nil || staffErr != nil {
			t.Fatalf("filing %v; staff %+v", inErr, staffErr)
		}
		var custReply int64
		if err := f.sp.P.QueryRow(ctx, `
			SELECT av.card_id FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE ad.name = 'reply_body_text' AND av.value #>> '{}' LIKE 'CUSTOMER:%'`).Scan(&custReply); err != nil {
			t.Fatal(err)
		}
		list := r9Replies(t, f, commID)
		if !r9Has(list, custReply) || !r9Has(list, staffReply) {
			t.Errorf("replies %v: the customer's %d on it %v, the staff reply %d on it %v",
				list, custReply, r9Has(list, custReply), staffReply, r9Has(list, staffReply))
		}
	})

	t.Run("someone_taken_off_while_mail_is_filed", func(t *testing.T) {
		var carol comm.PersonUpsertByEmailOutput
		dispatch(t, f, api.SubRequest{ID: "p", Endpoint: "person", Action: "upsert_by_email",
			Data: json.RawMessage(`{"email":"carol@example.com","kind":"contact"}`)}, &carol)
		hold, err := f.sp.P.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = hold.Rollback(ctx) }() // a no-op after the commit below
		var holdPID int32
		if err := hold.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&holdPID); err != nil {
			t.Fatal(err)
		}
		var ok bool
		var code string
		if err := hold.QueryRow(ctx, `SELECT ok, code FROM comm_set_recipients_batch($1, $2::jsonb)`, f.adminID,
			fmt.Sprintf(`[{"comm_id":"%d","recipient_person_ids":["%d"]}]`, commID, carol.PersonID)).Scan(&ok, &code); err != nil || !ok {
			t.Fatalf("set_recipients: ok=%v code=%s err=%v", ok, code, err)
		}
		in := &comm.Intake{Pool: f.sp}
		raw := []byte("From: Bob <bob@example.com>\r\nTo: support@example.com\r\n" +
			"Subject: Re: Bug report [#" + threadID + "]\r\nDate: Tue, 3 Nov 2026 11:00:00 +0000\r\n" +
			"Message-ID: <bob-r9@example.com>\r\n\r\nBOB: me too.\r\n")
		done := make(chan error, 1)
		go func() {
			_, err := in.FileRaw(ctx, channelID, comm.TransportPOST, 0, raw)
			done <- err
		}()
		r9WaitBlockedBy(t, f.sp.P, holdPID)
		if err := hold.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		rp, e := r9Post(t, f, commID, "STAFF: next update")
		if e != nil {
			t.Fatalf("reply.post: %+v", e)
		}
		var to string
		if err := f.sp.P.QueryRow(ctx, `SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE av.card_id = $1 AND ad.name = 'reply_to'`, rp).Scan(&to); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(to, "alice@example.com") || !strings.Contains(to, "carol@example.com") {
			t.Errorf("after Alice was taken off, the next reply goes To: %s", to)
		}
	})
}

// TestAnAccountThatDoesntPollIsLeftAlone (#3): with no IMAP host the poller
// has nothing to do, and it neither fails nor faults the account — which
// still sends.
func TestAnAccountThatDoesntPollIsLeftAlone(t *testing.T) {
	f := setupAdmin(t, "kitp_test_r9_no_imap")
	ctx := context.Background()
	ch := seedChannelWith(t, f, `"send_method":"webhook","send_url":"https://mail-out.example.com/","send_secret":"s","intake_mode":"thread"`)
	pollOnce(t, f, ch, inbound(1, "Printer", "It's on fire."))
	thread := commsUnder(t, f, f.projectID)[0]
	setChannel(t, f, ch, `"imap_enabled":false`)
	p := comm.NewIMAPPollerForTest(f.sp, ch, time.Second) // the real dial
	for i := 0; i < 12; i++ {
		if err := p.Tick(ctx); err != nil {
			t.Fatalf("tick %d: %v", i, err)
		}
	}
	if status, reason, err := comm.ReadChannelStatus(ctx, f.sp.P, ch); err != nil || status != comm.ChannelStatusEnabled {
		t.Fatalf("after 12 ticks: %s %s %v", status, reason, err)
	}
	if p.Backoff() != 0 {
		t.Errorf("backoff %v", p.Backoff())
	}
	var authFails int
	if err := f.sp.P.QueryRow(ctx, `SELECT count(*) FROM comm_log WHERE channel_id = $1 AND kind = 'imap_auth_fail'`, ch).Scan(&authFails); err != nil {
		t.Fatal(err)
	}
	if authFails != 0 {
		t.Errorf("imap_auth_fail rows: %d", authFails)
	}
	if _, e := r9Post(t, f, thread, "On it."); e != nil {
		t.Fatalf("reply.post: %+v", e)
	}
	s := comm.NewSMTPSenderForTest(f.sp, ch, time.Second)
	calls := 0
	s.SetAPITransport(func(context.Context, comm.Outbound, string, string, []byte) error { calls++; return nil })
	if err := s.RunOnce(ctx); err != nil || calls != 1 {
		t.Errorf("sender: err %v, sends %d; want the reply sent", err, calls)
	}
}

// TestARelayCopyIsNamedByKitp (#6): whatever display name the inbound From
// carries, the copy names the sender as kitp knows them — Ada's card — so
// "Carol <ada@…>" can't go out as "Carol via Support".
func TestARelayCopyIsNamedByKitp(t *testing.T) {
	r := newRelayFixture(t, "kitp_test_r9_relay_name", "")
	for i, from := range []string{"Carol <ada@example.com>", `"carol@ourco.example" <ada@example.com>`} {
		r.reply(t, uint32(40+i), func(m *comm.InboundMessage) {
			m.From = from
			m.MessageID = fmt.Sprintf("<dn-%d@x.example>", i)
		})
	}
	rt := &recordingTransport{}
	s := comm.NewSMTPSenderForTest(r.f.sp, r.ch, time.Second)
	s.SetTransport(rt.fn)
	if err := s.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if len(rt.calls) != 2 {
		t.Fatalf("copies sent: %d, want 2", len(rt.calls))
	}
	for _, c := range rt.calls {
		m, err := mail.ReadMessage(strings.NewReader(string(c.msg)))
		if err != nil {
			t.Fatal(err)
		}
		if got := m.Header.Get("From"); got != `"Ada Lovelace via Support" <support@example.com>` {
			t.Errorf("copy From: %s", got)
		}
	}
}

// TestACcOfAPrivateAddressNamesNobody (L3): mail that Cc's a user's private
// second address doesn't put the user on the thread, and the staff reply
// doesn't show their primary.
func TestACcOfAPrivateAddressNamesNobody(t *testing.T) {
	f := setupAdmin(t, "kitp_test_r9_cc_private")
	ctx := context.Background()
	var uid, person int64
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name, email, oidc_sub) VALUES ('Ursula', 'ursula@corp.example', 'u-sub') RETURNING id`).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'person' RETURNING id`).Scan(&person); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`INSERT INTO user_account_person (user_account_id, person_card_id) VALUES ($1, $2)`,
		`INSERT INTO attribute_value (card_id, attribute_def_id, value) SELECT $2, id, '"Ursula"' FROM attribute_def WHERE name = 'title' AND $1::bigint > 0`,
		`INSERT INTO attribute_value (card_id, attribute_def_id, value) SELECT $2, id, '"ursula@corp.example"' FROM attribute_def WHERE name = 'email' AND $1::bigint > 0`,
		`INSERT INTO person_email (person_card_id, email, source, verified_at) SELECT $2, 'ursula.home@private.example', 'added', now() WHERE $1::bigint > 0`,
	} {
		if _, err := f.sp.P.Exec(ctx, q, uid, person); err != nil {
			t.Fatal(err)
		}
	}
	channelID := seedChannelForIMAP(t, f, "support@ourco.example", 0)
	commID, threadID := seedCommForIMAP(t, f, channelID, "Order 42")
	stub := &stubIMAPClient{messages: []comm.InboundMessage{{
		UID: 1, From: "Mallory <mallory@outside.example>", To: "support@ourco.example",
		Cc: "ursula.home@private.example", Subject: "Re: Order 42", ThreadIDHdr: threadID, Body: "hi",
	}}}
	p := comm.NewIMAPPollerForTest(f.sp, channelID, 5*time.Second)
	p.SetDialFunc(func(ctx context.Context, _ comm.IMAPConfig) (comm.InboundClient, error) { return stub, nil })
	if err := p.RunOnce(ctx); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if r9Has(recipientIDsOf(t, f, commID), person) {
		t.Error("the Cc put Ursula (a kitp user) on the thread")
	}
	rp, e := r9Post(t, f, commID, "Thanks")
	if e != nil {
		t.Fatalf("reply.post: %+v", e)
	}
	var to string
	if err := f.sp.P.QueryRow(ctx, `
		SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1 AND ad.name = 'reply_to'`, rp).Scan(&to); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(to, "ursula@corp.example") {
		t.Errorf("the staff reply shows Ursula's primary: To %s", to)
	}
}

// TestAReceiveOnlyAccountQueuesNothing (L5): an account that doesn't send
// takes no first message (comm.create) and sends no copies on.
func TestAReceiveOnlyAccountQueuesNothing(t *testing.T) {
	r := newRelayFixture(t, "kitp_test_r9_receive_only", `,"send_method":"none","relay_replies":"on"`)
	f := r.f
	r.reply(t, 2, nil)
	for _, m := range listThread(t, f, r.thread).Replies {
		if m.Relay != nil {
			t.Errorf("a copy was queued on a receive-only account: %+v", m.Relay)
		}
	}
	if d := logDetail(t, f, r.ch, "relay_skipped"); d["reason"] != "cannot_send" {
		t.Errorf("relay_skipped = %v, want reason cannot_send", d)
	}
	var pOut comm.PersonUpsertByEmailOutput
	dispatch(t, f, api.SubRequest{ID: "p", Endpoint: "person", Action: "upsert_by_email",
		Data: json.RawMessage(`{"email":"customer@example.com","kind":"contact"}`)}, &pOut)
	e := dispatchExpectErr(t, f, api.SubRequest{ID: "c", Endpoint: "comm", Action: "create", Data: json.RawMessage(
		fmt.Sprintf(`{"task_id":"%d","channel_id":"%d","subject":"Hello","initial_message":"First words","recipient_person_ids":["%d"]}`,
			f.taskID, r.ch, pOut.PersonID))})
	if e.Code != "cannot_send" {
		t.Errorf("comm.create with a first message on a receive-only account: %s, want cannot_send", e.Code)
	}
}

// TestARetrySendsTheSameMessageID (L7): a send whose answer was lost is
// tried again with the same Message-ID, so the copy can be dropped.
func TestARetrySendsTheSameMessageID(t *testing.T) {
	f := setupAdmin(t, "kitp_test_r9_retry_msgid")
	ctx := context.Background()
	ch := seedChannelWith(t, f, `"send_method":"webhook","send_url":"https://mail-out.example.com/","send_secret":"s","intake_mode":"thread"`)
	pollOnce(t, f, ch, inbound(1, "Printer", "It's on fire."))
	thread := commsUnder(t, f, f.projectID)[0]
	if _, e := r9Post(t, f, thread, "On it."); e != nil {
		t.Fatalf("reply.post: %+v", e)
	}
	s := comm.NewSMTPSenderForTest(f.sp, ch, time.Second)
	var ids []string
	s.SetAPITransport(func(_ context.Context, _ comm.Outbound, _, _ string, msg []byte) error {
		m, err := mail.ReadMessage(strings.NewReader(string(msg)))
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, m.Header.Get("Message-ID"))
		if len(ids) == 1 {
			return fmt.Errorf(`webhook: Post "https://mail-out.example.com/": context deadline exceeded`)
		}
		return nil
	})
	if err := s.RunOnce(ctx); err != nil {
		t.Logf("attempt 1: %v", err)
	}
	if _, err := f.sp.P.Exec(ctx, `UPDATE comm_send_attempt SET next_attempt_at = now() - interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	if err := s.RunOnce(ctx); err != nil {
		t.Fatalf("attempt 2: %v", err)
	}
	if len(ids) != 2 || ids[0] != ids[1] || ids[0] == "" {
		t.Errorf("Message-IDs sent: %v, want the same one twice", ids)
	}
}

// TestTheClaimLooksAgain (L16): a message is claimed only if it is still
// one the sender would load: its thread not deleted, the account not
// paused.
func TestTheClaimLooksAgain(t *testing.T) {
	f := setupAdmin(t, "kitp_test_r9_claim_again")
	ctx := context.Background()
	channelID, replyID := seedPendingReply(t, f, "support@example.com")
	commID := r9CommOfReply(t, f, replyID)
	s := comm.NewSMTPSenderForTest(f.sp, channelID, time.Second)
	if _, err := f.sp.P.Exec(ctx, `UPDATE card SET deleted_at = now() WHERE id = $1`, f.taskID); err != nil {
		t.Fatal(err)
	}
	if ok, err := comm.ClaimForTest(ctx, s, replyID); err != nil || ok {
		t.Errorf("claimed a message on a deleted task's thread: %v %v", ok, err)
	}
	if _, err := f.sp.P.Exec(ctx, `UPDATE card SET deleted_at = NULL WHERE id = $1`, f.taskID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sp.P.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		SELECT $1, id, to_jsonb($2::text) FROM attribute_def WHERE name = 'channel_status'
		ON CONFLICT (card_id, attribute_def_id) DO UPDATE SET value = EXCLUDED.value`, channelID, comm.ChannelStatusDisabledAdmin); err != nil {
		t.Fatal(err)
	}
	if ok, err := comm.ClaimForTest(ctx, s, replyID); err != nil || ok {
		t.Errorf("claimed a message on a paused account: %v %v", ok, err)
	}
	if _, err := f.sp.P.Exec(ctx, `
		UPDATE attribute_value SET value = to_jsonb($2::text)
		WHERE card_id = $1 AND attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'channel_status')`, channelID, comm.ChannelStatusEnabled); err != nil {
		t.Fatal(err)
	}
	if ok, err := comm.ClaimForTest(ctx, s, replyID); err != nil || !ok {
		t.Errorf("the message can't be claimed once all is well again: %v %v", ok, err)
	}
	_ = commID
}
