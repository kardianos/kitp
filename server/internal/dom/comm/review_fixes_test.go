package comm_test

// Review fixes, area 3 (docs/REVIEW_FIXES.md): mail in areas that are off
// (A3), thread matches across projects (A3), comm.attach (A15, A23) and a
// thread's comments on its task (A13).

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/dom/comm"
)

func setArea(t *testing.T, f *fixture, project int64, area string, on bool) {
	t.Helper()
	ctx := context.Background()
	if on {
		if _, err := f.sp.P.Exec(ctx, `DELETE FROM project_area WHERE project_id = $1 AND area_key = $2`, project, area); err != nil {
			t.Fatal(err)
		}
		return
	}
	if _, err := f.sp.P.Exec(ctx, `
		INSERT INTO project_area (project_id, area_key, state) VALUES ($1, $2, 'off')
		ON CONFLICT (project_id, area_key) DO UPDATE SET state = 'off'`, project, area); err != nil {
		t.Fatal(err)
	}
}

// threadWithID inserts a comm under parent carrying thread id tid.
func threadWithID(t *testing.T, f *fixture, parent int64, tid string) int64 {
	t.Helper()
	var id int64
	if err := f.sp.P.QueryRow(context.Background(), `
		WITH c AS (INSERT INTO card (card_type_id, parent_card_id) SELECT id, $1 FROM card_type WHERE name = 'comm' RETURNING id)
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		SELECT c.id, ad.id, to_jsonb($2::text) FROM c, attribute_def ad WHERE ad.name = 'thread_id'
		RETURNING card_id`, parent, tid).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// TestIntakeWithTasksOff (A3): with Tasks off, a task-mode account's new
// mail becomes a thread on its own — in view — not a hidden task.
func TestIntakeWithTasksOff(t *testing.T) {
	f := setupAdmin(t, "kitp_test_intake_tasks_off")
	ch := seedChannelWith(t, f, `"intake_mode":"task"`)
	setArea(t, f, f.projectID, "tasks", false)
	tasks0 := countCards(t, f, "task")
	pollOnce(t, f, ch, inbound(1, "Printer on fire", "It is on fire."))
	if got := countCards(t, f, "task") - tasks0; got != 0 {
		t.Errorf("new tasks with Tasks off = %d, want 0", got)
	}
	if got := commsUnder(t, f, f.projectID); len(got) != 1 {
		t.Errorf("threads on their own = %v, want the new mail as one", got)
	}
}

// TestThreadMatchStaysInView (A3): a reply's thread id only matches a
// thread in the account's own project that anyone can see; otherwise the
// message is new mail here, not appended elsewhere or out of sight.
func TestThreadMatchStaysInView(t *testing.T) {
	f := setupAdmin(t, "kitp_test_thread_match_scope")
	ch := seedChannelWith(t, f, `"intake_mode":"thread"`)
	ctx := context.Background()
	var other int64
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'project' RETURNING id`).Scan(&other); err != nil {
		t.Fatal(err)
	}
	elsewhere := threadWithID(t, f, other, "Zz0000000A")
	pollOnce(t, f, ch, inbound(1, "Re: hello [#Zz0000000A]", "Injected?"))
	if n := replyCountOf(t, f, elsewhere); n != 0 {
		t.Errorf("mail to this account was appended to another project's thread (%d replies)", n)
	}
	if got := commsUnder(t, f, f.projectID); len(got) != 1 {
		t.Errorf("threads here = %v, want the message as new mail", got)
	}

	onTask := threadWithID(t, f, f.taskID, "Yy0000000B")
	setArea(t, f, f.projectID, "tasks", false)
	pollOnce(t, f, ch, inbound(2, "Re: printer [#Yy0000000B]", "Still broken."))
	if n := replyCountOf(t, f, onTask); n != 0 {
		t.Errorf("mail was appended to a thread hidden with Tasks off (%d replies)", n)
	}
	if got := commsUnder(t, f, f.projectID); len(got) != 2 {
		t.Errorf("threads here = %v, want the reply as new, visible mail", got)
	}
}

// TestSMTPHoldsHiddenThreads (A3): a queued reply on a thread in an area
// that is off waits, and sends once the area is back on.
func TestSMTPHoldsHiddenThreads(t *testing.T) {
	f := setupAdmin(t, "kitp_test_smtp_hidden")
	channelID, replyID := seedPendingReply(t, f, "kitp@example.com")
	setArea(t, f, f.projectID, "tasks", false) // the thread is on a task
	rt := &recordingTransport{}
	s := comm.NewSMTPSenderForTest(f.sp, channelID, time.Second)
	s.SetTransport(rt.fn)
	if err := s.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(rt.calls) != 0 || statusOf(t, f, replyID) != "pending" {
		t.Fatalf("a reply on a hidden thread went out: %d sends, status %s", len(rt.calls), statusOf(t, f, replyID))
	}
	setArea(t, f, f.projectID, "tasks", true)
	if err := s.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(rt.calls) != 1 {
		t.Errorf("after Tasks is back on: %d sends, want 1", len(rt.calls))
	}
}

// TestCommAttachMakeTaskAndAreas (A15, A23): Make a task is one request
// (the task and the attach together); with Tasks off both attach and Make
// a task say area_off, and no task is left behind.
func TestCommAttachMakeTaskAndAreas(t *testing.T) {
	f := setupAdmin(t, "kitp_test_comm_attach_make")
	ch := seedChannelWith(t, f, `"intake_mode":"thread"`)
	pollOnce(t, f, ch, inbound(1, "Invoice question", "Why two invoices?"))
	thread := commsUnder(t, f, f.projectID)[0]

	var out comm.CommAttachOutput
	dispatch(t, f, api.SubRequest{ID: "m", Endpoint: "comm", Action: "attach",
		Data: json.RawMessage(fmt.Sprintf(`{"comm_id":"%d","new_task_title":"Two invoices"}`, thread))}, &out)
	if out.TaskID == 0 || out.ParentID != out.TaskID {
		t.Fatalf("make a task = %+v", out)
	}
	var title string
	if err := f.sp.P.QueryRow(context.Background(), `
		SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1 AND ad.name = 'title'`, out.TaskID).Scan(&title); err != nil || title != "Two invoices" {
		t.Errorf("the new task's title = %q (%v)", title, err)
	}
	if got := taskComms(t, f, out.TaskID); len(got) != 1 || got[0] != thread {
		t.Errorf("the new task's comms = %v", got)
	}
	dispatch(t, f, api.SubRequest{ID: "d", Endpoint: "comm", Action: "attach",
		Data: json.RawMessage(fmt.Sprintf(`{"comm_id":"%d","task_id":"0"}`, thread))}, &out)

	setArea(t, f, f.projectID, "tasks", false)
	tasks0 := countCards(t, f, "task")
	for _, data := range []string{
		fmt.Sprintf(`{"comm_id":"%d","task_id":"%d"}`, thread, f.taskID),
		fmt.Sprintf(`{"comm_id":"%d","new_task_title":"Nope"}`, thread),
	} {
		if e := dispatchExpectErr(t, f, api.SubRequest{ID: "a", Endpoint: "comm", Action: "attach", Data: json.RawMessage(data)}); e.Code != "area_off" {
			t.Errorf("%s with Tasks off: %s (%s), want area_off", data, e.Code, e.Message)
		}
	}
	if got := countCards(t, f, "task") - tasks0; got != 0 {
		t.Errorf("a refused Make a task left %d tasks", got)
	}
}

// TestTaskShowsItsThreadsComments (A13): once a thread is on a task, the
// task's activity (with_thread_comments) includes the comments made on
// the thread — not the thread's other activity.
func TestTaskShowsItsThreadsComments(t *testing.T) {
	f := setupAdmin(t, "kitp_test_thread_comments")
	ctx := context.Background()
	thread := threadWithID(t, f, f.taskID, "Ww0000000C")
	var comment, other int64
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO activity (card_id, kind, actor_id) VALUES ($1, 'comment', $2) RETURNING id`, thread, f.adminID).Scan(&comment); err != nil {
		t.Fatal(err)
	}
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO activity (card_id, kind, actor_id) VALUES ($1, 'card_create', $2) RETURNING id`, thread, f.adminID).Scan(&other); err != nil {
		t.Fatal(err)
	}
	ids := func(with bool) map[int64]bool {
		t.Helper()
		in, _ := json.Marshal([]map[string]any{{"card_id": fmt.Sprint(f.taskID), "with_thread_comments": with}})
		var res []byte
		if err := f.sp.P.QueryRow(ctx, `SELECT result FROM activity_select_batch($1, $2::jsonb)`, f.adminID, in).Scan(&res); err != nil {
			t.Fatal(err)
		}
		var out struct {
			Rows []struct {
				ID int64 `json:"id,string"`
			} `json:"rows"`
		}
		if err := json.Unmarshal(res, &out); err != nil {
			t.Fatal(err)
		}
		m := map[int64]bool{}
		for _, r := range out.Rows {
			m[r.ID] = true
		}
		return m
	}
	if got := ids(true); !got[comment] || got[other] {
		t.Errorf("with_thread_comments: comment %v (want true), thread's other activity %v (want false)", got[comment], got[other])
	}
	if got := ids(false); got[comment] {
		t.Error("without the flag the task's activity includes its thread's comment")
	}
}
