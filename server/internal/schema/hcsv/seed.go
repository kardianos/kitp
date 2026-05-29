// Package hcsv — seed/demo loader.
//
// This file consumes the hcsv AST produced by parse.go for seed.hcsv
// and demo.hcsv and renders it to SQL INSERT statements.
//
// The format is described in docs/hcsv_strawman/README.md. Quick recap of
// the row-level grammar handled here:
//
//   - bare cells: numbers (42, 3.14), bools (true, false), null, or
//     identifiers/strings (everything else). Strings are emitted as
//     SQL string literals when the target column is text/jsonb; bare
//     numbers and bools render directly.
//   - "..." double-quoted: always a SQL string literal.
//   - `...` backtick: contents verbatim — array / lookup / alias /
//     parent detection is suppressed. Emitted as `'...'` for text
//     columns and `to_jsonb('...'::text)` for attribute_value cells
//     (so embedded JSON survives the round trip as a JSON-encoded
//     string, the shape the client and predicate compiler consume).
//   - parent: id of the row owning this row's section via heading
//     nesting (depth-3 child of a depth-2 table card section).
//   - @<alias>: id of a previously-aliased row (alias= modifier on the
//     section, or alias column on the row).
//   - $<table>.<name> / $<table>."dotted.name": looks up the named row
//     in <table> using its `### meta` `name_column` or `name_attribute`.
//     Emitted as an inline SELECT subquery so the lookup resolves
//     whether the row was just inserted or already lived in the DB.
//   - [a, b, c]: cross-product expansion of the row (NOT applicable
//     when the cell targets a card_ref[] attribute — that case writes
//     the array as a JSON literal).
//
// Card-row attribute expansion: when a section is `# table card` (or
// `## table card`), the loader splits each row into structural columns
// (id, card_type_id, parent_card_id, phase, …) and attribute
// columns (any column matching a built-in attribute_def.name). For each
// attribute, one card_create activity is emitted per card, followed by
// per-attribute (activity, attribute_value) CTE pairs that thread
// last_activity_id from the just-inserted activity row.
//
// The demo guard clause (skip if any non-template project exists) is
// emitted as a single PL/pgSQL DO block wrapping the demo SQL — keeping
// the guard simple beats inventing more loader machinery for one
// fixture. The "non-template" qualifier exists so the install seed's
// own template project (Gate 11; flagged is_template=true) does not
// trip the guard before the demo runs on first apply.
package hcsv

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
)

// SeedOptions controls how a seed/demo document is rendered.
type SeedOptions struct {
	// GuardDemo wraps the final SQL in a DO $$ … END $$ block that
	// returns early when the card table already has rows. Used for
	// demo.hcsv where re-applying must be a no-op.
	GuardDemo bool

	// KnownAttrTypes pre-seeds the loader's attribute_name → value_type
	// map with entries harvested from upstream files. demo.hcsv doesn't
	// declare its own attribute_defs — those live in seed.hcsv — so
	// without this map the demo loader can't tell `tags` is a
	// card_ref[] attribute and falls through to cross-product
	// expansion on `[…]` cells (duplicating rows with 2+ tags,
	// silently dropping rows with `[]`).
	KnownAttrTypes map[string]string
}

// GenerateOptions controls GenerateAll.
type GenerateOptions struct {
	// Demo includes the contents of demo.hcsv after the install seed.
	Demo bool

	// DemoPath optionally overrides the default db/schema/demo.hcsv
	// location. When empty, the canonical demo file is used. Useful
	// for tests that want a stable fixture independent of the live
	// dev demo. Ignored when Demo=false.
	DemoPath string
}

// GenerateAll reads schema.hcsv + seed.hcsv + (optionally) demo.hcsv
// and renders one CREATE … + INSERT … SQL script. Mirrors the old
// declarative.GenerateAll contract.
func GenerateAll(opts GenerateOptions) (string, error) {
	schema, err := Load("")
	if err != nil {
		return "", err
	}
	seedPath, demoPath := SeedPaths()
	seedBuf, err := os.ReadFile(seedPath)
	if err != nil {
		return "", fmt.Errorf("hcsv: read %s: %w", seedPath, err)
	}
	seedDoc, err := Parse(seedBuf)
	if err != nil {
		return "", err
	}
	seedAttrTypes := collectAttributeValueTypes(seedDoc.Root)
	seedSQL, err := BuildSeed(seedDoc, schema, SeedOptions{})
	if err != nil {
		return "", err
	}
	var b strings.Builder
	b.WriteString("-- Auto-generated from db/schema/schema.hcsv + seed.hcsv (+ demo.hcsv) by\n")
	b.WriteString("-- server/cmd/schema-gen. Do not edit by hand.\n\n")
	b.WriteString(GenerateSQL(schema))
	if seedSQL != "" {
		b.WriteString("\n-- Seed: built-in system rows.\n")
		b.WriteString(seedSQL)
	}
	if opts.Demo {
		path := demoPath
		if opts.DemoPath != "" {
			path = opts.DemoPath
		}
		demoSQL, err := LoadSeed(path, schema, SeedOptions{
			GuardDemo:      true,
			KnownAttrTypes: seedAttrTypes,
		})
		if err != nil {
			return "", err
		}
		if demoSQL != "" {
			b.WriteString("\n-- Demo: opt-in fixture data.\n")
			b.WriteString(demoSQL)
		}
	}
	return b.String(), nil
}

// SeedPaths returns the canonical locations of seed.hcsv and demo.hcsv.
// KITP_SCHEMA_DIR (containers / packaged deploys) overrides the source-
// relative walk — see Path().
func SeedPaths() (seed, demo string) {
	if dir := os.Getenv("KITP_SCHEMA_DIR"); dir != "" {
		return filepath.Join(dir, "seed.hcsv"), filepath.Join(dir, "demo.hcsv")
	}
	_, file, _, _ := runtime.Caller(0)
	dir := filepath.Dir(file)
	for range 8 {
		s := filepath.Join(dir, "db", "schema", "seed.hcsv")
		d := filepath.Join(dir, "db", "schema", "demo.hcsv")
		if st, err := os.Stat(s); err == nil && !st.IsDir() {
			return s, d
		}
		dir = filepath.Dir(dir)
	}
	panic("hcsv: seed.hcsv not found above package source")
}

// TestDemoPath returns the canonical location of test_demo.hcsv —
// the stable, minimal demo fixture used by migrate-style tests when
// they want predictable row counts independent of dev demo growth.
func TestDemoPath() string {
	_, file, _, _ := runtime.Caller(0)
	dir := filepath.Dir(file)
	for range 8 {
		p := filepath.Join(dir, "db", "schema", "test_demo.hcsv")
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
		dir = filepath.Dir(dir)
	}
	panic("hcsv: test_demo.hcsv not found above package source")
}

// LoadSeed reads + parses a seed/demo file and returns the rendered
// SQL. The schema argument supplies column types, meta blocks, and
// the list of structural columns for attribute-expansion gating.
func LoadSeed(path string, schema *Schema, opts SeedOptions) (string, error) {
	buf, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("hcsv: read %s: %w", path, err)
	}
	doc, err := Parse(buf)
	if err != nil {
		return "", err
	}
	return BuildSeed(doc, schema, opts)
}

// BuildSeed renders a parsed seed/demo document.
func BuildSeed(doc *Document, schema *Schema, opts SeedOptions) (string, error) {
	if doc == nil || doc.Root == nil {
		return "", fmt.Errorf("hcsv: empty document")
	}
	root := doc.Root
	switch root.Kind {
	case "seed", "demo":
		// ok
	default:
		return "", fmt.Errorf("hcsv: root section must be `# seed` or `# demo`, got %q at line %d", root.Kind, root.Line)
	}
	attrTypes := collectAttributeValueTypes(root)
	for name, vt := range opts.KnownAttrTypes {
		if _, ok := attrTypes[name]; !ok {
			attrTypes[name] = vt
		}
	}
	l := &seedLoader{
		schema:        schema,
		tables:        indexTables(schema),
		aliases:       map[string]*seedRow{},
		attrValueType: attrTypes,
	}
	if err := l.walk(root, nil); err != nil {
		return "", err
	}
	if err := l.topoSort(); err != nil {
		return "", err
	}
	body := l.emit()
	if opts.GuardDemo {
		var b strings.Builder
		b.WriteString("DO $demo$ BEGIN\n")
		// Skip the demo when a non-template project already exists. The
		// install seed (Gate 11) creates a 'Standard Project Template'
		// project flagged is_template=true; the guard ignores that one so
		// the demo / test_demo loads on first apply but is a no-op on
		// re-apply where the demo project itself is present.
		b.WriteString("IF EXISTS (SELECT 1 FROM card c WHERE c.card_type_id=(SELECT id FROM card_type WHERE name='project') AND NOT EXISTS (SELECT 1 FROM attribute_value av JOIN attribute_def ad ON ad.id=av.attribute_def_id WHERE av.card_id=c.id AND ad.name='is_template' AND av.value=to_jsonb(TRUE))) THEN RETURN; END IF;\n")
		// setval() emitted by reset_sequence is a plain SELECT — wrap
		// as PERFORM so PL/pgSQL accepts it.
		body = strings.ReplaceAll(body, "SELECT setval(", "PERFORM setval(")
		b.WriteString(body)
		b.WriteString("END $demo$;\n")
		return b.String(), nil
	}
	return body, nil
}

// ---------------------------------------------------------------------
// AST → row plan
// ---------------------------------------------------------------------

// seedRow is one expanded insert candidate. After array expansion each
// expanded row is its own seedRow. Aliases map to (one of) the rows
// that carry the alias (a section-level alias attaches to every row
// in the section; a row-level `alias` column attaches to a single row).
type seedRow struct {
	id        int // 1-based unique id used for graph keys
	table     string
	parent    *seedRow // resolved at walk time; nil for depth-1 sections
	cells     map[string]cellValue
	alias     string // optional
	section   *seedSection
	deps      []int
	resolvedT topoState
}

type topoState int

const (
	topoUnvisited topoState = iota
	topoVisiting
	topoDone
)

// seedSection is the loader's mirror of one section heading. Holds
// the modifier set (on_conflict, reset_sequence, under, alias).
type seedSection struct {
	table         string
	depth         int
	onConflict    []string
	onConflictAny bool // on_conflict="*" — emits ON CONFLICT DO NOTHING (no target)
	resetSequence string
	underAlias    string // explicit `under=...` modifier
	defaultAlias  string // `alias=...` modifier; tags every row
	guard         string // `guard="<SQL expression>"` — skip section when expr is true
	rows          []*seedRow
	line          int
}

// cellValue is the parsed form of one cell.
type cellValue struct {
	kind cellKind
	// raw is the cell's source text (post-CSV decoding).
	raw string
	// text is the resolved literal — depends on kind.
	text string
	// arr is set when kind==ckArray.
	arr []cellValue
	// lookupTable / lookupName for ckLookup.
	lookupTable, lookupName string
	// aliasName for ckAlias.
	aliasName string
}

type cellKind int

const (
	ckBare      cellKind = iota // numeric/bool/null/identifier/bare text
	ckString                    // explicit "..." or already-resolved
	ckBacktick                  // backtick content (verbatim)
	ckParent                    // literal `parent`
	ckAlias                     // @name
	ckLookup                    // $table.name
	ckArray                     // [a, b, c]
	ckNull                      // literal `null`
)

// seedLoader builds the row list during AST walk and emits SQL after
// toposort.
type seedLoader struct {
	schema  *Schema
	tables  map[string]*Table
	rows    []*seedRow
	aliases map[string]*seedRow // alias-name → row carrying that alias
	// sectionStack is the chain of currently-open depth-2 sections so
	// depth-3+ sections find their `parent` row.
	sectionStack []*seedSection
	// attrValueType maps attribute_def name → value_type, pre-scanned
	// from the parsed Doc so the loader can distinguish "cross-product
	// over a list" (the default for `[…]` cells), "JSON array value"
	// (for card_ref[] cells), and "verbatim JSON literal in backticks"
	// (for any other non-card_ref attribute) without a hardcoded
	// switch on the attribute name. See V18 / FLOW_AND_SCREEN_KERNEL.md
	// gate-5 cross-cutting cleanup.
	attrValueType map[string]string
}

// collectAttributeValueTypes walks the parsed doc once before the loader
// starts emitting rows and indexes every attribute_def row by name →
// value_type. The loader consults the map when parsing card-table cells
// to decide between:
//   - card_ref[] → the `[…]` cell is a JSON-array literal (no cross-
//     product expansion);
//   - anything else (text / number / bool / card_ref) → backtick-quoted
//     cells stay verbatim so embedded JSON arrays / objects do not
//     trigger array expansion through `[`. Non-backtick cells fall
//     through to the normal grammar.
//
// Schema-driven so adding a new attribute / value_type doesn't require
// touching this file. The hardcoded `tags` switch this replaced was the
// last knob the loader carried about specific attribute names.
func collectAttributeValueTypes(root *Section) map[string]string {
	out := map[string]string{}
	var visit func(*Section)
	visit = func(sec *Section) {
		if sec == nil {
			return
		}
		// Match either `## table attribute_def` (the seed file's depth
		// for top-level tables) or any depth — we don't constrain
		// because seed.hcsv keeps attribute_def at depth 2.
		if sec.Kind == "table" && sec.Name == "attribute_def" {
			for _, child := range sec.Children {
				if child.Kind != "rows" {
					continue
				}
				nameCol := -1
				typeCol := -1
				for i, h := range child.Header {
					switch h {
					case "name":
						nameCol = i
					case "value_type":
						typeCol = i
					}
				}
				if nameCol < 0 || typeCol < 0 {
					continue
				}
				for _, row := range child.Rows {
					if nameCol >= len(row) || typeCol >= len(row) {
						continue
					}
					out[strings.TrimSpace(row[nameCol])] = strings.TrimSpace(row[typeCol])
				}
			}
		}
		for _, child := range sec.Children {
			visit(child)
		}
	}
	visit(root)
	return out
}

func indexTables(s *Schema) map[string]*Table {
	out := make(map[string]*Table, len(s.Tables))
	for i := range s.Tables {
		t := &s.Tables[i]
		out[t.Name] = t
	}
	return out
}

// walk recurses into the AST, materialising one *seedRow per data row.
func (l *seedLoader) walk(sec *Section, parent *seedRow) error {
	for _, child := range sec.Children {
		switch child.Kind {
		case "table":
			ts, err := l.readTableSection(child, parent)
			if err != nil {
				return err
			}
			// Each row in the section becomes a candidate parent for the
			// children of THIS section heading. (Most table sections
			// have no children themselves; depth-2 card sections often
			// do.) Use the LAST row as the parent — matches strawman
			// rule: `parent` resolves to the last row of the parent
			// section unless `under=` overrides.
			var nextParent *seedRow
			if len(ts.rows) > 0 {
				nextParent = ts.rows[len(ts.rows)-1]
			}
			if err := l.walk(child, nextParent); err != nil {
				return err
			}
		case "rows":
			// `### rows` is consumed by readTableSection, but if a
			// `### rows` appears directly under the root for some
			// reason, skip rather than error.
		default:
			return fmt.Errorf("hcsv: line %d: unsupported section %q under %q", child.Line, child.Kind, sec.Kind)
		}
	}
	return nil
}

// readTableSection parses one `# table <name>` (or `## table <name>`)
// heading + its `### rows` child.
func (l *seedLoader) readTableSection(sec *Section, parent *seedRow) (*seedSection, error) {
	if sec.Name == "" {
		return nil, fmt.Errorf("hcsv: line %d: `table` heading missing name", sec.Line)
	}
	tbl, ok := l.tables[sec.Name]
	if !ok {
		return nil, fmt.Errorf("hcsv: line %d: unknown table %q", sec.Line, sec.Name)
	}

	ts := &seedSection{
		table:         sec.Name,
		depth:         sec.Depth,
		defaultAlias:  sec.Modifiers["alias"],
		underAlias:    sec.Modifiers["under"],
		resetSequence: sec.Modifiers["reset_sequence"],
		guard:         sec.Modifiers["guard"],
		line:          sec.Line,
	}
	if oc := sec.Modifiers["on_conflict"]; oc != "" {
		if strings.ContainsRune(oc, ';') {
			return nil, fmt.Errorf("hcsv: line %d: on_conflict cannot contain `;`", sec.Line)
		}
		if strings.TrimSpace(oc) == "*" {
			ts.onConflictAny = true
		} else {
			ts.onConflict = splitList(oc)
		}
	}

	// Resolve `under=` against the loader-wide alias map. We may not
	// have seen the alias yet — defer to the second pass if so.
	var explicitParent *seedRow
	if ts.underAlias != "" {
		if r, ok := l.aliases[ts.underAlias]; ok {
			explicitParent = r
		} else {
			// stored as deferred: encode it in the row's deps via a
			// synthetic placeholder. To keep this simple we require
			// the alias to be defined earlier in the file; aliases are
			// declared, not referenced into the future, in the seed
			// shape we have today.
			return nil, fmt.Errorf("hcsv: line %d: under=%q references unknown alias", sec.Line, ts.underAlias)
		}
	}

	// Find the ### rows child.
	var rowsSec *Section
	for _, child := range sec.Children {
		if child.Kind == "rows" {
			rowsSec = child
			break
		}
	}
	if rowsSec == nil {
		// A table heading with no rows is legal but pointless; let it slide.
		l.sectionStack = append(l.sectionStack, ts)
		defer func() { l.sectionStack = l.sectionStack[:len(l.sectionStack)-1] }()
		return ts, nil
	}
	if rowsSec.Header == nil {
		return nil, fmt.Errorf("hcsv: line %d: rows section has no header", rowsSec.Line)
	}

	// For each data row in the section, parse cells, expand arrays
	// (cross-product) and emit one seedRow per expanded tuple.
	header := rowsSec.Header
	for _, row := range rowsSec.Rows {
		// Parse each cell into cellValue, tracking which column it
		// belongs to so we know whether `[…]` is cross-product (default)
		// or a JSON array (target attribute is card_ref[]).
		parsed := make([]cellValue, len(header))
		for i, h := range header {
			raw := ""
			if i < len(row) {
				raw = row[i]
			}
			pv, err := parseCell(raw, l.isCardRefArrayAttr(tbl, h), l.verbatimBacktickFor(tbl, h))
			if err != nil {
				return nil, fmt.Errorf("hcsv: line %d: column %q: %w", rowsSec.Line, h, err)
			}
			parsed[i] = pv
		}
		// Cross-product expansion. Build all combinations of array
		// cells; non-array cells fix their single value across the
		// expansion.
		expansions := expandArrays(parsed)
		for _, exp := range expansions {
			sr := &seedRow{
				id:      len(l.rows) + 1,
				table:   sec.Name,
				cells:   map[string]cellValue{},
				section: ts,
			}
			if explicitParent != nil {
				sr.parent = explicitParent
			} else {
				sr.parent = parent
			}
			for i, h := range header {
				if h == "alias" {
					if exp[i].kind == ckBare || exp[i].kind == ckString {
						sr.alias = strings.TrimSpace(exp[i].text)
					}
					continue
				}
				sr.cells[h] = exp[i]
			}
			if ts.defaultAlias != "" && sr.alias == "" {
				sr.alias = ts.defaultAlias
			}
			if sr.alias != "" {
				if _, exists := l.aliases[sr.alias]; exists {
					return nil, fmt.Errorf("hcsv: line %d: alias %q reused", rowsSec.Line, sr.alias)
				}
				l.aliases[sr.alias] = sr
			}
			ts.rows = append(ts.rows, sr)
			l.rows = append(l.rows, sr)
		}
	}
	return ts, nil
}

// isCardRefArrayAttr reports whether column `name` on table `t` is a
// card-attribute (for card-table only) whose attribute_def has value
// type card_ref[]. The answer is data-driven: the loader pre-scans
// every attribute_def row in the doc at construction time and stashes
// each name's value_type in `l.attrValueType`. No hardcoded list of
// attribute names anywhere in the loader.
func (l *seedLoader) isCardRefArrayAttr(t *Table, name string) bool {
	if t.Name != "card" {
		return false
	}
	return l.attrValueType[name] == "card_ref[]"
}

// verbatimBacktickFor reports whether a backtick-quoted cell on column
// `name` of table `t` should be carried through as ckBacktick verbatim
// (no array / lookup interpretation). Two cases qualify:
//
//   - A card attribute whose value_type is anything OTHER than card_ref
//     / card_ref[]. These attributes (`text`, `number`, `bool`) often
//     hold JSON literals (predicate trees, toggle-group specs); leading
//     `[` in a backtick cell must not trigger cross-product expansion.
//   - A jsonb column on a non-card table. Backtick-quoted JSON values
//     stored directly in a jsonb column similarly shouldn't be parsed
//     as cross-product lists.
//
// Backtick-wrapped lists of $-lookups used to drive role_grant cross-
// product expansion (bigint columns, no value_type) are NOT covered —
// those land here with `false` and the loader strips the marker, leaving
// the normal cell grammar to interpret the `[…]` as ckArray.
func (l *seedLoader) verbatimBacktickFor(t *Table, name string) bool {
	if t.Name == "card" {
		vt, ok := l.attrValueType[name]
		if !ok {
			return false
		}
		switch vt {
		case "card_ref", "card_ref[]":
			return false
		}
		return true
	}
	if t != nil {
		for _, c := range t.Columns {
			if c.Name == name {
				ct := strings.ToLower(c.Type)
				if strings.HasPrefix(ct, "jsonb") {
					return true
				}
				return false
			}
		}
	}
	return false
}

// isStructuralCardColumn returns true when `name` is a physical
// column on the card table (per the parsed Schema). Other columns
// become attribute_value rows via attribute expansion.
//
// Derived from the Schema rather than a hard-coded switch so adding
// a card-table column in schema.hcsv doesn't require a code update
// here. `alias` is the lone synthetic column the loader consumes
// for row-id labels — never structural, never an attribute.
func isStructuralCardColumn(schema *Schema, name string) bool {
	if name == "alias" {
		return false
	}
	if schema == nil {
		return false
	}
	for _, t := range schema.Tables {
		if t.Name != "card" {
			continue
		}
		for _, c := range t.Columns {
			if c.Name == name {
				return true
			}
		}
		return false
	}
	return false
}

// ---------------------------------------------------------------------
// Cell parsing
// ---------------------------------------------------------------------

// parseCell decodes one CSV-decoded raw cell into a cellValue. When
// the column targets a card_ref[] attribute, `[…]` is parsed as a
// single JSON-array value rather than cross-product expansion.
//
// `verbatimBacktick` (set by callers for jsonb columns and non-card_ref
// card-attribute columns) tells the parser that backtick-quoted content
// should be carried through as ckBacktick — leading `[` does NOT trigger
// cross-product expansion. The other use of backtick — wrapping a
// cross-product list of $-lookups for an integer column, e.g. role_grant
// rows — is preserved by leaving `verbatimBacktick=false` for those
// columns: parseCell strips the marker and the `[…]` content is parsed
// normally as ckArray.
func parseCell(raw string, isCardRefArray, verbatimBacktick bool) (cellValue, error) {
	if strings.HasPrefix(raw, backtickPrefix) {
		inner := raw[len(backtickPrefix):]
		if verbatimBacktick {
			return cellValue{kind: ckBacktick, raw: raw, text: inner}, nil
		}
		// Strip the marker and let the rest of the cell-grammar (array /
		// $-lookup / @-alias / parent / null / bare) own the
		// interpretation. This is how the role_grant cross-product
		// expansion has worked since the loader landed.
		raw = inner
	}
	s := strings.TrimSpace(raw)
	if s == "" {
		return cellValue{kind: ckBare, raw: "", text: ""}, nil
	}
	switch {
	case s == "null" || s == "NULL":
		return cellValue{kind: ckNull, raw: raw}, nil
	case s == "parent":
		return cellValue{kind: ckParent, raw: raw}, nil
	case strings.HasPrefix(s, "@"):
		return cellValue{kind: ckAlias, raw: raw, aliasName: s[1:]}, nil
	case strings.HasPrefix(s, "$"):
		tbl, name, err := parseLookup(s[1:])
		if err != nil {
			return cellValue{}, err
		}
		return cellValue{kind: ckLookup, raw: raw, lookupTable: tbl, lookupName: name}, nil
	case strings.HasPrefix(s, "[") && strings.HasSuffix(s, "]"):
		inner := s[1 : len(s)-1]
		parts, err := splitArrayElements(inner)
		if err != nil {
			return cellValue{}, err
		}
		arr := make([]cellValue, 0, len(parts))
		for _, p := range parts {
			elt, err := parseCell(p, false, false) // elements don't recurse into special cases
			if err != nil {
				return cellValue{}, err
			}
			arr = append(arr, elt)
		}
		cv := cellValue{kind: ckArray, raw: raw, arr: arr}
		if isCardRefArray {
			// caller will treat this single cellValue as a JSON-array
			// literal at render time. Use a sentinel via raw flag.
			cv.text = "card_ref_array"
		}
		return cv, nil
	}
	// Bare / numeric / bool — leave for renderValue to decide based on
	// target column type.
	return cellValue{kind: ckBare, raw: raw, text: s}, nil
}

// parseLookup splits "table.name" or `table."dotted.name"`.
func parseLookup(s string) (string, string, error) {
	dot := strings.IndexByte(s, '.')
	if dot < 0 {
		return "", "", fmt.Errorf("$-lookup %q: expected `table.name`", s)
	}
	tbl := s[:dot]
	rest := s[dot+1:]
	if len(rest) >= 2 && rest[0] == '"' && rest[len(rest)-1] == '"' {
		return tbl, rest[1 : len(rest)-1], nil
	}
	return tbl, rest, nil
}

// splitArrayElements splits the inside of `[…]` by commas at depth 0,
// respecting nested brackets and quoted segments.
func splitArrayElements(s string) ([]string, error) {
	var out []string
	depth := 0
	inQ := false
	inBt := false
	start := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case inQ:
			if c == '"' {
				if i+1 < len(s) && s[i+1] == '"' {
					i++
					continue
				}
				inQ = false
			}
		case inBt:
			if c == '`' {
				inBt = false
			}
		default:
			switch c {
			case '"':
				inQ = true
			case '`':
				inBt = true
			case '[':
				depth++
			case ']':
				depth--
			case ',':
				if depth == 0 {
					out = append(out, strings.TrimSpace(s[start:i]))
					start = i + 1
				}
			}
		}
	}
	if inQ || inBt {
		return nil, fmt.Errorf("unterminated quoted element in array")
	}
	tail := strings.TrimSpace(s[start:])
	if tail != "" || len(out) > 0 {
		out = append(out, tail)
	}
	return out, nil
}

// expandArrays takes one parsed-cell row and returns N cross-product
// expansions. A non-array cell contributes a single value. An array
// cell flagged as a JSON-array literal (text=="card_ref_array")
// contributes a single value too — the array survives intact.
func expandArrays(cells []cellValue) [][]cellValue {
	out := [][]cellValue{{}}
	for _, c := range cells {
		if c.kind == ckArray && c.text != "card_ref_array" {
			next := make([][]cellValue, 0, len(out)*len(c.arr))
			for _, prefix := range out {
				for _, elt := range c.arr {
					grown := make([]cellValue, len(prefix)+1)
					copy(grown, prefix)
					grown[len(prefix)] = elt
					next = append(next, grown)
				}
			}
			out = next
		} else {
			for i := range out {
				out[i] = append(out[i], c)
			}
		}
	}
	return out
}

// ---------------------------------------------------------------------
// Toposort
// ---------------------------------------------------------------------

// topoSort orders l.rows so that for any row R that depends on another
// row D in the same file, D comes first. Dependencies come from
// `parent` references, @<alias> references, and $-lookups when the
// looked-up table+name is also a row being inserted in this run.
//
// $-lookups that resolve to pre-existing DB rows render as inline
// SELECT subqueries — no cross-row dependency needed.
func (l *seedLoader) topoSort() error {
	rowsByAlias := l.aliases
	// Build a synthetic lookup-by-name for rows the file inserts.
	// (table+name → seedRow) where `name` is determined by the row's
	// table meta.
	byNamedKey := map[string]*seedRow{}
	for _, r := range l.rows {
		key, ok := l.namedKey(r)
		if ok {
			byNamedKey[key] = r
		}
	}

	for _, r := range l.rows {
		// `parent` dependency from heading nesting.
		if r.parent != nil {
			r.deps = append(r.deps, r.parent.id)
		}
		for _, c := range r.cells {
			r.deps = append(r.deps, l.depsFromCell(c, rowsByAlias, byNamedKey)...)
		}
	}

	var sorted []*seedRow
	byID := map[int]*seedRow{}
	for _, r := range l.rows {
		byID[r.id] = r
	}
	var visit func(r *seedRow, stack []int) error
	visit = func(r *seedRow, stack []int) error {
		if r.resolvedT == topoDone {
			return nil
		}
		if r.resolvedT == topoVisiting {
			return fmt.Errorf("hcsv: dependency cycle involving row table=%s alias=%s", r.table, r.alias)
		}
		r.resolvedT = topoVisiting
		for _, d := range r.deps {
			dep, ok := byID[d]
			if !ok {
				continue
			}
			if err := visit(dep, append(stack, r.id)); err != nil {
				return err
			}
		}
		r.resolvedT = topoDone
		sorted = append(sorted, r)
		return nil
	}
	for _, r := range l.rows {
		if err := visit(r, nil); err != nil {
			return err
		}
	}
	l.rows = sorted
	return nil
}

// namedKey returns a "table:name" string for r when the table's meta
// declares a name_column AND the row carries a value for that column.
// Used by toposort and $-lookups to wire same-file references without
// needing a SELECT subquery.
func (l *seedLoader) namedKey(r *seedRow) (string, bool) {
	tbl, ok := l.tables[r.table]
	if !ok || tbl.Meta == nil {
		return "", false
	}
	nameCol := tbl.Meta["name_column"]
	if nameCol == "" {
		return "", false
	}
	c, ok := r.cells[nameCol]
	if !ok {
		return "", false
	}
	if c.kind == ckBare || c.kind == ckString {
		return r.table + ":" + c.text, true
	}
	return "", false
}

// depsFromCell returns the row-ids c references.
func (l *seedLoader) depsFromCell(c cellValue, byAlias map[string]*seedRow, byNamed map[string]*seedRow) []int {
	var out []int
	switch c.kind {
	case ckAlias:
		if r, ok := byAlias[c.aliasName]; ok {
			out = append(out, r.id)
		}
	case ckLookup:
		if r, ok := byNamed[c.lookupTable+":"+c.lookupName]; ok {
			out = append(out, r.id)
		}
	case ckArray:
		for _, e := range c.arr {
			out = append(out, l.depsFromCell(e, byAlias, byNamed)...)
		}
	}
	return out
}

// ---------------------------------------------------------------------
// SQL emission
// ---------------------------------------------------------------------

// emit walks sorted rows and writes SQL. Card rows trigger attribute
// expansion. All other rows are simple INSERTs. A section's
// reset_sequence fires immediately after the section's last row in
// toposort order — so later sections that auto-allocate ids see the
// advanced sequence.
func (l *seedLoader) emit() string {
	var b strings.Builder
	// Count rows per section to know when we've hit the last one.
	rowsLeft := map[*seedSection]int{}
	for _, r := range l.rows {
		rowsLeft[r.section]++
	}
	for _, r := range l.rows {
		if r.table == "card" {
			l.emitCardRow(&b, r)
		} else {
			l.emitPlainRow(&b, r)
		}
		rowsLeft[r.section]--
		if rowsLeft[r.section] == 0 && r.section.resetSequence != "" {
			fmt.Fprintf(&b,
				"SELECT setval('%s', GREATEST((SELECT COALESCE(MAX(id), 0) FROM %s), 1));\n",
				r.section.resetSequence, r.section.table)
		}
	}
	return b.String()
}

// emitPlainRow writes one INSERT for a non-card row.
func (l *seedLoader) emitPlainRow(b *strings.Builder, r *seedRow) {
	tbl := l.tables[r.table]
	cols := make([]string, 0, len(r.cells))
	for k := range r.cells {
		cols = append(cols, k)
	}
	sort.Strings(cols)
	fmt.Fprintf(b, "INSERT INTO %s (%s) VALUES (", r.table, strings.Join(cols, ", "))
	for i, c := range cols {
		if i > 0 {
			b.WriteString(", ")
		}
		b.WriteString(l.renderForColumn(r, r.cells[c], tbl, c))
	}
	b.WriteString(")")
	if r.section.onConflictAny {
		b.WriteString(" ON CONFLICT DO NOTHING")
	} else if len(r.section.onConflict) > 0 {
		fmt.Fprintf(b, " ON CONFLICT (%s) DO NOTHING", strings.Join(r.section.onConflict, ", "))
	}
	b.WriteString(";\n")
}

// emitCardRow writes:
//
//   - INSERT INTO card (structural columns) [RETURNING id INTO …]
//   - INSERT INTO activity (kind='card_create')
//   - per attribute: WITH a AS (INSERT INTO activity … RETURNING id)
//     INSERT INTO attribute_value … SELECT … FROM a;
//
// To plumb the just-inserted card id into subsequent inserts without
// a session variable, we use a single WITH chain rooted in the card
// INSERT. Each per-attribute CTE feeds off the card-id CTE.
func (l *seedLoader) emitCardRow(b *strings.Builder, r *seedRow) {
	// Partition columns.
	var structCols []string
	var attrCols []string
	for k := range r.cells {
		if isStructuralCardColumn(l.schema, k) {
			structCols = append(structCols, k)
		} else {
			attrCols = append(attrCols, k)
		}
	}
	sort.Strings(structCols)
	sort.Strings(attrCols)

	// Drop attribute columns whose value is null or an empty bare cell
	// — matches the runtime rule (no attribute_value row written for
	// an absent attribute).
	{
		kept := attrCols[:0]
		for _, k := range attrCols {
			cv := r.cells[k]
			if cv.kind == ckNull {
				continue
			}
			if cv.kind == ckBare && strings.TrimSpace(cv.text) == "" {
				continue
			}
			kept = append(kept, k)
		}
		attrCols = kept
	}

	// Use a CTE chain. The TRAILING statement (no longer a CTE) is the
	// last operation in the chain so the statement is valid both at
	// top level AND inside a DO $$ … $$ block (PG forbids a trailing
	// `SELECT` inside DO; an INSERT is fine).
	b.WriteString("WITH ")
	// 1) the card row
	b.WriteString("c AS (\n    INSERT INTO card (")
	b.WriteString(strings.Join(structCols, ", "))
	b.WriteString(") VALUES (")
	tbl := l.tables["card"]
	for i, k := range structCols {
		if i > 0 {
			b.WriteString(", ")
		}
		b.WriteString(l.renderForColumn(r, r.cells[k], tbl, k))
	}
	b.WriteString(")")
	if r.section.onConflictAny {
		b.WriteString(" ON CONFLICT DO NOTHING")
	} else if len(r.section.onConflict) > 0 {
		fmt.Fprintf(b, " ON CONFLICT (%s) DO NOTHING", strings.Join(r.section.onConflict, ", "))
	}
	b.WriteString(" RETURNING id\n)")

	// 2) card_create activity. The trailing statement when there are no
	// attribute columns; otherwise a CTE.
	adef := func(name string) string {
		return fmt.Sprintf("(SELECT id FROM attribute_def WHERE name=%s)", sqlString(name))
	}
	if len(attrCols) == 0 {
		b.WriteString("\nINSERT INTO activity (card_id, kind, actor_id)\n")
		b.WriteString("SELECT id, 'card_create', 1 FROM c;\n")
		return
	}

	b.WriteString(", crt AS (\n    INSERT INTO activity (card_id, kind, actor_id)\n")
	b.WriteString("    SELECT id, 'card_create', 1 FROM c RETURNING card_id\n)")

	// 3) one (activity, attribute_value) pair per attribute. All but
	// the LAST pair live in CTEs; the last attribute_value INSERT is
	// the top-level statement.
	for i, k := range attrCols {
		cv := r.cells[k]
		jsonExpr := l.renderJSON(cv)
		actCTE := fmt.Sprintf("aa%d", i)
		fmt.Fprintf(b, ", %s AS (\n", actCTE)
		fmt.Fprintf(b, "    INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)\n")
		fmt.Fprintf(b, "    SELECT c.id, 'attr_update', %s, NULL, %s, 1 FROM c, crt\n", adef(k), jsonExpr)
		fmt.Fprintf(b, "    RETURNING id, card_id\n)")
		isLast := i == len(attrCols)-1
		if !isLast {
			avCTE := fmt.Sprintf("av%d", i)
			fmt.Fprintf(b, ", %s AS (\n", avCTE)
			fmt.Fprintf(b, "    INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)\n")
			fmt.Fprintf(b, "    SELECT c.id, %s, %s, %s.id FROM c, %s\n", adef(k), jsonExpr, actCTE, actCTE)
			fmt.Fprintf(b, "    RETURNING card_id\n)")
		} else {
			// Trailing top-level INSERT — no CTE wrap, no RETURNING.
			fmt.Fprintf(b, "\nINSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)\n")
			fmt.Fprintf(b, "SELECT c.id, %s, %s, %s.id FROM c, %s;\n", adef(k), jsonExpr, actCTE, actCTE)
		}
	}
}

// renderCell turns one cell value into a SQL expression for a column
// whose type is `colType` (lowercased postgres type string, e.g. "text",
// "bigint", "jsonb"). The column-type input lets us decide bare-cell
// quoting and bool/int rendering.
func (l *seedLoader) renderCell(_ *seedRow, c cellValue, colType string) string {
	switch c.kind {
	case ckNull:
		return "NULL"
	case ckParent:
		// `parent` requires row context — handled in renderCellWithRow.
		return "NULL"
	case ckAlias:
		return l.aliasLookupSQL(c.aliasName)
	case ckLookup:
		return l.dollarLookupSQL(c.lookupTable, c.lookupName)
	case ckString:
		return sqlString(c.text)
	case ckBacktick:
		if strings.HasPrefix(colType, "jsonb") {
			return sqlString(c.text) + "::jsonb"
		}
		return sqlString(c.text)
	case ckArray:
		// Non-card_ref[] cross-product expansion already happened at
		// walk time. If we reach here we shouldn't have an unexpanded
		// array cross-product cell. card_ref[] gets rendered specially
		// from renderJSON, not via renderCell — but handle for safety.
		return l.renderJSON(c)
	case ckBare:
		return renderBareForColumn(c.text, colType)
	}
	return "NULL"
}

// renderCellWithRow is the row-aware version of renderCell. The
// `parent` cell-kind needs the owning row's .parent pointer; every
// other kind is row-independent and falls through to renderCell.
func (l *seedLoader) renderCellWithRow(r *seedRow, c cellValue, colType string) string {
	if c.kind == ckParent {
		if r.parent == nil {
			return "NULL"
		}
		return l.rowIDExpr(r.parent)
	}
	return l.renderCell(r, c, colType)
}

// rowIDExpr returns a SQL expression yielding the id of a previously
// inserted row. Card rows live inside a CTE; non-card rows are
// addressed by their natural-name lookup (always available since
// `parent` only appears on card rows for the parent project/etc.).
//
// For card-parent references we cannot use a CTE because the parent's
// CTE is in a different statement. Instead, emit a subquery that
// selects the id from card via attribute_value/<name_attribute>. The
// attribute name comes from the card table's `### meta name_attribute`
// — no hardcoded `title` knowledge here. For non-name parents (rare)
// the strawman expects an explicit alias.
func (l *seedLoader) rowIDExpr(r *seedRow) string {
	// Prefer an alias if one was declared (we record it but still need
	// to map back to a SQL expression). Aliases also can't cross CTE
	// boundaries, so we resolve them via a subquery against the table.
	return l.cardLookupByNameAttr(r)
}

// cardLookupByNameAttr emits `(SELECT id FROM card WHERE … <name_attr>='X')`
// using the row's name-attribute value. The attribute name (`title`
// in the live schema) comes from the card table's meta block —
// schema.hcsv is the single source of truth on which attribute names
// cards by.
//
// When the row has a known parent (from heading nesting or `under=`),
// the subquery also constrains on `parent_card_id` — necessary now that
// the install seed and demo / test_demo can both define cards with the
// same title (e.g., "Inbox" exists on both the template and Default
// Project). Without the parent constraint a downstream `@sc_inbox`
// reference would resolve via `LIMIT 1` to whichever screen happened to
// land first in the result set.
func (l *seedLoader) cardLookupByNameAttr(r *seedRow) string {
	nameAttr := l.cardNameAttribute()
	if nameAttr == "" {
		return "NULL /* card meta missing name_attribute */"
	}
	nameCell, ok := r.cells[nameAttr]
	if !ok {
		return fmt.Sprintf("NULL /* unresolved card parent: no %s attribute */", nameAttr)
	}
	if nameCell.kind != ckString && nameCell.kind != ckBare {
		return fmt.Sprintf("NULL /* parent %s is dynamic */", nameAttr)
	}
	// Constrain by card_type too if known.
	ctCell, _ := r.cells["card_type_id"]
	njson := fmt.Sprintf("to_jsonb(%s::text)", sqlString(nameCell.text))
	conds := []string{
		fmt.Sprintf("ad.name=%s", sqlString(nameAttr)),
		fmt.Sprintf("av.value=%s", njson),
	}
	if ctCell.kind == ckLookup {
		ctSel := fmt.Sprintf("(SELECT id FROM %s WHERE name=%s)", ctCell.lookupTable, sqlString(ctCell.lookupName))
		conds = append(conds, fmt.Sprintf("c.card_type_id=%s", ctSel))
	}
	if r.parent != nil {
		conds = append(conds, fmt.Sprintf("c.parent_card_id=%s", l.cardLookupByNameAttr(r.parent)))
	}
	return fmt.Sprintf(
		"(SELECT av.card_id FROM attribute_value av JOIN attribute_def ad ON ad.id=av.attribute_def_id JOIN card c ON c.id=av.card_id WHERE %s LIMIT 1)",
		strings.Join(conds, " AND "))
}

// cardNameAttribute pulls the `name_attribute` value from the card
// table's `### meta` block. Empty string when the schema doesn't carry
// one — caller renders a fallback marker so a broken schema is loud.
func (l *seedLoader) cardNameAttribute() string {
	tbl, ok := l.tables["card"]
	if !ok || tbl.Meta == nil {
		return ""
	}
	return tbl.Meta["name_attribute"]
}

// aliasLookupSQL returns a SQL expression resolving an @alias to its
// row id. For card rows we resolve via the name-attribute subquery
// (cross-CTE-statement-safe). For non-card rows we use the table's
// natural-name lookup.
func (l *seedLoader) aliasLookupSQL(alias string) string {
	r, ok := l.aliases[alias]
	if !ok {
		return fmt.Sprintf("NULL /* unknown alias @%s */", alias)
	}
	if r.table == "card" {
		return l.cardLookupByNameAttr(r)
	}
	// Non-card alias: use the table's name_column lookup if the row
	// has a value for it; otherwise fall back to a default.
	tbl, _ := l.tables[r.table]
	if tbl != nil && tbl.Meta != nil {
		if nc := tbl.Meta["name_column"]; nc != "" {
			if cv, ok := r.cells[nc]; ok && (cv.kind == ckBare || cv.kind == ckString) {
				return fmt.Sprintf("(SELECT id FROM %s WHERE %s=%s)", r.table, nc, sqlString(cv.text))
			}
		}
	}
	return fmt.Sprintf("NULL /* alias @%s: no name_column meta */", alias)
}

// dollarLookupSQL emits an inline SELECT for $<table>.<name>. Uses the
// table's `### meta` to find the column or attribute that holds the
// natural name — schema.hcsv is the single source of truth so the
// loader never hardcodes a specific attribute name.
func (l *seedLoader) dollarLookupSQL(table, name string) string {
	tbl, ok := l.tables[table]
	if !ok {
		return fmt.Sprintf("NULL /* unknown table %q */", table)
	}
	if tbl.Meta != nil {
		if nc := tbl.Meta["name_column"]; nc != "" {
			return fmt.Sprintf("(SELECT id FROM %s WHERE %s=%s)", table, nc, sqlString(name))
		}
		if na := tbl.Meta["name_attribute"]; na != "" {
			return fmt.Sprintf(
				"(SELECT av.card_id FROM attribute_value av JOIN attribute_def ad ON ad.id=av.attribute_def_id WHERE ad.name=%s AND av.value=to_jsonb(%s::text) LIMIT 1)",
				sqlString(na), sqlString(name))
		}
	}
	return fmt.Sprintf("NULL /* %s.%s: no meta */", table, name)
}

// renderJSON turns a cellValue into a JSON expression suitable for an
// attribute_value.value cell.
//
// ckBacktick is rendered as a JSON STRING (not a parsed JSON value).
// Predicate JSON and toggle-group JSON are stored on text-typed
// attribute_defs as JSON-encoded text; the client parses the string
// layer back with JSON.parse before consuming the embedded JSON tree.
// Keeping ckBacktick a string preserves that round-trip shape and
// matches how the same content rendered before Gate 11 (when backticks
// flowed through ckBare → renderBareJSON, which wraps text as
// to_jsonb('…'::text)).
func (l *seedLoader) renderJSON(c cellValue) string {
	switch c.kind {
	case ckNull:
		return "NULL"
	case ckString:
		return fmt.Sprintf("to_jsonb(%s::text)", sqlString(c.text))
	case ckBacktick:
		return fmt.Sprintf("to_jsonb(%s::text)", sqlString(c.text))
	case ckLookup:
		return fmt.Sprintf("to_jsonb(%s)", l.dollarLookupSQL(c.lookupTable, c.lookupName))
	case ckAlias:
		return fmt.Sprintf("to_jsonb(%s)", l.aliasLookupSQL(c.aliasName))
	case ckParent:
		// Shouldn't be a JSON-valued cell, but render defensively.
		return "NULL"
	case ckArray:
		// JSON-array value. Render each element as a JSON value and
		// wrap in jsonb_build_array.
		parts := make([]string, 0, len(c.arr))
		for _, e := range c.arr {
			switch e.kind {
			case ckAlias:
				parts = append(parts, l.aliasLookupSQL(e.aliasName))
			case ckLookup:
				parts = append(parts, l.dollarLookupSQL(e.lookupTable, e.lookupName))
			case ckBare:
				parts = append(parts, renderBareForColumn(e.text, "bigint"))
			case ckString:
				parts = append(parts, sqlString(e.text))
			case ckNull:
				parts = append(parts, "NULL")
			default:
				parts = append(parts, "NULL")
			}
		}
		if len(parts) == 0 {
			return "'[]'::jsonb"
		}
		return "jsonb_build_array(" + strings.Join(parts, ", ") + ")"
	case ckBare:
		return renderBareJSON(c.text)
	}
	return "NULL"
}

// renderBareForColumn formats a bare cell into a SQL literal based on
// the column's postgres type.
func renderBareForColumn(s, colType string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "DEFAULT"
	}
	switch strings.ToLower(s) {
	case "true":
		return "TRUE"
	case "false":
		return "FALSE"
	case "null":
		return "NULL"
	}
	if _, err := strconv.ParseInt(s, 10, 64); err == nil {
		return s
	}
	if _, err := strconv.ParseFloat(s, 64); err == nil {
		return s
	}
	// Identifiers like now(), DEFAULT etc., or text values.
	switch ct := strings.ToLower(colType); {
	case strings.HasPrefix(ct, "text"), strings.HasPrefix(ct, "varchar"), strings.HasPrefix(ct, "char"), strings.HasPrefix(ct, "citext"):
		return sqlString(s)
	case strings.HasPrefix(ct, "jsonb"):
		return sqlString(s) + "::jsonb"
	case strings.HasPrefix(ct, "timestamp"):
		// Function-like (now()) is valid; quoted text otherwise.
		if strings.HasSuffix(s, ")") || strings.Contains(s, "(") {
			return s
		}
		return sqlString(s)
	}
	// Default: treat as raw expression. Callers expect e.g. 0 / now().
	return s
}

// renderBareJSON formats a bare cell as a JSON value (no column-type
// hint available — heuristic only).
func renderBareJSON(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "NULL"
	}
	switch strings.ToLower(s) {
	case "true":
		return "to_jsonb(TRUE)"
	case "false":
		return "to_jsonb(FALSE)"
	case "null":
		return "NULL"
	}
	if _, err := strconv.ParseInt(s, 10, 64); err == nil {
		return "to_jsonb(" + s + "::bigint)"
	}
	if _, err := strconv.ParseFloat(s, 64); err == nil {
		return "to_jsonb(" + s + "::double precision)"
	}
	return fmt.Sprintf("to_jsonb(%s::text)", sqlString(s))
}

// colType returns the postgres type of column `name` on table `t`.
func colType(t *Table, name string) string {
	if t == nil {
		return ""
	}
	for _, c := range t.Columns {
		if c.Name == name {
			return c.Type
		}
	}
	return ""
}

// sqlString single-quote-escapes s.
func sqlString(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

// renderForColumn is the single dispatch helper every emitter goes
// through to render one cell into a SQL expression. Routes via
// renderCellWithRow so `parent`-cells pick up the owning row's
// .parent pointer.
func (l *seedLoader) renderForColumn(r *seedRow, c cellValue, t *Table, col string) string {
	return l.renderCellWithRow(r, c, colType(t, col))
}
