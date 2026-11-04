package portal_test

// Regression test for review 2026-11-03 round 2 #19: a deleted project's
// pages leave the sites, and come back when it is restored.

import (
	"context"
	"net/http"
	"testing"
)

func TestRestoredProjectsPagesComeBack(t *testing.T) {
	f := setup(t, "kitp_test_r2_portal_undelete")
	ctx := context.Background()
	_, pub := publicSite(t, f)
	run := func(fn string) {
		t.Helper()
		var ok bool
		var code string
		if err := f.sp.P.QueryRow(ctx, `SELECT ok, code FROM `+fn+`(1, jsonb_build_array(jsonb_build_object('card_id', $1::bigint::text)))`, f.project).Scan(&ok, &code); err != nil || !ok {
			t.Fatalf("%s: ok=%v code=%q err=%v", fn, ok, code, err)
		}
	}
	run("card_delete_batch")
	build(t, f)
	if code, _, _ := get(t, pub, "docs.example.test", "/getting-started/"); code == http.StatusOK {
		t.Errorf("a page of a deleted project is still served")
	}
	run("card_undelete_batch")
	build(t, f)
	if code, _, _ := get(t, pub, "docs.example.test", "/getting-started/"); code != http.StatusOK {
		t.Errorf("after restoring the project its published page answers %d, want 200", code)
	}
}
