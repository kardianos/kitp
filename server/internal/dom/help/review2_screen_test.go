package help_test

// Regression test for review 2026-11-03 round 2 #7: help.get_screen
// describes only a screen (and default view) the caller can see.

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/help"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

func TestHelpScreenSeesOnlyWhatYouSee(t *testing.T) {
	reg.Reset()
	pool := store.TestPool(t, "kitp_test_r2_help_screen")
	sp := store.NewPool(pool)
	cardtype.Register()
	card.Register(sp)
	help.Register()
	srv := api.NewServer(sp)
	ctx := context.Background()
	call := func(c context.Context, ep, ac, data string) api.SubResponse {
		return srv.Dispatch(c, api.BatchRequest{Subrequests: []api.SubRequest{{ID: "x", Endpoint: ep, Action: ac, Data: json.RawMessage(data)}}}).Subresponses[0]
	}
	ins := func(data string) int64 {
		sr := call(auth.WithSystemUser(ctx), "card", "insert", data)
		if !sr.OK {
			t.Fatalf("insert: %+v", sr.Error)
		}
		b, _ := json.Marshal(sr.Data)
		var o card.InsertOutput
		if err := json.Unmarshal(b, &o); err != nil {
			t.Fatal(err)
		}
		return o.ID
	}
	proj := ins(`{"card_type_name":"project","title":"Board only"}`)
	status := store.TemplateStatusID(t, pool, proj, "Todo")
	task := ins(fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"Layoffs: list for Q1","attributes":{"status":"%d"}}`, proj, status))

	var uid int64
	if err := pool.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ('Nobody') RETURNING id`).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	nobody := auth.WithUser(ctx, &auth.UserCtx{ID: uid, DisplayName: "Nobody"})

	// Someone's personal screen with a private default view.
	var person, scr, view int64
	if err := pool.QueryRow(ctx, `INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'person' RETURNING id`).Scan(&person); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO card (card_type_id, private_to) SELECT id, $1 FROM card_type WHERE name = 'screen' RETURNING id`, person).Scan(&scr); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO card (card_type_id, parent_card_id, private_to) SELECT id, $1, $2 FROM card_type WHERE name = 'filter' RETURNING id`, scr, person).Scan(&view); err != nil {
		t.Fatal(err)
	}
	for _, s := range []struct {
		id          int64
		attr, value string
	}{
		{scr, "title", `"Ada: people I'm interviewing"`},
		{scr, "layout", `"list"`},
		{scr, "default_filter", fmt.Sprint(view)},
		{view, "title", `"Candidates"`},
	} {
		if _, err := pool.Exec(ctx, `INSERT INTO attribute_value (card_id, attribute_def_id, value) SELECT $1, id, $3::jsonb FROM attribute_def WHERE name = $2`, s.id, s.attr, s.value); err != nil {
			t.Fatalf("%s: %v", s.attr, err)
		}
	}
	for _, c := range []struct {
		label string
		id    int64
	}{{"a task", task}, {"someone's private screen", scr}} {
		sr := call(nobody, "help", "get_screen", fmt.Sprintf(`{"screen_card_id":"%d"}`, c.id))
		if sr.OK || sr.Error.Code != "not_found" {
			b, _ := json.Marshal(sr.Data)
			t.Errorf("help.get_screen(%s) as an account with no role: ok=%v %s, want not_found", c.label, sr.OK, b)
		}
	}
	// A screen the caller can see is described.
	screen := ins(fmt.Sprintf(`{"card_type_name":"screen","parent_card_id":"%d","title":"Board","attributes":{"layout":"kanban","slug":"r2-board"}}`, proj))
	sr := call(auth.WithSystemUser(ctx), "help", "get_screen", fmt.Sprintf(`{"screen_card_id":"%d"}`, screen))
	if !sr.OK {
		t.Fatalf("help.get_screen(a visible screen): %+v", sr.Error)
	}
	if b, _ := json.Marshal(sr.Data); !strings.Contains(string(b), "Board") {
		t.Errorf("help for a visible screen = %s", b)
	}
}
