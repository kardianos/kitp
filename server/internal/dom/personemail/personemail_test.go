package personemail_test

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/comm"
	"github.com/kitp/kitp/server/internal/dom/personemail"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

type fixture struct {
	srv                *api.Server
	sp                 *store.Pool
	ada, bob, admin    context.Context
	adaPerson, channel int64
}

func call(t *testing.T, f *fixture, ctx context.Context, endpoint, action string, data any) api.SubResponse {
	t.Helper()
	b, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	return f.srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{{ID: "x", Endpoint: endpoint, Action: action, Data: b}}}).Subresponses[0]
}

func code(r api.SubResponse) string {
	if r.OK || r.Error == nil {
		return ""
	}
	return r.Error.Code
}

func into(t *testing.T, r api.SubResponse, v any) {
	t.Helper()
	if !r.OK {
		t.Fatalf("dispatch: %+v", r.Error)
	}
	b, _ := json.Marshal(r.Data)
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatal(err)
	}
}

// login makes an account, its person with primary email, and that email
// on the list as a sign-in would leave it.
func login(t *testing.T, f *fixture, name, role, email string) (context.Context, int64) {
	t.Helper()
	ctx := context.Background()
	var uid, pid int64
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name, email, oidc_sub) VALUES ($1, $2, $1) RETURNING id`, name, email).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'person' RETURNING id`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`INSERT INTO user_account_person (user_account_id, person_card_id) VALUES ($1, $2)`,
		`INSERT INTO user_role (user_id, role_id) SELECT $1, id FROM role WHERE name = '` + role + `'`,
	} {
		args := []any{uid, pid}
		if strings.Contains(q, "user_role") {
			args = []any{uid}
		}
		if _, err := f.sp.P.Exec(ctx, q, args...); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.sp.P.Exec(ctx, `SELECT person_email_note_signin($1, $2, '', $3)`, pid, email, uid); err != nil {
		t.Fatal(err)
	}
	return auth.WithUser(ctx, &auth.UserCtx{ID: uid, DisplayName: name}), pid
}

func setup(t *testing.T, schema string) *fixture {
	t.Helper()
	reg.Reset()
	sp := store.NewPool(store.TestPool(t, schema))
	cardtype.Register()
	card.Register(sp)
	attribute.Register(sp)
	comm.Register(sp)
	personemail.Register(sp)
	f := &fixture{srv: api.NewServer(sp), sp: sp}
	f.ada, f.adaPerson = login(t, f, "ada", "worker", "ada@corp.example")
	f.bob, _ = login(t, f, "bob", "worker", "bob@corp.example")
	f.admin, _ = login(t, f, "root", "admin", "root@corp.example")
	// A mail account to send codes from.
	if err := sp.P.QueryRow(context.Background(), `
		WITH p AS (INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'project' RETURNING id),
		     ch AS (INSERT INTO card (card_type_id, parent_card_id) SELECT ct.id, p.id FROM card_type ct, p WHERE ct.name = 'comm_channel' RETURNING id)
		SELECT id FROM ch`).Scan(&f.channel); err != nil {
		t.Fatal(err)
	}
	for attr, v := range map[string]string{"smtp_host": `"smtp.example"`, "smtp_port": `587`, "from_address": `"kitp@corp.example"`} {
		if _, err := sp.P.Exec(context.Background(), `
			INSERT INTO attribute_value (card_id, attribute_def_id, value) SELECT $1, id, $3::jsonb FROM attribute_def WHERE name = $2`, f.channel, attr, v); err != nil {
			t.Fatal(err)
		}
	}
	return f
}

func (f *fixture) primary(t *testing.T, person int64) string {
	t.Helper()
	var e string
	if err := f.sp.P.QueryRow(context.Background(), `
		SELECT COALESCE((SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
		                 WHERE av.card_id = $1 AND ad.name = 'email'), '')`, person).Scan(&e); err != nil {
		t.Fatal(err)
	}
	return e
}

var codeRE = regexp.MustCompile(`[A-Z0-9]{5}-[A-Z0-9]{5}`)

// TestAddVerifyChoosePrimary: an address of your own is added once a mail
// account sends account emails, verified by the code mailed to it, can
// become the primary, and the primary can't be removed.
func TestAddVerifyChoosePrimary(t *testing.T) {
	f := setup(t, "kitp_test_person_email")
	sent, restore := personemail.CaptureMailForTest()
	defer restore()
	if c := code(call(t, f, f.ada, "person_email", "add", map[string]any{"email": "ada@home.example"})); c != "no_sender" {
		t.Fatalf("add with no account-mail account: %q, want no_sender", c)
	}
	if c := code(call(t, f, f.ada, "account_mail", "set", map[string]any{"channel_id": fmt.Sprint(f.channel)})); c == "" {
		t.Error("a worker chose the account-mail account")
	}
	if r := call(t, f, f.admin, "account_mail", "set", map[string]any{"channel_id": fmt.Sprint(f.channel)}); !r.OK {
		t.Fatalf("account_mail.set: %+v", r.Error)
	}
	if r := call(t, f, f.ada, "person_email", "add", map[string]any{"email": " Ada@Home.example "}); !r.OK {
		t.Fatalf("add: %+v", r.Error)
	}
	mails := sent()
	if len(mails) != 1 || mails[0].To != "ada@home.example" {
		t.Fatalf("sent %+v, want one code to ada@home.example", mails)
	}
	got := codeRE.FindString(string(mails[0].Msg))
	if got == "" {
		t.Fatalf("no code in the mail:\n%s", mails[0].Msg)
	}
	if !strings.Contains(string(mails[0].Msg), comm.NotificationHeader+": verify") {
		t.Error("the code mail isn't marked as a notification (a reply would be filed)")
	}
	var list personemail.ListOutput
	into(t, call(t, f, f.ada, "person_email", "list", map[string]any{}), &list)
	if len(list.Addresses) != 2 || list.Addresses[1].Email != "ada@home.example" || list.Addresses[1].Verified || !list.CanAdd {
		t.Fatalf("list after add: %+v", list)
	}
	if c := code(call(t, f, f.ada, "person_email", "set_primary", map[string]any{"email": "ada@home.example"})); c != "not_verified" {
		t.Errorf("primary before verifying: %q, want not_verified", c)
	}
	if c := code(call(t, f, f.ada, "person_email", "verify", map[string]any{"email": "ada@home.example", "code": "AAAAA-AAAAA"})); c != "invalid_code" {
		t.Errorf("a wrong code: %q, want invalid_code", c)
	}
	if c := code(call(t, f, f.bob, "person_email", "verify", map[string]any{"email": "ada@home.example", "code": got})); c != "not_found" {
		t.Errorf("Bob using Ada's code: %q, want not_found", c)
	}
	typed := strings.ToLower(strings.ReplaceAll(got, "-", " "))
	if r := call(t, f, f.ada, "person_email", "verify", map[string]any{"email": "ada@home.example", "code": typed}); !r.OK {
		t.Fatalf("verify %q: %+v", typed, r.Error)
	}
	if r := call(t, f, f.ada, "person_email", "set_primary", map[string]any{"email": "ada@home.example"}); !r.OK {
		t.Fatalf("set_primary: %+v", r.Error)
	}
	if p := f.primary(t, f.adaPerson); p != "ada@home.example" {
		t.Errorf("primary %q, want ada@home.example", p)
	}
	if c := code(call(t, f, f.ada, "person_email", "remove", map[string]any{"email": "ada@home.example"})); c != "primary" {
		t.Errorf("removing the primary: %q, want primary", c)
	}
	// Bob adding Ada's verified address is answered like any address — no
	// in_use to say whose it is — but nothing is mailed (review 2026-11-06
	// L2). The send limit is per address, so let a minute pass first.
	if _, err := f.sp.P.Exec(context.Background(), `UPDATE person_email_code_sent SET sent_at = sent_at - interval '2 minutes'`); err != nil {
		t.Fatal(err)
	}
	before := len(sent())
	if r := call(t, f, f.bob, "person_email", "add", map[string]any{"email": "ada@home.example"}); !r.OK {
		t.Errorf("Bob adding Ada's verified address: %+v, want the same answer as any address", r.Error)
	}
	if n := len(sent()); n != before {
		t.Errorf("a code went to Ada's address on Bob's add (%d mails, want %d)", n, before)
	}
	if c := code(call(t, f, f.bob, "person_email", "list", map[string]any{"person_id": fmt.Sprint(f.adaPerson)})); c != "forbidden" {
		t.Errorf("Bob listing Ada's addresses: %q, want forbidden", c)
	}
	if r := call(t, f, f.admin, "person_email", "remove", map[string]any{"person_id": fmt.Sprint(f.adaPerson), "email": "ada@corp.example"}); !r.OK {
		t.Errorf("an admin removing Ada's other address: %+v", r.Error)
	}
}

// TestPrimaryFollowsTheSignInEmail: a new sign-in email becomes the primary
// when the primary was the previous sign-in email, and not when the person
// chose another.
func TestPrimaryFollowsTheSignInEmail(t *testing.T) {
	f := setup(t, "kitp_test_person_email_signin")
	ctx := context.Background()
	uid := auth.ActorOrSystem(f.ada)
	note := func(email, prev string) {
		t.Helper()
		if _, err := f.sp.P.Exec(ctx, `SELECT person_email_note_signin($1, $2, $3, $4)`, f.adaPerson, email, prev, uid); err != nil {
			t.Fatal(err)
		}
	}
	note("ada.lovelace@corp.example", "ada@corp.example")
	if p := f.primary(t, f.adaPerson); p != "ada.lovelace@corp.example" {
		t.Fatalf("after a renamed sign-in: primary %q", p)
	}
	if r := call(t, f, f.ada, "person_email", "set_primary", map[string]any{"email": "ada@corp.example"}); !r.OK {
		t.Fatalf("set_primary: %+v", r.Error)
	}
	note("a.lovelace@corp.example", "ada.lovelace@corp.example")
	if p := f.primary(t, f.adaPerson); p != "ada@corp.example" {
		t.Errorf("a primary Ada chose moved to the new sign-in email: %q", p)
	}
	var n int
	if err := f.sp.P.QueryRow(ctx, `SELECT count(*) FROM person_email WHERE person_card_id = $1 AND verified_at IS NOT NULL`, f.adaPerson).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 3 {
		t.Errorf("%d verified addresses, want 3 (each sign-in email kept)", n)
	}
}

// TestMailFromAnyVerifiedAddress: person.upsert_by_email (what intake and
// thread recipients use) finds the person by a verified second address,
// not by a pending one; a user's email isn't card data any more.
func TestMailFromAnyVerifiedAddress(t *testing.T) {
	f := setup(t, "kitp_test_person_email_match")
	ctx := context.Background()
	if _, err := f.sp.P.Exec(ctx, `
		INSERT INTO person_email (person_card_id, email, source, verified_at) VALUES ($1, 'ada@old.example', 'signin', now()), ($1, 'ada@pending.example', 'added', NULL)`, f.adaPerson); err != nil {
		t.Fatal(err)
	}
	sys := auth.WithSystemUser(ctx)
	var out comm.PersonUpsertByEmailOutput
	into(t, call(t, f, sys, "person", "upsert_by_email", map[string]any{"email": "Ada@Old.example"}), &out)
	if out.PersonID != f.adaPerson || out.Created {
		t.Errorf("mail from a verified second address: person %d (created %v), want Ada's %d", out.PersonID, out.Created, f.adaPerson)
	}
	into(t, call(t, f, sys, "person", "upsert_by_email", map[string]any{"email": "ada@pending.example"}), &out)
	if out.PersonID == f.adaPerson {
		t.Error("an unverified address matched Ada")
	}
	if c := code(call(t, f, f.admin, "attribute", "update", map[string]any{
		"card_id": fmt.Sprint(f.adaPerson), "attribute_name": "email", "value": "someone@else.example"})); c != "validation" {
		t.Errorf("an admin editing a user's email: %q, want validation", c)
	}
}
