// review8_security_test.go: the dispatcher-level fixes of the 2026-11-06
// security review.
package api_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

func r8As(srv *api.Server, uid int64, subs ...api.SubRequest) api.BatchResponse {
	return srv.Dispatch(auth.WithUser(context.Background(), &auth.UserCtx{ID: uid}), api.BatchRequest{Subrequests: subs})
}

func r8Sub(id, endpoint, action, data string) api.SubRequest {
	return api.SubRequest{ID: id, Endpoint: endpoint, Action: action, Data: json.RawMessage(data)}
}

// r8Code is the batch's error code: the first sub-request's own, not a
// sibling's "aborted".
func r8Code(r api.BatchResponse) string {
	for _, s := range r.Subresponses {
		if s.Error != nil && s.Error.Code != "aborted" {
			return s.Error.Code
		}
	}
	return ""
}

func r8Deleted(t *testing.T, sp *store.Pool, id int64) bool {
	t.Helper()
	var d bool
	if err := sp.P.QueryRow(context.Background(), `SELECT deleted_at IS NOT NULL FROM card WHERE id = $1`, id).Scan(&d); err != nil {
		t.Fatal(err)
	}
	return d
}

// TestAWriteAimedAtAFreeCardIDIsRefused (review 2026-11-06 #1): the authz
// pass runs before the request transaction, and card ids are sequential. A
// gated write naming an id no card had when it was checked — one its own
// batch makes, or whatever card gets it in between — is refused once the
// card exists; one still missing gets the handler's own not-found.
func TestAWriteAimedAtAFreeCardIDIsRefused(t *testing.T) {
	srv, sp := setupAuthz(t, "kitp_test_r8_free_id")
	projA, taskA := makeProjectAndTask(t, srv, "A")
	projC, _ := makeProjectAndTask(t, srv, "C")
	worker := grantRole(t, sp, "worker-A-manager-C", "worker", &projA)
	grantRole(t, sp, "worker-A-manager-C", "manager", &projC)
	viewer := grantRole(t, sp, "viewer-A", "viewer", &projA)
	statusA := store.TemplateStatusID(t, sp.P, projA, "Todo")

	var next int64
	if err := sp.P.QueryRow(context.Background(), `SELECT nextval(pg_get_serial_sequence('card', 'id')) + 1`).Scan(&next); err != nil {
		t.Fatal(err)
	}
	// One batch: make a task in A (id next), then merge A's task into it.
	r := r8As(srv, worker,
		r8Sub("new", "card", "insert", fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"bin","attributes":{"status":"%d"}}`, projA, statusA)),
		r8Sub("merge", "card", "merge", fmt.Sprintf(`{"survivor_id":"%d","loser_ids":["%d"]}`, next, taskA)),
	)
	if c := r8Code(r); c != "card_not_found" {
		t.Errorf("merging into the batch's own new card: %q, want card_not_found", c)
	}
	if r8Deleted(t, sp, taskA) {
		t.Error("A's task was merged away")
	}
	// A free id, written by someone with no grant on whatever lands there:
	// still missing at the handler, so its own not-found.
	for _, s := range []api.SubRequest{
		r8Sub("u", "attribute", "update", fmt.Sprintf(`{"card_id":"%d","attribute_name":"title","value":"defaced"}`, next+50)),
		r8Sub("d", "card", "delete", fmt.Sprintf(`{"card_id":"%d"}`, next+50)),
	} {
		if c := r8Code(r8As(srv, viewer, s)); c != "card_not_found" {
			t.Errorf("%s.%s on a free id: %q, want card_not_found", s.Endpoint, s.Action, c)
		}
	}
	// An existing card still goes to the grant check as before.
	if c := r8Code(r8As(srv, viewer, r8Sub("u", "attribute", "update", fmt.Sprintf(`{"card_id":"%d","attribute_name":"title","value":"x"}`, taskA)))); c != "unauthorized" {
		t.Errorf("a viewer's edit of an existing task: %q, want unauthorized", c)
	}
}

// TestOnlyAWorkspaceAdminWritesAMailAccount (review 2026-11-06 #2): a
// project-scoped admin's card.update grant doesn't reach a mail account's
// server, port or From through attribute.update, nor delete it: kitp logs
// in there with the stored password.
func TestOnlyAWorkspaceAdminWritesAMailAccount(t *testing.T) {
	srv, sp := setupAuthz(t, "kitp_test_r8_channel")
	ctx := context.Background()
	projA, _ := makeProjectAndTask(t, srv, "A")
	projAdmin := grantRole(t, sp, "admin-of-A", "admin", &projA)
	wsAdmin := grantRole(t, sp, "workspace-admin", "admin", nil)
	var ch int64
	if err := sp.P.QueryRow(ctx, `
		INSERT INTO card (card_type_id, parent_card_id) SELECT id, $1 FROM card_type WHERE name = 'comm_channel' RETURNING id`, projA).Scan(&ch); err != nil {
		t.Fatal(err)
	}
	for _, attr := range []string{"smtp_host", "imap_host", "from_address", "smtp_username"} {
		r := r8As(srv, projAdmin, r8Sub("u", "attribute", "update", fmt.Sprintf(`{"card_id":"%d","attribute_name":%q,"value":"evil.example.net"}`, ch, attr)))
		if c := r8Code(r); c != "forbidden" {
			t.Errorf("project admin sets %s: %q, want forbidden", attr, c)
		}
	}
	if c := r8Code(r8As(srv, projAdmin, r8Sub("d", "card", "delete", fmt.Sprintf(`{"card_id":"%d"}`, ch)))); c != "forbidden" {
		t.Errorf("project admin deletes the account: %q, want forbidden", c)
	}
	if c := r8Code(r8As(srv, projAdmin, r8Sub("i", "card", "insert", fmt.Sprintf(`{"card_type_name":"comm_channel","parent_card_id":"%d","title":"mine"}`, projA)))); c != "forbidden" {
		t.Errorf("project admin makes an account: %q, want forbidden", c)
	}
	if r := r8As(srv, wsAdmin, r8Sub("u", "attribute", "update", fmt.Sprintf(`{"card_id":"%d","attribute_name":"smtp_host","value":"smtp.example.com"}`, ch))); !r.Subresponses[0].OK {
		t.Errorf("a workspace admin sets smtp_host: %+v", r.Subresponses[0].Error)
	}
}

// TestNamingAPersonNeedsOneTheCallerMayName (review 2026-11-06 #5): a
// person card has no project, but what is named comes back out (exports,
// a thread's To, digests). A project's worker names someone they can see,
// a member of the project, or someone already named in it — not any
// person id in the workspace.
func TestNamingAPersonNeedsOneTheCallerMayName(t *testing.T) {
	srv, sp := setupAuthz(t, "kitp_test_r8_person_ref")
	ctx := context.Background()
	projA, taskA := makeProjectAndTask(t, srv, "A")
	_, taskB := makeProjectAndTask(t, srv, "B")
	worker := grantRole(t, sp, "worker-A", "worker", &projA)
	person := func(title string) int64 {
		t.Helper()
		var id int64
		if err := sp.P.QueryRow(ctx, `
			WITH c AS (INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'person' RETURNING id)
			INSERT INTO attribute_value (card_id, attribute_def_id, value)
			SELECT c.id, ad.id, to_jsonb($1::text) FROM c, attribute_def ad WHERE ad.name = 'title'
			RETURNING card_id`, title).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	setOriginator := func(uid, task, p int64) api.BatchResponse {
		return r8As(srv, uid, r8Sub("o", "attribute", "update", fmt.Sprintf(`{"card_id":"%d","attribute_name":"originator","value":"%d"}`, task, p)))
	}
	// B's customer, named on B's task by someone who may.
	customerB := person("Zed (B's customer)")
	if r := setOriginator(auth.SystemUserID, taskB, customerB); !r.Subresponses[0].OK {
		t.Fatalf("System names B's customer on B: %+v", r.Subresponses[0].Error)
	}
	if c := r8Code(setOriginator(worker, taskA, customerB)); c != "cross_project_ref" {
		t.Errorf("A's worker names B's customer: %q, want cross_project_ref", c)
	}
	// A member of A (a login with a role in A) may be named.
	member := person("Mia (member of A)")
	memberUID := grantRole(t, sp, "mia", "worker", &projA)
	if _, err := sp.P.Exec(ctx, `INSERT INTO user_account_person (user_account_id, person_card_id) VALUES ($1, $2)`, memberUID, member); err != nil {
		t.Fatal(err)
	}
	if r := setOriginator(worker, taskA, member); !r.Subresponses[0].OK {
		t.Errorf("A's worker names a member of A: %+v", r.Subresponses[0].Error)
	}
	// Once someone who may has named B's customer in A, A's people may too.
	if r := setOriginator(auth.SystemUserID, taskA, customerB); !r.Subresponses[0].OK {
		t.Fatalf("System names B's customer on A: %+v", r.Subresponses[0].Error)
	}
	statusA := store.TemplateStatusID(t, sp.P, projA, "Todo")
	r := r8As(srv, worker, r8Sub("t", "card", "insert", fmt.Sprintf(
		`{"card_type_name":"task","parent_card_id":"%d","title":"follow-up","attributes":{"status":"%d","originator":"%d"}}`, projA, statusA, customerB)))
	if !r.Subresponses[0].OK {
		t.Errorf("A's worker names a person already named in A: %+v", r.Subresponses[0].Error)
	}
	// card.insert refuses the same way as attribute.update.
	stranger := person("Sol (nobody's)")
	r = r8As(srv, worker, r8Sub("t", "card", "insert", fmt.Sprintf(
		`{"card_type_name":"task","parent_card_id":"%d","title":"x","attributes":{"status":"%d","originator":"%d"}}`, projA, statusA, stranger)))
	if c := r8Code(r); c != "cross_project_ref" {
		t.Errorf("card.insert naming a person nobody named in A: %q, want cross_project_ref", c)
	}
}
