package comm_test

// A mail account's ways in and out (docs/MAIL_INTAKE_AND_CALENDARS.md,
// "Sending"): the send methods on comm_channel.set / .list, test_send, and
// the reply sender going the account's way.

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/dom/comm"
)

func channelRow(t *testing.T, f *fixture, id int64) comm.ChannelRow {
	t.Helper()
	var out comm.ChannelListOutput
	dispatch(t, f, api.SubRequest{ID: "l", Endpoint: "comm_channel", Action: "list",
		Data: json.RawMessage(fmt.Sprintf(`{"project_id":"%d"}`, f.projectID))}, &out)
	for _, r := range out.Rows {
		if r.ID == id {
			return r
		}
	}
	t.Fatalf("channel %d not listed", id)
	return comm.ChannelRow{}
}

func setChannel(t *testing.T, f *fixture, id int64, extra string) {
	t.Helper()
	body := fmt.Sprintf(`{"id":"%d","project_id":"%d","name":"Support","channel_type":"email",%s}`, id, f.projectID, extra)
	dispatch(t, f, api.SubRequest{ID: "s", Endpoint: "comm_channel", Action: "set", Data: json.RawMessage(body)}, &comm.ChannelSetOutput{})
}

// TestAMailAccountChoosesHowItSends: each send method keeps its settings
// and its secret (write-only); a new method without a new secret clears the
// old one; can_send says whether there is a way out; polling can be
// switched off; the routes are counted.
func TestAMailAccountChoosesHowItSends(t *testing.T) {
	f := setupAdmin(t, "kitp_test_r9_send_methods")
	ch := seedChannelWith(t, f, "")
	if r := channelRow(t, f, ch); comm.ResolveSendMethod(r.SendMethod) != comm.SendMethodSMTP || !r.CanSend {
		t.Fatalf("an account with SMTP: method %q can_send %v", r.SendMethod, r.CanSend)
	}
	setChannel(t, f, ch, `"send_method":"mailgun","send_domain":"MG.Example.com","send_region":"eu","send_secret":"key-1"`)
	r := channelRow(t, f, ch)
	if r.SendMethod != "mailgun" || r.SendDomain != "mg.example.com" || r.SendRegion != "eu" || !r.HasSendSecret || !r.CanSend {
		t.Errorf("after Mailgun: %+v", r)
	}
	cfg, err := comm.LoadSMTPConfig(context.Background(), f.sp.P, ch)
	if err != nil {
		t.Fatal(err)
	}
	if o := cfg.Outbound(); o.Method != "mailgun" || o.Secret != "key-1" || !o.Ready() {
		t.Errorf("the sender's view: %+v", o)
	}
	// Postmark without a token: the Mailgun key is no use, so it goes.
	setChannel(t, f, ch, `"send_method":"postmark"`)
	if r := channelRow(t, f, ch); r.HasSendSecret || r.CanSend {
		t.Errorf("Postmark with Mailgun's key kept: has_send_secret %v can_send %v", r.HasSendSecret, r.CanSend)
	}
	setChannel(t, f, ch, `"send_method":"postmark","send_secret":"tok"`)
	if r := channelRow(t, f, ch); !r.CanSend {
		t.Error("Postmark with its token can't send")
	}
	setChannel(t, f, ch, `"send_method":"none"`)
	if r := channelRow(t, f, ch); r.CanSend {
		t.Error("an account that doesn't send can_send")
	}
	// Refused settings.
	for _, bad := range []string{
		`"send_method":"carrier-pigeon"`,
		`"send_method":"webhook","send_url":"http://mail.example.com/send","send_secret":"s"`,
		`"send_method":"webhook","send_url":"https://user:pw@mail.example.com/","send_secret":"s"`,
		`"send_method":"mailgun","send_domain":"not a domain"`,
		`"send_method":"mailgun","send_region":"asia"`,
	} {
		body := fmt.Sprintf(`{"id":"%d","project_id":"%d","name":"Support","channel_type":"email",%s}`, ch, f.projectID, bad)
		if e := dispatchExpectErr(t, f, api.SubRequest{ID: "s", Endpoint: "comm_channel", Action: "set", Data: json.RawMessage(body)}); e.Code != "validation" {
			t.Errorf("%s: %s, want validation", bad, e.Code)
		}
	}
	setChannel(t, f, ch, `"send_method":"webhook","send_url":"https://mail-out.example.com/kitp","send_secret":"s3cret"`)
	if r := channelRow(t, f, ch); r.SendURL != "https://mail-out.example.com/kitp" || !r.CanSend {
		t.Errorf("after the webhook: %+v", r)
	}
	// An explicit "" clears the secret, as with the passwords.
	setChannel(t, f, ch, `"send_secret":""`)
	if r := channelRow(t, f, ch); r.HasSendSecret || r.CanSend {
		t.Errorf("send_secret \"\" left has_send_secret %v can_send %v", r.HasSendSecret, r.CanSend)
	}
	setChannel(t, f, ch, `"send_secret":"s3cret"`)
	// Polling off: the IMAP settings go.
	setChannel(t, f, ch, `"imap_enabled":false`)
	if r := channelRow(t, f, ch); r.IMAPHost != "" || r.IMAPUsername != "" || r.HasIMAPPassword {
		t.Errorf("polling off left %q / %q / password %v", r.IMAPHost, r.IMAPUsername, r.HasIMAPPassword)
	}
	// The routes are counted (comm_route.create is mailin's; the row as it
	// leaves one).
	if _, err := f.sp.P.Exec(context.Background(), `
		INSERT INTO card_access (card_id, purpose, token_hash, hint, provider) VALUES ($1, 'inbound_post', 'h1', 'h1', 'raw')`, ch); err != nil {
		t.Fatal(err)
	}
	if r := channelRow(t, f, ch); r.PostRoutes != 1 || r.SMTPRoutes != 0 {
		t.Errorf("routes: post %d smtp %d, want 1 / 0", r.PostRoutes, r.SMTPRoutes)
	}
}

// TestTestSendMailsYouTheAccountsWay: the test message goes to the admin's
// own address through the account's way out, marked as a notification, and
// lands in the Comm log; an account with no way out is refused.
func TestTestSendMailsYouTheAccountsWay(t *testing.T) {
	f := setupAdmin(t, "kitp_test_r9_test_send")
	ctx := context.Background()
	var person int64
	if err := f.sp.P.QueryRow(ctx, `
		WITH c AS (INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'person' RETURNING id)
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		SELECT c.id, ad.id, to_jsonb('root@corp.example'::text) FROM c, attribute_def ad WHERE ad.name = 'email'
		RETURNING card_id`).Scan(&person); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sp.P.Exec(ctx, `INSERT INTO user_account_person (user_account_id, person_card_id) VALUES ($1, $2)`, f.adminID, person); err != nil {
		t.Fatal(err)
	}
	ch := seedChannelWith(t, f, `"send_method":"webhook","send_url":"https://mail-out.example.com/","send_secret":"s"`)
	var got []string
	var gotMsg string
	restore := comm.SetTestSendTransportsForTest(nil, func(_ context.Context, o comm.Outbound, from, to string, msg []byte) error {
		got = append(got, o.Method+" "+from+" → "+to)
		gotMsg = string(msg)
		return nil
	})
	defer restore()
	var out comm.ChannelTestSendOutput
	dispatch(t, f, api.SubRequest{ID: "t", Endpoint: "comm_channel", Action: "test_send",
		Data: json.RawMessage(fmt.Sprintf(`{"channel_id":"%d"}`, ch))}, &out)
	if out.To != "root@corp.example" || len(got) != 1 || got[0] != "webhook support@example.com → root@corp.example" {
		t.Errorf("test_send: %+v, sent %v", out, got)
	}
	if !strings.Contains(gotMsg, comm.NotificationHeader+": test") || !strings.Contains(gotMsg, "<"+comm.NotificationMessageIDPrefix) {
		t.Errorf("the test message isn't marked as a notification:\n%s", gotMsg)
	}
	if d := logDetail(t, f, ch, "send_test"); d["ok"] != true {
		t.Errorf("Comm log send_test = %v", d)
	}
	setChannel(t, f, ch, `"send_method":"none"`)
	if e := dispatchExpectErr(t, f, api.SubRequest{ID: "t", Endpoint: "comm_channel", Action: "test_send",
		Data: json.RawMessage(fmt.Sprintf(`{"channel_id":"%d"}`, ch))}); e.Code != "cannot_send" {
		t.Errorf("an account with no way out: %s, want cannot_send", e.Code)
	}
}

// TestRepliesGoTheAccountsWay: a queued reply on an account that sends by
// webhook goes through the API transport with the message whole; on an
// account that doesn't send it is failed at once, saying why.
func TestRepliesGoTheAccountsWay(t *testing.T) {
	f := setupAdmin(t, "kitp_test_r9_reply_way")
	ch := seedChannelWith(t, f, `"send_method":"webhook","send_url":"https://mail-out.example.com/","send_secret":"s","intake_mode":"thread"`)
	pollOnce(t, f, ch, inbound(1, "Printer", "It's on fire."))
	thread := commsUnder(t, f, f.projectID)[0]
	var rp comm.ReplyPostOutput
	dispatch(t, f, api.SubRequest{ID: "r", Endpoint: "reply", Action: "post",
		Data: json.RawMessage(fmt.Sprintf(`{"comm_id":"%d","body":"On it."}`, thread))}, &rp)
	s := comm.NewSMTPSenderForTest(f.sp, ch, time.Second)
	smtpCalls := 0
	s.SetTransport(func(context.Context, string, int, string, string, string, string, []byte) error {
		smtpCalls++
		return nil
	})
	var apiTo, apiMsg string
	s.SetAPITransport(func(_ context.Context, o comm.Outbound, _, to string, msg []byte) error {
		if o.Method != comm.SendMethodWebhook || o.Secret != "s" {
			t.Errorf("the API transport got %+v", o)
		}
		apiTo, apiMsg = to, string(msg)
		return nil
	})
	if err := s.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if smtpCalls != 0 || apiTo == "" || !strings.Contains(apiMsg, "On it.") || !strings.Contains(apiMsg, "Message-ID:") {
		t.Errorf("smtp calls %d, api to %q, message %q", smtpCalls, apiTo, apiMsg)
	}
	// A receive-only account takes no reply.
	setChannel(t, f, ch, `"send_method":"none"`)
	if e := dispatchExpectErr(t, f, api.SubRequest{ID: "r", Endpoint: "reply", Action: "post",
		Data: json.RawMessage(fmt.Sprintf(`{"comm_id":"%d","body":"Second."}`, thread))}); e.Code != "cannot_send" {
		t.Errorf("a reply on a receive-only account: %s, want cannot_send", e.Code)
	}
	// One whose way out isn't complete (a webhook that lost its secret by a
	// method change): the queued reply fails at once, with the reason.
	setChannel(t, f, ch, `"send_method":"webhook","send_secret":"s"`)
	dispatch(t, f, api.SubRequest{ID: "r", Endpoint: "reply", Action: "post",
		Data: json.RawMessage(fmt.Sprintf(`{"comm_id":"%d","body":"Second."}`, thread))}, &rp)
	setChannel(t, f, ch, `"send_method":"postmark"`)
	if err := s.RunOnce(context.Background()); err == nil {
		t.Error("a reply on an account with no way out went through")
	}
	var status string
	if err := f.sp.P.QueryRow(context.Background(), `
		SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1 AND ad.name = 'delivery_status'`, rp.ReplyID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "failed" {
		t.Errorf("delivery_status %q, want failed (no retries for no way out)", status)
	}
	if d := logDetail(t, f, ch, "send_fail"); !strings.Contains(fmt.Sprint(d["error"]), "no way out") {
		t.Errorf("Comm log send_fail = %v", d)
	}
}
