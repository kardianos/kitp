package portal_test

import (
	"context"
	"fmt"
	"net/http"
	"testing"
)

// TestDeletedFilesAndProjectsLeaveTheSite (review 2026-11-03 #17): a
// deleted attachment stops being served at once, and deleting a project
// takes its pages off the public site, even through a rebuild.
func TestDeletedFilesAndProjectsLeaveTheSite(t *testing.T) {
	f := setup(t, "kitp_test_portal_deleted")
	ctx := context.Background()
	data := []byte("secret-bytes-of-a-file")
	addr, err := f.storage.Put(ctx, "text/plain", data)
	if err != nil {
		t.Fatal(err)
	}
	var fileID, attID int64
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO file (filename, size_bytes, mime_type, created_by) VALUES ('secret.txt', $1, 'text/plain', 1) RETURNING id`, len(data)).Scan(&fileID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sp.P.Exec(ctx, `INSERT INTO file_chunk (file_id, seq, cas_address, chunk_size) VALUES ($1, 0, $2, $3)`, fileID, addr, len(data)); err != nil {
		t.Fatal(err)
	}
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO attachment (card_id, file_id) VALUES ($1, $2) RETURNING id`, f.guide, fileID).Scan(&attID); err != nil {
		t.Fatal(err)
	}
	setAttr(t, f, f.guide, "description", fmt.Sprintf("See [the file](attachment:%d).", attID))
	_, pub := publicSite(t, f)
	path := fmt.Sprintf("/_files/%d/secret.txt", attID)
	if code, _, _ := get(t, pub, "docs.example.test", path); code != http.StatusOK {
		t.Fatalf("before delete: %d, want 200", code)
	}
	var ok bool
	var c string
	if err := f.sp.P.QueryRow(ctx, `SELECT ok, code FROM attachment_delete_batch(1, jsonb_build_array(jsonb_build_object('id', $1::bigint::text)))`, attID).Scan(&ok, &c); err != nil || !ok {
		t.Fatalf("attachment.delete: ok=%v code=%q err=%v", ok, c, err)
	}
	if code, _, _ := get(t, pub, "docs.example.test", path); code == http.StatusOK {
		t.Error("a deleted attachment is still served")
	}
	var dirty int
	if err := f.sp.P.QueryRow(ctx, `SELECT count(*) FROM portal_state WHERE dirty_since IS NOT NULL`).Scan(&dirty); err != nil {
		t.Fatal(err)
	}
	if dirty == 0 {
		t.Error("deleting a published page's attachment didn't mark its portal for a rebuild")
	}

	if code, _, _ := get(t, pub, "docs.example.test", "/getting-started/"); code != http.StatusOK {
		t.Fatalf("GET /getting-started/ before the project was deleted: %d, want 200", code)
	}
	if err := f.sp.P.QueryRow(ctx, `SELECT ok, code FROM card_delete_batch(1, jsonb_build_array(jsonb_build_object('card_id', $1::bigint::text)))`, f.project).Scan(&ok, &c); err != nil || !ok {
		t.Fatalf("card.delete project: ok=%v code=%q err=%v", ok, c, err)
	}
	for _, p := range []string{"/getting-started/"} {
		if code, _, _ := get(t, pub, "docs.example.test", p); code == http.StatusOK {
			t.Errorf("GET %s after the project was deleted: 200", p)
		}
	}
	if _, err := f.sp.P.Exec(ctx, `UPDATE portal_state SET dirty_since = clock_timestamp()`); err != nil {
		t.Fatal(err)
	}
	build(t, f)
	if code, _, _ := get(t, pub, "docs.example.test", "/getting-started/"); code == http.StatusOK {
		t.Error("a rebuild put the deleted project's page back")
	}
}
