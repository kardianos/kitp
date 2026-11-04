package projectstamp_test

// Regression test for review 2026-11-03 round 2 #14: making a project with
// project.stamp needs a workspace-wide grant to create projects, as
// card.insert {project} does; a role scoped to one project isn't one.

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
)

func TestStampNeedsAWorkspaceGrant(t *testing.T) {
	f := setup(t, "kitp_test_r2_stamp_grant")
	f.seedTemplate(t)
	ctx := context.Background()
	var uid int64
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ('Scoped') RETURNING id`).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sp.P.Exec(ctx, `INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT $1, id, $2 FROM role WHERE name = 'worker'`, uid, f.templateID); err != nil {
		t.Fatal(err)
	}
	scoped := auth.WithUser(ctx, &auth.UserCtx{ID: uid, DisplayName: "Scoped"})
	body := json.RawMessage(fmt.Sprintf(`{"template_project_id":"%d","name":"by a scoped worker"}`, f.templateID))
	resp := f.srv.Dispatch(scoped, api.BatchRequest{Subrequests: []api.SubRequest{{
		ID: "s", Endpoint: "project", Action: "stamp", Data: body,
	}}})
	if sr := resp.Subresponses[0]; sr.OK || sr.Error.Code != "forbidden" {
		t.Errorf("project.stamp by a project-scoped worker: %+v, want forbidden", sr)
	}
	// A workspace admin still stamps.
	stamp(t, f, f.templateID, "by the admin")
}
