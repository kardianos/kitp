package card_test

import (
	"context"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/store"
)

// scopedWorker inserts a login holding worker on the given projects.
func scopedWorker(t *testing.T, pool *pgxpool.Pool, projects ...int64) int64 {
	t.Helper()
	ctx := context.Background()
	var id int64
	if err := pool.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ('scoped') RETURNING id`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	for _, p := range projects {
		if _, err := pool.Exec(ctx, `INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT $1, id, $2 FROM role WHERE name = 'worker'`, id, p); err != nil {
			t.Fatal(err)
		}
	}
	return id
}

func switchOff(t *testing.T, pool *pgxpool.Pool, project int64, area string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `INSERT INTO project_area (project_id, area_key, state) VALUES ($1, $2, 'off')`, project, area); err != nil {
		t.Fatal(err)
	}
}

// TestTaskMoveBatch_Destination (B6, A16): the dispatcher authorizes a
// move against the task's own project; the destination needs the actor's
// grant too, and its Tasks area must be on.
func TestTaskMoveBatch_Destination(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_task_move_destination")
	p1, _ := seedProjectWithStatus(t, pool)
	p2, s2 := seedProjectWithStatus(t, pool)
	p3, s3 := seedProjectWithStatus(t, pool)
	task := seedCardUnder(t, pool, "task", p1)
	move := func(actor, to, status int64) taskMoveRow {
		t.Helper()
		rows := callTaskMoveBatch(t, pool, actor, []map[string]any{{
			"card_id": strconv.FormatInt(task, 10), "new_project_id": strconv.FormatInt(to, 10), "new_status_id": strconv.FormatInt(status, 10),
		}})
		return rows[0]
	}
	onlySource := scopedWorker(t, pool, p1)
	if r := move(onlySource, p2, s2); r.OK || r.Code != "forbidden" {
		t.Errorf("a worker on the source only moved a task into another project: %+v", r)
	}
	both := scopedWorker(t, pool, p1, p2, p3)
	switchOff(t, pool, p3, "tasks")
	if r := move(both, p3, s3); r.OK || r.Code != "area_off" {
		t.Errorf("a task moved into a project with Tasks off: %+v", r)
	}
	if r := move(both, p2, s2); !r.OK {
		t.Errorf("a worker on both projects: %+v", r)
	}
}

// TestCardMoveBatch_Destination (B6, A16): card.move into another project
// needs a grant there, an invisible parent reads as missing, and the
// destination's area must be on.
func TestCardMoveBatch_Destination(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_move_destination")
	p1 := seedCardUnder(t, pool, "project", 0)
	p2 := seedCardUnder(t, pool, "project", 0)
	p3 := seedCardUnder(t, pool, "project", 0)
	task := seedCardUnder(t, pool, "task", p1)
	move := func(actor, to int64) cardMoveRow {
		t.Helper()
		return callCardMoveBatch(t, pool, actor, []map[string]any{{
			"card_id": strconv.FormatInt(task, 10), "new_parent_card_id": strconv.FormatInt(to, 10),
		}})[0]
	}
	onlySource := scopedWorker(t, pool, p1)
	if r := move(onlySource, p2); r.OK || r.Code != "parent_not_found" {
		t.Errorf("a parent the actor can't see: want parent_not_found, got %+v", r)
	}
	// Sees p2 (a viewer role there) but may not update tasks in it.
	var viewer int64
	if err := pool.QueryRow(context.Background(), `SELECT id FROM role WHERE name = 'viewer'`).Scan(&viewer); err == nil {
		if _, err := pool.Exec(context.Background(), `INSERT INTO user_role (user_id, role_id, scope_card_id) VALUES ($1, $2, $3)`, onlySource, viewer, p2); err != nil {
			t.Fatal(err)
		}
		if r := move(onlySource, p2); r.OK || r.Code != "forbidden" {
			t.Errorf("a viewer of the destination moved a task into it: %+v", r)
		}
	}
	both := scopedWorker(t, pool, p1, p2, p3)
	switchOff(t, pool, p3, "tasks")
	if r := move(both, p3); r.OK {
		t.Errorf("a task moved into a project with Tasks off: %+v", r)
	}
	if r := move(both, p2); !r.OK {
		t.Errorf("a worker on both projects: %+v", r)
	}
}
