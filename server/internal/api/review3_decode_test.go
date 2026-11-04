package api_test

// Regression test for review 2026-11-03 round 3 #15: a value of the wrong
// kind is named by its JSON kind, never by a Go type.

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
)

type r3Leaf struct {
	Attr string `json:"attr"`
}

type r3Input struct {
	Where    []r3Leaf                   `json:"where"`
	Node     r3Leaf                     `json:"node"`
	Attrs    map[string]json.RawMessage `json:"attributes"`
	N        int64                      `json:"n"`
	On       bool                       `json:"on"`
	Name     string                     `json:"name"`
	Children []r3Leaf                   `json:"children"`
}

func TestDecodeMessageNamesJSONKinds(t *testing.T) {
	for body, want := range map[string]string{
		`{"where":{}}`:      "where must be an array",
		`{"node":[]}`:       "node must be an object",
		`{"attributes":[]}`: "attributes must be an object",
		`{"n":"x"}`:         "n must be a whole number",
		`{"on":1}`:          "on must be true or false",
		`{"name":2}`:        "name must be a string",
		`{"children":[3]}`:  "must be an object",
		`[]`:                "an object was expected",
	} {
		var in r3Input
		err := json.Unmarshal([]byte(body), &in)
		if err == nil {
			t.Fatalf("%s decoded", body)
		}
		msg := api.JSONDecodeMessage(err)
		if !strings.Contains(msg, want) {
			t.Errorf("%s: %q, want it to say %q", body, msg, want)
		}
		for _, leak := range []string{"r3", "api_test", "[]", "map[", "int64", "json.", "jsontext"} {
			if strings.Contains(msg, leak) {
				t.Errorf("%s: %q names a Go type (%q)", body, msg, leak)
			}
		}
	}
}
