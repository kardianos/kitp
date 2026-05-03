package mcp

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/card"
)

// updateGolden refreshes goldens when -update is passed. Run with:
//   go test ./internal/mcp -run TestSchemaGolden -update
var updateGolden = flag.Bool("update", false, "rewrite testdata goldens on mismatch")

// TestSchemaGolden_CardInsert / TestSchemaGolden_AttributeUpdate generate
// the JSONSchema for two representative handler input types and assert
// against goldens in testdata/. If the goldens don't exist (first run)
// the test writes them and passes once.
func TestSchemaGolden_CardInsert(t *testing.T) {
	checkGolden(t, "card_insert", reflect.TypeFor[card.InsertInput]())
}

func TestSchemaGolden_AttributeUpdate(t *testing.T) {
	checkGolden(t, "attribute_update", reflect.TypeFor[attribute.UpdateInput]())
}

func checkGolden(t *testing.T, name string, in reflect.Type) {
	t.Helper()
	s := SchemaForType(in, true)
	got, err := formatSchemaJSON(s)
	if err != nil {
		t.Fatalf("formatSchema: %v", err)
	}
	path := filepath.Join("testdata", name+".golden.json")
	want, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			t.Fatalf("read golden %s: %v", path, err)
		}
		// First-run: write and pass.
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatalf("write initial golden: %v", err)
		}
		t.Logf("wrote %s (first run)", path)
		return
	}
	if bytes.Equal(got, want) {
		return
	}
	if *updateGolden {
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatalf("update golden: %v", err)
		}
		t.Logf("updated %s", path)
		return
	}

	// Friendly diff: pretty-print expected vs got.
	t.Errorf("golden mismatch for %s.\n--- want ---\n%s\n--- got ---\n%s\n(rerun with -update to refresh)",
		path, string(want), string(got))
}

// TestSchemaForType_Primitives covers the type-mapping table from
// docs/mcp-tags.md. Each case asserts the JSON Schema output matches
// the documented mapping.
func TestSchemaForType_Primitives(t *testing.T) {
	cases := []struct {
		name string
		typ  reflect.Type
		want string
	}{
		{"string", reflect.TypeFor[string](), `"type":"string"`},
		{"bool", reflect.TypeFor[bool](), `"type":"boolean"`},
		{"int", reflect.TypeFor[int](), `"type":"integer"`},
		{"int64", reflect.TypeFor[int64](), `"type":"integer"`},
		{"slice_int", reflect.TypeFor[[]int](), `"type":"array"`},
		{"map_string_any", reflect.TypeFor[map[string]any](), `"type":"object"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := SchemaForType(tc.typ, false)
			b, _ := json.Marshal(s)
			if !bytes.Contains(b, []byte(tc.want)) {
				t.Fatalf("schema for %s: got %s want substring %q", tc.name, b, tc.want)
			}
		})
	}
}

// TestSchemaForType_TagParse exercises desc / required / enum.
// Reminder: per docs/mcp-tags.md, `desc=` is greedy and must come last.
func TestSchemaForType_TagParse(t *testing.T) {
	type In struct {
		A string `json:"a" mcp:"required,enum=x|y|z,desc=an a"`
		B int    `json:"b,omitempty" mcp:"desc=optional b"`
		C *int   `json:"c,omitempty" mcp:"desc=pointer optional"`
	}
	s := SchemaForType(reflect.TypeFor[In](), true)
	if s.Type != "object" {
		t.Fatalf("type: %q", s.Type)
	}
	a := s.Properties["a"]
	if a == nil || a.Type != "string" {
		t.Fatalf("a missing or wrong type: %+v", a)
	}
	if a.Description != "an a" {
		t.Errorf("a desc: %q", a.Description)
	}
	if len(a.Enum) != 3 || a.Enum[0] != "x" {
		t.Errorf("a enum: %v", a.Enum)
	}
	// Required list contains only a.
	if len(s.Required) != 1 || s.Required[0] != "a" {
		t.Errorf("required: %v, want [a]", s.Required)
	}
}
