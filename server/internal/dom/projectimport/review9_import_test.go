package projectimport_test

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/projectimport"
)

// TestAnImportMatchesOnlyPeopleYouMayName (review 2026-11-06 round 8): an
// import matched assignee emails against every person in the workspace, so
// a file told which addresses were someone's, and the insert's refusal which
// person id had one. An importer matches only people they may name in the
// project (person_referable); anyone else's address reads as unknown.
func TestAnImportMatchesOnlyPeopleYouMayName(t *testing.T) {
	handler, srv, sp := setup(t)
	ctx := context.Background()
	pid := makeProject(t, srv, "Ours")
	var zed int64
	if err := sp.P.QueryRow(ctx, `INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'person' RETURNING id`).Scan(&zed); err != nil {
		t.Fatal(err)
	}
	for name, v := range map[string]string{"title": "Zed", "email": "zed@secret.example"} {
		if _, err := sp.P.Exec(ctx, `INSERT INTO attribute_value (card_id, attribute_def_id, value) SELECT $1, id, to_jsonb($2::text) FROM attribute_def WHERE name = $3`, zed, v, name); err != nil {
			t.Fatal(err)
		}
	}
	jobID := doWizard(t, handler, srv, pid, "title,assignee_email\nT1,zed@secret.example\n",
		map[string]string{"title": "title", "assignee_email": "assignee_email"},
		projectimport.ResolutionConfig{Persons: "leave_blank"})
	w := reviewWorker(t, sp, "importer", pid)
	if _, err := sp.P.Exec(ctx, `
		WITH j AS (UPDATE import_job SET created_by = $2 WHERE id = $1 RETURNING file_id)
		UPDATE file SET created_by = $2 WHERE id = (SELECT file_id FROM j)`, jobID, auth.ActorOrSystem(w)); err != nil {
		t.Fatal(err)
	}
	r := dispatchAs(srv, w, "project.import", "commit", fmt.Sprintf(`{"job_id":"%d"}`, jobID))
	if !r.OK {
		t.Fatalf("commit: %+v", r.Error)
	}
	if r.Error != nil && strings.Contains(r.Error.Message, fmt.Sprint(zed)) {
		t.Errorf("the import names Zed's id: %+v", r.Error)
	}
	var assigned int
	if err := sp.P.QueryRow(ctx, `
		SELECT count(*) FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'assignee'
		JOIN card c ON c.id = av.card_id AND c.parent_card_id = $1
		WHERE av.value = to_jsonb($2::bigint)`, pid, zed).Scan(&assigned); err != nil {
		t.Fatal(err)
	}
	if assigned != 0 {
		t.Errorf("the worker's import assigned Zed, whom they can't name, to %d tasks", assigned)
	}
}

// TestAnImportRefusesALongTitle (round 8 #7): card.insert's 500-character
// cap, as a row error rather than a failed insert.
func TestAnImportRefusesALongTitle(t *testing.T) {
	handler, srv, _ := setup(t)
	pid := makeProject(t, srv, "Long")
	jobID := doWizard(t, handler, srv, pid, "title\n"+strings.Repeat("x", 501)+"\n",
		map[string]string{"title": "title"}, projectimport.ResolutionConfig{})
	r := dispatchAs(srv, auth.WithSystemUser(context.Background()), "project.import", "commit", fmt.Sprintf(`{"job_id":"%d"}`, jobID))
	if r.OK || r.Error == nil || !strings.Contains(r.Error.Message, "at most 500 characters") {
		t.Errorf("commit of a 501-character title: ok=%v err=%+v", r.OK, r.Error)
	}
}
