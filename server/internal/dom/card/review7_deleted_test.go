package card_test

import (
	"context"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

// underDeleted reads card_under_deleted for one card.
func underDeleted(t *testing.T, pool *pgxpool.Pool, id int64) bool {
	t.Helper()
	var v bool
	if err := pool.QueryRow(context.Background(), `SELECT card_under_deleted($1)`, id).Scan(&v); err != nil {
		t.Fatalf("card_under_deleted(%d): %v", id, err)
	}
	return v
}

// listedIDs is what card.select_with_attributes lists of a card type.
func listedIDs(t *testing.T, pool *pgxpool.Pool, cardType string) map[string]bool {
	t.Helper()
	rows := callCardSelectWithAttrsBatch(t, pool, auth.SystemUserID, []map[string]any{{"card_type_name": cardType}})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("select %s: %+v", cardType, rows)
	}
	out := map[string]bool{}
	for _, r := range decodeSWA(t, rows[0].Result).Rows {
		out[r.ID] = true
	}
	return out
}

// TestWhatIsUnderADeletedCardGoesWithIt: card.delete marks one card, and
// what is under it goes with it — a thread on a deleted task (and its
// messages), a task in a deleted project — from the lists, and comes back
// with card.undelete. Found on the demo (2026-11-06): a deleted task's
// thread stayed on the Comms screen and opening it failed (approval.list:
// task not found).
func TestWhatIsUnderADeletedCardGoesWithIt(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_under_deleted")
	ctx := context.Background()
	projectID, taskID := seedProjectWithTask(t, pool, "gone")
	var commID, replyID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO card (card_type_id, parent_card_id)
		SELECT id, $1 FROM card_type WHERE name = 'comm' RETURNING id`, taskID).Scan(&commID); err != nil {
		t.Fatalf("comm: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'reply_body' RETURNING id`).Scan(&replyID); err != nil {
		t.Fatalf("reply: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		SELECT $1, id, jsonb_build_array($2::bigint) FROM attribute_def WHERE name = 'replies'`, commID, replyID); err != nil {
		t.Fatalf("replies: %v", err)
	}
	comm, task := strconv.FormatInt(commID, 10), strconv.FormatInt(taskID, 10)

	for _, id := range []int64{projectID, taskID, commID, replyID} {
		if underDeleted(t, pool, id) {
			t.Fatalf("card %d is under a deleted card before anything was deleted", id)
		}
	}
	if !listedIDs(t, pool, "comm")[comm] {
		t.Fatal("the thread isn't listed to begin with")
	}

	del := func(id int64) {
		t.Helper()
		if r := callCardDeleteBatch(t, pool, auth.SystemUserID, []map[string]any{{"card_id": strconv.FormatInt(id, 10)}}); len(r) != 1 || !r[0].OK {
			t.Fatalf("delete %d: %+v", id, r)
		}
	}
	undel := func(id int64) {
		t.Helper()
		if r := callCardUndeleteBatch(t, pool, auth.SystemUserID, []map[string]any{{"card_id": strconv.FormatInt(id, 10)}}); len(r) != 1 || !r[0].OK {
			t.Fatalf("undelete %d: %+v", id, r)
		}
	}

	// The task goes: its thread and the thread's message go with it.
	del(taskID)
	if underDeleted(t, pool, taskID) {
		t.Error("a deleted card's own deleted_at counts; callers check that themselves")
	}
	if !underDeleted(t, pool, commID) || !underDeleted(t, pool, replyID) {
		t.Errorf("thread %v, message %v: want both under the deleted task",
			underDeleted(t, pool, commID), underDeleted(t, pool, replyID))
	}
	if listedIDs(t, pool, "comm")[comm] {
		t.Error("a deleted task's thread is still listed")
	}
	undel(taskID)
	if !listedIDs(t, pool, "comm")[comm] || underDeleted(t, pool, commID) {
		t.Error("card.undelete of the task doesn't bring its thread back")
	}

	// The project goes: its tasks go with it.
	del(projectID)
	if listedIDs(t, pool, "task")[task] || listedIDs(t, pool, "comm")[comm] {
		t.Error("a deleted project's task or thread is still listed")
	}
	undel(projectID)
	if !listedIDs(t, pool, "task")[task] {
		t.Error("card.undelete of the project doesn't bring its task back")
	}
}
