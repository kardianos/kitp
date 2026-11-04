package projectimport_test

// Regression tests for the import findings of the second 2026-11-03 review.

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
)

// TestImportJobsAreTheirCreators (round 2 #9): another worker on the
// project can't re-map, preview or commit someone's import job.
func TestImportJobsAreTheirCreators(t *testing.T) {
	handler, srv, sp := setup(t)
	pid := makeProject(t, srv, "Shared")
	secret := uploadCSV(t, handler, srv, []byte("salary,name\n250000,Alice CEO\n"))
	sr := dispatch(t, srv, "u", "project.import", "upload",
		fmt.Sprintf(`{"project_id":"%d","file_id":"%d"}`, pid, secret))
	if !sr.OK {
		t.Fatalf("upload: %+v", sr.Error)
	}
	var up struct {
		JobID string `json:"job_id"`
	}
	b, _ := json.Marshal(sr.Data)
	if err := json.Unmarshal(b, &up); err != nil {
		t.Fatal(err)
	}
	bob := reviewWorker(t, sp, "bob", pid)
	for _, c := range []struct{ action, data string }{
		{"set_mapping", fmt.Sprintf(`{"job_id":"%s","mapping":{"name":"title"}}`, up.JobID)},
		{"preview", fmt.Sprintf(`{"job_id":"%s","resolution":{}}`, up.JobID)},
		{"commit", fmt.Sprintf(`{"job_id":"%s"}`, up.JobID)},
	} {
		r := dispatchAs(srv, bob, "project.import", c.action, c.data)
		if r.OK || r.Error.Code != "job_not_found" {
			t.Errorf("bob %s on someone else's job: %+v, want job_not_found", c.action, r)
		}
	}
}

// TestImportRefusesLargeFiles (round 2 #11): a file over MaxImportBytes is
// refused before it is read.
func TestImportRefusesLargeFiles(t *testing.T) {
	_, srv, sp := setup(t)
	pid := makeProject(t, srv, "Big")
	var fileID int64
	if err := sp.P.QueryRow(context.Background(), `
		INSERT INTO file (filename, mime_type, size_bytes, created_by)
		VALUES ('big.csv', 'text/csv', 17*1024*1024, 1) RETURNING id`).Scan(&fileID); err != nil {
		t.Fatal(err)
	}
	sr := dispatch(t, srv, "u", "project.import", "upload", fmt.Sprintf(`{"project_id":"%d","file_id":"%d"}`, pid, fileID))
	if sr.OK || sr.Error.Code != "file_too_large" {
		t.Errorf("upload of a 17 MB file: %+v, want file_too_large", sr)
	}
}
