// Direct PL/pgSQL test for reply_post_batch — Phase 3 of
// docs/UNIFIED_HANDLER_PLAN.md. Seeds the minimum graph (project /
// task / comm / person / channel) directly so the function test
// stays independent of card.insert / comm.create.
package comm_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

type replyPostResult struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callReplyPostBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []replyPostResult {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM reply_post_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var out []replyPostResult
	for rows.Next() {
		var r replyPostResult
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

// replyFixture seeds a project + task + comm (with thread_id +
// channel_ref + comm_recipients) + a person card with an email, all
// inserted directly. Returns the ids we need to drive reply_post_batch
// in isolation.
type replyFixture struct {
	projectID int64
	taskID    int64
	channelID int64
	commID    int64
	personID  int64
	threadID  string
	taskTitle string
}

// insertAttr is a tiny helper that writes one attribute_value row
// (without activity) so the seed is concise. The function under test
// reads attribute_value, not activity, so this is sufficient for
// fixture construction.
func insertAttr(t *testing.T, pool *pgxpool.Pool, cardID int64, attrName string, value any) {
	t.Helper()
	js, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal %s: %v", attrName, err)
	}
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		SELECT $1, ad.id, $2::jsonb FROM attribute_def ad WHERE ad.name = $3
	`, cardID, string(js), attrName); err != nil {
		t.Fatalf("seed attr %s: %v", attrName, err)
	}
}

func seedReplyFixture(t *testing.T, pool *pgxpool.Pool, fromAddress, recipientEmail string) replyFixture {
	t.Helper()
	ctx := context.Background()
	f := replyFixture{threadID: "abcdEF0123", taskTitle: "Issue X"}

	mkCard := func(ctName string, parent int64) int64 {
		var id int64
		var q string
		var args []any
		if parent == 0 {
			q = `INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name=$1 RETURNING id`
			args = []any{ctName}
		} else {
			q = `INSERT INTO card (card_type_id, parent_card_id) SELECT id, $2 FROM card_type WHERE name=$1 RETURNING id`
			args = []any{ctName, parent}
		}
		if err := pool.QueryRow(ctx, q, args...).Scan(&id); err != nil {
			t.Fatalf("mkCard %s: %v", ctName, err)
		}
		return id
	}

	f.projectID = mkCard("project", 0)
	insertAttr(t, pool, f.projectID, "title", "TestProject")

	f.taskID = mkCard("task", f.projectID)
	insertAttr(t, pool, f.taskID, "title", f.taskTitle)

	f.channelID = mkCard("comm_channel", f.projectID)
	insertAttr(t, pool, f.channelID, "title", "Support")
	insertAttr(t, pool, f.channelID, "channel_type", "email")
	if fromAddress != "" {
		insertAttr(t, pool, f.channelID, "from_address", fromAddress)
	}

	f.commID = mkCard("comm", f.taskID)
	insertAttr(t, pool, f.commID, "title", "Help thread")
	insertAttr(t, pool, f.commID, "thread_id", f.threadID)
	// channel_ref + comm_recipients are card_ref / card_ref[]; store as
	// numeric jsonb to mirror the canonical form attribute_update_batch
	// writes (the function reads numeric forms via jsonb_typeof checks).
	if _, err := pool.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		SELECT $1, ad.id, to_jsonb($2::bigint) FROM attribute_def ad WHERE ad.name='channel_ref'
	`, f.commID, f.channelID); err != nil {
		t.Fatalf("seed channel_ref: %v", err)
	}

	if recipientEmail != "" {
		f.personID = mkCard("person", 0)
		insertAttr(t, pool, f.personID, "title", "Recipient")
		insertAttr(t, pool, f.personID, "email", recipientEmail)
		insertAttr(t, pool, f.personID, "person_kind", "contact")
		// comm_recipients is card_ref[]; numeric jsonb array per the
		// canonical write form.
		if _, err := pool.Exec(ctx, `
			INSERT INTO attribute_value (card_id, attribute_def_id, value)
			SELECT $1, ad.id, jsonb_build_array(to_jsonb($2::bigint)) FROM attribute_def ad WHERE ad.name='comm_recipients'
		`, f.commID, f.personID); err != nil {
			t.Fatalf("seed comm_recipients: %v", err)
		}
	}
	return f
}

// TestReplyPostBatch_Happy — single happy path: the function inserts a
// reply_body card, writes the five attributes (with derived To: /
// Subject snapshots), appends the new id to comm.replies, and returns
// reply_id.
func TestReplyPostBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_reply_post_batch_happy")
	f := seedReplyFixture(t, pool, "kitp@example.com", "cust@example.com")

	rows := callReplyPostBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"comm_id": strconv.FormatInt(f.commID, 10), "body": "Hello, here is a fix."},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("happy: %+v", rows)
	}
	var got struct {
		ReplyID string `json:"reply_id"`
	}
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.ReplyID == "" {
		t.Fatal("empty reply_id")
	}

	// Verify the six attributes.
	ctx := context.Background()
	var to, from, subject, body, status, author string
	if err := pool.QueryRow(ctx, `
		SELECT
			(SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1::bigint AND ad.name='reply_to'),
			(SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1::bigint AND ad.name='reply_from'),
			(SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1::bigint AND ad.name='reply_subject'),
			(SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1::bigint AND ad.name='reply_body_text'),
			(SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1::bigint AND ad.name='delivery_status'),
			(SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1::bigint AND ad.name='reply_author')
	`, got.ReplyID).Scan(&to, &from, &subject, &body, &status, &author); err != nil {
		t.Fatalf("read attrs: %v", err)
	}
	if to != "cust@example.com" {
		t.Errorf("reply_to=%q want cust@example.com", to)
	}
	if from != "kitp@example.com" {
		t.Errorf("reply_from=%q want kitp@example.com (channel from_address)", from)
	}
	expectSubject := "[#" + f.threadID + "] " + f.taskTitle
	if subject != expectSubject {
		t.Errorf("reply_subject=%q want %q", subject, expectSubject)
	}
	if body != "Hello, here is a fix." {
		t.Errorf("body=%q", body)
	}
	if status != "pending" {
		t.Errorf("status=%q want pending", status)
	}
	if want := strconv.FormatInt(auth.SystemUserID, 10); author != want {
		t.Errorf("reply_author=%q want %q (the reply.post actor)", author, want)
	}

	// Verify comm.replies got the new reply_body id appended.
	var stored []byte
	if err := pool.QueryRow(ctx, `
		SELECT av.value FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id=$1 AND ad.name='replies'
	`, f.commID).Scan(&stored); err != nil {
		t.Fatalf("read replies: %v", err)
	}
	var ids []int64
	if err := json.Unmarshal(stored, &ids); err != nil {
		t.Fatalf("decode replies: %v: %s", err, stored)
	}
	rid, _ := strconv.ParseInt(got.ReplyID, 10, 64)
	if len(ids) != 1 || ids[0] != rid {
		t.Errorf("comm.replies=%v want [%d]", ids, rid)
	}
}

// TestReplyPostBatch_MultiRow — two distinct comms get one reply each
// in one call; both must succeed with unique reply ids.
func TestReplyPostBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_reply_post_batch_multi")
	a := seedReplyFixture(t, pool, "", "a@example.com")
	b := seedReplyFixture(t, pool, "", "b@example.com")

	rows := callReplyPostBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"comm_id": strconv.FormatInt(a.commID, 10), "body": "first"},
		{"comm_id": strconv.FormatInt(b.commID, 10), "body": "second"},
	})
	if len(rows) != 2 {
		t.Fatalf("rows: %d", len(rows))
	}
	type out struct {
		ReplyID string `json:"reply_id"`
	}
	var got [2]out
	for i, r := range rows {
		if !r.OK {
			t.Fatalf("row %d: %+v", i, r)
		}
		if err := json.Unmarshal(r.Result, &got[i]); err != nil {
			t.Fatalf("unmarshal %d: %v", i, err)
		}
	}
	if got[0].ReplyID == "" || got[1].ReplyID == "" || got[0].ReplyID == got[1].ReplyID {
		t.Errorf("reply ids must be unique non-empty: %+v", got)
	}
}

// TestReplyPostBatch_PerRowFailure — four inputs surface per-row codes:
//   - happy
//   - missing body
//   - missing comm_id
//   - comm with NO recipients -> no_recipients
func TestReplyPostBatch_PerRowFailure(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_reply_post_batch_perrow")
	withRcp := seedReplyFixture(t, pool, "", "x@example.com")
	noRcp := seedReplyFixture(t, pool, "", "")

	rows := callReplyPostBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"comm_id": strconv.FormatInt(withRcp.commID, 10), "body": "good"},
		{"comm_id": strconv.FormatInt(withRcp.commID, 10), "body": ""},
		{"comm_id": "0", "body": "x"},
		{"comm_id": strconv.FormatInt(noRcp.commID, 10), "body": "silent"},
	})
	if len(rows) != 4 {
		t.Fatalf("rows: %d", len(rows))
	}
	if !rows[0].OK {
		t.Errorf("row 0 should pass: %+v", rows[0])
	}
	if rows[1].OK || rows[1].Code != "validation" {
		t.Errorf("row 1 want validation; got %+v", rows[1])
	}
	if !strings.Contains(rows[1].Message, "body is required") {
		t.Errorf("row 1 message: %q", rows[1].Message)
	}
	if rows[2].OK || rows[2].Code != "validation" {
		t.Errorf("row 2 want validation; got %+v", rows[2])
	}
	if rows[3].OK || rows[3].Code != "no_recipients" {
		t.Errorf("row 3 want no_recipients; got %+v", rows[3])
	}
}

// TestReplyPostBatch_NonCommRejects — comm_id pointing at a task is
// 'comm_wrong_type'.
func TestReplyPostBatch_NonCommRejects(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_reply_post_batch_non_comm")
	f := seedReplyFixture(t, pool, "", "x@example.com")
	rows := callReplyPostBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"comm_id": strconv.FormatInt(f.taskID, 10), "body": "x"},
	})
	if len(rows) != 1 || rows[0].OK {
		t.Fatalf("expected fail: %+v", rows)
	}
	if rows[0].Code != "comm_wrong_type" {
		t.Errorf("code=%q want comm_wrong_type (%s)", rows[0].Code, rows[0].Message)
	}
}

// TestReplyPostBatch_AppendsToExistingReplies — when comm.replies
// already has an entry the new reply id is appended (not replaced),
// and the legacy string-form id in the stored array is canonicalised
// to a number on write.
func TestReplyPostBatch_AppendsToExistingReplies(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_reply_post_batch_append")
	f := seedReplyFixture(t, pool, "", "x@example.com")
	// Pre-seed comm.replies with a legacy STRING-form id (1234) to
	// exercise the canonicaliser branch.
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		SELECT $1, ad.id, '["1234"]'::jsonb FROM attribute_def ad WHERE ad.name='replies'
	`, f.commID); err != nil {
		t.Fatalf("seed legacy replies: %v", err)
	}

	rows := callReplyPostBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"comm_id": strconv.FormatInt(f.commID, 10), "body": "appended"},
	})
	if !rows[0].OK {
		t.Fatalf("happy: %+v", rows[0])
	}
	var got struct {
		ReplyID string `json:"reply_id"`
	}
	_ = json.Unmarshal(rows[0].Result, &got)
	rid, _ := strconv.ParseInt(got.ReplyID, 10, 64)

	var stored []byte
	if err := pool.QueryRow(context.Background(), `
		SELECT av.value FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id=$1 AND ad.name='replies'
	`, f.commID).Scan(&stored); err != nil {
		t.Fatalf("read: %v", err)
	}
	expected := fmt.Sprintf("[1234, %d]", rid)
	// Compare semantically — both should decode to [1234, rid].
	var ids []int64
	if err := json.Unmarshal(stored, &ids); err != nil {
		t.Fatalf("decode %s: %v", stored, err)
	}
	if len(ids) != 2 || ids[0] != 1234 || ids[1] != rid {
		t.Errorf("stored=%s want %s (numeric canonicalised)", stored, expected)
	}
}
