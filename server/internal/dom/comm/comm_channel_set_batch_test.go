// Direct PL/pgSQL test for comm_channel_set_batch — Phase 4 of
// docs/UNIFIED_HANDLER_PLAN.md.
package comm_test

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

// intToStr formats a bigint as a string, the form the dispatcher's
// `,string` JSON tags use for 64-bit ids on the wire.
func intToStr(n int64) string { return strconv.FormatInt(n, 10) }

type chanSetResult struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callCommChannelSetBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []chanSetResult {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM comm_channel_set_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var out []chanSetResult
	for rows.Next() {
		var r chanSetResult
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

// seedChannelFixture inserts a project card directly and returns its
// id. The handler under test creates the channel; we only need the
// parent project.
func seedChannelFixture(t *testing.T, pool *pgxpool.Pool) int64 {
	t.Helper()
	ctx := context.Background()
	var pid int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name='project' RETURNING id
	`).Scan(&pid); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		SELECT $1, ad.id, to_jsonb('TestProject'::text) FROM attribute_def ad WHERE ad.name='title'
	`, pid); err != nil {
		t.Fatalf("seed project title: %v", err)
	}
	return pid
}

// TestCommChannelSetBatch_HappyInsert — id=0 inserts a fresh channel
// + secret row; passwords encrypt via pgp_sym_encrypt and round-trip
// through pgp_sym_decrypt.
func TestCommChannelSetBatch_HappyInsert(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_channel_set_batch_insert")
	pid := seedChannelFixture(t, pool)

	rows := callCommChannelSetBatch(t, pool, auth.SystemUserID, []map[string]any{
		{
			"project_id":     intToStr(pid),
			"name":           "Support",
			"channel_type":   "email",
			"imap_host":      "imap.example.com",
			"imap_port":      993,
			"imap_username":  "u",
			"imap_password":  "imap-secret",
			"smtp_host":      "smtp.example.com",
			"smtp_port":      587,
			"smtp_username":  "u",
			"smtp_password":  "smtp-secret",
			"from_address":   "support@example.com",
		},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("happy: %+v", rows)
	}
	var got struct {
		ChannelID string `json:"channel_id"`
	}
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.ChannelID == "" {
		t.Fatal("empty channel_id")
	}

	// Verify title + imap_host + smtp_host attributes.
	var title, imapHost, smtpHost, fromAddr string
	if err := pool.QueryRow(context.Background(), `
		SELECT
			(SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1::bigint AND ad.name='title'),
			(SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1::bigint AND ad.name='imap_host'),
			(SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1::bigint AND ad.name='smtp_host'),
			(SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1::bigint AND ad.name='from_address')
	`, got.ChannelID).Scan(&title, &imapHost, &smtpHost, &fromAddr); err != nil {
		t.Fatalf("read attrs: %v", err)
	}
	if title != "Support" || imapHost != "imap.example.com" || smtpHost != "smtp.example.com" || fromAddr != "support@example.com" {
		t.Errorf("attrs mismatch: title=%q imap=%q smtp=%q from=%q", title, imapHost, smtpHost, fromAddr)
	}

	// Verify passwords encrypt + decrypt with the GUC key.
	var imapPlain, smtpPlain string
	if err := pool.QueryRow(context.Background(), `
		SELECT
			pgp_sym_decrypt(imap_password, current_setting('app.comm_secret_key')),
			pgp_sym_decrypt(smtp_password, current_setting('app.comm_secret_key'))
		FROM comm_secret WHERE channel_card_id=$1::bigint
	`, got.ChannelID).Scan(&imapPlain, &smtpPlain); err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if imapPlain != "imap-secret" || smtpPlain != "smtp-secret" {
		t.Errorf("decrypted mismatch: imap=%q smtp=%q", imapPlain, smtpPlain)
	}
}

// TestCommChannelSetBatch_UpdatePreservesOmittedPassword — second
// call with id set + only one password supplied leaves the other
// password ciphertext byte-identical.
func TestCommChannelSetBatch_UpdatePreservesOmittedPassword(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_channel_set_batch_update")
	pid := seedChannelFixture(t, pool)

	rows := callCommChannelSetBatch(t, pool, auth.SystemUserID, []map[string]any{
		{
			"project_id":     intToStr(pid),
			"name":           "Support",
			"channel_type":   "email",
			"imap_password":  "orig-imap",
			"smtp_password":  "orig-smtp",
		},
	})
	if !rows[0].OK {
		t.Fatalf("insert: %+v", rows[0])
	}
	var got struct {
		ChannelID string `json:"channel_id"`
	}
	_ = json.Unmarshal(rows[0].Result, &got)

	var imapBefore, smtpBefore []byte
	if err := pool.QueryRow(context.Background(), `
		SELECT imap_password, smtp_password FROM comm_secret WHERE channel_card_id=$1::bigint
	`, got.ChannelID).Scan(&imapBefore, &smtpBefore); err != nil {
		t.Fatal(err)
	}

	// Update: rename + change imap_password only. smtp_password omitted.
	rows = callCommChannelSetBatch(t, pool, auth.SystemUserID, []map[string]any{
		{
			"id":            got.ChannelID,
			"project_id":    intToStr(pid),
			"name":          "Support v2",
			"channel_type":  "email",
			"imap_password": "new-imap",
		},
	})
	if !rows[0].OK {
		t.Fatalf("update: %+v", rows[0])
	}

	var imapAfter, smtpAfter []byte
	if err := pool.QueryRow(context.Background(), `
		SELECT imap_password, smtp_password FROM comm_secret WHERE channel_card_id=$1::bigint
	`, got.ChannelID).Scan(&imapAfter, &smtpAfter); err != nil {
		t.Fatal(err)
	}
	if string(smtpAfter) != string(smtpBefore) {
		t.Errorf("smtp ciphertext changed across an update that omitted smtp_password")
	}
	var imapPlain string
	if err := pool.QueryRow(context.Background(), `
		SELECT pgp_sym_decrypt(imap_password, current_setting('app.comm_secret_key'))
		FROM comm_secret WHERE channel_card_id=$1::bigint
	`, got.ChannelID).Scan(&imapPlain); err != nil {
		t.Fatal(err)
	}
	if imapPlain != "new-imap" {
		t.Errorf("imap plaintext=%q, want new-imap", imapPlain)
	}

	var titleNow string
	if err := pool.QueryRow(context.Background(), `
		SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id=$1::bigint AND ad.name='title'
	`, got.ChannelID).Scan(&titleNow); err != nil {
		t.Fatal(err)
	}
	if titleNow != "Support v2" {
		t.Errorf("title=%q want Support v2", titleNow)
	}
}

// TestCommChannelSetBatch_MultiRow — two channels under the same
// project in one call. Both must succeed with distinct ids.
func TestCommChannelSetBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_channel_set_batch_multi")
	pid := seedChannelFixture(t, pool)

	rows := callCommChannelSetBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"project_id": intToStr(pid), "name": "A", "channel_type": "email"},
		{"project_id": intToStr(pid), "name": "B", "channel_type": "email"},
	})
	if len(rows) != 2 || !rows[0].OK || !rows[1].OK {
		t.Fatalf("multi: %+v", rows)
	}
	type out struct{ ChannelID string `json:"channel_id"` }
	var a, b out
	_ = json.Unmarshal(rows[0].Result, &a)
	_ = json.Unmarshal(rows[1].Result, &b)
	if a.ChannelID == "" || b.ChannelID == "" || a.ChannelID == b.ChannelID {
		t.Errorf("channel ids must be unique non-empty: %q vs %q", a.ChannelID, b.ChannelID)
	}
}

// TestCommChannelSetBatch_PerRowFailure — combinations of missing
// name / channel_type / unsupported type / missing project.
func TestCommChannelSetBatch_PerRowFailure(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_channel_set_batch_perrow")
	pid := seedChannelFixture(t, pool)

	rows := callCommChannelSetBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"project_id": intToStr(pid), "name": "OK", "channel_type": "email"},
		{"project_id": intToStr(pid), "channel_type": "email"},               // name missing
		{"project_id": intToStr(pid), "name": "X", "channel_type": "slack"},  // unsupported
		{"name": "Y", "channel_type": "email"},                                 // project_id missing
		{"project_id": "99999999", "name": "Z", "channel_type": "email"},     // project not found
	})
	if len(rows) != 5 {
		t.Fatalf("rows: %d", len(rows))
	}
	if !rows[0].OK {
		t.Errorf("row 0 must pass: %+v", rows[0])
	}
	if rows[1].OK || rows[1].Code != "validation" || !strings.Contains(rows[1].Message, "name is required") {
		t.Errorf("row 1 want validation; got %+v", rows[1])
	}
	if rows[2].OK || rows[2].Code != "validation" || !strings.Contains(rows[2].Message, "channel_type") {
		t.Errorf("row 2 want validation/channel_type; got %+v", rows[2])
	}
	if rows[3].OK || rows[3].Code != "validation" {
		t.Errorf("row 3 want validation; got %+v", rows[3])
	}
	if rows[4].OK || rows[4].Code != "project_not_found" {
		t.Errorf("row 4 want project_not_found; got %+v", rows[4])
	}
}

// TestCommChannelSetBatch_StatusEnabledClearsFault — supplying
// channel_status='enabled' on a channel that previously had a fault
// reason clears that reason in the same call.
func TestCommChannelSetBatch_StatusEnabledClearsFault(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_channel_set_batch_status")
	pid := seedChannelFixture(t, pool)
	rows := callCommChannelSetBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"project_id": intToStr(pid), "name": "X", "channel_type": "email", "channel_status": "disabled-fault"},
	})
	if !rows[0].OK {
		t.Fatalf("create: %+v", rows[0])
	}
	var got struct{ ChannelID string `json:"channel_id"` }
	_ = json.Unmarshal(rows[0].Result, &got)

	// Seed a fault reason directly.
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		SELECT $1::bigint, ad.id, to_jsonb('IMAP dial failed'::text) FROM attribute_def ad WHERE ad.name='channel_fault_reason'
		ON CONFLICT (card_id, attribute_def_id) DO UPDATE SET value=EXCLUDED.value
	`, got.ChannelID); err != nil {
		t.Fatalf("seed reason: %v", err)
	}

	// Re-enable.
	rows = callCommChannelSetBatch(t, pool, auth.SystemUserID, []map[string]any{
		{
			"id":             got.ChannelID,
			"project_id":     intToStr(pid),
			"name":           "X",
			"channel_type":   "email",
			"channel_status": "enabled",
		},
	})
	if !rows[0].OK {
		t.Fatalf("re-enable: %+v", rows[0])
	}
	var reason string
	if err := pool.QueryRow(context.Background(), `
		SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id=$1::bigint AND ad.name='channel_fault_reason'
	`, got.ChannelID).Scan(&reason); err != nil {
		t.Fatalf("read reason: %v", err)
	}
	if reason != "" {
		t.Errorf("fault reason not cleared: %q", reason)
	}
}
