package attachment_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/cas"
	"github.com/kitp/kitp/server/internal/dom/activity"
	"github.com/kitp/kitp/server/internal/dom/attachment"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/dom/file"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// setup returns a fresh schema with all the attachment-flow handlers
// registered + a mux carrying the chunk-upload + download HTTP routes.
// The auth middleware fronts the lot so the System User flows through
// every request.
func setup(t *testing.T, schema string) (http.Handler, *api.Server, *store.Pool) {
	t.Helper()
	reg.Reset()
	pool := store.TestPool(t, schema)
	sp := store.NewPool(pool)
	echo.Register()
	cardtype.Register()
	card.Register(sp)
	attribute.Register(sp)
	activity.Register(sp)
	attachment.Register(sp)
	file.Register(sp)

	srv := api.NewServer(sp)
	user, err := auth.NewSystemUser(context.Background(), pool, "dev", auth.ModeOff)
	if err != nil {
		t.Fatalf("system user: %v", err)
	}

	storage := cas.New(cas.NewPgBackend(pool))
	rt := api.NewTestRouter(user)
	cas.Mount(rt, cas.HTTPConfig{
		Pool:     sp,
		Storage:  storage,
		MaxBytes: 4 * 1024 * 1024, // 4 MB per chunk for tests
	})
	attachment.Mount(rt, attachment.Config{
		Pool:    sp,
		Storage: storage,
	})
	srv.MountBatch(rt)
	// Server-side thumb generation is opt-in (main wires this); tests
	// that exercise the image pipeline rely on it being present, while
	// the text-only tests don't fire the thumbnailer because canThumb
	// returns false for "text/plain".
	attachment.SetThumbDeps(storage, nil)
	t.Cleanup(func() { attachment.SetThumbDeps(nil, nil) })

	mux := http.NewServeMux()
	mux.Handle("/api/", rt.Mux())
	return mux, srv, sp
}

// uploadChunk POSTs one chunk via the multipart route and returns the
// {address, size_bytes} response.
type chunkResp struct {
	Address   string `json:"address"`
	SizeBytes int64  `json:"size_bytes"`
}

func uploadChunk(t *testing.T, handler http.Handler, body []byte) chunkResp {
	t.Helper()
	req := httptest.NewRequest("POST", "/api/v1/cas/chunk", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/octet-stream")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != 200 {
		t.Fatalf("chunk upload: %d: %s", rr.Code, rr.Body.String())
	}
	var out chunkResp
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode chunk: %v", err)
	}
	return out
}

// createFile + createAttachment via the JSON dispatcher.
func createAttachment(
	t *testing.T,
	srv *api.Server,
	cardID int64,
	filename, mime string,
	chunks []chunkResp,
) attachment.CreateOutput {
	t.Helper()
	ctx := auth.WithSystemUser(context.Background())

	var chunkPayload []map[string]any
	for _, c := range chunks {
		chunkPayload = append(chunkPayload, map[string]any{
			"address":    c.Address,
			"size_bytes": c.SizeBytes,
		})
	}
	fileReq, _ := json.Marshal(map[string]any{
		"filename":  filename,
		"mime_type": mime,
		"chunks":    chunkPayload,
	})
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "f", Endpoint: "file", Action: "create", Data: fileReq},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("file.create: %+v", resp.Subresponses[0])
	}
	var fOut file.CreateOutput
	b, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(b, &fOut)

	attReq, _ := json.Marshal(struct {
		CardID int64 `json:"card_id,string"`
		FileID int64 `json:"file_id,string"`
	}{CardID: cardID, FileID: fOut.ID})
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "a", Endpoint: "attachment", Action: "create", Data: attReq},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("attachment.create: %+v", resp.Subresponses[0])
	}
	var aOut attachment.CreateOutput
	b, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(b, &aOut)
	return aOut
}

// makeProject inserts a top-level project card and returns its id.
func makeProject(t *testing.T, srv *api.Server) int64 {
	t.Helper()
	resp := srv.Dispatch(auth.WithSystemUser(context.Background()), api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("project: %+v", resp.Subresponses[0])
	}
	var pOut card.InsertOutput
	b, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(b, &pOut)
	return pOut.ID
}

// TestChunkedUploadDownloadDelete: a single 9 KiB file sliced into three
// 3 KiB chunks goes through chunk upload → file.create → attachment.create
// → list → download → delete, with byte-perfect round-trip.
func TestChunkedUploadDownloadDelete(t *testing.T) {
	handler, srv, _ := setup(t, "kitp_test_attachment_chunked")
	ctx := auth.WithSystemUser(context.Background())
	pid := makeProject(t, srv)

	// Build a 9 KiB body and slice into three 3 KiB chunks.
	whole := bytes.Repeat([]byte("kitp-attachment-chunk-payload\n"), 300)
	chunkSize := len(whole) / 3
	chunks := make([]chunkResp, 0, 3)
	for off := 0; off < len(whole); off += chunkSize {
		end := off + chunkSize
		if end > len(whole) {
			end = len(whole)
		}
		chunks = append(chunks, uploadChunk(t, handler, whole[off:end]))
	}
	if len(chunks) != 3 {
		t.Fatalf("expected 3 chunks, got %d", len(chunks))
	}

	att := createAttachment(t, srv, pid, "payload.txt", "text/plain", chunks)
	if att.SizeBytes != int64(len(whole)) {
		t.Fatalf("attachment size = %d, want %d", att.SizeBytes, len(whole))
	}

	// List
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "l", Endpoint: "attachment", Action: "list", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d"}`, pid))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("list: %+v", resp.Subresponses[0])
	}
	var lOut attachment.ListOutput
	b, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(b, &lOut)
	if len(lOut.Rows) != 1 || lOut.Rows[0].ID != att.ID || lOut.Rows[0].SizeBytes != int64(len(whole)) {
		t.Fatalf("list rows: %+v", lOut.Rows)
	}

	// Download — the body must equal the original whole-file bytes.
	dlReq := httptest.NewRequest("GET",
		fmt.Sprintf("/api/v1/attachment/%d/download", att.ID), nil)
	dlRR := httptest.NewRecorder()
	handler.ServeHTTP(dlRR, dlReq)
	if dlRR.Code != 200 {
		t.Fatalf("download: %d: %s", dlRR.Code, dlRR.Body.String())
	}
	if !bytes.Equal(dlRR.Body.Bytes(), whole) {
		t.Fatalf("download bytes mismatch (got %d, want %d)", dlRR.Body.Len(), len(whole))
	}
	if got := dlRR.Header().Get("Content-Type"); got != "text/plain" {
		t.Fatalf("Content-Type %q, want text/plain", got)
	}

	// Soft-delete
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "d", Endpoint: "attachment", Action: "delete", Data: json.RawMessage(
			fmt.Sprintf(`{"id":"%d"}`, att.ID))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("delete: %+v", resp.Subresponses[0])
	}

	// Download after delete → 404
	dl2 := httptest.NewRequest("GET",
		fmt.Sprintf("/api/v1/attachment/%d/download", att.ID), nil)
	dl2RR := httptest.NewRecorder()
	handler.ServeHTTP(dl2RR, dl2)
	if dl2RR.Code != 404 {
		t.Fatalf("download after delete: %d, want 404", dl2RR.Code)
	}
}

// TestChunkUploadDeduplicates: uploading identical chunk bytes twice
// collapses to one cas_blob row.
func TestChunkUploadDeduplicates(t *testing.T) {
	handler, _, sp := setup(t, "kitp_test_attachment_chunk_dedupe")
	ctx := auth.WithSystemUser(context.Background())
	body := []byte("dedupe-me-chunk")
	a := uploadChunk(t, handler, body)
	b := uploadChunk(t, handler, body)
	if a.Address != b.Address {
		t.Fatalf("addresses diverged on identical bytes: %q vs %q", a.Address, b.Address)
	}
	var n int
	if err := sp.P.QueryRow(ctx,
		`SELECT count(*) FROM cas_blob WHERE address = $1`, a.Address,
	).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected 1 cas_blob row, got %d", n)
	}
}

// TestChunkOversizeRejected confirms the 413 path on the chunk route.
func TestChunkOversizeRejected(t *testing.T) {
	reg.Reset()
	pool := store.TestPool(t, "kitp_test_attachment_chunk_oversize")
	sp := store.NewPool(pool)
	echo.Register()
	cardtype.Register()
	card.Register(sp)
	attribute.Register(sp)
	activity.Register(sp)
	attachment.Register(sp)
	file.Register(sp)
	_ = api.NewServer(sp) // dispatcher registry warmed up
	user, err := auth.NewSystemUser(context.Background(), pool, "dev", auth.ModeOff)
	if err != nil {
		t.Fatalf("system user: %v", err)
	}
	storage := cas.New(cas.NewPgBackend(pool))
	rt := api.NewTestRouter(user)
	cas.Mount(rt, cas.HTTPConfig{
		Pool:     sp,
		Storage:  storage,
		MaxBytes: 64,
	})
	mux := http.NewServeMux()
	mux.Handle("/api/", rt.Mux())
	handler := http.Handler(mux)

	body := bytes.Repeat([]byte("x"), 256)
	req := httptest.NewRequest("POST", "/api/v1/cas/chunk", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/octet-stream")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusRequestEntityTooLarge {
		got, _ := io.ReadAll(rr.Body)
		t.Fatalf("expected 413, got %d: %s", rr.Code, got)
	}
}

// TestImageThumbnailGenerated uploads a small PNG, then asserts:
//   - attachment.list returns kind="image" and a non-zero thumb_file_id
//   - GET /api/v1/attachment/{id}/thumb returns 200 + a JPEG body
//   - GET /api/v1/attachment/{id}/view returns 200 + Content-Disposition: inline
//
// Together these exercise the full image pipeline: chunk upload →
// file.create → attachment.create (which triggers server-side thumb
// generation) → list → both byte-stream routes.
func TestImageThumbnailGenerated(t *testing.T) {
	handler, srv, _ := setup(t, "kitp_test_attachment_image_thumb")
	ctx := auth.WithSystemUser(context.Background())
	pid := makeProject(t, srv)

	// Build a tiny but valid PNG: an 8×8 solid block. The exact pixels
	// don't matter — we just need image.Decode to succeed.
	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	for y := 0; y < 8; y++ {
		for x := 0; x < 8; x++ {
			img.Set(x, y, color.RGBA{R: 200, G: 100, B: 50, A: 255})
		}
	}
	var pngBuf bytes.Buffer
	if err := png.Encode(&pngBuf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	pngBytes := pngBuf.Bytes()

	// Upload the whole PNG as a single chunk (well under the test cap).
	c := uploadChunk(t, handler, pngBytes)
	att := createAttachment(t, srv, pid, "pic.png", "image/png", []chunkResp{c})
	if att.Kind != "image" {
		t.Fatalf("create kind = %q, want image", att.Kind)
	}
	if att.ThumbFileID == 0 {
		t.Fatalf("create thumb_file_id = 0, want non-zero")
	}

	// list — confirms the same data flows through the read path.
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "l", Endpoint: "attachment", Action: "list", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d"}`, pid))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("list: %+v", resp.Subresponses[0])
	}
	var lOut attachment.ListOutput
	b, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(b, &lOut)
	if len(lOut.Rows) != 1 {
		t.Fatalf("list rows = %d, want 1", len(lOut.Rows))
	}
	if lOut.Rows[0].Kind != "image" || lOut.Rows[0].ThumbFileID == 0 {
		t.Fatalf("list row = %+v, want kind=image and non-zero thumb_file_id", lOut.Rows[0])
	}

	// GET /thumb — JPEG body whose bytes parse as a valid image.
	thReq := httptest.NewRequest("GET",
		fmt.Sprintf("/api/v1/attachment/%d/thumb", att.ID), nil)
	thRR := httptest.NewRecorder()
	handler.ServeHTTP(thRR, thReq)
	if thRR.Code != 200 {
		t.Fatalf("thumb route: %d: %s", thRR.Code, thRR.Body.String())
	}
	if got := thRR.Header().Get("Content-Type"); got != "image/jpeg" {
		t.Fatalf("thumb content-type = %q, want image/jpeg", got)
	}
	if disp := thRR.Header().Get("Content-Disposition"); !bytes.Contains([]byte(disp), []byte("inline")) {
		t.Fatalf("thumb content-disposition = %q, want inline", disp)
	}
	if _, _, err := image.Decode(bytes.NewReader(thRR.Body.Bytes())); err != nil {
		t.Fatalf("thumb body did not decode as image: %v", err)
	}

	// GET /view — same bytes as download, but inline disposition.
	vReq := httptest.NewRequest("GET",
		fmt.Sprintf("/api/v1/attachment/%d/view", att.ID), nil)
	vRR := httptest.NewRecorder()
	handler.ServeHTTP(vRR, vReq)
	if vRR.Code != 200 {
		t.Fatalf("view route: %d", vRR.Code)
	}
	if disp := vRR.Header().Get("Content-Disposition"); !bytes.Contains([]byte(disp), []byte("inline")) {
		t.Fatalf("view content-disposition = %q, want inline", disp)
	}
	if !bytes.Equal(vRR.Body.Bytes(), pngBytes) {
		t.Fatalf("view body diverged from upload (got %d bytes, want %d)", vRR.Body.Len(), len(pngBytes))
	}
}

// TestActivityRows confirms attachment.create + attachment.delete each
// emit a matching activity row with the filename embedded.
func TestActivityRows(t *testing.T) {
	handler, srv, sp := setup(t, "kitp_test_attachment_activity")
	ctx := auth.WithSystemUser(context.Background())
	pid := makeProject(t, srv)

	body := []byte("activity bytes")
	c := uploadChunk(t, handler, body)
	att := createAttachment(t, srv, pid, "notes.txt", "text/plain", []chunkResp{c})

	var valueNew []byte
	if err := sp.P.QueryRow(ctx, `
		SELECT value_new FROM activity
		WHERE card_id = $1 AND kind = 'attachment_create'
	`, pid).Scan(&valueNew); err != nil {
		t.Fatalf("create activity lookup: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(valueNew, &payload); err != nil {
		t.Fatalf("payload unmarshal: %v", err)
	}
	if payload["filename"] != "notes.txt" {
		t.Fatalf("payload filename = %v, want notes.txt", payload["filename"])
	}

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "d", Endpoint: "attachment", Action: "delete", Data: json.RawMessage(
			fmt.Sprintf(`{"id":"%d"}`, att.ID))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("delete: %+v", resp.Subresponses[0])
	}
	var valueOld []byte
	if err := sp.P.QueryRow(ctx, `
		SELECT value_old FROM activity
		WHERE card_id = $1 AND kind = 'attachment_delete'
	`, pid).Scan(&valueOld); err != nil {
		t.Fatalf("delete activity lookup: %v", err)
	}
	payload = nil
	if err := json.Unmarshal(valueOld, &payload); err != nil {
		t.Fatalf("delete payload unmarshal: %v", err)
	}
	if payload["filename"] != "notes.txt" {
		t.Fatalf("delete payload filename = %v, want notes.txt", payload["filename"])
	}
}

