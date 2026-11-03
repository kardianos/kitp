package attachment

import (
	"bytes"
	"context"
	"encoding/binary"
	"hash/crc32"
	"net/http"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/cas"
	"github.com/kitp/kitp/server/internal/store"
)

// TestRequireAttachmentAccess is the focused regression test for DI-3
// (docs/DESIGN_INVARIANTS.md). Lives in
// `package attachment` (not _test) so it can call the unexported
// requireAttachmentAccess helper. We seed via direct SQL — no
// dispatcher, no HTTP — so the test is fast and the assertion
// surface is small.
//
// Three cases:
//   - stranger (no grants)   → Forbidden
//   - system (seeded admin)  → nil (allowed)
//   - bogus attachment id    → NotFound (don't leak existence)
func TestRequireAttachmentAccess(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_attachment_internal_authz")
	sp := store.NewPool(pool)
	ctx := context.Background()

	// Seed: one project card + one attachment hanging directly off
	// it. The attachment table only needs file_id + card_id; the
	// authz query doesn't care about chunks or file rows.
	var projectCT int64
	if err := pool.QueryRow(ctx, `SELECT id FROM card_type WHERE name='project'`).Scan(&projectCT); err != nil {
		t.Fatalf("lookup project card_type: %v", err)
	}
	var projectID int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO card (card_type_id, parent_card_id) VALUES ($1, NULL) RETURNING id`,
		projectCT,
	).Scan(&projectID); err != nil {
		t.Fatalf("seed project card: %v", err)
	}
	var fileID int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO file (filename, mime_type, size_bytes, created_by)
		 VALUES ('secret.txt', 'text/plain', 16, $1) RETURNING id`,
		auth.SystemUserID,
	).Scan(&fileID); err != nil {
		t.Fatalf("seed file: %v", err)
	}
	var attID int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO attachment (card_id, file_id) VALUES ($1, $2) RETURNING id`,
		projectID, fileID,
	).Scan(&attID); err != nil {
		t.Fatalf("seed attachment: %v", err)
	}

	// Seed a user with no role grants.
	var strangerID int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO user_account (display_name) VALUES ('stranger-attach-authz') RETURNING id`,
	).Scan(&strangerID); err != nil {
		t.Fatalf("seed stranger: %v", err)
	}

	t.Run("stranger forbidden", func(t *testing.T) {
		err := requireAttachmentAccess(ctx, sp, strangerID, attID)
		if err == nil {
			t.Fatal("expected Forbidden, got nil")
		}
		he, ok := api.AsHTTPError(err)
		if !ok || he.Status != http.StatusForbidden {
			t.Fatalf("expected 403, got %v", err)
		}
	})

	t.Run("system allowed", func(t *testing.T) {
		if err := requireAttachmentAccess(ctx, sp, auth.SystemUserID, attID); err != nil {
			t.Fatalf("expected nil, got %v", err)
		}
	})

	t.Run("bogus id not found", func(t *testing.T) {
		err := requireAttachmentAccess(ctx, sp, strangerID, 999_999)
		if err == nil {
			t.Fatal("expected NotFound, got nil")
		}
		he, ok := api.AsHTTPError(err)
		if !ok || he.Status != http.StatusNotFound {
			t.Fatalf("expected 404, got %v", err)
		}
	})
}

// TestRequireAttachmentAccessNested (B14): an attachment on a card deeper
// in a project — a page under a page — belongs to that project, so the
// project's members can open it and others can't.
func TestRequireAttachmentAccessNested(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_attachment_access_nested")
	sp := store.NewPool(pool)
	ctx := context.Background()
	q := func(sql string, args ...any) int64 {
		t.Helper()
		var id int64
		if err := pool.QueryRow(ctx, sql, args...).Scan(&id); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
		return id
	}
	card := func(typ string, parent any) int64 {
		return q(`INSERT INTO card (card_type_id, parent_card_id) SELECT id, $2 FROM card_type WHERE name = $1 RETURNING id`, typ, parent)
	}
	project := card("project", nil)
	other := card("project", nil)
	inner := card("page", card("page", project))
	fileID := q(`INSERT INTO file (filename, mime_type, size_bytes, created_by) VALUES ('n.txt', 'text/plain', 1, $1) RETURNING id`, auth.SystemUserID)
	att := q(`INSERT INTO attachment (card_id, file_id) VALUES ($1, $2) RETURNING id`, inner, fileID)
	worker := func(name string, scope int64) int64 {
		id := q(`INSERT INTO user_account (display_name) VALUES ($1) RETURNING id`, name)
		if _, err := pool.Exec(ctx, `INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT $1, id, $2 FROM role WHERE name = 'worker'`, id, scope); err != nil {
			t.Fatal(err)
		}
		return id
	}
	if err := requireAttachmentAccess(ctx, sp, worker("member", project), att); err != nil {
		t.Errorf("a member of the project: %v", err)
	}
	err := requireAttachmentAccess(ctx, sp, worker("outsider", other), att)
	if he, ok := api.AsHTTPError(err); !ok || he.Status != http.StatusForbidden {
		t.Errorf("a member of another project: %v, want 403", err)
	}
}

// TestThumbSourceCaps (B5): a picture whose header claims a huge size
// gets no thumbnail (decoding it would allocate the whole pixel buffer),
// and the source buffer stops growing at its cap.
func TestThumbSourceCaps(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_attachment_thumb_caps")
	ctx := context.Background()
	storage := cas.New(cas.NewPgBackend(pool))

	// A PNG of 30000×30000 pixels, as far as its header says.
	var png bytes.Buffer
	png.WriteString("\x89PNG\r\n\x1a\n")
	chunk := func(typ string, data []byte) {
		_ = binary.Write(&png, binary.BigEndian, uint32(len(data))) // a bytes.Buffer write can't fail
		png.WriteString(typ)
		png.Write(data)
		_ = binary.Write(&png, binary.BigEndian, crc32.ChecksumIEEE(append([]byte(typ), data...)))
	}
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:], 30000)
	binary.BigEndian.PutUint32(ihdr[4:], 30000)
	ihdr[8], ihdr[9] = 8, 6 // 8-bit RGBA
	chunk("IHDR", ihdr)
	chunk("IDAT", []byte{0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01})
	chunk("IEND", nil)

	addr, err := storage.Put(ctx, "image/png", png.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	var fileID int64
	if err := pool.QueryRow(ctx, `INSERT INTO file (filename, mime_type, size_bytes, created_by) VALUES ('bomb.png', 'image/png', $1, $2) RETURNING id`, png.Len(), auth.SystemUserID).Scan(&fileID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO file_chunk (file_id, seq, cas_address, chunk_size) VALUES ($1, 0, $2, $3)`, fileID, addr, png.Len()); err != nil {
		t.Fatal(err)
	}
	_, err = generateThumb(ctx, pool, storage, fileID, auth.SystemUserID)
	if err == nil || !strings.Contains(err.Error(), "megapixels") {
		t.Errorf("a 900-megapixel header: %v, want refused by its size", err)
	}

	var raw bytes.Buffer
	lb := &limitedBuffer{buf: &raw, max: 10}
	if _, err := lb.Write([]byte("12345678")); err != nil {
		t.Fatal(err)
	}
	if _, err := lb.Write([]byte("abc")); err == nil {
		t.Error("the buffer grew past its cap")
	}
}
