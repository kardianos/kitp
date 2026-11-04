package attachment_test

// A signed download link is checked again when it is fetched (review
// 2026-11-03 round 4, "Worth a look").

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSignedDownloadIsCheckedWhenFetched(t *testing.T) {
	handler, srv, sp := setup(t, "kitp_test_r5_signed_dl")
	ctx := context.Background()
	pA := makeProject(t, srv)
	tA := r3Task(t, srv, pA)
	w := r3User(t, sp, "w", "worker", pA, 0)
	att := createAttachment(t, srv, tA, "w.txt", "text/plain", []chunkResp{uploadChunk(t, handler, []byte("w's file"))})
	mint := func() string {
		t.Helper()
		dl := r3D(srv, r3Ctx(w), "attachment", "download_url", fmt.Sprintf(`{"id":"%d"}`, att.ID))
		if !dl.OK {
			t.Fatalf("download_url: %+v", dl.Error)
		}
		b, err := json.Marshal(dl.Data)
		if err != nil {
			t.Fatal(err)
		}
		var o struct {
			URL string `json:"url"`
		}
		if err := json.Unmarshal(b, &o); err != nil {
			t.Fatal(err)
		}
		return o.URL
	}
	get := func(u string) int {
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, httptest.NewRequest("GET", u, nil))
		return rr.Code
	}
	link := mint()
	if code := get(link); code != http.StatusOK {
		t.Fatalf("a fresh link: %d", code)
	}
	if _, err := sp.P.Exec(ctx, `DELETE FROM user_role WHERE user_id = $1`, w); err != nil {
		t.Fatal(err)
	}
	if code := get(link); code == http.StatusOK {
		t.Error("a link still worked after its maker lost every role")
	}
}
