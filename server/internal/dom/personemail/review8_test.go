package personemail_test

import (
	"context"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/comm"
	"github.com/kitp/kitp/server/internal/dom/personemail"
	domuser "github.com/kitp/kitp/server/internal/dom/user"
)

// withAccountMail chooses the fixture's mail account for account emails.
func withAccountMail(t *testing.T, f *fixture) {
	t.Helper()
	if r := call(t, f, f.admin, "account_mail", "set", map[string]any{"channel_id": fmt.Sprint(f.channel)}); !r.OK {
		t.Fatalf("account_mail.set: %+v", r.Error)
	}
}

// ageSends makes every logged code send as old as ago (a SQL interval).
func ageSends(t *testing.T, f *fixture, ago string) {
	t.Helper()
	if _, err := f.sp.P.Exec(context.Background(), `UPDATE person_email_code_sent SET sent_at = sent_at - $1::interval`, ago); err != nil {
		t.Fatal(err)
	}
}

// TestCodeSendsAreLimited (review 2026-11-06 #7): the limits count codes
// sent, not address rows, so re-adding an address, a batch of the same
// add, or adding and removing fresh ones can't make the account-emails
// mailbox send without end.
func TestCodeSendsAreLimited(t *testing.T) {
	f := setup(t, "kitp_test_r8_code_limits")
	withAccountMail(t, f)
	sent, restore := personemail.CaptureMailForTest()
	defer restore()
	add := func(email string) api.SubResponse {
		return call(t, f, f.ada, "person_email", "add", map[string]any{"email": email})
	}

	// One batch adding one address twice: the second is refused, so
	// nothing is sent.
	r := f.srv.Dispatch(f.ada, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "a", Endpoint: "person_email", Action: "add", Data: []byte(`{"email":"x@out.example"}`)},
		{ID: "b", Endpoint: "person_email", Action: "add", Data: []byte(`{"email":"x@out.example"}`)},
	}})
	if r.Subresponses[0].OK || r.Subresponses[1].OK {
		t.Errorf("a batch adding one address twice went through: %+v", r.Subresponses)
	}
	if n := len(sent()); n != 0 {
		t.Errorf("%d code mails from the refused batch", n)
	}
	// Re-adding within a minute is refused; after it, sent again.
	if r := add("x@out.example"); !r.OK {
		t.Fatalf("add: %+v", r.Error)
	}
	if c := code(add("x@out.example")); c != "limit" {
		t.Errorf("a second code to one address within a minute: %q, want limit", c)
	}
	// 5 codes an hour per person, and removing addresses doesn't reset it.
	ageSends(t, f, "2 minutes")
	for i := 0; i < 4; i++ {
		e := fmt.Sprintf("y%d@out.example", i)
		if r := add(e); !r.OK {
			t.Fatalf("add %s: %+v", e, r.Error)
		}
		if r := call(t, f, f.ada, "person_email", "remove", map[string]any{"email": e}); !r.OK {
			t.Fatalf("remove %s: %+v", e, r.Error)
		}
	}
	if c := code(add("z@out.example")); c != "limit" {
		t.Errorf("a 6th code within an hour (after removing four): %q, want limit", c)
	}
	if n := len(sent()); n != 5 {
		t.Errorf("%d code mails, want 5", n)
	}
	// 5 a day to one address, whoever asks.
	ageSends(t, f, "2 hours")
	target := "victim@out.example"
	for i := 0; i < 5; i++ {
		who := f.ada
		if i%2 == 1 {
			who = f.bob
		}
		if r := call(t, f, who, "person_email", "add", map[string]any{"email": target}); !r.OK {
			t.Fatalf("send %d to %s: %+v", i+1, target, r.Error)
		}
		ageSends(t, f, "2 minutes")
	}
	if c := code(call(t, f, f.admin, "person_email", "add", map[string]any{"email": target})); c != "limit" {
		t.Errorf("a 6th code to one address in a day: %q, want limit", c)
	}
}

// TestCodesGoOnlyThroughAnEnabledAccount (review 2026-11-06 L12): with the
// account-emails mailbox paused, no code goes out.
func TestCodesGoOnlyThroughAnEnabledAccount(t *testing.T) {
	f := setup(t, "kitp_test_r8_code_sender_off")
	withAccountMail(t, f)
	sent, restore := personemail.CaptureMailForTest()
	defer restore()
	if _, err := f.sp.P.Exec(context.Background(), `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		SELECT $1, id, to_jsonb($2::text) FROM attribute_def WHERE name = 'channel_status'
		ON CONFLICT (card_id, attribute_def_id) DO UPDATE SET value = EXCLUDED.value`, f.channel, comm.ChannelStatusDisabledAdmin); err != nil {
		t.Fatal(err)
	}
	if c := code(call(t, f, f.ada, "person_email", "add", map[string]any{"email": "ada@home.example"})); c != "no_sender" {
		t.Errorf("add with the mailbox paused: %q, want no_sender", c)
	}
	if n := len(sent()); n != 0 {
		t.Errorf("%d code mails through a paused mailbox", n)
	}
}

// TestThePrimaryIsAVerifiedAddress (review 2026-11-06 L1): an address typed
// onto a contact before it got a login isn't the user's to keep — granting
// the login makes its email the primary, and a sign-in replaces a primary
// that is only on the card; the list calls such a primary unverified.
func TestThePrimaryIsAVerifiedAddress(t *testing.T) {
	f := setup(t, "kitp_test_r8_primary")
	ctx := context.Background()
	sys := auth.WithSystemUser(ctx)
	// A contact whose email a worker set.
	var contact int64
	if err := f.sp.P.QueryRow(ctx, `
		WITH c AS (INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'person' RETURNING id)
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		SELECT c.id, ad.id, to_jsonb('planted@evil.example'::text) FROM c, attribute_def ad WHERE ad.name = 'email'
		RETURNING card_id`).Scan(&contact); err != nil {
		t.Fatal(err)
	}
	if r := call(t, f, sys, "person", "grant_account", map[string]any{"person_card_id": fmt.Sprint(contact), "email": "dana@corp.example"}); !r.OK {
		t.Fatalf("grant_account: %+v", r.Error)
	}
	if p := f.primary(t, contact); p != "dana@corp.example" {
		t.Errorf("after grant_account the primary is %q, want the login's email", p)
	}
	// A primary that is only on the card (edited there some other way) is
	// replaced at the next sign-in, and listed unverified until then.
	if _, err := f.sp.P.Exec(ctx, `
		UPDATE attribute_value SET value = to_jsonb('planted@evil.example'::text)
		WHERE card_id = $1 AND attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'email')`, contact); err != nil {
		t.Fatal(err)
	}
	var list personemail.ListOutput
	into(t, call(t, f, f.admin, "person_email", "list", map[string]any{"person_id": fmt.Sprint(contact)}), &list)
	for _, a := range list.Addresses {
		if a.Email == "planted@evil.example" && (a.Verified || a.Source != "card") {
			t.Errorf("a card-only primary listed as %+v, want source card, unverified", a)
		}
	}
	var uid int64
	if err := f.sp.P.QueryRow(ctx, `SELECT user_account_id FROM user_account_person WHERE person_card_id = $1`, contact).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sp.P.Exec(ctx, `SELECT person_email_note_signin($1, 'dana@corp.example', 'dana@corp.example', $2)`, contact, uid); err != nil {
		t.Fatal(err)
	}
	if p := f.primary(t, contact); p != "dana@corp.example" {
		t.Errorf("after the sign-in the primary is %q, want the sign-in email", p)
	}
	// person.merge onto a contact with a typed email: the login moves, and
	// its email is the survivor's primary.
	var planted int64
	if err := f.sp.P.QueryRow(ctx, `
		WITH c AS (INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'person' RETURNING id)
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		SELECT c.id, ad.id, to_jsonb('planted2@evil.example'::text) FROM c, attribute_def ad WHERE ad.name = 'email'
		RETURNING card_id`).Scan(&planted); err != nil {
		t.Fatal(err)
	}
	if r := call(t, f, sys, "person", "merge", map[string]any{"survivor_id": fmt.Sprint(planted), "loser_ids": []string{fmt.Sprint(contact)}}); !r.OK {
		t.Fatalf("person.merge: %+v", r.Error)
	}
	if p := f.primary(t, planted); p != "dana@corp.example" {
		t.Errorf("after person.merge the survivor's primary is %q, want the moved login's email", p)
	}
}

// TestALoginsAddressesGoWithIt (review 2026-11-06 L11): revoking a login
// removes its person's addresses, so nobody is locked out of them — the
// same human's next login included.
func TestALoginsAddressesGoWithIt(t *testing.T) {
	f := setup(t, "kitp_test_r8_revoke_addresses")
	domuser.Register() // user.revoke_login; the dispatcher looks handlers up per call
	ctx := context.Background()
	var uid int64
	if err := f.sp.P.QueryRow(ctx, `SELECT user_account_id FROM user_account_person WHERE person_card_id = $1`, f.adaPerson).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	if r := call(t, f, f.admin, "user", "revoke_login", map[string]any{"user_account_id": fmt.Sprint(uid)}); !r.OK {
		t.Fatalf("revoke_login: %+v", r.Error)
	}
	var n int
	if err := f.sp.P.QueryRow(ctx, `SELECT count(*) FROM person_email WHERE person_card_id = $1`, f.adaPerson).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("%d addresses left on a revoked login's person", n)
	}
}

// TestSecondAddressesMatchOnlyForAdmins (review 2026-11-06 L2): a project's
// worker can't learn whose a second address is through
// person.upsert_by_email, and a contact made with someone's verified
// address doesn't take their mail.
func TestSecondAddressesMatchOnlyForAdmins(t *testing.T) {
	f := setup(t, "kitp_test_r8_upsert_second")
	ctx := context.Background()
	if _, err := f.sp.P.Exec(ctx, `INSERT INTO person_email (person_card_id, email, source, verified_at) VALUES ($1, 'ada@private.example', 'added', now())`, f.adaPerson); err != nil {
		t.Fatal(err)
	}
	var out comm.PersonUpsertByEmailOutput
	into(t, call(t, f, f.bob, "person", "upsert_by_email", map[string]any{"email": "ada@private.example"}), &out)
	if out.PersonID == f.adaPerson {
		t.Error("a worker's upsert_by_email found Ada by her second address")
	}
	// Bob's call made a contact with that address; mail (as System) still
	// files as Ada.
	into(t, call(t, f, auth.WithSystemUser(ctx), "person", "upsert_by_email", map[string]any{"email": "ada@private.example"}), &out)
	if out.PersonID != f.adaPerson {
		t.Errorf("mail from Ada's second address matched person %d, want Ada's %d", out.PersonID, f.adaPerson)
	}
}
