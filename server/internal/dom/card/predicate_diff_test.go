// predicate_diff_test.go: A13 (BE-H2 safe increment) — property/diff
// test that the Go predicate compiler (card.CompileTree, where.go) and
// the SQL predicate compiler (card_compile_predicate.sql, exercised via
// card.select_with_attributes) agree on a set of randomly-generated
// predicate trees.
//
// Why: the two compilers are hand-mirrored. The hand-counted placeholder
// offsets the SQL side used to carry (now folded into _ph_push) were
// exactly the kind of divergence a string-by-string review misses. This
// test runs identical random trees through both and asserts identical
// matched-card sets, so any future drift between the two compilers
// (placeholder bookkeeping, op semantics) fails loudly.
package card_test

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"slices"
	"testing"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

// goCompileMatch runs `tree` through the Go compiler (card.CompileTree)
// against the same project's tasks and returns the matched task ids —
// mirroring projectexport.loadTaskRows' execution path. This is the
// "Go compiler" half of the diff.
func goCompileMatch(t *testing.T, pool *store.Pool, projectID int64, tree card.CardWhereGroup) []int64 {
	t.Helper()
	ctx := auth.WithSystemUser(context.Background())
	tx, err := pool.P.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx)

	snap, err := schema.Load(ctx, tx)
	if err != nil {
		t.Fatalf("schema load: %v", err)
	}
	b := named.New()
	b.Set("project_id", projectID)
	clause, err := card.CompileTree(ctx, tx, tree, b.Bind, snap)
	if err != nil {
		t.Fatalf("Go CompileTree: %v", err)
	}
	sql, args, err := b.Compile(`
		SELECT c.id
		FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id
		WHERE ct.name = 'task' AND c.parent_card_id = :project_id
		  AND c.deleted_at IS NULL
		  AND (` + clause + `)
		ORDER BY c.id`)
	if err != nil {
		t.Fatalf("compile named: %v", err)
	}
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		t.Fatalf("Go-compiled query: %v\nSQL: %s", err, sql)
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}
	slices.Sort(out)
	return out
}

// randTree builds a random predicate tree using only operators both
// compilers implement identically over the seeded attributes
// (milestone_ref card_ref eq/ne/in/not in, assignee number exists, plus
// and/or/not nesting). depth bounds the recursion.
func randTree(rng *rand.Rand, depth int, milestoneIDs []int64) card.CardWhereGroup {
	conn := []string{"and", "or"}[rng.Intn(2)]
	n := 1 + rng.Intn(3)
	g := card.CardWhereGroup{Connective: conn}
	for i := 0; i < n; i++ {
		g.Children = append(g.Children, randNode(rng, depth, milestoneIDs))
	}
	return g
}

func randNode(rng *rand.Rand, depth int, milestoneIDs []int64) card.CardWhereTreeNode {
	// Recurse into a sub-group sometimes (incl. a NOT group, which must
	// have exactly one child).
	if depth > 0 && rng.Intn(3) == 0 {
		switch rng.Intn(3) {
		case 0:
			sub := randTree(rng, depth-1, milestoneIDs)
			return card.CardWhereTreeNode{Connective: sub.Connective, Children: sub.Children}
		case 1:
			return card.CardWhereTreeNode{
				Connective: "not",
				Children:   []card.CardWhereTreeNode{randNode(rng, depth-1, milestoneIDs)},
			}
		}
	}
	return randLeaf(rng, milestoneIDs)
}

func randLeaf(rng *rand.Rand, milestoneIDs []int64) card.CardWhereTreeNode {
	val := func(id int64) json.RawMessage { return json.RawMessage(fmt.Sprintf("%d", id)) }
	switch rng.Intn(5) {
	case 0: // eq milestone_ref
		return card.CardWhereTreeNode{Attr: "milestone_ref", Op: "=",
			Values: []json.RawMessage{val(milestoneIDs[rng.Intn(len(milestoneIDs))])}}
	case 1: // ne milestone_ref
		return card.CardWhereTreeNode{Attr: "milestone_ref", Op: "!=",
			Values: []json.RawMessage{val(milestoneIDs[rng.Intn(len(milestoneIDs))])}}
	case 2: // in milestone_ref (1-2 values)
		vs := []json.RawMessage{val(milestoneIDs[rng.Intn(len(milestoneIDs))])}
		if rng.Intn(2) == 0 {
			vs = append(vs, val(milestoneIDs[rng.Intn(len(milestoneIDs))]))
		}
		return card.CardWhereTreeNode{Attr: "milestone_ref", Op: "in", Values: vs}
	case 3: // not in milestone_ref
		return card.CardWhereTreeNode{Attr: "milestone_ref", Op: "not in",
			Values: []json.RawMessage{val(milestoneIDs[rng.Intn(len(milestoneIDs))])}}
	default: // exists / not exists assignee
		op := "exists"
		if rng.Intn(2) == 0 {
			op = "not exists"
		}
		return card.CardWhereTreeNode{Attr: "assignee", Op: op}
	}
}

func TestPredicateCompiler_GoVsSQL_Diff(t *testing.T) {
	srv, pool := setupAttr(t, "kitp_test_predicate_diff")
	projectID, ids, sm := seedTasks(t, srv, []map[string]any{
		{"milestone_ref": "M1", "assignee": 1},
		{"milestone_ref": "M2", "assignee": 2},
		{"milestone_ref": "M1"},
		{"milestone_ref": "M3", "assignee": 1},
		{"milestone_ref": "M2"},
		{"assignee": 2},
	})
	milestoneIDs := []int64{sm["M1"], sm["M2"], sm["M3"]}
	// The universe under test is exactly the tasks we seeded. We
	// intersect both halves with it so the diff measures predicate
	// SEMANTICS (which is what the two compilers must agree on), not the
	// surrounding scope plumbing (visibility / parent filter), which the
	// SQL handler and the Go reference query implement separately. A demo
	// task that matches an always-true predicate is irrelevant to whether
	// the two compilers agree.
	seeded := map[int64]bool{}
	for _, id := range ids {
		seeded[id] = true
	}
	intersect := func(in []int64) []int64 {
		var out []int64
		for _, id := range in {
			if seeded[id] {
				out = append(out, id)
			}
		}
		slices.Sort(out)
		return out
	}

	rng := rand.New(rand.NewSource(20260524))
	for iter := 0; iter < 200; iter++ {
		tree := randTree(rng, 2, milestoneIDs)
		treeJSON, err := json.Marshal(tree)
		if err != nil {
			t.Fatalf("marshal tree: %v", err)
		}

		// SQL compiler half (card_compile_predicate.sql via dispatch).
		sqlIDs := intersect(rowIDs(queryTree(t, srv, projectID, string(treeJSON))))

		// Go compiler half (card.CompileTree).
		goIDs := intersect(goCompileMatch(t, pool, projectID, tree))

		if !equalIDs(sqlIDs, goIDs) {
			t.Fatalf("iter %d: compilers disagree\ntree: %s\nSQL: %v\nGo:  %v",
				iter, treeJSON, sqlIDs, goIDs)
		}
	}
}
