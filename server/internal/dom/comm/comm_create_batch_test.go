// Direct PL/pgSQL test for comm_create_batch — Phase 4 of
// docs/UNIFIED_HANDLER_PLAN.md. Seeds the minimum graph directly so
// the function test stays independent of card.insert / flow.set.
package comm_test

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

type commCreateResult struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callCommCreateBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []commCreateResult {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM comm_create_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var out []commCreateResult
	for rows.Next() {
		var r commCreateResult
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

// commCreateFixture sets up the rows comm.create needs:
//   project (with title), status card, task (under project), channel
//   (under project), comm_status open card (under project), flow row
//   binding comm_status to project with default_create_status_id =
//   open card. Direct INSERTs so the test doesn't lean on
//   card_insert_batch / flow_set behaviour.
type commCreateFixture struct {
	projectID int64
	taskID    int64
	taskTitle string
	channelID int64
	openID    int64
}

func seedCommCreateFixture(t *testing.T, pool *pgxpool.Pool) commCreateFixture {
	t.Helper()
	ctx := context.Background()
	f := commCreateFixture{taskTitle: "Issue Y"}

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
	mkAttr := func(cardID int64, name string, val any) {
		js, _ := json.Marshal(val)
		if _, err := pool.Exec(ctx, `
			INSERT INTO attribute_value (card_id, attribute_def_id, value)
			SELECT $1, ad.id, $2::jsonb FROM attribute_def ad WHERE ad.name = $3
		`, cardID, string(js), name); err != nil {
			t.Fatalf("seed attr %s: %v", name, err)
		}
	}

	f.projectID = mkCard("project", 0)
	mkAttr(f.projectID, "title", "TestProject")

	f.taskID = mkCard("task", f.projectID)
	mkAttr(f.taskID, "title", f.taskTitle)

	f.channelID = mkCard("comm_channel", f.projectID)
	mkAttr(f.channelID, "title", "Support")
	mkAttr(f.channelID, "channel_type", "email")

	f.openID = mkCard("status", f.projectID)
	mkAttr(f.openID, "title", "Open")

	// flow row binding comm_status to this project with the open card
	// as default_create_status_id.
	if _, err := pool.Exec(ctx, `
		INSERT INTO flow (name, attribute_def_id, scope_card_id, default_create_status_id)
		SELECT 'Test comm flow', ad.id, $1, $2
		FROM attribute_def ad WHERE ad.name='comm_status'
	`, f.projectID, f.openID); err != nil {
		t.Fatalf("seed flow: %v", err)
	}
	return f
}

// TestCommCreateBatch_Happy — single happy path: comm card lands,
// the four initial attributes are written, thread_id matches the
// alphanumeric regex, and the task's `comms` attribute is appended.
func TestCommCreateBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_create_batch_happy")
	f := seedCommCreateFixture(t, pool)

	rows := callCommCreateBatch(t, pool, auth.SystemUserID, []map[string]any{
		{
			"task_id":    intToStr(f.taskID),
			"channel_id": intToStr(f.channelID),
			"subject":    "Help!",
		},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("happy: %+v", rows)
	}
	var got struct {
		CommID   string `json:"comm_id"`
		ThreadID string `json:"thread_id"`
	}
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.CommID == "" {
		t.Fatal("empty comm_id")
	}
	re := regexp.MustCompile(`^[0-9A-Za-z]{10}$`)
	if !re.MatchString(got.ThreadID) {
		t.Errorf("thread_id %q does not match alphanumeric 10-char regex", got.ThreadID)
	}

	// Comm attributes.
	ctx := context.Background()
	var title, threadID string
	var channelRef, status int64
	if err := pool.QueryRow(ctx, `
		SELECT
			(SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1::bigint AND ad.name='title'),
			(SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1::bigint AND ad.name='thread_id'),
			(SELECT (av.value)::text::bigint FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1::bigint AND ad.name='channel_ref'),
			(SELECT (av.value)::text::bigint FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1::bigint AND ad.name='comm_status')
	`, got.CommID).Scan(&title, &threadID, &channelRef, &status); err != nil {
		t.Fatalf("read attrs: %v", err)
	}
	if title != "Help!" {
		t.Errorf("title=%q want Help!", title)
	}
	if threadID != got.ThreadID {
		t.Errorf("thread_id mismatch: stored=%q returned=%q", threadID, got.ThreadID)
	}
	if channelRef != f.channelID {
		t.Errorf("channel_ref=%d want %d", channelRef, f.channelID)
	}
	if status != f.openID {
		t.Errorf("comm_status=%d want %d (Open default)", status, f.openID)
	}

	// Task's comms attribute now contains the comm.
	var commsJSON []byte
	if err := pool.QueryRow(ctx, `
		SELECT av.value FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id=$1 AND ad.name='comms'
	`, f.taskID).Scan(&commsJSON); err != nil {
		t.Fatalf("task.comms: %v", err)
	}
	var ids []int64
	if err := json.Unmarshal(commsJSON, &ids); err != nil {
		t.Fatalf("decode comms: %v: %s", err, commsJSON)
	}
	if len(ids) != 1 {
		t.Fatalf("task.comms=%v want one entry", ids)
	}
}

// TestCommCreateBatch_MultiRow — two comms under the same task in
// one call; both succeed with distinct thread_ids and ids.
func TestCommCreateBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_create_batch_multi")
	f := seedCommCreateFixture(t, pool)

	rows := callCommCreateBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"task_id": intToStr(f.taskID), "channel_id": intToStr(f.channelID), "subject": "A"},
		{"task_id": intToStr(f.taskID), "channel_id": intToStr(f.channelID), "subject": "B"},
	})
	if len(rows) != 2 {
		t.Fatalf("rows: %d", len(rows))
	}
	type out struct {
		CommID   string `json:"comm_id"`
		ThreadID string `json:"thread_id"`
	}
	var got [2]out
	for i, r := range rows {
		if !r.OK {
			t.Fatalf("row %d: %+v", i, r)
		}
		_ = json.Unmarshal(r.Result, &got[i])
	}
	if got[0].CommID == got[1].CommID || got[0].ThreadID == got[1].ThreadID {
		t.Errorf("comms must be unique: %+v", got)
	}
}

// TestCommCreateBatch_PerRowFailure — mixed validation failures with
// happy siblings.
func TestCommCreateBatch_PerRowFailure(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_create_batch_perrow")
	f := seedCommCreateFixture(t, pool)
	rows := callCommCreateBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"task_id": intToStr(f.taskID), "channel_id": intToStr(f.channelID)},                  // happy
		{"task_id": "0", "channel_id": intToStr(f.channelID)},                                  // validation
		{"task_id": intToStr(f.taskID), "channel_id": "999999"},                                // channel_not_found
		{"task_id": "999999", "channel_id": intToStr(f.channelID)},                             // task_not_found
		{"task_id": intToStr(f.channelID), "channel_id": intToStr(f.channelID)},                // task_wrong_type
	})
	if len(rows) != 5 {
		t.Fatalf("rows: %d", len(rows))
	}
	if !rows[0].OK {
		t.Errorf("row 0 must pass: %+v", rows[0])
	}
	if rows[1].OK || rows[1].Code != "validation" {
		t.Errorf("row 1 want validation; got %+v", rows[1])
	}
	if rows[2].OK || rows[2].Code != "channel_not_found" {
		t.Errorf("row 2 want channel_not_found; got %+v", rows[2])
	}
	if rows[3].OK || rows[3].Code != "task_not_found" {
		t.Errorf("row 3 want task_not_found; got %+v", rows[3])
	}
	if rows[4].OK || rows[4].Code != "task_wrong_type" {
		t.Errorf("row 4 want task_wrong_type; got %+v", rows[4])
	}
}

// TestCommCreateBatch_ProjectMismatch — task in project A + channel
// in project B → 'project_mismatch'.
func TestCommCreateBatch_ProjectMismatch(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_create_batch_mismatch")
	f := seedCommCreateFixture(t, pool)
	// Second project + a channel under it (no flow needed; the
	// project_mismatch check fires before flow resolution).
	ctx := context.Background()
	var pid2, ch2 int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name='project' RETURNING id
	`).Scan(&pid2); err != nil {
		t.Fatalf("seed p2: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO card (card_type_id, parent_card_id)
		SELECT id, $1 FROM card_type WHERE name='comm_channel' RETURNING id
	`, pid2).Scan(&ch2); err != nil {
		t.Fatalf("seed ch2: %v", err)
	}
	rows := callCommCreateBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"task_id": intToStr(f.taskID), "channel_id": intToStr(ch2)},
	})
	if rows[0].OK || rows[0].Code != "project_mismatch" {
		t.Errorf("want project_mismatch; got %+v", rows[0])
	}
}

// TestCommCreateBatch_InitialMessage — an initial_message is an OUTBOUND
// message the actor sends to the recipients: it materialises a reply_body
// card with delivery_status='pending' (so the SMTP sender ships it), the
// channel's from_address as reply_from, the recipient emails as the reply_to
// To: snapshot, and reply_author = actor — then appends its id to
// comm.replies. (Regression: it used to be stored 'received', which rendered
// it as inbound-from-the-recipient and was never sent.)
func TestCommCreateBatch_InitialMessage(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_create_batch_initial")
	f := seedCommCreateFixture(t, pool)
	ctx := context.Background()

	// The channel needs a from_address for the outbound reply_from snapshot.
	if _, err := pool.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		SELECT $1, ad.id, to_jsonb($2::text) FROM attribute_def ad WHERE ad.name='from_address'
	`, f.channelID, "support@acme.test"); err != nil {
		t.Fatalf("seed from_address: %v", err)
	}

	mkPerson := func(email string) int64 {
		var id int64
		if err := pool.QueryRow(ctx, `
			INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name='person' RETURNING id
		`).Scan(&id); err != nil {
			t.Fatalf("mkPerson: %v", err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO attribute_value (card_id, attribute_def_id, value)
			SELECT $1, ad.id, to_jsonb($2::text) FROM attribute_def ad WHERE ad.name='email'
		`, id, email); err != nil {
			t.Fatalf("person email: %v", err)
		}
		return id
	}
	p1 := mkPerson("a@example.com")
	p2 := mkPerson("b@example.com")

	rows := callCommCreateBatch(t, pool, auth.SystemUserID, []map[string]any{
		{
			"task_id":              intToStr(f.taskID),
			"channel_id":           intToStr(f.channelID),
			"subject":              "Login issue",
			"initial_message":      "Cannot log in",
			"recipient_person_ids": []string{intToStr(p1), intToStr(p2)},
		},
	})
	if !rows[0].OK {
		t.Fatalf("happy: %+v", rows[0])
	}
	var got struct {
		CommID string `json:"comm_id"`
	}
	_ = json.Unmarshal(rows[0].Result, &got)

	var repliesJSON []byte
	if err := pool.QueryRow(ctx, `
		SELECT av.value FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id=$1 AND ad.name='replies'
	`, got.CommID).Scan(&repliesJSON); err != nil {
		t.Fatalf("read comm.replies: %v", err)
	}
	var replyIDs []int64
	if err := json.Unmarshal(repliesJSON, &replyIDs); err != nil {
		t.Fatalf("decode: %v: %s", err, repliesJSON)
	}
	if len(replyIDs) != 1 {
		t.Fatalf("replies=%v want one entry", replyIDs)
	}

	var status, body, subject, replyFrom, replyTo string
	var replyAuthor int64
	if err := pool.QueryRow(ctx, `
		SELECT
			(SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1 AND ad.name='delivery_status'),
			(SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1 AND ad.name='reply_body_text'),
			(SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1 AND ad.name='reply_subject'),
			(SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1 AND ad.name='reply_from'),
			(SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1 AND ad.name='reply_to'),
			(SELECT (av.value)::text::bigint FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id=$1 AND ad.name='reply_author')
	`, replyIDs[0]).Scan(&status, &body, &subject, &replyFrom, &replyTo, &replyAuthor); err != nil {
		t.Fatalf("reply attrs: %v", err)
	}
	if status != "pending" {
		t.Errorf("delivery_status=%q want pending (outbound, queued for SMTP)", status)
	}
	if body != "Cannot log in" {
		t.Errorf("body=%q", body)
	}
	if subject != "Login issue" {
		t.Errorf("subject=%q", subject)
	}
	if replyFrom != "support@acme.test" {
		t.Errorf("reply_from=%q want the channel from_address", replyFrom)
	}
	if replyTo != "a@example.com, b@example.com" {
		t.Errorf("reply_to=%q want the recipient To: snapshot", replyTo)
	}
	if replyAuthor != auth.SystemUserID {
		t.Errorf("reply_author=%d want actor %d", replyAuthor, auth.SystemUserID)
	}
}

// TestCommCreateBatch_InitialMessageNeedsRecipients — an initial message is
// sent TO someone, so omitting recipient_person_ids is rejected up front
// (before any card insert) with code='no_recipients', leaving no orphan comm.
func TestCommCreateBatch_InitialMessageNeedsRecipients(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_create_batch_initial_norecip")
	f := seedCommCreateFixture(t, pool)
	rows := callCommCreateBatch(t, pool, auth.SystemUserID, []map[string]any{
		{
			"task_id":         intToStr(f.taskID),
			"channel_id":      intToStr(f.channelID),
			"initial_message": "Hello?",
		},
	})
	if rows[0].OK || rows[0].Code != "no_recipients" {
		t.Errorf("want no_recipients; got %+v", rows[0])
	}
	// No comm card should have been created for the failed row.
	var commCount int
	if err := pool.QueryRow(context.Background(), `
		SELECT count(*) FROM card c JOIN card_type ct ON ct.id = c.card_type_id
		WHERE ct.name = 'comm' AND c.parent_card_id = $1
	`, f.taskID).Scan(&commCount); err != nil {
		t.Fatalf("count comms: %v", err)
	}
	if commCount != 0 {
		t.Errorf("orphan comm card(s) created: %d", commCount)
	}
}

// TestCommCreateBatch_NoCommFlow — a project without a comm flow
// fails with code='no_comm_flow'.
func TestCommCreateBatch_NoCommFlow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_create_batch_no_flow")
	f := seedCommCreateFixture(t, pool)
	// Strip the flow row so the lookup misses.
	if _, err := pool.Exec(context.Background(), `
		DELETE FROM flow WHERE scope_card_id = $1
	`, f.projectID); err != nil {
		t.Fatalf("delete flow: %v", err)
	}
	rows := callCommCreateBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"task_id": intToStr(f.taskID), "channel_id": intToStr(f.channelID)},
	})
	if rows[0].OK || rows[0].Code != "no_comm_flow" {
		t.Errorf("want no_comm_flow; got %+v (%s)", rows[0], rows[0].Message)
	}
	_ = strings.Contains // keep import used
}

// TestCommCreateBatch_WithRecipients — supplying recipient_person_ids
// writes the comm_recipients attribute as a numeric jsonb array.
func TestCommCreateBatch_WithRecipients(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_create_batch_recipients")
	f := seedCommCreateFixture(t, pool)
	ctx := context.Background()

	mkPerson := func(email string) int64 {
		var id int64
		if err := pool.QueryRow(ctx, `
			INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name='person' RETURNING id
		`).Scan(&id); err != nil {
			t.Fatalf("mkPerson: %v", err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO attribute_value (card_id, attribute_def_id, value)
			SELECT $1, ad.id, to_jsonb($2::text) FROM attribute_def ad WHERE ad.name='email'
		`, id, email); err != nil {
			t.Fatalf("person email: %v", err)
		}
		return id
	}
	p1 := mkPerson("a@example.com")
	p2 := mkPerson("b@example.com")

	rows := callCommCreateBatch(t, pool, auth.SystemUserID, []map[string]any{
		{
			"task_id":             intToStr(f.taskID),
			"channel_id":          intToStr(f.channelID),
			"recipient_person_ids": []string{intToStr(p1), intToStr(p2), intToStr(p1)}, // duplicate
		},
	})
	if !rows[0].OK {
		t.Fatalf("happy: %+v", rows[0])
	}
	var got struct {
		CommID string `json:"comm_id"`
	}
	_ = json.Unmarshal(rows[0].Result, &got)

	var stored []byte
	if err := pool.QueryRow(ctx, `
		SELECT av.value FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id=$1 AND ad.name='comm_recipients'
	`, got.CommID).Scan(&stored); err != nil {
		t.Fatalf("recipients: %v", err)
	}
	var ids []int64
	if err := json.Unmarshal(stored, &ids); err != nil {
		t.Fatalf("decode: %v: %s", err, stored)
	}
	if len(ids) != 2 || ids[0] != p1 || ids[1] != p2 {
		t.Errorf("recipients=%v want [%d %d] (dedup, first-seen order)", ids, p1, p2)
	}
}
