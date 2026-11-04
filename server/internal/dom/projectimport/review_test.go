package projectimport_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/projectimport"
	"github.com/kitp/kitp/server/internal/store"
)

func reviewWorker(t *testing.T, sp *store.Pool, name string, project int64) context.Context {
	t.Helper()
	ctx := context.Background()
	var uid int64
	if err := sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ($1) RETURNING id`, name).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	if _, err := sp.P.Exec(ctx, `INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT $1, id, $2 FROM role WHERE name = 'worker'`, uid, project); err != nil {
		t.Fatal(err)
	}
	return auth.WithUser(ctx, &auth.UserCtx{ID: uid, DisplayName: name})
}

func dispatchAs(srv *api.Server, ctx context.Context, endpoint, action, data string) api.SubResponse {
	return srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "x", Endpoint: endpoint, Action: action, Data: json.RawMessage(data)},
	}}).Subresponses[0]
}

// TestUploadReadsOnlyYourFiles (review 2026-11-03 #5): a worker can't read a
// stored file they neither uploaded nor can see attached somewhere, by
// naming it in an import.
func TestUploadReadsOnlyYourFiles(t *testing.T) {
	handler, srv, sp := setup(t)
	pid := makeProject(t, srv, "Mine")
	secret := uploadCSV(t, handler, srv, []byte("salary,name\n250000,Alice CEO\n")) // System's file
	w := reviewWorker(t, sp, "nosy", pid)
	r := dispatchAs(srv, w, "project.import", "upload", fmt.Sprintf(`{"project_id":"%d","file_id":"%d"}`, pid, secret))
	if r.OK {
		b, _ := json.Marshal(r.Data)
		t.Fatalf("a worker read someone else's file through an import: %s", b)
	}
	if r.Error == nil || strings.Contains(r.Error.Message, "Alice") {
		t.Errorf("error = %+v", r.Error)
	}
}

// TestCommitCreatesOnlyWhatYouMay (review 2026-11-03 #26): an import a
// worker commits can't create milestones or tags, which only managers add.
func TestCommitCreatesOnlyWhatYouMay(t *testing.T) {
	handler, srv, sp := setup(t)
	pid := makeProject(t, srv, "Values")
	csv := "title,milestone\nT1,Sprint Z\n"
	jobID := doWizard(t, handler, srv, pid, csv, map[string]string{"title": "title", "milestone": "milestone"},
		projectimport.ResolutionConfig{Milestones: "auto_create"})
	w := reviewWorker(t, sp, "importer", pid)
	// The job (and its file) are the worker's own: a job is its creator's
	// (round 2 #9).
	if _, err := sp.P.Exec(context.Background(), `
		WITH j AS (UPDATE import_job SET created_by = $2 WHERE id = $1 RETURNING file_id)
		UPDATE file SET created_by = $2 WHERE id = (SELECT file_id FROM j)`, jobID, auth.ActorOrSystem(w)); err != nil {
		t.Fatal(err)
	}
	r := dispatchAs(srv, w, "project.import", "commit", fmt.Sprintf(`{"job_id":"%d"}`, jobID))
	if r.OK || r.Error == nil || r.Error.Code != "forbidden" {
		t.Fatalf("a worker's import created a milestone: ok=%v err=%+v", r.OK, r.Error)
	}
	var n int
	if err := sp.P.QueryRow(context.Background(), `
		SELECT count(*) FROM card c JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'milestone'
		WHERE c.parent_card_id = $1`, pid).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("milestones in the project = %d, want 0", n)
	}
}
