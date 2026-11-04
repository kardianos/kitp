package attachment_test

// Regression tests for the file findings of the third 2026-11-03 review.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/cas"
	domcas "github.com/kitp/kitp/server/internal/dom/cas"
	"github.com/kitp/kitp/server/internal/store"
)

func r3User(t *testing.T, sp *store.Pool, name, role string, project int64, parent int64) int64 {
	t.Helper()
	ctx := context.Background()
	var id int64
	var err error
	if parent != 0 {
		err = sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name, is_agent, parent_user_id) VALUES ($1, true, $2) RETURNING id`, name, parent).Scan(&id)
	} else {
		err = sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ($1) RETURNING id`, name).Scan(&id)
	}
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sp.P.Exec(ctx, `INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT $1, id, $2 FROM role WHERE name = $3`, id, project, role); err != nil {
		t.Fatal(err)
	}
	return id
}

func r3Ctx(id int64) context.Context {
	return auth.WithUser(context.Background(), &auth.UserCtx{ID: id, DisplayName: fmt.Sprint(id)})
}

func r3D(srv *api.Server, ctx context.Context, ep, act, data string) api.SubResponse {
	return srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{{ID: "x", Endpoint: ep, Action: act, Data: json.RawMessage(data)}}}).Subresponses[0]
}

// chunk upload as a given user, through its own router.
func r3Chunk(t *testing.T, sp *store.Pool, storage *cas.Storage, uid int64, body []byte) string {
	t.Helper()
	rt := api.NewTestRouter(&auth.UserCtx{ID: uid})
	cas.Mount(rt, cas.HTTPConfig{Pool: sp, Storage: storage, MaxBytes: 4 << 20})
	req := httptest.NewRequest("POST", "/api/v1/cas/chunk", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/octet-stream")
	rr := httptest.NewRecorder()
	rt.Mux().ServeHTTP(rr, req)
	if rr.Code != 200 {
		t.Fatalf("chunk as %d: %d %s", uid, rr.Code, rr.Body.String())
	}
	var c chunkResp
	if err := json.Unmarshal(rr.Body.Bytes(), &c); err != nil {
		t.Fatal(err)
	}
	return c.Address
}

func r3Task(t *testing.T, srv *api.Server, pid int64) int64 {
	t.Helper()
	sr := r3D(srv, auth.WithSystemUser(context.Background()), "card", "insert", fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"T"}`, pid))
	if !sr.OK {
		t.Fatalf("task: %+v", sr.Error)
	}
	b, _ := json.Marshal(sr.Data)
	var o struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(b, &o); err != nil {
		t.Fatal(err)
	}
	var id int64
	if _, err := fmt.Sscan(o.ID, &id); err != nil {
		t.Fatal(err)
	}
	return id
}

// TestFilesRound3 covers the third 2026-11-03 review's file findings:
// file.create answers alike for bytes stored for someone else and bytes
// kitp never had (#18); an agent and its owner are one account for files
// (#20); two upload links in one batch are two links (#19); and a common
// file's bytes cost nothing per file that shares them (#7).
func TestFilesRound3(t *testing.T) {
	handler, srv, sp := setup(t, "kitp_test_r3_files")
	storage := cas.New(cas.NewPgBackend(sp.P))
	domcas.Register(sp)
	pA := makeProject(t, srv)
	pB := makeProject(t, srv)
	tA := r3Task(t, srv, pA)
	tB := r3Task(t, srv, pB)

	// #18: a worker who sent nothing names stored bytes and absent bytes.
	w2 := r3User(t, sp, "w2", "worker", pA, 0)
	w2ctx := r3Ctx(w2)
	secret := []byte("PIN: 4711\n")
	cs := uploadChunk(t, handler, secret)
	createAttachment(t, srv, tB, "pin.txt", "text/plain", []chunkResp{cs})
	sumNo := sha256.Sum256([]byte("PIN: 4712\n"))
	absent := hex.EncodeToString(sumNo[:])
	rStored := r3D(srv, w2ctx, "file", "create", fmt.Sprintf(`{"filename":"x.txt","chunks":[{"address":%q,"size_bytes":1}]}`, cs.Address))
	rAbsent := r3D(srv, w2ctx, "file", "create", fmt.Sprintf(`{"filename":"x.txt","chunks":[{"address":%q,"size_bytes":1}]}`, absent))
	if rStored.OK || rAbsent.OK {
		t.Fatalf("file.create of bytes not sent: stored ok=%v, absent ok=%v", rStored.OK, rAbsent.OK)
	}
	strip := func(m, addr string) string { return strings.ReplaceAll(m, addr, "<addr>") }
	if rStored.Error.Code != rAbsent.Error.Code || strip(rStored.Error.Message, cs.Address) != strip(rAbsent.Error.Message, absent) {
		t.Errorf("file.create tells stored bytes (%s %q) from absent ones (%s %q)",
			rStored.Error.Code, rStored.Error.Message, rAbsent.Error.Code, rAbsent.Error.Message)
	}

	// #20: an agent attaches its owner's file and makes a file of its bytes.
	o := r3User(t, sp, "owner", "worker", pA, 0)
	g := r3User(t, sp, "agent", "worker", pA, o)
	ob := []byte("owner's notes")
	oaddr := r3Chunk(t, sp, storage, o, ob)
	ofc := r3D(srv, r3Ctx(o), "file", "create", fmt.Sprintf(`{"filename":"notes.txt","chunks":[{"address":%q,"size_bytes":%d}]}`, oaddr, len(ob)))
	if !ofc.OK {
		t.Fatalf("owner file.create: %+v", ofc.Error)
	}
	b, _ := json.Marshal(ofc.Data)
	var of struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(b, &of); err != nil {
		t.Fatal(err)
	}
	if ga := r3D(srv, r3Ctx(g), "attachment", "create", fmt.Sprintf(`{"card_id":"%d","file_id":%q}`, tA, of.ID)); !ga.OK {
		t.Errorf("an agent couldn't attach its owner's file: %+v", ga.Error)
	}
	if gf := r3D(srv, r3Ctx(g), "file", "create", fmt.Sprintf(`{"filename":"notes.txt","chunks":[{"address":%q,"size_bytes":%d}]}`, oaddr, len(ob))); !gf.OK {
		t.Errorf("an agent couldn't make a file of its owner's bytes: %+v", gf.Error)
	}

	// #19: two identical upload_url requests in one batch.
	data, _ := json.Marshal(map[string]string{"card_id": fmt.Sprint(tA), "filename": "photo.jpg", "mime_type": "image/jpeg"})
	resp := srv.Dispatch(auth.WithSystemUser(context.Background()), api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "a", Endpoint: "attachment", Action: "upload_url", Data: data},
		{ID: "b", Endpoint: "attachment", Action: "upload_url", Data: data},
	}})
	var urls []string
	for _, s := range resp.Subresponses {
		b, _ := json.Marshal(s.Data)
		var u struct {
			URL string `json:"url"`
		}
		if err := json.Unmarshal(b, &u); err != nil {
			t.Fatal(err)
		}
		urls = append(urls, u.URL)
	}
	if len(urls) != 2 || urls[0] == urls[1] {
		t.Fatalf("two upload links in one batch: %v", urls)
	}
	for i, u := range urls {
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, httptest.NewRequest("PUT", u, bytes.NewReader([]byte(fmt.Sprintf("file %d", i)))))
		if rr.Code != http.StatusCreated && rr.Code != http.StatusOK {
			t.Errorf("upload %d: %d %s", i, rr.Code, rr.Body.String())
		}
	}

	// #7: bytes in thousands of files, asked about by someone who holds
	// none of them, answer at once.
	logo := uploadChunk(t, handler, []byte("a signature logo"))
	if _, err := sp.P.Exec(context.Background(), `
		WITH f AS (
			INSERT INTO file (filename, mime_type, size_bytes, sha256, created_by)
			SELECT 'logo.png', 'image/png', 16, $1, 1 FROM generate_series(1, 3000)
			RETURNING id)
		INSERT INTO file_chunk (file_id, seq, cas_address, chunk_size) SELECT id, 0, $1, 16 FROM f`, logo.Address); err != nil {
		t.Fatalf("3000 files sharing bytes: %v", err)
	}
	start := time.Now()
	mc := r3D(srv, w2ctx, "cas", "missing_chunks", fmt.Sprintf(`{"addresses":[%q,%q]}`, logo.Address, logo.Address))
	if !mc.OK {
		t.Fatalf("missing_chunks: %+v", mc.Error)
	}
	if el := time.Since(start); el > 2*time.Second {
		t.Errorf("missing_chunks over bytes in 3000 files took %v", el)
	}
	if got := fmt.Sprint(mc.Data); !strings.Contains(got, logo.Address) {
		t.Errorf("missing_chunks = %v, want the address reported missing", got)
	}
}
