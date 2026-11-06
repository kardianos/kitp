// review9_unborn_test.go: the round-8 review's dispatcher findings
// (2026-11-06): a card made while its group runs, and attachment ids.
package api_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/activity"
	"github.com/kitp/kitp/server/internal/dom/attachment"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/dom/file"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// waitBlockedBy waits until some backend waits on a lock held by pid.
func waitBlockedBy(t *testing.T, sp *store.Pool, pid int) {
	t.Helper()
	for i := 0; i < 1000; i++ {
		var blocked bool
		if err := sp.P.QueryRow(context.Background(), `
			SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid)))`, pid).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("the batch never waited on the held row")
}

func titleOf(t *testing.T, sp *store.Pool, id int64) string {
	t.Helper()
	var title string
	if err := sp.P.QueryRow(context.Background(), `
		SELECT av.value #>> '{}' FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'title'
		WHERE av.card_id = $1`, id).Scan(&title); err != nil {
		t.Fatal(err)
	}
	return title
}

// TestACardMadeWhileItsGroupRunsIsRefused (round 8 #1): consecutive
// sub-requests of one handler run in one statement, which reads on fresh
// snapshots as it goes. A worker of A edits their own task, then the next
// free card id; B's task takes that id while the group waits on the first
// edit's row. The group's later input sees it, so the dispatcher looks
// again after the statement and fails the batch.
func TestACardMadeWhileItsGroupRunsIsRefused(t *testing.T) {
	srv, sp := setupAuthz(t, "kitp_test_r9_unborn_group")
	ctx := context.Background()
	projA, taskA := makeProjectAndTask(t, srv, "A")
	projB, _ := makeProjectAndTask(t, srv, "B")
	worker := grantRole(t, sp, "worker-A", "worker", &projA)
	statusB := store.TemplateStatusID(t, sp.P, projB, "Todo")

	hold, err := sp.P.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = hold.Rollback(ctx) }() // a no-op once released below
	var pid int
	if err := hold.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	if _, err := hold.Exec(ctx, `
		SELECT 1 FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'title'
		WHERE av.card_id = $1 FOR UPDATE OF av`, taskA); err != nil {
		t.Fatal(err)
	}
	var next int64
	if err := sp.P.QueryRow(ctx, `SELECT nextval(pg_get_serial_sequence('card', 'id')) + 1`).Scan(&next); err != nil {
		t.Fatal(err)
	}
	done := make(chan api.BatchResponse, 1)
	go func() {
		done <- r8As(srv, worker,
			r8Sub("own", "attribute", "update", fmt.Sprintf(`{"card_id":"%d","attribute_name":"title","value":"mine"}`, taskA)),
			r8Sub("hit", "attribute", "update", fmt.Sprintf(`{"card_id":"%d","attribute_name":"title","value":"defaced"}`, next)))
	}()
	waitBlockedBy(t, sp, pid)
	vr := srv.Dispatch(auth.WithSystemUser(ctx), api.BatchRequest{Subrequests: []api.SubRequest{
		r8Sub("v", "card", "insert", fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"B plan","attributes":{"status":"%d"}}`, projB, statusB)),
	}})
	if !vr.Subresponses[0].OK {
		t.Fatalf("B's task: %+v", vr.Subresponses[0].Error)
	}
	var made card.InsertOutput
	buf, _ := json.Marshal(vr.Subresponses[0].Data)
	if err := json.Unmarshal(buf, &made); err != nil {
		t.Fatal(err)
	}
	if made.ID != next {
		t.Fatalf("B's task is %d, the batch aimed at %d", made.ID, next)
	}
	if err := hold.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	res := <-done
	if c := r8Code(res); c != "card_not_found" {
		t.Errorf("the batch: %q, want card_not_found", c)
	}
	if got := titleOf(t, sp, next); got != "B plan" {
		t.Errorf("B's task is titled %q", got)
	}
	if got := titleOf(t, sp, taskA); got != "task1" {
		t.Errorf("the failed batch kept its first edit: %q", got)
	}
}

// TestAttachmentWritesAskTheGrantThemselves (round 8 #4): an attachment id
// with no row at authz gives the dispatcher no card to check, so
// attachment.delete and attachment.download_url ask card.update on the
// attachment's card themselves.
func TestAttachmentWritesAskTheGrantThemselves(t *testing.T) {
	reg.Reset()
	sp := store.NewPool(store.TestPool(t, "kitp_test_r9_attach_grant"))
	echo.Register()
	cardtype.Register()
	card.Register(sp)
	attribute.Register(sp)
	activity.Register(sp)
	attachment.Register(sp)
	file.Register(sp)
	srv := api.NewServer(sp)
	ctx := context.Background()
	projA, taskA := makeProjectAndTask(t, srv, "A")
	_, taskB := makeProjectAndTask(t, srv, "B")
	worker := grantRole(t, sp, "worker-A", "worker", &projA)
	add := func(onCard int64) int64 {
		t.Helper()
		var id int64
		if err := sp.P.QueryRow(ctx, `
			WITH f AS (INSERT INTO file (filename, size_bytes, mime_type, created_by) VALUES ('x.pdf', 10, 'application/pdf', $2) RETURNING id)
			INSERT INTO attachment (card_id, file_id) SELECT $1, f.id FROM f RETURNING id`, onCard, worker).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	inB, inA := add(taskB), add(taskA)
	for _, fn := range []string{"attachment_download_url_batch", "attachment_delete_batch"} {
		for _, c := range []struct {
			id   int64
			want string
		}{{inB, "unauthorized"}, {inA, ""}} {
			var code string
			if err := sp.P.QueryRow(ctx, fmt.Sprintf(`SELECT code FROM %s($1, $2::jsonb)`, fn),
				worker, fmt.Sprintf(`[{"id":"%d"}]`, c.id)).Scan(&code); err != nil {
				t.Fatalf("%s: %v", fn, err)
			}
			if code != c.want {
				t.Errorf("%s of attachment %d by a worker of A: %q, want %q", fn, c.id, code, c.want)
			}
		}
	}
}
