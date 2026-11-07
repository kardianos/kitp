package attribute_test

// A task's start is never after its due date (docs/TIMELINE_AND_CALENDAR.md
// T8): attribute.update and card.insert refuse such a pair with a
// 'validation' answer, the attribute_value_date_order trigger refuses it on
// every other path, and two writers of one card's dates take turns.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/activity"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

func dateOrderServer(t *testing.T, schema string) (*api.Server, *pgxpool.Pool) {
	t.Helper()
	reg.Reset()
	pool := store.TestPool(t, schema)
	sp := store.NewPool(pool)
	cardtype.Register()
	card.Register(sp)
	attribute.Register(sp)
	activity.Register(sp)
	return api.NewServer(sp), pool
}

// dateWrite is one attribute.update of a date; value "" removes it.
type dateWrite struct{ attr, value string }

// batch sends the writes as one batch, in order, and returns the first
// refusal (nil when every write went through).
func batch(t *testing.T, srv *api.Server, cardID int64, writes ...dateWrite) *api.ErrorEnvelope {
	t.Helper()
	var subs []api.SubRequest
	for i, w := range writes {
		var v any = w.value
		if w.value == "" {
			v = nil
		}
		b, err := json.Marshal(map[string]any{"card_id": fmt.Sprint(cardID), "attribute_name": w.attr, "value": v})
		if err != nil {
			t.Fatal(err)
		}
		subs = append(subs, api.SubRequest{ID: fmt.Sprint(i), Endpoint: "attribute", Action: "update", Data: b})
	}
	resp := srv.Dispatch(auth.WithSystemUser(context.Background()), api.BatchRequest{Subrequests: subs})
	for _, r := range resp.Subresponses {
		if !r.OK && r.Error != nil && r.Error.Code != "aborted" {
			return r.Error
		}
	}
	return nil
}

func storedDates(t *testing.T, pool *pgxpool.Pool, cardID int64) (start, due string) {
	t.Helper()
	var s, d *string
	if err := pool.QueryRow(context.Background(),
		`SELECT card_date($1, 'start_date'), card_date($1, 'due_date')`, cardID).Scan(&s, &d); err != nil {
		t.Fatal(err)
	}
	if s != nil {
		start = *s
	}
	if d != nil {
		due = *d
	}
	return start, due
}

func newDatedTask(t *testing.T, srv *api.Server, project int64, attrs map[string]any) api.SubResponse {
	t.Helper()
	return call(t, srv, "card", "insert", map[string]any{
		"card_type_name": "task", "parent_card_id": fmt.Sprint(project), "title": "T", "attributes": attrs,
	})
}

// TestStartNeverAfterDue walks one task through date writes in order; each
// step's batch either goes through or is refused whole, and the stored pair
// after it is checked either way.
func TestStartNeverAfterDue(t *testing.T) {
	srv, pool := dateOrderServer(t, "kitp_test_date_order")
	project := insertID(t, call(t, srv, "card", "insert", map[string]any{"card_type_name": "project", "title": "Dates"}))
	task := insertID(t, newDatedTask(t, srv, project, map[string]any{"start_date": "2026-11-10", "due_date": "2026-11-20"}))

	for _, s := range []struct {
		name               string
		writes             []dateWrite
		refused            string // "" = goes through; else part of the refusal
		wantStart, wantDue string
	}{
		{"start on the due day", []dateWrite{{"start_date", "2026-11-20"}}, "", "2026-11-20", "2026-11-20"},
		{"start after the due date", []dateWrite{{"start_date", "2026-11-21"}},
			"the start date 2026-11-21 is after the due date 2026-11-20", "2026-11-20", "2026-11-20"},
		{"due before the start", []dateWrite{{"due_date", "2026-11-19"}},
			"the start date 2026-11-20 is after the due date 2026-11-19", "2026-11-20", "2026-11-20"},
		{"move later, due first", []dateWrite{{"due_date", "2026-12-05"}, {"start_date", "2026-12-01"}}, "", "2026-12-01", "2026-12-05"},
		{"move later, start first", []dateWrite{{"start_date", "2026-12-10"}, {"due_date", "2026-12-15"}},
			"the start date 2026-12-10 is after the due date 2026-12-05", "2026-12-01", "2026-12-05"},
		{"move earlier, start first", []dateWrite{{"start_date", "2026-11-01"}, {"due_date", "2026-11-05"}}, "", "2026-11-01", "2026-11-05"},
		{"remove the due date", []dateWrite{{"due_date", ""}}, "", "2026-11-01", ""},
		{"a start with no due date", []dateWrite{{"start_date", "2027-01-01"}}, "", "2027-01-01", ""},
		{"a due date before that start", []dateWrite{{"due_date", "2026-12-31"}},
			"the start date 2027-01-01 is after the due date 2026-12-31", "2027-01-01", ""},
		{"remove the start date", []dateWrite{{"start_date", ""}}, "", "", ""},
		{"a due date with no start", []dateWrite{{"due_date", "2026-01-01"}}, "", "", "2026-01-01"},
	} {
		t.Run(s.name, func(t *testing.T) {
			e := batch(t, srv, task, s.writes...)
			switch {
			case s.refused == "" && e != nil:
				t.Fatalf("refused: %+v", e)
			case s.refused != "" && e == nil:
				t.Fatalf("went through, want refused with %q", s.refused)
			case s.refused != "" && (e.Code != "validation" || !strings.Contains(e.Message, s.refused)):
				t.Fatalf("refused with %+v, want validation %q", e, s.refused)
			}
			if start, due := storedDates(t, pool, task); start != s.wantStart || due != s.wantDue {
				t.Errorf("stored start %q due %q, want %q %q", start, due, s.wantStart, s.wantDue)
			}
		})
	}

	for _, c := range []struct {
		name    string
		attrs   map[string]any
		refused bool
	}{
		{"insert: start after due", map[string]any{"start_date": "2026-11-21", "due_date": "2026-11-20"}, true},
		{"insert: the same day", map[string]any{"start_date": "2026-11-20", "due_date": "2026-11-20"}, false},
		{"insert: a start only", map[string]any{"start_date": "2026-11-21"}, false},
		{"insert: a start and a null due", map[string]any{"start_date": "2026-11-21", "due_date": nil}, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			r := newDatedTask(t, srv, project, c.attrs)
			if r.OK == c.refused {
				t.Fatalf("ok = %v, want %v: %+v", r.OK, !c.refused, r.Error)
			}
			if c.refused && (r.Error.Code != "validation" || !strings.Contains(r.Error.Message, "is after the due date")) {
				t.Errorf("refused with %+v, want validation", r.Error)
			}
		})
	}
}

// TestDateOrderTrigger: a write that goes around the handlers is refused
// too, and one statement that writes both dates is judged on the pair it
// leaves, not row by row.
func TestDateOrderTrigger(t *testing.T) {
	srv, pool := dateOrderServer(t, "kitp_test_date_order_trigger")
	ctx := context.Background()
	project := insertID(t, call(t, srv, "card", "insert", map[string]any{"card_type_name": "project", "title": "Dates"}))
	task := insertID(t, newDatedTask(t, srv, project, map[string]any{"start_date": "2026-11-10", "due_date": "2026-11-20"}))

	const set = `UPDATE attribute_value av SET value = to_jsonb(v.value)
		FROM (VALUES ('start_date', $2::text), ('due_date', $3::text)) AS v(name, value)
		JOIN attribute_def ad ON ad.name = v.name
		WHERE av.card_id = $1 AND av.attribute_def_id = ad.id AND v.value IS NOT NULL`
	for _, c := range []struct {
		name       string
		start, due any
		refused    bool
	}{
		{"start past the due date", "2026-11-25", nil, true},
		{"due before the start", nil, "2026-11-01", true},
		// Row by row this passes through start 2027-03-01 / due 2026-11-20.
		{"both later in one statement", "2027-03-01", "2027-03-10", false},
		{"both earlier in one statement", "2026-01-01", "2026-01-02", false},
	} {
		t.Run(c.name, func(t *testing.T) {
			_, err := pool.Exec(ctx, set, task, c.start, c.due)
			if c.refused {
				if err == nil || !strings.Contains(err.Error(), "is after the due date") {
					t.Fatalf("err = %v, want the date-order refusal", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("refused: %v", err)
			}
		})
	}
	if start, due := storedDates(t, pool, task); start != "2026-01-01" || due != "2026-01-02" {
		t.Errorf("stored start %q due %q, want 2026-01-01 2026-01-02", start, due)
	}
}

// TestDateWritersTakeTurns: while one transaction has moved the start, a
// second that moves the due date before it waits for the first to commit,
// then reads its start and is refused — it doesn't pass against the start
// it would have read before.
func TestDateWritersTakeTurns(t *testing.T) {
	srv, pool := dateOrderServer(t, "kitp_test_date_order_turns")
	ctx := context.Background()
	project := insertID(t, call(t, srv, "card", "insert", map[string]any{"card_type_name": "project", "title": "Dates"}))
	task := insertID(t, newDatedTask(t, srv, project, map[string]any{"start_date": "2026-11-10", "due_date": "2026-11-20"}))

	update := func(attr, value string) string {
		b, err := json.Marshal([]map[string]any{{"card_id": fmt.Sprint(task), "attribute_name": attr, "value": value}})
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	const run = `SELECT ok, coalesce(code, ''), coalesce(message, '') FROM attribute_update_batch(1, $1::jsonb)`

	first, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		// Rolled back only if the test stops before the commit below.
		if rerr := first.Rollback(ctx); rerr != nil && !errors.Is(rerr, pgx.ErrTxClosed) {
			t.Errorf("rollback: %v", rerr)
		}
	}()
	var ok bool
	var code, msg string
	if err := first.QueryRow(ctx, run, update("start_date", "2026-11-18")).Scan(&ok, &code, &msg); err != nil || !ok {
		t.Fatalf("first writer: ok=%v code=%q msg=%q err=%v", ok, code, msg, err)
	}

	type answer struct {
		ok        bool
		code, msg string
		err       error
	}
	secondInput := update("due_date", "2026-11-15")
	second := make(chan answer, 1)
	go func() {
		var a answer
		a.err = pool.QueryRow(ctx, run, secondInput).Scan(&a.ok, &a.code, &a.msg)
		second <- a
	}()
	select {
	case a := <-second:
		t.Fatalf("the second writer didn't wait for the first: %+v", a)
	case <-time.After(300 * time.Millisecond):
	}
	if err := first.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	a := <-second
	if a.err != nil {
		t.Fatalf("second writer: %v", a.err)
	}
	if a.ok || a.code != "validation" || !strings.Contains(a.msg, "the start date 2026-11-18 is after the due date 2026-11-15") {
		t.Errorf("second writer: ok=%v code=%q msg=%q, want refused against the first's start", a.ok, a.code, a.msg)
	}
	if start, due := storedDates(t, pool, task); start != "2026-11-18" || due != "2026-11-20" {
		t.Errorf("stored start %q due %q, want 2026-11-18 2026-11-20", start, due)
	}
}
