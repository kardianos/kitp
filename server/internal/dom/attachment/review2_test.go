package attachment_test

// Regression tests for the upload findings of the second 2026-11-03 review.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
)

// TestUploadLinkWorksOnce (round 2 #21): a signed upload link uploads one
// file; using it again is 410 Gone.
func TestUploadLinkWorksOnce(t *testing.T) {
	handler, srv, sp := setup(t, "kitp_test_r2_upload_once")
	pid := makeProject(t, srv)
	link := mintUploadURL(t, srv, pid, "a.txt", "text/plain")
	var codes []int
	for range 2 {
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, httptest.NewRequest("PUT", link, bytes.NewReader([]byte("replayed body"))))
		codes = append(codes, rr.Code)
	}
	if codes[0] != http.StatusCreated || codes[1] != http.StatusGone {
		t.Errorf("two PUTs to one link: %v, want 201 then 410", codes)
	}
	var n int
	if err := sp.P.QueryRow(context.Background(), `SELECT count(*) FROM attachment WHERE card_id = $1`, pid).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("attachments = %d, want 1", n)
	}
}

// TestBytesAreNotClaimedByHash (round 2 #21): a worker who only knows the
// hash of stored bytes can't make a file of them (cas.missing_chunks's side
// is tested in dom/cas).
func TestBytesAreNotClaimedByHash(t *testing.T) {
	handler, srv, sp := setup(t, "kitp_test_r2_cas_claim")
	pA := makeProject(t, srv)
	pB := makeProject(t, srv)
	secret := []byte("PIN: 4711\n")
	c := uploadChunk(t, handler, secret)
	createAttachment(t, srv, pB, "pin.txt", "text/plain", []chunkResp{c})
	ctx := context.Background()
	var w int64
	if err := sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ('w') RETURNING id`).Scan(&w); err != nil {
		t.Fatal(err)
	}
	if _, err := sp.P.Exec(ctx, `INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT $1, id, $2 FROM role WHERE name = 'worker'`, w, pA); err != nil {
		t.Fatal(err)
	}
	wctx := auth.WithUser(ctx, &auth.UserCtx{ID: w, DisplayName: "w"})
	d := func(ep, act, data string) api.SubResponse {
		return srv.Dispatch(wctx, api.BatchRequest{Subrequests: []api.SubRequest{{ID: "x", Endpoint: ep, Action: act, Data: json.RawMessage(data)}}}).Subresponses[0]
	}
	sum := sha256.Sum256(secret)
	addr := hex.EncodeToString(sum[:])
	if r := d("file", "create", fmt.Sprintf(`{"filename":"x.txt","mime_type":"text/plain","chunks":[{"address":%q,"size_bytes":%d}]}`, addr, len(secret))); r.OK {
		t.Error("file.create took bytes the caller never sent")
	}
}
