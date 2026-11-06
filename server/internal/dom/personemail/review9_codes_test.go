package personemail_test

// Round 8 of the 2026-11-06 review: the code-send limits under concurrency
// and failure (#5), add while the account-emails mailbox is paused (L2),
// and user.restore_login's primary (L4).

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/dom/comm"
	"github.com/kitp/kitp/server/internal/dom/personemail"
	domuser "github.com/kitp/kitp/server/internal/dom/user"
)

// sendAtOnce dispatches each batch on its own goroutine; a send is held in
// the transport until every batch has reached one or a short wait passes,
// so no batch commits before the others have counted.
func sendAtOnce(t *testing.T, f *fixture, who []context.Context, batches [][]api.SubRequest) (oks, mails int) {
	t.Helper()
	release := make(chan struct{})
	entered := make(chan string, 1000)
	sent, restore := personemail.HoldingMailForTest(release, entered)
	defer restore()
	var wg sync.WaitGroup
	res := make([][]api.SubResponse, len(batches))
	for i := range batches {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			res[i] = f.srv.Dispatch(who[i], api.BatchRequest{Subrequests: batches[i]}).Subresponses
		}(i)
	}
	wait := time.After(2 * time.Second)
	for n := 0; n < len(batches); n++ {
		select {
		case <-entered:
		case <-wait:
			n = len(batches)
		}
	}
	close(release)
	wg.Wait()
	for i := range res {
		for _, r := range res[i] {
			if r.OK {
				oks++
			}
		}
	}
	return oks, len(sent())
}

// TestCodeLimitsHoldForBatchesAtOnce (#5): batches sent at the same moment
// wait for one another, so one person gets at most 5 codes an hour, and one
// address at most 1 a minute, whoever asks.
func TestCodeLimitsHoldForBatchesAtOnce(t *testing.T) {
	f := setup(t, "kitp_test_r9_codes_at_once")
	withAccountMail(t, f)
	var who []context.Context
	var batches [][]api.SubRequest
	for b := 0; b < 4; b++ {
		var subs []api.SubRequest
		for i := 0; i < 3; i++ {
			subs = append(subs, api.SubRequest{ID: fmt.Sprint(i), Endpoint: "person_email", Action: "add",
				Data: []byte(fmt.Sprintf(`{"email":"spam%d-%d@victim.example"}`, b, i))})
		}
		who = append(who, f.ada)
		batches = append(batches, subs)
	}
	if _, mails := sendAtOnce(t, f, who, batches); mails > 5 {
		t.Errorf("one person, 4 batches at once: %d code mails, want at most 5", mails)
	}
	who = []context.Context{f.bob, f.admin}
	batches = nil
	for range who {
		batches = append(batches, []api.SubRequest{{ID: "a", Endpoint: "person_email", Action: "add",
			Data: []byte(`{"email":"target@victim.example"}`)}})
	}
	if _, mails := sendAtOnce(t, f, who, batches); mails > 1 {
		t.Errorf("two people, one address, at once: %d code mails, want at most 1", mails)
	}
}

// TestACodeSentStaysCountedWhenTheBatchFails (#5): a batch that fails after
// a code went out — a wrong code in the same batch, or a later address the
// server refuses — rolls back, but the send is still counted.
func TestACodeSentStaysCountedWhenTheBatchFails(t *testing.T) {
	f := setup(t, "kitp_test_r9_codes_rollback")
	withAccountMail(t, f)
	sent, restore := personemail.CaptureMailForTest()
	victim := "victim@out.example"
	for i := 0; i < 4; i++ {
		f.srv.Dispatch(f.ada, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "a", Endpoint: "person_email", Action: "add", Data: []byte(fmt.Sprintf(`{"email":%q}`, victim))},
			{ID: "b", Endpoint: "person_email", Action: "verify", Data: []byte(fmt.Sprintf(`{"email":%q,"code":"AAAAA-AAAAA"}`, victim))},
		}})
	}
	n := 0
	for _, m := range sent() {
		if m.To == victim {
			n++
		}
	}
	restore()
	if n != 1 {
		t.Errorf("4 batches of add + a wrong code: %d code mails to %s, want 1 (1 a minute)", n, victim)
	}

	sent, restore = personemail.RefusingMailForTest("refused@victim.example")
	defer restore()
	for round := 0; round < 3; round++ {
		f.srv.Dispatch(f.bob, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "a", Endpoint: "person_email", Action: "add", Data: []byte(`{"email":"target@victim.example"}`)},
			{ID: "c", Endpoint: "person_email", Action: "add", Data: []byte(`{"email":"refused@victim.example"}`)},
		}})
	}
	toTarget := 0
	for _, m := range sent() {
		if m.To == "target@victim.example" {
			toTarget++
		}
	}
	if toTarget != 1 {
		t.Errorf("3 batches whose second send is refused: %d codes to target@victim.example, want 1", toTarget)
	}
}

// TestAddAnswersTheSameWhileTheMailboxIsPaused (L2): with the account-emails
// mailbox paused, a free address and one verified on someone else are both
// refused, so add doesn't tell which is someone's.
func TestAddAnswersTheSameWhileTheMailboxIsPaused(t *testing.T) {
	f := setup(t, "kitp_test_r9_codes_paused")
	withAccountMail(t, f)
	ctx := context.Background()
	var bobPerson int64
	if err := f.sp.P.QueryRow(ctx, `SELECT uap.person_card_id FROM user_account_person uap JOIN user_account ua ON ua.id = uap.user_account_id WHERE ua.display_name = 'bob'`).Scan(&bobPerson); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sp.P.Exec(ctx, `INSERT INTO person_email (person_card_id, email, source, verified_at) VALUES ($1, 'bob.private@home.example', 'added', now())`, bobPerson); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sp.P.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		SELECT $1, id, to_jsonb($2::text) FROM attribute_def WHERE name = 'channel_status'
		ON CONFLICT (card_id, attribute_def_id) DO UPDATE SET value = EXCLUDED.value`, f.channel, comm.ChannelStatusDisabledAdmin); err != nil {
		t.Fatal(err)
	}
	sent, restore := personemail.CaptureMailForTest()
	defer restore()
	free := call(t, f, f.ada, "person_email", "add", map[string]any{"email": "nobody@home.example"})
	taken := call(t, f, f.ada, "person_email", "add", map[string]any{"email": "bob.private@home.example"})
	if code(free) != "no_sender" || code(taken) != "no_sender" || len(sent()) != 0 {
		t.Errorf("mailbox paused: a free address %q, a taken one %q, %d mails; want no_sender for both and none",
			code(free), code(taken), len(sent()))
	}
}

// TestRestoreLoginGivesBackTheLoginsPrimary (L4): an email typed on the
// card while the login was revoked isn't the user's primary once it is
// restored.
func TestRestoreLoginGivesBackTheLoginsPrimary(t *testing.T) {
	f := setup(t, "kitp_test_r9_codes_restore")
	domuser.Register()
	ctx := context.Background()
	var uid int64
	var loginEmail string
	if err := f.sp.P.QueryRow(ctx, `
		SELECT ua.id, COALESCE(ua.email, '') FROM user_account_person uap JOIN user_account ua ON ua.id = uap.user_account_id
		WHERE uap.person_card_id = $1`, f.adaPerson).Scan(&uid, &loginEmail); err != nil {
		t.Fatal(err)
	}
	if loginEmail == "" {
		if _, err := f.sp.P.Exec(ctx, `UPDATE user_account SET email = 'ada@corp.example' WHERE id = $1`, uid); err != nil {
			t.Fatal(err)
		}
		loginEmail = "ada@corp.example"
	}
	if r := call(t, f, f.admin, "user", "revoke_login", map[string]any{"user_account_id": fmt.Sprint(uid)}); !r.OK {
		t.Fatalf("revoke_login: %+v", r.Error)
	}
	if _, err := f.sp.P.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		SELECT $1, id, to_jsonb('attacker@evil.example'::text) FROM attribute_def WHERE name = 'email'
		ON CONFLICT (card_id, attribute_def_id) DO UPDATE SET value = EXCLUDED.value`, f.adaPerson); err != nil {
		t.Fatal(err)
	}
	if r := call(t, f, f.admin, "user", "restore_login", map[string]any{"user_account_id": fmt.Sprint(uid)}); !r.OK {
		t.Fatalf("restore_login: %+v", r.Error)
	}
	if p := f.primary(t, f.adaPerson); p != loginEmail {
		t.Errorf("after restore_login the primary is %q, want the login's %q", p, loginEmail)
	}
}
