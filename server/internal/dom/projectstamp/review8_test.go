package projectstamp_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/projectstamp"
)

// TestStampLeavesOffAreaCardsBehind (review 2026-11-06 #9): a template
// whose Content area is switched off (its pages hidden from everyone,
// admins included) is stamped by a worker; the copy carries none of the
// hidden pages into the new project, where the area is on and they would
// show.
func TestStampLeavesOffAreaCardsBehind(t *testing.T) {
	f := setup(t, "kitp_test_r8_stamp_off_area")
	f.seedTemplate(t)
	ctx := f.ctx

	// A page under the template, with a body.
	var page int64
	if err := f.sp.P.QueryRow(ctx, `
		WITH c AS (
			INSERT INTO card (card_type_id, parent_card_id)
			SELECT id, $1 FROM card_type WHERE name = 'page' RETURNING id)
		SELECT id FROM c`, f.templateID).Scan(&page); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sp.P.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		SELECT $1, ad.id, CASE ad.name WHEN 'title' THEN to_jsonb('Salary bands'::text)
		                               ELSE to_jsonb('CEO 400k; VP 250k'::text) END
		FROM attribute_def ad WHERE ad.name IN ('title', 'description')`, page); err != nil {
		t.Fatal(err)
	}
	// Content switched off in the template: the page is hidden.
	if _, err := f.sp.P.Exec(ctx, `INSERT INTO project_area (project_id, area_key, state) VALUES ($1, 'content', 'off')`, f.templateID); err != nil {
		t.Fatal(err)
	}

	// A workspace worker (can stamp, sees the template project).
	var w int64
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ('w') RETURNING id`).Scan(&w); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sp.P.Exec(ctx, `INSERT INTO user_role (user_id, role_id) SELECT $1, id FROM role WHERE name = 'worker'`, w); err != nil {
		t.Fatal(err)
	}
	var before bool
	if err := f.sp.P.QueryRow(ctx, `SELECT card_visible_to($1, $2)`, w, page).Scan(&before); err != nil {
		t.Fatal(err)
	}
	wctx := auth.WithUser(context.Background(), &auth.UserCtx{ID: w, DisplayName: "w"})
	resp := f.srv.Dispatch(wctx, api.BatchRequest{Subrequests: []api.SubRequest{{
		ID: "s", Endpoint: "project", Action: "stamp",
		Data: json.RawMessage(fmt.Sprintf(`{"template_project_id":"%d","name":"mine"}`, f.templateID)),
	}}})
	sub := resp.Subresponses[0]
	if !sub.OK {
		t.Fatalf("stamp: %+v", sub.Error)
	}
	raw, _ := json.Marshal(sub.Data)
	var out projectstamp.StampOutput
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	var copied int
	if err := f.sp.P.QueryRow(ctx, `
		SELECT count(*) FROM card c JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'page'
		WHERE c.parent_card_id = $1`, out.NewProjectID).Scan(&copied); err != nil {
		t.Fatal(err)
	}
	if before {
		t.Fatal("the off-area page was visible before the stamp; the test proves nothing")
	}
	if copied != 0 {
		t.Errorf("%d pages from the switched-off area were copied into the new project", copied)
	}
}
