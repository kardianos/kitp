package attachment

// Regression test for review 2026-11-03 round 2 #10: seeing a card is not
// enough to copy its files into a project where you write.

import (
	"context"
	"encoding/json"
	"strconv"
	"testing"

	"github.com/kitp/kitp/server/internal/store"
)

func TestViewerCantCopyFiles(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_r2_attachment_viewer")
	ctx := context.Background()
	q := func(sql string, args ...any) int64 {
		t.Helper()
		var id int64
		if err := pool.QueryRow(ctx, sql, args...).Scan(&id); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
		return id
	}
	pA := q(`INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'project' RETURNING id`)
	pB := q(`INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'project' RETURNING id`)
	tA := q(`INSERT INTO card (card_type_id, parent_card_id) SELECT id, $1 FROM card_type WHERE name = 'task' RETURNING id`, pA)
	tB := q(`INSERT INTO card (card_type_id, parent_card_id) SELECT id, $1 FROM card_type WHERE name = 'task' RETURNING id`, pB)
	fileID := q(`INSERT INTO file (filename, mime_type, size_bytes, created_by) VALUES ('payroll.txt', 'text/plain', 16, 1) RETURNING id`)
	q(`INSERT INTO attachment (card_id, file_id) VALUES ($1, $2) RETURNING id`, tB, fileID)
	v := q(`INSERT INTO user_account (display_name) VALUES ('v') RETURNING id`)
	q(`INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT $1, id, $2 FROM role WHERE name = 'worker' RETURNING user_id`, v, pA)
	q(`INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT $1, id, $2 FROM role WHERE name = 'viewer' RETURNING user_id`, v, pB)

	in, err := json.Marshal([]map[string]string{{"card_id": strconv.FormatInt(tA, 10), "file_id": strconv.FormatInt(fileID, 10)}})
	if err != nil {
		t.Fatal(err)
	}
	var ok bool
	var code string
	if err := pool.QueryRow(ctx, `SELECT ok, code FROM attachment_create_batch($1, $2::jsonb)`, v, string(in)).Scan(&ok, &code); err != nil {
		t.Fatal(err)
	}
	if ok || code != "not_found" {
		t.Errorf("a viewer of B attaching B's file in A: ok=%v code=%q, want not_found", ok, code)
	}
}
