package hcsv

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// Reference is the foreign-key target of a column.
type Reference struct {
	Table    string
	Column   string
	OnDelete string
}

// Column describes one table column. Type is taken verbatim — the
// generator does not interpret postgres-isms beyond appending NOT NULL
// / DEFAULT / UNIQUE / REFERENCES suffixes. PrimaryKey on a column is
// sugar for a single-column PK; multi-column PKs come through Table.PrimaryKey.
type Column struct {
	Name       string
	Type       string
	Nullable   *bool
	Default    string
	Unique     bool
	PrimaryKey bool
	References *Reference
}

// Index is a table-level CREATE INDEX directive.
type Index struct {
	Name        string
	Columns     []string
	Expressions []string
	Using       string
	Unique      bool
	Where       string
}

// Table is the schema-level representation of one table parsed out of hcsv.
type Table struct {
	Name       string
	Doc        string
	Columns    []Column
	PrimaryKey []string
	Unique     [][]string
	Indexes    []Index
	// Meta is the parsed `### meta` block. Free-form per table; future
	// seed loaders use it to resolve `$<table>.<name>` lookups.
	Meta map[string]string
}

// Schema is a fully-parsed hcsv schema document, ready to render to SQL.
type Schema struct {
	Doc        string
	Extensions []string
	Tables     []Table
}

// Path returns the canonical location of db/schema/schema.hcsv. Walks
// up from the package source so tests find it regardless of cwd.
func Path() string {
	_, file, _, _ := runtime.Caller(0)
	dir := filepath.Dir(file)
	for range 8 {
		candidate := filepath.Join(dir, "db", "schema", "schema.hcsv")
		if st, err := os.Stat(candidate); err == nil && !st.IsDir() {
			return candidate
		}
		dir = filepath.Dir(dir)
	}
	panic("hcsv: schema.hcsv not found above package source")
}

// Load reads and parses db/schema/schema.hcsv.
func Load(path string) (*Schema, error) {
	if path == "" {
		path = Path()
	}
	buf, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("hcsv: read %s: %w", path, err)
	}
	doc, err := Parse(buf)
	if err != nil {
		return nil, err
	}
	return BuildSchema(doc)
}

// BuildSchema validates the parsed AST is schema-shaped and projects
// it into a Schema model.
func BuildSchema(doc *Document) (*Schema, error) {
	if doc == nil || doc.Root == nil {
		return nil, fmt.Errorf("hcsv: empty document")
	}
	root := doc.Root
	if root.Kind != "db" {
		return nil, fmt.Errorf("hcsv: root section must be `# db`, got %q at line %d", root.Kind, root.Line)
	}
	s := &Schema{Doc: root.Modifiers["doc"]}
	for _, child := range root.Children {
		switch child.Kind {
		case "prop":
			if err := readProps(child, s); err != nil {
				return nil, err
			}
		case "table":
			t, err := readTable(child)
			if err != nil {
				return nil, err
			}
			s.Tables = append(s.Tables, t)
		default:
			return nil, fmt.Errorf("hcsv: line %d: unsupported top-level section %q", child.Line, child.Kind)
		}
	}
	return s, nil
}

// readProps reads a `## prop` block. Recognised rows: extension.
func readProps(sec *Section, s *Schema) error {
	want := []string{"name", "value"}
	if err := requireHeader(sec, want); err != nil {
		return err
	}
	for _, row := range sec.Rows {
		key := row[0]
		val := row[1]
		switch key {
		case "extension":
			s.Extensions = append(s.Extensions, val)
		default:
			return fmt.Errorf("hcsv: line %d: unsupported prop %q", sec.Line, key)
		}
	}
	return nil
}

// readTable converts a `## table <name>` section into a Table.
func readTable(sec *Section) (Table, error) {
	if sec.Name == "" {
		return Table{}, fmt.Errorf("hcsv: line %d: `table` heading missing name", sec.Line)
	}
	t := Table{
		Name: sec.Name,
		Doc:  sec.Modifiers["doc"],
	}
	if pk := sec.Modifiers["primary_key"]; pk != "" {
		t.PrimaryKey = splitList(pk)
	}
	// `unique` heading modifier — comma-separated columns of a single
	// table-level UNIQUE constraint. Live schema never has more than
	// one per table; if a future schema needs N, this becomes a
	// pipe-or-semicolon-separated list of lists.
	if u := sec.Modifiers["unique"]; u != "" {
		t.Unique = append(t.Unique, splitList(u))
	}
	for _, child := range sec.Children {
		switch child.Kind {
		case "columns":
			cols, err := readColumns(child)
			if err != nil {
				return Table{}, err
			}
			t.Columns = cols
		case "indexes":
			idxs, err := readIndexes(child)
			if err != nil {
				return Table{}, err
			}
			t.Indexes = idxs
		case "meta":
			t.Meta = readMeta(child)
		case "rows":
			// Phase 1: seeds live in declarative.toml. A `### rows`
			// block here is parsed and ignored so a future phase can
			// move seeds without re-touching this loader.
		default:
			return Table{}, fmt.Errorf("hcsv: line %d: unsupported child %q under table %q", child.Line, child.Kind, sec.Name)
		}
	}
	if len(t.Columns) == 0 {
		return Table{}, fmt.Errorf("hcsv: table %q has no `### columns` block", t.Name)
	}
	return t, nil
}

// readColumns parses a `### columns` block.
func readColumns(sec *Section) ([]Column, error) {
	if sec.Header == nil {
		return nil, fmt.Errorf("hcsv: line %d: columns block empty", sec.Line)
	}
	hdr := sec.Header
	idx := headerIndex(hdr)
	getCell := func(row []string, key string) (string, bool) {
		i, ok := idx[key]
		if !ok {
			return "", false
		}
		return cellAt(row, i), true
	}
	out := make([]Column, 0, len(sec.Rows))
	for _, row := range sec.Rows {
		c := Column{}
		c.Name, _ = getCell(row, "name")
		c.Type, _ = getCell(row, "type")
		if c.Name == "" || c.Type == "" {
			return nil, fmt.Errorf("hcsv: line %d: column row missing name or type: %v", sec.Line, row)
		}
		if v, _ := getCell(row, "pk"); v != "" {
			b, err := parseBool(v)
			if err != nil {
				return nil, fmt.Errorf("hcsv: column %q pk: %w", c.Name, err)
			}
			c.PrimaryKey = b
		}
		if v, _ := getCell(row, "unique"); v != "" {
			b, err := parseBool(v)
			if err != nil {
				return nil, fmt.Errorf("hcsv: column %q unique: %w", c.Name, err)
			}
			c.Unique = b
		}
		if v, ok := getCell(row, "nullable"); ok && v != "" {
			b, err := parseBool(v)
			if err != nil {
				return nil, fmt.Errorf("hcsv: column %q nullable: %w", c.Name, err)
			}
			c.Nullable = &b
		}
		c.Default, _ = getCell(row, "default")
		if ref, _ := getCell(row, "references"); ref != "" {
			tbl, col, ok := strings.Cut(ref, ".")
			if !ok {
				return nil, fmt.Errorf("hcsv: column %q references %q: expected `table.column`", c.Name, ref)
			}
			od, _ := getCell(row, "on_delete")
			c.References = &Reference{
				Table:    tbl,
				Column:   col,
				OnDelete: od,
			}
		}
		out = append(out, c)
	}
	return out, nil
}

// readIndexes parses a `### indexes` block.
func readIndexes(sec *Section) ([]Index, error) {
	if sec.Header == nil {
		return nil, fmt.Errorf("hcsv: line %d: indexes block empty", sec.Line)
	}
	idx := headerIndex(sec.Header)
	getCell := func(row []string, key string) (string, bool) {
		i, ok := idx[key]
		if !ok {
			return "", false
		}
		return cellAt(row, i), true
	}
	out := make([]Index, 0, len(sec.Rows))
	for _, row := range sec.Rows {
		ix := Index{}
		ix.Name, _ = getCell(row, "name")
		if ix.Name == "" {
			return nil, fmt.Errorf("hcsv: line %d: index row missing name: %v", sec.Line, row)
		}
		if v, _ := getCell(row, "columns"); v != "" {
			ix.Columns = splitList(v)
		}
		if v, _ := getCell(row, "expressions"); v != "" {
			// Expressions are single SQL fragments today (one cell, one
			// expression); a comma-list would conflict with operator
			// classes containing commas. Keep them as a single-element
			// slice for parity with the declarative.toml shape.
			ix.Expressions = []string{v}
		}
		if v, _ := getCell(row, "unique"); v != "" {
			b, err := parseBool(v)
			if err != nil {
				return nil, fmt.Errorf("hcsv: index %q unique: %w", ix.Name, err)
			}
			ix.Unique = b
		}
		ix.Using, _ = getCell(row, "using")
		ix.Where, _ = getCell(row, "where")
		out = append(out, ix)
	}
	return out, nil
}

// readMeta reads a `### meta` block into a flat key/value map. The
// block has one header row and one data row (key columns in header,
// values in row). hcsv-style metadata.
func readMeta(sec *Section) map[string]string {
	if sec.Header == nil || len(sec.Rows) == 0 {
		return nil
	}
	out := map[string]string{}
	row := sec.Rows[0]
	for i, k := range sec.Header {
		if i < len(row) {
			out[k] = row[i]
		}
	}
	return out
}

// GenerateSQL renders the schema to a CREATE-everything SQL script
// (extensions + tables + indexes). Output mirrors declarative.go's
// format so the diff against today's output is minimal.
func GenerateSQL(s *Schema) string {
	tables := topoSortTables(s.Tables)
	var b strings.Builder
	for _, e := range s.Extensions {
		fmt.Fprintf(&b, "CREATE EXTENSION IF NOT EXISTS %s;\n", e)
	}
	if len(s.Extensions) > 0 {
		b.WriteByte('\n')
	}
	for _, t := range tables {
		emitTable(&b, t)
		for _, idx := range t.Indexes {
			emitIndex(&b, t.Name, idx)
		}
		b.WriteByte('\n')
	}
	return b.String()
}

// topoSortTables orders tables so that for any FK from A to B, B comes
// first. Ties break alphabetically. Self-references tolerated.
func topoSortTables(in []Table) []Table {
	byName := make(map[string]Table, len(in))
	deps := make(map[string]map[string]struct{}, len(in))
	for _, t := range in {
		byName[t.Name] = t
		set := map[string]struct{}{}
		for _, c := range t.Columns {
			if c.References != nil && c.References.Table != t.Name {
				set[c.References.Table] = struct{}{}
			}
		}
		deps[t.Name] = set
	}
	var out []Table
	emitted := map[string]bool{}
	for len(out) < len(in) {
		var ready []string
		for name := range byName {
			if emitted[name] {
				continue
			}
			ok := true
			for d := range deps[name] {
				if _, exists := byName[d]; exists && !emitted[d] {
					ok = false
					break
				}
			}
			if ok {
				ready = append(ready, name)
			}
		}
		if len(ready) == 0 {
			panic(fmt.Sprintf("hcsv: cycle in table dependency graph; remaining %d", len(in)-len(out)))
		}
		sort.Strings(ready)
		for _, n := range ready {
			out = append(out, byName[n])
			emitted[n] = true
		}
	}
	return out
}

// emitTable writes one CREATE TABLE statement for t.
func emitTable(b *strings.Builder, t Table) {
	if t.Doc != "" {
		b.WriteString("-- ")
		b.WriteString(t.Doc)
		b.WriteByte('\n')
	}
	fmt.Fprintf(b, "CREATE TABLE IF NOT EXISTS %s (\n", t.Name)

	pkCols := pkColumns(t)
	parts := make([]string, 0, len(t.Columns)+1+len(t.Unique))
	for _, c := range t.Columns {
		parts = append(parts, "    "+columnDDL(c, len(pkCols) <= 1))
	}
	if len(pkCols) > 1 {
		parts = append(parts, fmt.Sprintf("    PRIMARY KEY (%s)", strings.Join(pkCols, ", ")))
	}
	for _, u := range t.Unique {
		parts = append(parts, fmt.Sprintf("    UNIQUE (%s)", strings.Join(u, ", ")))
	}
	b.WriteString(strings.Join(parts, ",\n"))
	b.WriteString("\n);\n")
}

// emitIndex writes one CREATE [UNIQUE] INDEX statement.
func emitIndex(b *strings.Builder, table string, idx Index) {
	kw := "CREATE INDEX"
	if idx.Unique {
		kw = "CREATE UNIQUE INDEX"
	}
	body := idx.Expressions
	if len(body) == 0 {
		body = idx.Columns
	}
	fmt.Fprintf(b, "%s IF NOT EXISTS %s ON %s", kw, idx.Name, table)
	if idx.Using != "" {
		fmt.Fprintf(b, " USING %s", idx.Using)
	}
	fmt.Fprintf(b, " (%s)", strings.Join(body, ", "))
	if idx.Where != "" {
		fmt.Fprintf(b, " WHERE %s", idx.Where)
	}
	b.WriteString(";\n")
}

// pkColumns returns the primary-key column names. Prefers the
// table-level PrimaryKey list; otherwise falls back to any column
// with PrimaryKey=true.
func pkColumns(t Table) []string {
	if len(t.PrimaryKey) > 0 {
		return t.PrimaryKey
	}
	var out []string
	for _, c := range t.Columns {
		if c.PrimaryKey {
			out = append(out, c.Name)
		}
	}
	return out
}

// columnDDL renders one column line. inlineSinglePK drops PRIMARY KEY
// onto the column itself when there's exactly one PK column overall.
func columnDDL(c Column, inlineSinglePK bool) string {
	var parts []string
	parts = append(parts, c.Name, c.Type)
	if c.PrimaryKey && inlineSinglePK {
		parts = append(parts, "PRIMARY KEY")
	} else if c.Nullable != nil && !*c.Nullable {
		parts = append(parts, "NOT NULL")
	}
	if c.Default != "" {
		parts = append(parts, "DEFAULT "+c.Default)
	}
	if c.Unique {
		parts = append(parts, "UNIQUE")
	}
	if c.References != nil {
		fk := fmt.Sprintf("REFERENCES %s(%s)", c.References.Table, c.References.Column)
		switch strings.ToLower(c.References.OnDelete) {
		case "cascade":
			fk += " ON DELETE CASCADE"
		case "set_null", "set null":
			fk += " ON DELETE SET NULL"
		case "restrict":
			fk += " ON DELETE RESTRICT"
		case "":
			// default — no clause
		default:
			panic(fmt.Sprintf("hcsv: unsupported on_delete %q", c.References.OnDelete))
		}
		parts = append(parts, fk)
	}
	return strings.Join(parts, " ")
}

// requireHeader checks that sec.Header is exactly want, in order.
func requireHeader(sec *Section, want []string) error {
	if len(sec.Header) != len(want) {
		return fmt.Errorf("hcsv: line %d: header %v, want %v", sec.Line, sec.Header, want)
	}
	for i, h := range want {
		if sec.Header[i] != h {
			return fmt.Errorf("hcsv: line %d: header[%d]=%q, want %q", sec.Line, i, sec.Header[i], h)
		}
	}
	return nil
}

// headerIndex maps each column name in hdr to its position.
func headerIndex(hdr []string) map[string]int {
	out := make(map[string]int, len(hdr))
	for i, h := range hdr {
		out[h] = i
	}
	return out
}

// cellAt returns the i'th cell of row (or "" when i is out of range
// or i is the sentinel from a missing-key lookup, -1).
func cellAt(row []string, i int) string {
	if i < 0 || i >= len(row) {
		return ""
	}
	return row[i]
}

// parseBool accepts a stricter set than strconv: only the literal
// strings true/false (case-insensitive). Empty handled by caller.
func parseBool(s string) (bool, error) {
	switch strings.ToLower(s) {
	case "true":
		return true, nil
	case "false":
		return false, nil
	}
	return false, fmt.Errorf("expected true/false, got %q", s)
}

// splitList parses a `"a, b, c"` cell (or `a, b, c` if unquoted into
// multiple cells already) into a list. The cell has already been
// unquoted by the CSV reader, so a multi-column index whose `columns`
// cell was `"col1, col2"` arrives here as the single string
// `col1, col2`.
func splitList(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}
