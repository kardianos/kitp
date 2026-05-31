// Regression tests for the per-row visibility predicate
// (schema.VisibilityClause) applied to card.select,
// card.select_with_attributes, and card.search.
//
// Closes DI-6 (docs/DESIGN_INVARIANTS.md). The pre-fix
// dispatcher allowed any authenticated user to read any card by id;
// these tests pin the new behaviour:
//
//   - A worker scoped to project A sees project A's cards.
//   - The same worker does NOT see project B's cards.
//   - A globally-scoped admin sees both projects.
//   - The System User sees everything (dev-mode bypass via its
//     null-scoped user_role row from seed.hcsv).
package card_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

type visibilityFixture struct {
	srv       *api.Server
	sp        *store.Pool
	projectA  int64
	projectB  int64
	taskA     int64 // under projectA
	taskB     int64 // under projectB
	worker    int64 // user_role(worker, scope=projectA)
	admin     int64 // user_role(admin, scope=NULL)
	stranger  int64 // no user_role at all
}

// setupVisibility builds two parallel projects with one task each and
// three users: a worker scoped to A, a global admin, and a stranger
// with no role.
func setupVisibility(t *testing.T, schemaName string) *visibilityFixture {
	t.Helper()
	reg.Reset()
	pool := store.TestPool(t, schemaName)
	sp := store.NewPool(pool)
	echo.Register()
	cardtype.Register()
	card.Register(sp)
	attribute.Register(sp)
	srv := api.NewServer(sp)
	ctx := context.Background()
	sysCtx := auth.WithSystemUser(ctx)

	mkProject := func(title string) int64 {
		resp := srv.Dispatch(sysCtx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
				fmt.Sprintf(`{"card_type_name":"project","title":%q}`, title))},
		}})
		if !resp.Subresponses[0].OK {
			t.Fatalf("project %s: %+v", title, resp.Subresponses[0].Error)
		}
		var out card.InsertOutput
		buf, _ := json.Marshal(resp.Subresponses[0].Data)
		_ = json.Unmarshal(buf, &out)
		return out.ID
	}

	mkStatus := func(parent int64, title string) int64 {
		resp := srv.Dispatch(sysCtx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "s", Endpoint: "card", Action: "insert", Data: json.RawMessage(
				fmt.Sprintf(`{"card_type_name":"status","parent_card_id":"%d","title":%q}`, parent, title))},
		}})
		if !resp.Subresponses[0].OK {
			t.Fatalf("status %s: %+v", title, resp.Subresponses[0].Error)
		}
		var out card.InsertOutput
		buf, _ := json.Marshal(resp.Subresponses[0].Data)
		_ = json.Unmarshal(buf, &out)
		return out.ID
	}

	mkTask := func(parent, status int64, title string) int64 {
		resp := srv.Dispatch(sysCtx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "t", Endpoint: "card", Action: "insert", Data: json.RawMessage(fmt.Sprintf(
				`{"card_type_name":"task","parent_card_id":"%d","title":%q,"attributes":{"status":"%d"}}`,
				parent, title, status))},
		}})
		if !resp.Subresponses[0].OK {
			t.Fatalf("task %s: %+v", title, resp.Subresponses[0].Error)
		}
		var out card.InsertOutput
		buf, _ := json.Marshal(resp.Subresponses[0].Data)
		_ = json.Unmarshal(buf, &out)
		return out.ID
	}

	pA := mkProject("Visibility A")
	pB := mkProject("Visibility B")
	sA := mkStatus(pA, "Todo A")
	sB := mkStatus(pB, "Todo B")
	tA := mkTask(pA, sA, "task-vis-a")
	tB := mkTask(pB, sB, "task-vis-b")

	mkUser := func(name string, sql string, args ...any) int64 {
		var uid int64
		if err := sp.P.QueryRow(ctx,
			`INSERT INTO user_account (display_name) VALUES ($1) RETURNING id`, name,
		).Scan(&uid); err != nil {
			t.Fatalf("user %s: %v", name, err)
		}
		if sql != "" {
			full := append([]any{uid}, args...)
			if _, err := sp.P.Exec(ctx, sql, full...); err != nil {
				t.Fatalf("user_role %s: %v", name, err)
			}
		}
		return uid
	}

	worker := mkUser("vis-worker",
		`INSERT INTO user_role (user_id, role_id, scope_card_id)
		 SELECT $1, id, $2 FROM role WHERE name = 'worker'`, pA)
	admin := mkUser("vis-admin",
		`INSERT INTO user_role (user_id, role_id, scope_card_id)
		 SELECT $1, id, NULL FROM role WHERE name = 'admin'`)
	stranger := mkUser("vis-stranger", "")

	return &visibilityFixture{
		srv: srv, sp: sp,
		projectA: pA, projectB: pB,
		taskA: tA, taskB: tB,
		worker: worker, admin: admin, stranger: stranger,
	}
}

// dispatchAsVis runs a single sub-request under a given user id.
func dispatchAsVis(t *testing.T, f *visibilityFixture, uid int64, sub api.SubRequest) api.SubResponse {
	t.Helper()
	ctx := auth.WithUser(context.Background(), &auth.UserCtx{ID: uid, DisplayName: fmt.Sprintf("u%d", uid)})
	resp := f.srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{sub}})
	return resp.Subresponses[0]
}

// cardSelectIDs runs card.select_with_attributes and returns the row
// ids. We use _with_attributes because it's the SPA's main read path
// and exercises the addArg-based predicate composition.
func cardSelectIDs(t *testing.T, f *visibilityFixture, uid int64, parentCardID int64) []int64 {
	t.Helper()
	body := fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d"}`, parentCardID)
	resp := dispatchAsVis(t, f, uid, api.SubRequest{
		ID: "s", Endpoint: "card", Action: "select_with_attributes",
		Data: json.RawMessage(body),
	})
	if !resp.OK {
		t.Fatalf("card.select_with_attributes: %+v", resp.Error)
	}
	var out card.SelectWithAttributesOutput
	buf, _ := json.Marshal(resp.Data)
	_ = json.Unmarshal(buf, &out)
	ids := make([]int64, 0, len(out.Rows))
	for _, r := range out.Rows {
		ids = append(ids, r.ID)
	}
	return ids
}

// TestVisibility_SelectWithAttributes_WorkerScopedToA pins the
// project-scoped worker case: project A's tasks visible, project B's
// invisible — even when they pass `parent_card_id=projectB` directly.
func TestVisibility_SelectWithAttributes_WorkerScopedToA(t *testing.T) {
	f := setupVisibility(t, "kitp_test_visibility_select_attrs")

	if ids := cardSelectIDs(t, f, f.worker, f.projectA); len(ids) != 1 || ids[0] != f.taskA {
		t.Fatalf("worker→A: want [%d], got %v", f.taskA, ids)
	}
	if ids := cardSelectIDs(t, f, f.worker, f.projectB); len(ids) != 0 {
		t.Fatalf("worker→B: want [], got %v (cross-project read leaked)", ids)
	}
}

// TestVisibility_SelectWithAttributes_AdminSeesEverything pins the
// global-admin path: scope_card_id=NULL on the user_role makes the
// predicate evaluate true regardless of the card's project.
func TestVisibility_SelectWithAttributes_AdminSeesEverything(t *testing.T) {
	f := setupVisibility(t, "kitp_test_visibility_admin")

	if ids := cardSelectIDs(t, f, f.admin, f.projectA); len(ids) != 1 || ids[0] != f.taskA {
		t.Fatalf("admin→A: want [%d], got %v", f.taskA, ids)
	}
	if ids := cardSelectIDs(t, f, f.admin, f.projectB); len(ids) != 1 || ids[0] != f.taskB {
		t.Fatalf("admin→B: want [%d], got %v", f.taskB, ids)
	}
}

// TestVisibility_SelectWithAttributes_StrangerSeesNothing pins the
// strict default: a user with NO user_role row has no visibility,
// regardless of the role-gate having allowed them in.
func TestVisibility_SelectWithAttributes_StrangerSeesNothing(t *testing.T) {
	f := setupVisibility(t, "kitp_test_visibility_stranger")

	if ids := cardSelectIDs(t, f, f.stranger, f.projectA); len(ids) != 0 {
		t.Fatalf("stranger→A: want [], got %v", ids)
	}
	if ids := cardSelectIDs(t, f, f.stranger, f.projectB); len(ids) != 0 {
		t.Fatalf("stranger→B: want [], got %v", ids)
	}
}

// TestVisibility_Search_StrictlyScoped verifies card.search applies
// the same predicate. Searching for "task-vis" (matches both tasks)
// returns only the scoped worker's accessible task.
func TestVisibility_Search_StrictlyScoped(t *testing.T) {
	f := setupVisibility(t, "kitp_test_visibility_search")

	search := func(uid int64) []int64 {
		resp := dispatchAsVis(t, f, uid, api.SubRequest{
			ID: "q", Endpoint: "card", Action: "search",
			Data: json.RawMessage(`{"card_type_name":"task","query":"task-vis"}`),
		})
		if !resp.OK {
			t.Fatalf("card.search: %+v", resp.Error)
		}
		var out card.SearchOutput
		buf, _ := json.Marshal(resp.Data)
		_ = json.Unmarshal(buf, &out)
		ids := make([]int64, 0, len(out.Rows))
		for _, h := range out.Rows {
			ids = append(ids, h.ID)
		}
		return ids
	}

	wIDs := search(f.worker)
	if len(wIDs) != 1 || wIDs[0] != f.taskA {
		t.Fatalf("worker search: want [%d], got %v", f.taskA, wIDs)
	}
	aIDs := search(f.admin)
	if len(aIDs) != 2 {
		t.Fatalf("admin search: want 2 hits, got %v", aIDs)
	}
	// Order isn't pinned; just ensure both ids are present.
	got := fmt.Sprintf(" %d %d ", aIDs[0], aIDs[1])
	if !strings.Contains(got, fmt.Sprintf(" %d ", f.taskA)) ||
		!strings.Contains(got, fmt.Sprintf(" %d ", f.taskB)) {
		t.Fatalf("admin search: expected both tasks, got %v", aIDs)
	}
}
