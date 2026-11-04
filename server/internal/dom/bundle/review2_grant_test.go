package bundle_test

// Regression test for review 2026-11-03 round 2 #14: project.compose needs
// a workspace-wide grant to create projects, as card.insert {project} does.

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
)

func TestComposeNeedsAWorkspaceGrant(t *testing.T) {
	f := setup(t, "kitp_test_r2_compose_grant")
	ctx := context.Background()
	sr := call(f, "card", "insert", `{"card_type_name":"project","title":"Only this one"}`)
	if !sr.OK {
		t.Fatalf("project: %+v", sr.Error)
	}
	b, _ := json.Marshal(sr.Data)
	var out struct {
		ID json.Number `json:"id"`
	}
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	var uid int64
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ('Scoped') RETURNING id`).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sp.P.Exec(ctx, `INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT $1, id, $2::text::bigint FROM role WHERE name = 'worker'`, uid, out.ID.String()); err != nil {
		t.Fatal(err)
	}
	scoped := auth.WithUser(ctx, &auth.UserCtx{ID: uid, DisplayName: "Scoped"})
	resp := f.srv.Dispatch(scoped, api.BatchRequest{Subrequests: []api.SubRequest{{
		ID: "c", Endpoint: "project", Action: "compose", Data: json.RawMessage(`{"name":"via compose","preset":"content"}`),
	}}})
	if r := resp.Subresponses[0]; r.OK || r.Error.Code != "forbidden" {
		t.Errorf("project.compose by a project-scoped worker: %+v, want forbidden", r)
	}
	if r := call(f, "project", "compose", `{"name":"by the system","preset":"content"}`); !r.OK {
		t.Errorf("project.compose by a workspace admin: %+v", r.Error)
	}
}
