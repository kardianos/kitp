package user_test

// Regression test for review 2026-11-03 round 2 #3: the People screen's
// Remove takes the login away, not only its person link.

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/user"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

func TestRevokeLoginTakesEverything(t *testing.T) {
	reg.Reset()
	pool := store.TestPool(t, "kitp_test_r2_revoke_login")
	sp := store.NewPool(pool)
	cardtype.Register()
	card.Register(sp)
	attribute.Register(sp)
	user.Register()
	srv := api.NewServer(sp)
	ctx := context.Background()
	call := func(c context.Context, subs ...api.SubRequest) api.BatchResponse {
		return srv.Dispatch(c, api.BatchRequest{Subrequests: subs})
	}
	sub := func(ep, ac, data string) api.SubRequest {
		return api.SubRequest{ID: ep + "." + ac, Endpoint: ep, Action: ac, Data: json.RawMessage(data)}
	}
	var uid, person, bot int64
	if err := pool.QueryRow(ctx, `INSERT INTO user_account (display_name, oidc_sub, email) VALUES ('Leaver', 'sub-leaver', 'leaver@corp.example') RETURNING id`).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'person' RETURNING id`).Scan(&person); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO user_account (display_name, parent_user_id, is_agent) VALUES ('leaver-bot', $1, true) RETURNING id`, uid).Scan(&bot); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		fmt.Sprintf(`INSERT INTO user_account_person (user_account_id, person_card_id) VALUES (%d, %d)`, uid, person),
		fmt.Sprintf(`INSERT INTO user_role (user_id, role_id) SELECT %d, id FROM role WHERE name = 'worker'`, uid),
		fmt.Sprintf(`INSERT INTO user_role (user_id, role_id) SELECT %d, id FROM role WHERE name = 'worker'`, bot),
		fmt.Sprintf(`INSERT INTO session (id, user_id) VALUES ('sess-leaver', %d)`, uid),
		fmt.Sprintf(`INSERT INTO user_token (id, user_id, label) VALUES ('tok-leaver', %d, 'mine')`, uid),
		fmt.Sprintf(`INSERT INTO user_token (id, user_id, label) VALUES ('tok-bot', %d, 'bot')`, bot),
	} {
		if _, err := pool.Exec(ctx, q); err != nil {
			t.Fatal(err)
		}
	}

	// The People screen's Remove, in one batch.
	resp := call(auth.WithSystemUser(ctx),
		sub("user", "revoke_login", fmt.Sprintf(`{"user_account_id":"%d"}`, uid)),
		sub("card", "delete", fmt.Sprintf(`{"card_id":"%d"}`, person)))
	for _, r := range resp.Subresponses {
		if !r.OK {
			t.Fatalf("%s: %+v", r.ID, r.Error)
		}
	}
	// The identity stays, marked revoked, so it can be refused at sign-in
	// (round 3 #3).
	var roles, sessions, tokens, links int
	var revoked bool
	if err := pool.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM user_role WHERE user_id IN ($1, $2)),
		       (SELECT count(*) FROM session WHERE user_id = $1 AND revoked_at IS NULL),
		       (SELECT count(*) FROM user_token WHERE user_id IN ($1, $2) AND revoked_at IS NULL),
		       (SELECT count(*) FROM user_account_person WHERE user_account_id = $1),
		       (SELECT login_revoked_at IS NOT NULL AND oidc_sub = 'sub-leaver' FROM user_account WHERE id = $1)`, uid, bot,
	).Scan(&roles, &sessions, &tokens, &links, &revoked); err != nil {
		t.Fatal(err)
	}
	if roles != 0 || sessions != 0 || tokens != 0 || links != 0 || !revoked {
		t.Errorf("after Remove: roles %d sessions %d tokens %d links %d revoked %v, want all gone and the login marked revoked",
			roles, sessions, tokens, links, revoked)
	}

	// What the removed account can still do: nothing.
	leaver := auth.WithUser(ctx, &auth.UserCtx{ID: uid, DisplayName: "Leaver"})
	if r := call(leaver, sub("card", "insert", `{"card_type_name":"project","title":"still here"}`)).Subresponses[0]; r.OK {
		t.Error("the removed account still creates projects")
	}

	// Not yourself, not the System user, not an agent.
	for _, c := range []struct {
		who  int64
		code string
	}{{auth.SystemUserID, "forbidden"}, {bot, "not_found"}} {
		r := call(auth.WithSystemUser(ctx), sub("user", "revoke_login", fmt.Sprintf(`{"user_account_id":"%d"}`, c.who))).Subresponses[0]
		if r.OK || r.Error.Code != c.code {
			t.Errorf("revoke_login %d: %+v, want %s", c.who, r, c.code)
		}
	}
}
