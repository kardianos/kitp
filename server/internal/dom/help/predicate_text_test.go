package help

import "testing"

func TestRenderPredicateJSON(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"empty", "", "every task"},
		{"null", "null", "every task"},

		{
			"eq leaf",
			`{"attr":"status","op":"=","values":["doing"]}`,
			"tasks where status is doing",
		},
		{
			"ne leaf",
			`{"attr":"assignee","op":"!=","values":["alice"]}`,
			"tasks where assignee is not alice",
		},
		{
			"in leaf",
			`{"attr":"milestone_ref","op":"in","values":["1","2","3"]}`,
			"tasks where milestone is one of (card #1, card #2, card #3)",
		},
		{
			"exists leaf",
			`{"attr":"due_date","op":"exists"}`,
			"tasks where due date is set",
		},
		{
			"not exists leaf",
			`{"attr":"due_date","op":"not exists"}`,
			"tasks where due date is empty",
		},
		{
			"not terminal leaf",
			`{"attr":"phase","op":"not terminal"}`,
			"tasks where the task is still open",
		},
		{
			"has_phase leaf",
			`{"attr":"phase","op":"has_phase","values":["triage","active"]}`,
			"tasks where phase is in phase (triage, active)",
		},

		{
			"two-element AND",
			`{"connective":"and","children":[
				{"attr":"status","op":"=","values":["doing"]},
				{"attr":"assignee","op":"=","values":["alice"]}
			]}`,
			"tasks where status is doing and assignee is alice",
		},
		{
			"three-element AND Oxford comma",
			`{"connective":"and","children":[
				{"attr":"status","op":"=","values":["doing"]},
				{"attr":"assignee","op":"=","values":["alice"]},
				{"attr":"priority","op":"=","values":["high"]}
			]}`,
			"tasks where status is doing, assignee is alice, and priority is high",
		},
		{
			"OR of two",
			`{"connective":"or","children":[
				{"attr":"status","op":"=","values":["doing"]},
				{"attr":"status","op":"=","values":["review"]}
			]}`,
			"tasks where status is doing or status is review",
		},
		{
			"NOT of leaf",
			`{"connective":"not","children":[
				{"attr":"status","op":"=","values":["done"]}
			]}`,
			"tasks where not (status is done)",
		},
		{
			"nested AND inside OR is parenthesised",
			`{"connective":"or","children":[
				{"attr":"status","op":"=","values":["done"]},
				{"connective":"and","children":[
					{"attr":"status","op":"=","values":["doing"]},
					{"attr":"assignee","op":"=","values":["alice"]}
				]}
			]}`,
			"tasks where status is done or (status is doing and assignee is alice)",
		},
		{
			"empty AND",
			`{"connective":"and","children":[]}`,
			"tasks where always true",
		},
		{
			"empty OR",
			`{"connective":"or","children":[]}`,
			"tasks where always false",
		},
		{
			"boolean value",
			`{"attr":"is_blocked","op":"=","values":[true]}`,
			"tasks where is blocked is yes",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := RenderPredicateJSON(tc.in)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Errorf("got  %q\nwant %q", got, tc.want)
			}
		})
	}
}

func TestRenderPredicateJSON_errors(t *testing.T) {
	cases := []struct {
		name string
		in   string
	}{
		{"not json", `{garbage`},
		{"bad connective", `{"connective":"xor","children":[]}`},
		{"not group with two children", `{"connective":"not","children":[{"attr":"a","op":"="},{"attr":"b","op":"="}]}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := RenderPredicateJSON(tc.in)
			if err == nil {
				t.Fatalf("expected error, got nil")
			}
		})
	}
}
