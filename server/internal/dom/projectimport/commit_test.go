package projectimport_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/projectimport"
)

// doWizard drives upload → set_mapping → preview for a given CSV
// and returns the resulting job id so the test can run commit.
func doWizard(
	t *testing.T,
	handler http.Handler,
	srv *api.Server,
	projectID int64,
	csv string,
	mapping map[string]string,
	res projectimport.ResolutionConfig,
) int64 {
	t.Helper()
	fid := uploadCSV(t, handler, srv, []byte(csv))
	sr := dispatch(t, srv, "u", "project.import", "upload",
		fmt.Sprintf(`{"project_id":"%d","file_id":"%d"}`, projectID, fid))
	if !sr.OK {
		t.Fatalf("upload: %+v", sr.Error)
	}
	var up projectimport.UploadOutput
	b, _ := json.Marshal(sr.Data)
	_ = json.Unmarshal(b, &up)

	mb, _ := json.Marshal(mapping)
	sr = dispatch(t, srv, "m", "project.import", "set_mapping",
		fmt.Sprintf(`{"job_id":"%d","mapping":%s}`, up.JobID, mb))
	if !sr.OK {
		t.Fatalf("set_mapping: %+v", sr.Error)
	}

	rb, _ := json.Marshal(res)
	sr = dispatch(t, srv, "p", "project.import", "preview",
		fmt.Sprintf(`{"job_id":"%d","resolution":%s}`, up.JobID, rb))
	if !sr.OK {
		t.Fatalf("preview: %+v", sr.Error)
	}
	return up.JobID
}

// TestCommit_CleanRowsetCommits: a happy-path CSV (every ref already
// exists in the target project) commits, advances the job to
// 'completed', and creates the right number of cards.
func TestCommit_CleanRowsetCommits(t *testing.T) {
	handler, srv, sp := setup(t)
	pid := makeProject(t, srv, "Commit Demo")

	// Seed an existing milestone + component + tag so match_existing
	// passes without auto-creating anything.
	for _, ins := range []struct{ kind, title, extra string }{
		{"milestone", "M1", ""},
		{"component", "FE", ""},
		{"tag", "priority/high", `,"attributes":{"path":"priority/high"}`},
	} {
		body := fmt.Sprintf(`{"card_type_name":%q,"parent_card_id":"%d","title":%q%s}`,
			ins.kind, pid, ins.title, ins.extra)
		sr := dispatch(t, srv, "s", "card", "insert", body)
		if !sr.OK {
			t.Fatalf("seed %s: %+v", ins.kind, sr.Error)
		}
	}

	csv := "title,milestone,component,tags,description,sort_order\n" +
		"Task 1,M1,FE,priority/high,Hello,100\n" +
		"Task 2,M1,FE,priority/high,World,200\n"

	res := projectimport.ResolutionConfig{
		Persons:    "match_existing",
		Milestones: "match_existing",
		Components: "match_existing",
		Tags:       "match_existing",
	}
	mapping := map[string]string{
		"title":     "title",
		"milestone": "milestone", "component": "component", "tags": "tags",
		"description": "description", "sort_order": "sort_order",
	}
	jobID := doWizard(t, handler, srv, pid, csv, mapping, res)

	sr := dispatch(t, srv, "c", "project.import", "commit",
		fmt.Sprintf(`{"job_id":"%d"}`, jobID))
	if !sr.OK {
		t.Fatalf("commit: %+v", sr.Error)
	}
	var out projectimport.CommitOutput
	b, _ := json.Marshal(sr.Data)
	_ = json.Unmarshal(b, &out)
	if out.Status != "completed" {
		t.Errorf("status = %q, want completed", out.Status)
	}
	if out.Created.Tasks != 2 {
		t.Errorf("created.tasks = %d, want 2", out.Created.Tasks)
	}

	// Job row should be 'completed' with completed_at set.
	var status string
	var completed *string
	if err := sp.P.QueryRow(context.Background(),
		`SELECT status, completed_at::text FROM import_job WHERE id = $1`, jobID,
	).Scan(&status, &completed); err != nil {
		t.Fatalf("read job: %v", err)
	}
	if status != "completed" || completed == nil || *completed == "" {
		t.Errorf("job: status=%q completed_at=%v", status, completed)
	}

	// Verify the tasks landed under the project with the expected
	// titles, and each carries the milestone/component/tag refs.
	sr = dispatch(t, srv, "g", "card", "select_with_attributes",
		fmt.Sprintf(`{"parent_card_id":"%d","card_type_name":"task"}`, pid))
	if !sr.OK {
		t.Fatalf("select tasks: %+v", sr.Error)
	}
	var gOut card.SelectWithAttributesOutput
	b, _ = json.Marshal(sr.Data)
	_ = json.Unmarshal(b, &gOut)
	if len(gOut.Rows) != 2 {
		t.Fatalf("rows: got %d, want 2", len(gOut.Rows))
	}
	for _, row := range gOut.Rows {
		if string(row.Attributes["milestone_ref"]) == "" {
			t.Errorf("milestone_ref missing on task %d", row.ID)
		}
	}
}

// TestCommit_AutoCreatesPersons exercises the auto-create path for
// persons + milestones + tags. The CSV references three rows where
// the assignee email and milestone are brand-new; the commit should
// create them and link the tasks to the new ids.
func TestCommit_AutoCreatesPersons(t *testing.T) {
	handler, srv, sp := setup(t)
	pid := makeProject(t, srv, "Auto-create")

	csv := strings.Join([]string{
		"title,milestone,tags,assignee_email,assignee_name",
		"T1,Sprint A,quick/win,fresh1@example.invalid,Fresh One",
		"T2,Sprint A,quick/win,fresh1@example.invalid,Fresh One",
		"T3,Sprint B,,fresh2@example.invalid,Fresh Two",
	}, "\n") + "\n"

	res := projectimport.ResolutionConfig{
		Persons:    "auto_create",
		Milestones: "auto_create",
		Components: "match_existing",
		Tags:       "auto_create",
	}
	mapping := map[string]string{
		"title":          "title",
		"milestone":      "milestone",
		"tags":           "tags",
		"assignee_email": "assignee_email",
		"assignee_name":  "assignee_name",
	}
	jobID := doWizard(t, handler, srv, pid, csv, mapping, res)
	sr := dispatch(t, srv, "c", "project.import", "commit",
		fmt.Sprintf(`{"job_id":"%d"}`, jobID))
	if !sr.OK {
		t.Fatalf("commit: %+v", sr.Error)
	}
	var out projectimport.CommitOutput
	b, _ := json.Marshal(sr.Data)
	_ = json.Unmarshal(b, &out)

	// Counts: 3 tasks, 2 persons (dedup), 2 milestones, 1 tag.
	if out.Created.Tasks != 3 {
		t.Errorf("tasks = %d, want 3", out.Created.Tasks)
	}
	if out.Created.Persons != 2 {
		t.Errorf("persons = %d, want 2", out.Created.Persons)
	}
	if out.Created.Milestones != 2 {
		t.Errorf("milestones = %d, want 2", out.Created.Milestones)
	}
	if out.Created.Tags != 1 {
		t.Errorf("tags = %d, want 1", out.Created.Tags)
	}

	// Verify the persons actually landed and carry the email we asked
	// for (auto-created persons have no user_account link).
	var n int
	if err := sp.P.QueryRow(context.Background(), `
		SELECT count(*) FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'person'
		JOIN attribute_value av ON av.card_id = c.id
		JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'email'
		WHERE av.value #>> '{}' IN ('fresh1@example.invalid', 'fresh2@example.invalid')
	`).Scan(&n); err != nil {
		t.Fatalf("count persons: %v", err)
	}
	if n != 2 {
		t.Errorf("auto-created persons: got %d rows, want 2", n)
	}
}

// TestCommit_BadRowRollsBack: a CSV with a milestone that doesn't exist
// (mode=match_existing) aborts the whole tx. No tasks should be visible
// in the target project after the failure.
func TestCommit_BadRowRollsBack(t *testing.T) {
	handler, srv, sp := setup(t)
	pid := makeProject(t, srv, "Rollback Demo")

	csv := "title,milestone\nOK,M1\nBAD,nonexistent_milestone\n"
	res := projectimport.ResolutionConfig{Milestones: "match_existing"}
	mapping := map[string]string{"title": "title", "milestone": "milestone"}
	// Seed only M1 so the second row's milestone fails match_existing.
	if r := dispatch(t, srv, "ms", "card", "insert",
		fmt.Sprintf(`{"card_type_name":"milestone","parent_card_id":"%d","title":"M1"}`, pid),
	); !r.OK {
		t.Fatalf("seed milestone: %+v", r.Error)
	}
	jobID := doWizard(t, handler, srv, pid, csv, mapping, res)

	sr := dispatch(t, srv, "c", "project.import", "commit",
		fmt.Sprintf(`{"job_id":"%d"}`, jobID))
	if sr.OK {
		t.Fatalf("expected commit to fail; got %+v", sr.Data)
	}
	if sr.Error == nil || sr.Error.Code != "import_validation" {
		t.Errorf("error code: %+v", sr.Error)
	}

	// Confirm no tasks landed under the project.
	var n int
	if err := sp.P.QueryRow(context.Background(), `
		SELECT count(*) FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'task'
		WHERE c.parent_card_id = $1
	`, pid).Scan(&n); err != nil {
		t.Fatalf("count tasks: %v", err)
	}
	if n != 0 {
		t.Errorf("expected 0 tasks after rollback; got %d", n)
	}

	// Job row should still be 'previewed' (the failure tx rolled back).
	var status string
	if err := sp.P.QueryRow(context.Background(),
		`SELECT status FROM import_job WHERE id = $1`, jobID).Scan(&status); err != nil {
		t.Fatalf("read job: %v", err)
	}
	if status != "previewed" {
		t.Errorf("job status = %q, want previewed (no advance on failure)", status)
	}
}

// TestCommit_RerunRejected: committing a job a second time errors
// with code 'already_committed' so the wizard can route the user to
// "re-upload" instead of duplicating data.
func TestCommit_RerunRejected(t *testing.T) {
	handler, srv, _ := setup(t)
	pid := makeProject(t, srv, "Rerun Demo")

	csv := "title\nOne row\n"
	res := projectimport.ResolutionConfig{}
	mapping := map[string]string{"title": "title"}
	jobID := doWizard(t, handler, srv, pid, csv, mapping, res)

	sr := dispatch(t, srv, "c", "project.import", "commit",
		fmt.Sprintf(`{"job_id":"%d"}`, jobID))
	if !sr.OK {
		t.Fatalf("first commit: %+v", sr.Error)
	}

	sr = dispatch(t, srv, "c2", "project.import", "commit",
		fmt.Sprintf(`{"job_id":"%d"}`, jobID))
	if sr.OK {
		t.Fatalf("expected already_committed; got OK")
	}
	if sr.Error == nil || sr.Error.Code != "already_committed" {
		t.Errorf("error code: %+v", sr.Error)
	}
}

// TestCommit_SkipResolutionDropsRows: a row with an unknown
// component + skip mode drops the row but doesn't fail the commit.
func TestCommit_SkipResolutionDropsRows(t *testing.T) {
	handler, srv, _ := setup(t)
	pid := makeProject(t, srv, "Skip Demo")

	csv := strings.Join([]string{
		"title,component",
		"Keep,",                  // no component cell -> kept
		"Drop,Frontend",          // unknown component -> skipped
		"Keep2,",
	}, "\n") + "\n"
	res := projectimport.ResolutionConfig{Components: "skip"}
	mapping := map[string]string{"title": "title", "component": "component"}
	jobID := doWizard(t, handler, srv, pid, csv, mapping, res)

	sr := dispatch(t, srv, "c", "project.import", "commit",
		fmt.Sprintf(`{"job_id":"%d"}`, jobID))
	if !sr.OK {
		t.Fatalf("commit: %+v", sr.Error)
	}
	var out projectimport.CommitOutput
	b, _ := json.Marshal(sr.Data)
	_ = json.Unmarshal(b, &out)
	if out.Created.Tasks != 2 {
		t.Errorf("tasks = %d, want 2 (one row skipped)", out.Created.Tasks)
	}
	if out.SkippedRows != 1 {
		t.Errorf("skipped = %d, want 1", out.SkippedRows)
	}
}
