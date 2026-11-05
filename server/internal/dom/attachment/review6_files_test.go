package attachment_test

// Regression test for a "worth a look" item of the fifth 2026-11-03 review:
// an agent read its owner's files that were never attached (CSV imports)
// or whose attachments were all deleted, at any age.

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/cas"
	domcas "github.com/kitp/kitp/server/internal/dom/cas"
)

func TestOwnersFilesHandOverOnlyInFlight(t *testing.T) {
	_, srv, sp := setup(t, "kitp_test_r6_files_handover")
	storage := cas.New(cas.NewPgBackend(sp.P))
	domcas.Register(sp)
	ctx := context.Background()
	pA := makeProject(t, srv)
	tA := r3Task(t, srv, pA)
	o := r3User(t, sp, "owner", "worker", pA, 0)
	g := r3User(t, sp, "agent", "worker", pA, o)
	makeFile := func(body string) string {
		t.Helper()
		addr := r3Chunk(t, sp, storage, o, []byte(body))
		sr := r3D(srv, r3Ctx(o), "file", "create", fmt.Sprintf(`{"filename":"n.txt","chunks":[{"address":%q,"size_bytes":%d}]}`, addr, len(body)))
		if !sr.OK {
			t.Fatalf("file.create: %+v", sr.Error)
		}
		b, err := json.Marshal(sr.Data)
		if err != nil {
			t.Fatal(err)
		}
		var f struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(b, &f); err != nil {
			t.Fatal(err)
		}
		return f.ID
	}
	agentAttach := func(file string) bool {
		t.Helper()
		return r3D(srv, r3Ctx(g), "attachment", "create", fmt.Sprintf(`{"card_id":"%d","file_id":%q}`, tA, file)).OK
	}

	if !agentAttach(makeFile("just uploaded")) {
		t.Error("an agent couldn't attach the upload its owner just made")
	}
	old := makeFile("last month's CSV import")
	if _, err := sp.P.Exec(ctx, `UPDATE file SET created_at = now() - interval '2 days' WHERE id = $1`, old); err != nil {
		t.Fatal(err)
	}
	if agentAttach(old) {
		t.Error("an agent attached its owner's old, never-attached upload")
	}
	detached := makeFile("attached once, then removed")
	if sr := r3D(srv, r3Ctx(o), "attachment", "create", fmt.Sprintf(`{"card_id":"%d","file_id":%q}`, tA, detached)); !sr.OK {
		t.Fatalf("owner attach: %+v", sr.Error)
	}
	if _, err := sp.P.Exec(ctx, `UPDATE attachment SET deleted_at = now() WHERE file_id = $1`, detached); err != nil {
		t.Fatal(err)
	}
	if agentAttach(detached) {
		t.Error("an agent attached its owner's file whose attachments were deleted")
	}
}
