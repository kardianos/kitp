// Direct PL/pgSQL test for attachment_upload_url_batch. Exercises the
// SQL function shape (validation, live-card check, echoed values)
// without the dispatcher or the Go-side PostRun (signUploadURLs) that
// appends the signed url + expires_at — that hook is covered by
// upload_test.go, and the full mint → PUT flow by TestSignedUpload.
package attachment_test

import (
	"context"
	"encoding/json"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

func callAttachmentUploadURLBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []createResultRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM attachment_upload_url_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var out []createResultRow
	for rows.Next() {
		var r createResultRow
		var resJSON []byte
		if err := rows.Scan(&r.Idx, &r.OK, &r.Code, &r.Message, &resJSON); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if len(resJSON) > 0 {
			r.Result = json.RawMessage(append([]byte(nil), resJSON...))
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows.Err: %v", err)
	}
	return out
}

// uploadURLResultJSON mirrors the success shape (minus url/expires_at,
// which the PostRun fills in). Keep in sync with
// attachment.UploadURLOutput.
type uploadURLResultJSON struct {
	CardID   string `json:"card_id"`
	Filename string `json:"filename"`
	MimeType string `json:"mime_type"`
}

func TestAttachmentUploadURLBatch(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_attachment_upload_url")
	cardID, _ := seedCardAndFile(t, pool, "task", "unused.txt", "text/plain", 1)
	deletedID, _ := seedCardAndFile(t, pool, "task", "unused.txt", "text/plain", 1)
	if _, err := pool.Exec(context.Background(),
		`UPDATE card SET deleted_at = now() WHERE id = $1`, deletedID); err != nil {
		t.Fatalf("soft-delete card: %v", err)
	}
	card := strconv.FormatInt(cardID, 10)

	cases := []struct {
		name     string
		in       map[string]any
		wantCode string // "" = ok
		wantMime string
	}{
		{name: "happy", in: map[string]any{"card_id": card, "filename": "report.pdf", "mime_type": "application/pdf"}, wantMime: "application/pdf"},
		{name: "default mime", in: map[string]any{"card_id": card, "filename": "blob.bin"}, wantMime: "application/octet-stream"},
		{name: "missing card_id", in: map[string]any{"filename": "a.txt"}, wantCode: "validation"},
		{name: "missing filename", in: map[string]any{"card_id": card}, wantCode: "validation"},
		{name: "no extension", in: map[string]any{"card_id": card, "filename": "README"}, wantCode: "validation"},
		{name: "missing card", in: map[string]any{"card_id": "999999", "filename": "a.txt"}, wantCode: "not_found"},
		{name: "deleted card", in: map[string]any{"card_id": strconv.FormatInt(deletedID, 10), "filename": "a.txt"}, wantCode: "not_found"},
	}
	inputs := make([]map[string]any, len(cases))
	for i, tc := range cases {
		inputs[i] = tc.in
	}
	rows := callAttachmentUploadURLBatch(t, pool, auth.SystemUserID, inputs)
	if len(rows) != len(cases) {
		t.Fatalf("rows: got %d, want %d", len(rows), len(cases))
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := rows[i]
			if tc.wantCode != "" {
				if r.OK || r.Code != tc.wantCode {
					t.Fatalf("got ok=%v code=%q msg=%q, want code %q", r.OK, r.Code, r.Message, tc.wantCode)
				}
				return
			}
			if !r.OK {
				t.Fatalf("got code=%q msg=%q, want ok", r.Code, r.Message)
			}
			var got uploadURLResultJSON
			if err := json.Unmarshal(r.Result, &got); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if got.CardID != card || got.Filename != tc.in["filename"] || got.MimeType != tc.wantMime {
				t.Fatalf("result = %+v, want card %s / %v / %s", got, card, tc.in["filename"], tc.wantMime)
			}
		})
	}
}
