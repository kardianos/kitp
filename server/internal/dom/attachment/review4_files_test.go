package attachment_test

// Regression tests for the file findings of the fourth 2026-11-03 review.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/cas"
	domcas "github.com/kitp/kitp/server/internal/dom/cas"
)

func TestFilesRound4(t *testing.T) {
	handler, srv, sp := setup(t, "kitp_test_r4_files")
	storage := cas.New(cas.NewPgBackend(sp.P))
	domcas.Register(sp)
	ctx := context.Background()
	pA := makeProject(t, srv)
	pB := makeProject(t, srv)
	tA := r3Task(t, srv, pA)
	tB := r3Task(t, srv, pB)

	// #11: the owner works on A and B; their agent only on A. The owner's
	// file attached to a B task can't be attached by the agent to an A
	// task; one the owner hasn't attached anywhere yet can.
	o := r3User(t, sp, "owner", "worker", pA, 0)
	if _, err := sp.P.Exec(ctx, `INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT $1, id, $2 FROM role WHERE name = 'worker'`, o, pB); err != nil {
		t.Fatal(err)
	}
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
	secret := makeFile("project B's secret")
	if sr := r3D(srv, r3Ctx(o), "attachment", "create", fmt.Sprintf(`{"card_id":"%d","file_id":%q}`, tB, secret)); !sr.OK {
		t.Fatalf("owner attach on B: %+v", sr.Error)
	}
	if sr := r3D(srv, r3Ctx(g), "attachment", "create", fmt.Sprintf(`{"card_id":"%d","file_id":%q}`, tA, secret)); sr.OK {
		t.Error("an agent scoped to A attached its owner's B file to an A task")
	}
	fresh := makeFile("a hand-off")
	if sr := r3D(srv, r3Ctx(g), "attachment", "create", fmt.Sprintf(`{"card_id":"%d","file_id":%q}`, tA, fresh)); !sr.OK {
		t.Errorf("an agent couldn't attach its owner's unattached upload: %+v", sr.Error)
	}

	// #16: a deleted task's file is neither downloaded nor listed.
	att := createAttachment(t, srv, tA, "w.txt", "text/plain", []chunkResp{uploadChunk(t, handler, []byte("on a task about to go"))})
	if sr := r3D(srv, auth.WithSystemUser(ctx), "card", "delete", fmt.Sprintf(`{"card_id":"%d"}`, tA)); !sr.OK {
		t.Fatalf("card.delete: %+v", sr.Error)
	}
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, httptest.NewRequest("GET", fmt.Sprintf("/api/v1/attachment/%d/download", att.ID), nil))
	if rr.Code == http.StatusOK {
		t.Errorf("a deleted task's file downloaded (%d)", rr.Code)
	}
	if sr := r3D(srv, auth.WithSystemUser(ctx), "attachment", "list", fmt.Sprintf(`{"card_id":"%d"}`, tA)); sr.OK {
		t.Errorf("a deleted task's files were listed: %v", sr.Data)
	}

	// #15: an address with thousands of holders answers at once, and a
	// repeated address is reported as often as it is asked.
	logo := uploadChunk(t, handler, []byte("a logo many hold"))
	if _, err := sp.P.Exec(ctx, `
		WITH u AS (INSERT INTO user_account (display_name) SELECT 'h' || g FROM generate_series(1, 3000) g RETURNING id)
		INSERT INTO cas_blob_holder (address, user_id) SELECT $1, id FROM u`, logo.Address); err != nil {
		t.Fatal(err)
	}
	addrs := make([]string, 2000)
	for i := range addrs {
		addrs[i] = fmt.Sprintf("%q", logo.Address)
	}
	start := time.Now()
	mc := r3D(srv, r3Ctx(g), "cas", "missing_chunks", `{"addresses":[`+strings.Join(addrs, ",")+`]}`)
	if !mc.OK {
		t.Fatalf("missing_chunks: %+v", mc.Error)
	}
	if el := time.Since(start); el > 2*time.Second {
		t.Errorf("missing_chunks of one address held 3000 times, asked 2000 times, took %v", el)
	}
	if got := strings.Count(fmt.Sprint(mc.Data), logo.Address); got != 2000 {
		t.Errorf("missing_chunks reported the address %d times, want 2000", got)
	}
}
