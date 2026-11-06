package attribute_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/card"
)

// TestTwoScreensCantTakeOneSlugAtOnce (review 2026-11-06 round 8 L19): the
// slug check reads the other screens, then writes. Two writers of one slug
// in one project each saw it free; now the second waits for the first and
// then sees it taken.
func TestTwoScreensCantTakeOneSlugAtOnce(t *testing.T) {
	srv, sp := setup(t, "kitp_test_r9_slug_race")
	ctx := auth.WithSystemUser(context.Background())
	projectID := mustInsertProject(t, srv, ctx, "P")
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "s", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"screen","parent_card_id":"%d"}`, projectID))},
	}})
	mustOK(t, resp.Subresponses[0])
	var sOut card.SelectWithAttributesOutput
	raw(t, resp.Subresponses[0], &sOut)
	if len(sOut.Rows) < 2 {
		t.Fatalf("want two seeded screens, got %d", len(sOut.Rows))
	}
	a, b := sOut.Rows[0].ID, sOut.Rows[1].ID
	pool := sp.P
	bg := context.Background()
	set := func(q interface {
		QueryRow(context.Context, string, ...any) pgx.Row
	}, screen int64) (bool, string) {
		var ok bool
		var code string
		if err := q.QueryRow(bg, `SELECT ok, code FROM attribute_update_batch(1, $1::jsonb)`,
			fmt.Sprintf(`[{"card_id":"%d","attribute_name":"slug","value":"taken-twice"}]`, screen)).Scan(&ok, &code); err != nil {
			t.Errorf("attribute_update_batch: %v", err)
		}
		return ok, code
	}
	first, err := pool.Begin(bg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := first.Rollback(bg); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			t.Logf("rollback: %v", err)
		}
	}()
	var pid int32
	if err := first.QueryRow(bg, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	if ok, code := set(first, a); !ok {
		t.Fatalf("first writer: %s", code)
	}
	type res struct {
		ok   bool
		code string
	}
	second := make(chan res, 1)
	go func() {
		ok, code := set(pool, b)
		second <- res{ok, code}
	}()
	deadline := time.Now().Add(15 * time.Second)
	for {
		var n int
		if err := pool.QueryRow(bg, `SELECT count(*) FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))`, pid).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the second writer never waited for the first")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := first.Commit(bg); err != nil {
		t.Fatal(err)
	}
	if r := <-second; r.ok || r.code != "slug_in_use" {
		t.Errorf("second writer of the same slug: ok=%v code=%q, want slug_in_use", r.ok, r.code)
	}
}
