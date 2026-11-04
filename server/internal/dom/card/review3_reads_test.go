package card_test

// Regression test for the third 2026-11-03 review, finding 16.

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/schema"
)

// TestSnippetLeavesForAnAccountWithNoPerson (round 3 #16): a worker on A
// with no person card can't use project B's saved filter, in either
// compiler; kitp's own reads (no viewer) still can.
func TestSnippetLeavesForAnAccountWithNoPerson(t *testing.T) {
	f := setupVisibility(t, "kitp_test_r3_snippet_noperson")
	ctx := context.Background()
	pred, err := json.Marshal(`{"attr":"title","op":"contains","values":["x"]}`)
	if err != nil {
		t.Fatal(err)
	}
	snip := insertedID(t, reviewCall(t, f, auth.SystemUserID, "card", "insert", fmt.Sprintf(
		`{"card_type_name":"predicate_snippet","parent_card_id":"%d","title":"B's filter","attributes":{"predicate":%s}}`, f.projectB, pred)))
	if _, err := f.sp.P.Exec(ctx, `DELETE FROM user_account_person WHERE user_account_id = $1`, f.worker); err != nil {
		t.Fatal(err)
	}
	// The SQL compiler, as card.select_with_attributes calls it.
	var sql string
	if err := f.sp.P.QueryRow(ctx, `
		SELECT card_compile_predicate(jsonb_build_object('attr', '_snippet', 'op', 'snippet', 'values', jsonb_build_array($1::bigint)),
		                              '[]'::jsonb, ARRAY[]::bigint[], COALESCE(account_person($2), -1))->>'sql'`, snip, f.worker).Scan(&sql); err != nil {
		t.Fatal(err)
	}
	if sql != "FALSE" {
		t.Errorf("SQL compiler: B's snippet compiled for a person-less worker on A: %s", sql)
	}
	// The Go compiler, as the export and the digests call it.
	tx, err := f.sp.P.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	snap, err := schema.Load(ctx, tx)
	if err != nil {
		t.Fatal(err)
	}
	var args []any
	bind := func(v any) string { args = append(args, v); return fmt.Sprintf("$%d", len(args)) }
	tree := card.CardWhereGroup{Connective: "and", Children: []card.CardWhereTreeNode{
		{Attr: "_snippet", Op: "snippet", Values: []json.RawMessage{json.RawMessage(fmt.Sprint(snip))}}}}
	got, err := card.CompileTree(ctx, tx, tree, bind, snap, card.NoPerson)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "FALSE") || strings.Contains(got, "title") {
		t.Errorf("Go compiler: B's snippet compiled for NoPerson: %s", got)
	}
	if got, err := card.CompileTree(ctx, tx, tree, bind, snap, 0); err != nil || got == "FALSE" || got == "(FALSE)" {
		t.Errorf("Go compiler for kitp's own reads: %q (%v), want B's filter", got, err)
	}
}
