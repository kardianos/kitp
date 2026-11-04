package card_test

// Regression tests for the account findings of the third 2026-11-03 review
// that show through card reads and writes.

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/auth"
)

// TestWorkspaceAgentSeesOnlyItsGrants (round 3 #2): a workspace agent (owned
// by System) granted worker on project A sees A, not B; it has no person, so
// no other workspace agent's — or System's — personal things; and it is its
// own principal. A personal agent still sees what its owner sees.
func TestWorkspaceAgentSeesOnlyItsGrants(t *testing.T) {
	f := setupVisibility(t, "kitp_test_r3_wsagent")
	ctx := context.Background()
	newAgent := func(name string, owner int64) int64 {
		t.Helper()
		var id int64
		if err := f.sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name, parent_user_id, is_agent) VALUES ($1, $2, true) RETURNING id`, name, owner).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	agent := newAgent("forge", auth.SystemUserID)
	other := newAgent("ci", auth.SystemUserID)
	if _, err := f.sp.P.Exec(ctx, `INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT $1, id, $2 FROM role WHERE name = 'worker'`, agent, f.projectA); err != nil {
		t.Fatal(err)
	}
	var visA, visB bool
	var person *int64
	var principal, otherPrincipal int64
	if err := f.sp.P.QueryRow(ctx, `
		SELECT card_visible_to($1, $2), card_visible_to($1, $3), account_person($1),
		       account_principal($1), account_principal($4)`,
		agent, f.taskA, f.taskB, other).Scan(&visA, &visB, &person, &principal, &otherPrincipal); err != nil {
		t.Fatal(err)
	}
	if !visA || visB {
		t.Errorf("workspace agent with worker on A: sees A=%v, B=%v; want true, false", visA, visB)
	}
	if person != nil {
		t.Errorf("workspace agent's person = %d, want none", *person)
	}
	if principal != agent || otherPrincipal != other {
		t.Errorf("principals %d, %d; want each agent its own (%d, %d)", principal, otherPrincipal, agent, other)
	}
	if ids := cardSelectIDs(t, f, agent, f.projectB); len(ids) != 0 {
		t.Errorf("card.select under B as the workspace agent: %v", ids)
	}
	r := reviewCall(t, f, agent, "card", "select_with_attributes", fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d"}`, f.projectB))
	if r.OK && strings.Contains(fmt.Sprint(r.Data), fmt.Sprint(f.taskB)) {
		t.Errorf("select_with_attributes in B as the workspace agent: %v", r.Data)
	}
	pagent := newAgent("bot", f.worker)
	var pvisA, pvisB bool
	if err := f.sp.P.QueryRow(ctx, `SELECT card_visible_to($1, $2), card_visible_to($1, $3)`, pagent, f.taskA, f.taskB).Scan(&pvisA, &pvisB); err != nil {
		t.Fatal(err)
	}
	if !pvisA || pvisB {
		t.Errorf("personal agent of the A worker: sees A=%v, B=%v; want true, false", pvisA, pvisB)
	}
}

// TestLoginEmailIsAdminOnly (round 3 #17): a workspace worker can't change
// the email of a person who signs in; an admin can, and so can the user.
func TestLoginEmailIsAdminOnly(t *testing.T) {
	f := setupVisibility(t, "kitp_test_r3_login_email")
	ctx := context.Background()
	if _, err := f.sp.P.Exec(ctx, `INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT $1, id, NULL FROM role WHERE name = 'worker'`, f.worker); err != nil {
		t.Fatal(err)
	}
	var target, targetPerson int64
	if err := f.sp.P.QueryRow(ctx, `
		WITH u AS (INSERT INTO user_account (display_name, email) VALUES ('Mona', 'mona@example.com') RETURNING id),
		     p AS (INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'person' RETURNING id),
		     l AS (INSERT INTO user_account_person (user_account_id, person_card_id) SELECT u.id, p.id FROM u, p),
		     e AS (INSERT INTO attribute_value (card_id, attribute_def_id, value)
		           SELECT p.id, ad.id, to_jsonb('mona@example.com'::text) FROM p, attribute_def ad WHERE ad.name = 'email')
		SELECT u.id, p.id FROM u, p`).Scan(&target, &targetPerson); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sp.P.Exec(ctx, `INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT $1, id, NULL FROM role WHERE name = 'worker'`, target); err != nil {
		t.Fatal(err)
	}
	set := func(uid int64, email string) string {
		r := reviewCall(t, f, uid, "attribute", "update", fmt.Sprintf(`{"card_id":"%d","attribute_name":"email","value":%q}`, targetPerson, email))
		if r.OK {
			return ""
		}
		return r.Error.Code
	}
	if code := set(f.worker, "attacker@evil.example"); code != "forbidden" {
		t.Errorf("a worker changed a login's person email: code %q, want forbidden", code)
	}
	if code := set(f.admin, "mona@new.example"); code != "" {
		t.Errorf("an admin couldn't change it: %s", code)
	}
	if code := set(target, "mona@mine.example"); code != "" {
		t.Errorf("the user couldn't change their own: %s", code)
	}
}
