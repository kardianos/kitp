package bundle_test

// Regression test for the fourth 2026-11-03 review, finding 4.

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
)

// TestNothingMovesIntoABundleSource (round 4 #4): a workspace worker can't
// card.move or task.move anything into a feature bundle's source project.
func TestNothingMovesIntoABundleSource(t *testing.T) {
	f := setup(t, "kitp_test_r4_bundle_move")
	ctx := context.Background()
	var uid int64
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ('Wanda') RETURNING id`).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sp.P.Exec(ctx, `INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT $1, id, NULL FROM role WHERE name = 'worker'`, uid); err != nil {
		t.Fatal(err)
	}
	w := auth.WithUser(ctx, &auth.UserCtx{ID: uid, DisplayName: "Wanda"})
	as := func(endpoint, action, data string) api.SubResponse {
		return f.srv.Dispatch(w, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "x", Endpoint: endpoint, Action: action, Data: json.RawMessage(data)},
		}}).Subresponses[0]
	}
	id := func(sr api.SubResponse) int64 {
		t.Helper()
		var o struct {
			ID json.Number `json:"id"`
		}
		decode(t, sr, &o)
		n, err := o.ID.Int64()
		if err != nil {
			t.Fatal(err)
		}
		return n
	}
	src := scalar[int64](t, f, `SELECT source_project_id FROM bundle WHERE key = 'tracker'`)
	proj := id(as("card", "insert", `{"card_type_name":"project","title":"Wanda's"}`))
	screen := id(as("card", "insert", fmt.Sprintf(`{"card_type_name":"screen","parent_card_id":"%d","title":"planted","attributes":{"slug":"planted","layout":"list"}}`, proj)))
	if sr := as("card", "move", fmt.Sprintf(`{"card_id":"%d","new_parent_card_id":"%d"}`, screen, src)); sr.OK || sr.Error.Code != "forbidden" {
		t.Errorf("card.move into a bundle source: %+v, want forbidden", sr)
	}
	task := id(as("card", "insert", fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"planted task"}`, proj)))
	if sr := as("task", "move", fmt.Sprintf(`{"card_id":"%d","new_project_id":"%d"}`, task, src)); sr.OK || sr.Error.Code != "forbidden" {
		t.Errorf("task.move into a bundle source: %+v, want forbidden", sr)
	}
}
