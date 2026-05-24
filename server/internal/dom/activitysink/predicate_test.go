package activitysink_test

import (
	"testing"

	"github.com/kitp/kitp/server/internal/dom/activitysink"
)

// TestPredicateEval covers the small filter DSL the activity_sink pump
// runs against each activity row. Driven as a table because the matrix
// of (predicate, row) cases is what really matters — the eval function
// itself is two screens of switch cases.
func TestPredicateEval(t *testing.T) {
	type row = activitysink.ActivityRow
	cases := []struct {
		name string
		spec string
		r    row
		want bool
	}{
		{"empty filter matches every row", ``, row{Kind: "card_create"}, true},
		{"empty filter matches comment too", ``, row{Kind: "comment"}, true},

		{"kind_in match",
			`{"op":"kind_in","values":["comment","card_create"]}`,
			row{Kind: "comment"}, true},
		{"kind_in miss",
			`{"op":"kind_in","values":["comment"]}`,
			row{Kind: "attr_update"}, false},
		{"kind_not_in inverts",
			`{"op":"kind_not_in","values":["attr_update"]}`,
			row{Kind: "attr_update"}, false},
		{"kind_not_in non-match passes",
			`{"op":"kind_not_in","values":["attr_update"]}`,
			row{Kind: "comment"}, true},

		{"attr_in requires attr_update kind",
			`{"op":"attr_in","values":["status"]}`,
			row{Kind: "comment", AttributeName: "status"}, false},
		{"attr_in matches when both align",
			`{"op":"attr_in","values":["status","assignee"]}`,
			row{Kind: "attr_update", AttributeName: "assignee"}, true},
		{"attr_not_in accepts non-attr_update rows",
			`{"op":"attr_not_in","values":["sort_order"]}`,
			row{Kind: "comment"}, true},
		{"attr_not_in filters sort_order updates",
			`{"op":"attr_not_in","values":["sort_order"]}`,
			row{Kind: "attr_update", AttributeName: "sort_order"}, false},

		{"actor_in matches",
			`{"op":"actor_in","values":["7","42"]}`,
			row{ActorID: 42}, true},
		{"actor_in miss",
			`{"op":"actor_in","values":["7"]}`,
			row{ActorID: 42}, false},
		{"actor_not_in inverts",
			`{"op":"actor_not_in","values":["1"]}`,
			row{ActorID: 1}, false},

		{"and: all must match",
			`{"op":"and","items":[{"op":"kind_in","values":["comment"]},{"op":"actor_not_in","values":["1"]}]}`,
			row{Kind: "comment", ActorID: 5}, true},
		{"and: one mismatch fails",
			`{"op":"and","items":[{"op":"kind_in","values":["comment"]},{"op":"actor_not_in","values":["5"]}]}`,
			row{Kind: "comment", ActorID: 5}, false},

		{"or: any match passes",
			`{"op":"or","items":[{"op":"kind_in","values":["comment"]},{"op":"kind_in","values":["card_create"]}]}`,
			row{Kind: "card_create"}, true},
		{"or: empty fails closed",
			`{"op":"or","items":[]}`,
			row{Kind: "comment"}, false},

		{"unknown op fails closed",
			`{"op":"is_purple","values":["whatever"]}`,
			row{Kind: "comment"}, false},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p, err := activitysink.ParsePredicate(c.spec)
			if err != nil {
				t.Fatalf("ParsePredicate %q: %v", c.spec, err)
			}
			if got := p.Eval(c.r); got != c.want {
				t.Errorf("Eval(%+v) on %s = %v, want %v", c.r, c.spec, got, c.want)
			}
		})
	}
}

// TestParsePredicateInvalidJSON returns an error so the pumper can
// MarkChannelFault and stop pushing rather than silently match nothing.
func TestParsePredicateInvalidJSON(t *testing.T) {
	if _, err := activitysink.ParsePredicate(`{"op":`); err == nil {
		t.Fatal("ParsePredicate should reject malformed JSON")
	}
}
