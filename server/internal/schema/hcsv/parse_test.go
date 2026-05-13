package hcsv

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseHeadingShape(t *testing.T) {
	src := `# db
## table user_account
### columns
name, type
id, bigserial
`
	doc, err := Parse([]byte(src))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if doc.Root.Kind != "db" {
		t.Fatalf("root kind = %q, want db", doc.Root.Kind)
	}
	if len(doc.Root.Children) != 1 {
		t.Fatalf("root children = %d, want 1", len(doc.Root.Children))
	}
	tbl := doc.Root.Children[0]
	if tbl.Kind != "table" || tbl.Name != "user_account" {
		t.Fatalf("table heading = %+v", tbl)
	}
	if len(tbl.Children) != 1 || tbl.Children[0].Kind != "columns" {
		t.Fatalf("columns section missing: %+v", tbl.Children)
	}
	cols := tbl.Children[0]
	if !reflect.DeepEqual(cols.Header, []string{"name", "type"}) {
		t.Fatalf("header = %v", cols.Header)
	}
	if !reflect.DeepEqual(cols.Rows, [][]string{{"id", "bigserial"}}) {
		t.Fatalf("rows = %v", cols.Rows)
	}
}

func TestParseModifiers(t *testing.T) {
	cases := []struct {
		name string
		src  string
		want map[string]string
	}{
		{
			"unquoted",
			`# db | doc=hello`,
			map[string]string{"doc": "hello"},
		},
		{
			"quoted with comma",
			`# db | doc="hello, world"`,
			map[string]string{"doc": "hello, world"},
		},
		{
			"multiple",
			`# db | a=1 | b=two | c="three four"`,
			map[string]string{"a": "1", "b": "two", "c": "three four"},
		},
		{
			"quoted with pipe",
			`# db | doc="a|b"`,
			map[string]string{"doc": "a|b"},
		},
		{
			"escaped quote",
			`# db | doc="he said ""hi"""`,
			map[string]string{"doc": `he said "hi"`},
		},
		{
			"whitespace tolerated",
			`# db |  k  =  value  `,
			map[string]string{"k": "value"},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			doc, err := Parse([]byte(c.src))
			if err != nil {
				t.Fatalf("Parse: %v", err)
			}
			if !reflect.DeepEqual(doc.Root.Modifiers, c.want) {
				t.Fatalf("modifiers = %v, want %v", doc.Root.Modifiers, c.want)
			}
		})
	}
}

func TestParseCSVQuoting(t *testing.T) {
	src := `# db
## table t
### rows
a, b, c
plain, "with, comma", end
"esc ""quote""", second, third
empty,, last
`
	doc, err := Parse([]byte(src))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	rows := doc.Root.Children[0].Children[0].Rows
	want := [][]string{
		{"plain", "with, comma", "end"},
		{`esc "quote"`, "second", "third"},
		{"empty", "", "last"},
	}
	if !reflect.DeepEqual(rows, want) {
		t.Fatalf("rows = %#v\nwant %#v", rows, want)
	}
}

func TestBacktickCells(t *testing.T) {
	// Use a raw string literal whose own delimiter is the back-quote
	// pair — but Go raw strings can't contain backticks. Build the
	// source by concatenation so the embedded backticks survive.
	bq := "`"
	src := "# db\n" +
		"## table t\n" +
		"### rows\n" +
		"a, b, c\n" +
		"plain, " + bq + `{"foo":"bar","n":1}` + bq + ", end\n" +
		"x, " + bq + "with``literal" + bq + ", y\n" +
		"u, " + bq + `{"k":"v with, comma"}` + bq + ", v\n"
	doc, err := Parse([]byte(src))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	rows := doc.Root.Children[0].Children[0].Rows
	want := [][]string{
		{"plain", `{"foo":"bar","n":1}`, "end"},
		{"x", "with`literal", "y"},
		{"u", `{"k":"v with, comma"}`, "v"},
	}
	if !reflect.DeepEqual(rows, want) {
		t.Fatalf("rows = %#v\nwant %#v", rows, want)
	}
}

func TestBacktickMultilineCell(t *testing.T) {
	bq := "`"
	src := "# db\n" +
		"## table t\n" +
		"### rows\n" +
		"name, predicate\n" +
		"filterA, " + bq + "{\n" +
		"  \"attr\": \"status\",\n" +
		"  \"op\": \"has_phase\",\n" +
		"  \"values\": [\"active\"]\n" +
		"}" + bq + "\n" +
		"filterB, " + bq + `{"trivial":true}` + bq + "\n"
	doc, err := Parse([]byte(src))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	rows := doc.Root.Children[0].Children[0].Rows
	if len(rows) != 2 {
		t.Fatalf("expected 2 rows, got %d: %#v", len(rows), rows)
	}
	wantMulti := "{\n  \"attr\": \"status\",\n  \"op\": \"has_phase\",\n  \"values\": [\"active\"]\n}"
	if rows[0][1] != wantMulti {
		t.Fatalf("multiline cell = %q\nwant %q", rows[0][1], wantMulti)
	}
	if rows[1][1] != `{"trivial":true}` {
		t.Fatalf("second-row cell = %q", rows[1][1])
	}
}

func TestBacktickUnterminatedError(t *testing.T) {
	bq := "`"
	src := "# db\n## table t\n### rows\n" +
		"a, b\n" +
		"plain, " + bq + "no closing backtick\n"
	_, err := Parse([]byte(src))
	if err == nil {
		t.Fatal("expected error for unterminated backtick string")
	}
	if !strings.Contains(err.Error(), "unterminated quoted cell") {
		t.Fatalf("expected 'unterminated quoted cell' in error; got %v", err)
	}
}

func TestCommentStripping(t *testing.T) {
	src := `-- top comment
# db
-- another comment
## table t
### columns
-- inline-ish comment (must be at line start)
name, type
id, bigserial
`
	doc, err := Parse([]byte(src))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	cols := doc.Root.Children[0].Children[0]
	if len(cols.Rows) != 1 {
		t.Fatalf("rows = %v, want 1", cols.Rows)
	}
}

func TestMultiRowSection(t *testing.T) {
	src := `# db
## prop
name, value
extension, pg_trgm
extension, hstore
setting, "foo, bar"
`
	doc, err := Parse([]byte(src))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	rows := doc.Root.Children[0].Rows
	want := [][]string{
		{"extension", "pg_trgm"},
		{"extension", "hstore"},
		{"setting", "foo, bar"},
	}
	if !reflect.DeepEqual(rows, want) {
		t.Fatalf("rows = %#v\nwant %#v", rows, want)
	}
}

func TestNestedSections(t *testing.T) {
	src := `# db
## table card
### meta
name_attribute, id_column
title, id

### columns
name, type
id, bigserial
title, text

### indexes
name, columns
idx_title, title
`
	doc, err := Parse([]byte(src))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	tbl := doc.Root.Children[0]
	if len(tbl.Children) != 3 {
		t.Fatalf("table children = %d (%v), want 3", len(tbl.Children), kinds(tbl.Children))
	}
	got := kinds(tbl.Children)
	if !reflect.DeepEqual(got, []string{"meta", "columns", "indexes"}) {
		t.Fatalf("kinds = %v", got)
	}
}

func TestDepth4(t *testing.T) {
	src := `# a
## b
### c
#### d
name
x
`
	doc, err := Parse([]byte(src))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	d := doc.Root.Children[0].Children[0].Children[0]
	if d.Depth != 4 || d.Kind != "d" {
		t.Fatalf("d4 = %+v", d)
	}
}

func TestErrorCases(t *testing.T) {
	cases := []struct {
		name   string
		src    string
		errSub string
	}{
		{
			"no depth-1",
			"## table foo\nname\nid\n",
			"depth 1",
		},
		{
			"empty file",
			"",
			"empty or has no depth-1",
		},
		{
			"modifier missing =",
			`# db | doc`,
			"missing `=`",
		},
		{
			"unterminated quote",
			"# db | doc=\"hello",
			"unterminated",
		},
		{
			"data before any section",
			"not, a, heading\n# db",
			"outside any section",
		},
		{
			"multiple depth-1",
			"# db\n# db2",
			"multiple depth-1",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := Parse([]byte(c.src))
			if err == nil {
				t.Fatalf("expected error containing %q", c.errSub)
			}
			if !strings.Contains(err.Error(), c.errSub) {
				t.Fatalf("err = %v, want substring %q", err, c.errSub)
			}
		})
	}
}

func TestEmptyCells(t *testing.T) {
	src := `# db
## table t
### columns
name, type, default
id, bigserial,
created_at, timestamptz, now()
`
	doc, err := Parse([]byte(src))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	rows := doc.Root.Children[0].Children[0].Rows
	if rows[0][2] != "" {
		t.Fatalf("expected empty default; got %q", rows[0][2])
	}
	if rows[1][2] != "now()" {
		t.Fatalf("got %q", rows[1][2])
	}
}

func TestStrawmanSchemaParses(t *testing.T) {
	// Smoke-test against the strawman document so we know the parser
	// at least accepts every shape used in the spec.
	doc, err := Parse([]byte(strawmanSchema))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if doc.Root.Kind != "db" {
		t.Fatalf("root kind = %q", doc.Root.Kind)
	}
	var tables int
	for _, c := range doc.Root.Children {
		if c.Kind == "table" {
			tables++
		}
	}
	if tables < 10 {
		t.Fatalf("only %d tables parsed; expected >=10", tables)
	}
}

// kinds returns the Kind of each section in ss, in order.
func kinds(ss []*Section) []string {
	out := make([]string, len(ss))
	for i, s := range ss {
		out[i] = s.Kind
	}
	return out
}

// strawmanSchema is a trimmed snippet of docs/hcsv_strawman/schema.hcsv
// that exercises every parser feature we care about: doc modifiers,
// quoted strings, multi-column quoted cells, partial-index where
// clauses, GIN expressions.
const strawmanSchema = `# db | doc="Canonical kitp database schema (strawman slice)"

## prop
name, value
extension, pg_trgm

## table user_account | doc="Users."
### meta
name_column, id_column
display_name, id

### columns
name, type, pk, unique, nullable, default, references, on_delete
id, bigserial, true, false, false, , ,
oidc_sub, text, false, true, true, , ,
display_name, text, false, false, false, , ,
parent_user_id, bigint, false, false, true, , user_account.id, cascade

## table role | doc="Application role."
### columns
name, type, pk, nullable, default
id, bigserial, true, false,
name, text, false, false,

### indexes
name, columns, unique
role_name_uniq, name, true

## table attribute_value | doc="composite PK demo"
### columns
name, type, pk, unique, nullable, default, references, on_delete
card_id, bigint, true, false, false, , card.id, cascade
attribute_def_id, bigint, true, false, false, , attribute_def.id, restrict
value, jsonb, false, false, true, , ,

### indexes
name, columns, expressions, unique, using, where
attribute_value_trgm, , "(value::text) gin_trgm_ops", false, gin,

## table user_role_v2 | doc="partial unique index demo"
### columns
name, type, pk, unique, nullable, default, references, on_delete
id, bigserial, true, false, false, , ,
user_id, bigint, false, false, false, , user_account.id, cascade
role_id, bigint, false, false, false, , role.id, cascade
scope_card_id, bigint, false, false, true, , card.id, cascade

### indexes
name, columns, expressions, unique, using, where
uniq_user_role_scoped, "user_id, role_id, scope_card_id", , true, , "scope_card_id IS NOT NULL"
uniq_user_role_global, "user_id, role_id", , true, , "scope_card_id IS NULL"

## table card | doc="A card."
### columns
name, type, pk, nullable, default, references, on_delete
id, bigserial, true, false, , ,
parent_card_id, bigint, false, true, , card.id, cascade

## table activity
### columns
name, type, pk, nullable, default, references, on_delete
id, bigserial, true, false, , ,
card_id, bigint, false, false, , card.id, cascade

### indexes
name, columns
activity_card, card_id

## table card_type
### columns
name, type, pk, nullable, default, references, on_delete
id, bigserial, true, false, , ,
parent_card_type_id, bigint, false, true, , card_type.id, restrict

## table attribute_def
### columns
name, type, pk, nullable, default, references, on_delete
id, bigserial, true, false, , ,
target_card_type_id, bigint, false, true, , card_type.id, restrict

## table edge
### columns
name, type, pk, nullable, default, references, on_delete
id, bigserial, true, false, , ,
card_type_id, bigint, false, false, , card_type.id, cascade
attribute_def_id, bigint, false, false, , attribute_def.id, cascade

## table process
### columns
name, type, pk, nullable, default
id, bigserial, true, false,

## table role_grant
### columns
name, type, pk, nullable, default, references, on_delete
id, bigserial, true, false, , ,
role_id, bigint, false, false, , role.id, cascade
card_type_id, bigint, false, false, , card_type.id, cascade
process_id, bigint, false, false, , process.id, cascade
`
