package attachment

import (
	"context"
	"net/http"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
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
