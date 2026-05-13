package hcsv

import (
	"strings"
	"testing"
)

// minimalSchemaSrc is a tiny schema document used as the substrate for
// every seed-loader test below. It carries `### meta` blocks so the
// $-lookup resolver has something to consult.
const minimalSchemaSrc = `# db
## table role
### meta
name_column
name
### columns
name, type, pk, unique, nullable
id, bigserial, true, ,
name, text, , true, false

## table card_type
### meta
name_column
name
### columns
name, type, pk, unique, nullable, references
id, bigserial, true, , ,
name, text, , true, false,

## table card
### meta
name_attribute
title
### columns
name, type, pk, nullable, default, references
id, bigserial, true, , ,
card_type_id, bigint, , false, , card_type.id
parent_card_id, bigint, , , , card.id
phase, text, , false, 'triage',

## table attribute_def
### meta
name_column
name
### columns
name, type, pk, unique, nullable
id, bigserial, true, ,
name, text, , true, false
value_type, text, , , false

## table activity
### columns
name, type, pk, nullable, references
id, bigserial, true, ,
card_id, bigint, , false, card.id
kind, text, , false,
attribute_def_id, bigint, , , attribute_def.id
value_old, jsonb, , ,
value_new, jsonb, , ,
actor_id, bigint, , false,

## table attribute_value | primary_key="card_id, attribute_def_id"
### columns
name, type, nullable, references
card_id, bigint, false, card.id
attribute_def_id, bigint, false, attribute_def.id
value, jsonb, ,
last_activity_id, bigint, , activity.id

## table widget
### columns
name, type, pk, nullable
id, bigserial, true,
name, text, , false
parent_id, bigint, ,
`

func loadTestSchema(t *testing.T) *Schema {
	t.Helper()
	doc, err := Parse([]byte(minimalSchemaSrc))
	if err != nil {
		t.Fatalf("parse schema: %v", err)
	}
	s, err := BuildSchema(doc)
	if err != nil {
		t.Fatalf("build schema: %v", err)
	}
	return s
}

func renderSeed(t *testing.T, src string) string {
	t.Helper()
	schema := loadTestSchema(t)
	doc, err := Parse([]byte(src))
	if err != nil {
		t.Fatalf("parse seed: %v", err)
	}
	out, err := BuildSeed(doc, schema, SeedOptions{})
	if err != nil {
		t.Fatalf("build seed: %v", err)
	}
	return out
}

func mustContain(t *testing.T, got, want string) {
	t.Helper()
	if !strings.Contains(got, want) {
		t.Errorf("output missing %q\n--- got ---\n%s", want, got)
	}
}

// TestSeed_PlainRow_OnConflict covers the simplest case: one section,
// explicit columns, on_conflict modifier.
func TestSeed_PlainRow_OnConflict(t *testing.T) {
	src := `# seed
## table role | on_conflict="name"
### rows
name
admin
worker
`
	got := renderSeed(t, src)
	mustContain(t, got, "INSERT INTO role (name) VALUES ('admin') ON CONFLICT (name) DO NOTHING;")
	mustContain(t, got, "INSERT INTO role (name) VALUES ('worker') ON CONFLICT (name) DO NOTHING;")
}

// TestSeed_DollarLookup_NameColumn covers $-lookup resolution via
// name_column meta.
func TestSeed_DollarLookup_NameColumn(t *testing.T) {
	src := `# seed
## table card_type | on_conflict="name"
### rows
name
project
task

## table attribute_def | on_conflict="name"
### rows
name, value_type
title, text

## table widget
### rows
name, parent_id
foo, $card_type.task
`
	got := renderSeed(t, src)
	mustContain(t, got, "(SELECT id FROM card_type WHERE name='task')")
}

// TestSeed_Lookup_DottedName covers $process."dotted.name" with quoted
// inner name.
func TestSeed_Lookup_DottedName(t *testing.T) {
	// Use card_type table (with name_column meta) and a dotted name.
	src := `# seed
## table card_type | on_conflict="name"
### rows
name
foo.bar

## table widget
### rows
name, parent_id
x, $card_type."foo.bar"
`
	got := renderSeed(t, src)
	mustContain(t, got, "(SELECT id FROM card_type WHERE name='foo.bar')")
}

// TestSeed_Alias covers @<alias>: the synthetic `alias` column on a
// row marks it for cross-reference.
func TestSeed_Alias(t *testing.T) {
	src := `# seed
## table card_type | on_conflict="name"
### rows
name, alias
foo, ct_foo

## table widget
### rows
name, parent_id
referent, @ct_foo
`
	got := renderSeed(t, src)
	// Alias of a non-card row resolves via its name_column lookup.
	mustContain(t, got, "(SELECT id FROM card_type WHERE name='foo')")
}

// TestSeed_ArrayExpansion covers the cross-product semantics of `[a,
// b, c]` cells.
func TestSeed_ArrayExpansion(t *testing.T) {
	src := `# seed
## table role | on_conflict="name"
### rows
name
worker
manager

## table card_type | on_conflict="name"
### rows
name
project
task

## table widget
### rows
name, parent_id
g, ` + "`[$role.worker, $role.manager]`" + `
`
	got := renderSeed(t, src)
	if strings.Count(got, "INSERT INTO widget") != 2 {
		t.Errorf("expected 2 widget inserts (one per array elt); got\n%s", got)
	}
}

// TestSeed_CardRow_AttributeExpansion is the core feature: a card row
// with non-structural columns becomes a CTE chain emitting one
// activity card_create + one (activity attr_update, attribute_value)
// pair per attribute.
func TestSeed_CardRow_AttributeExpansion(t *testing.T) {
	src := `# seed
## table card_type | on_conflict="name"
### rows
name
project

## table attribute_def | on_conflict="name"
### rows
name, value_type
title, text

## table card
### rows
card_type_id, title
$card_type.project, "Hello"
`
	got := renderSeed(t, src)
	// CTE chain.
	mustContain(t, got, "WITH c AS (")
	mustContain(t, got, "INSERT INTO card (card_type_id)")
	// card_create activity.
	mustContain(t, got, "'card_create', 1 FROM c")
	// title attribute_value.
	mustContain(t, got, "INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)")
	mustContain(t, got, "to_jsonb('Hello'::text)")
}

// TestSeed_CardRow_NullAttributesDropped: nullable attribute cells
// don't emit attribute_value rows.
func TestSeed_CardRow_NullAttributesDropped(t *testing.T) {
	src := `# seed
## table card_type | on_conflict="name"
### rows
name
project

## table attribute_def | on_conflict="name"
### rows
name, value_type
title, text
description, text

## table card
### rows
card_type_id, title, description
$card_type.project, "x", null
`
	got := renderSeed(t, src)
	if strings.Contains(got, "name='description'") {
		t.Errorf("null attribute should be omitted; got\n%s", got)
	}
}

// TestSeed_ParentToken: parent under card heading resolves to the
// previous section's last row via title lookup.
func TestSeed_ParentToken(t *testing.T) {
	src := `# seed
## table card_type | on_conflict="name"
### rows
name
project
task

## table attribute_def | on_conflict="name"
### rows
name, value_type
title, text

## table card | alias=p_root
### rows
card_type_id, title
$card_type.project, "Root"

## table card | under=p_root
### rows
card_type_id, parent_card_id, title
$card_type.task, parent, "Child"
`
	got := renderSeed(t, src)
	// Child's parent reference must show the title-lookup against the
	// root card.
	mustContain(t, got, "av.value=to_jsonb('Root'::text)")
}

// TestSeed_CardRefArrayValue: a `tags` attribute on card with a
// bracketed list renders as jsonb_build_array of resolved ids, NOT
// cross-product expansion.
func TestSeed_CardRefArrayValue(t *testing.T) {
	src := `# seed
## table card_type | on_conflict="name"
### rows
name
project
tag

## table attribute_def | on_conflict="name"
### rows
name, value_type
title, text
tags, "card_ref[]"

## table card | alias=tag_a
### rows
card_type_id, title
$card_type.tag, "alpha"

## table card | alias=tag_b
### rows
card_type_id, title
$card_type.tag, "beta"

## table card
### rows
card_type_id, title, tags
$card_type.project, "P", ` + "`[@tag_a, @tag_b]`" + `
`
	got := renderSeed(t, src)
	if strings.Count(got, "INSERT INTO card (card_type_id)") < 3 {
		t.Errorf("expected 3 card inserts (2 tags + 1 project); got\n%s", got)
	}
	mustContain(t, got, "jsonb_build_array(")
}

// TestSeed_TopoSort detects a cycle.
func TestSeed_TopoSort_CycleDetected(t *testing.T) {
	// Two aliased rows pointing at each other through the alias map.
	src := `# seed
## table card_type | on_conflict="name"
### rows
name
ct

## table widget
### rows
name, parent_id, alias
a, @b, a
b, @a, b
`
	schema := loadTestSchema(t)
	doc, err := Parse([]byte(src))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	_, err = BuildSeed(doc, schema, SeedOptions{})
	if err == nil || !strings.Contains(err.Error(), "cycle") {
		t.Fatalf("expected cycle error; got %v", err)
	}
}

// TestSeed_GuardDemo wraps output in a DO block.
func TestSeed_GuardDemo(t *testing.T) {
	src := `# demo
## table card_type | on_conflict="name"
### rows
name
project
`
	schema := loadTestSchema(t)
	doc, err := Parse([]byte(src))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	got, err := BuildSeed(doc, schema, SeedOptions{GuardDemo: true})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	mustContain(t, got, "DO $demo$ BEGIN")
	mustContain(t, got, "END $demo$;")
}

// TestSeed_BacktickJSONLiteral: a backtick cell with JSON content is
// emitted as a SQL literal (CSV decode strips backticks).
func TestSeed_BacktickJSONLiteral(t *testing.T) {
	src := `# seed
## table card_type | on_conflict="name"
### rows
name
filter

## table attribute_def | on_conflict="name"
### rows
name, value_type
predicate, text

## table card
### rows
card_type_id, predicate
$card_type.filter, ` + "`{\"attr\":\"status\",\"op\":\"not terminal\"}`" + `
`
	got := renderSeed(t, src)
	mustContain(t, got, `to_jsonb('{"attr":"status","op":"not terminal"}'::text)`)
}

// TestSeed_ResetSequence emits the setval trailer.
func TestSeed_ResetSequence(t *testing.T) {
	src := `# seed
## table role | on_conflict="id" | reset_sequence=role_id_seq
### rows
id, name
1, admin
`
	got := renderSeed(t, src)
	mustContain(t, got, "SELECT setval('role_id_seq'")
}
