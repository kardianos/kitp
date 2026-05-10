// Package declarative is the canonical source of truth for the kitp
// database. db/schema/declarative.json declares every table, index,
// constraint, and the built-in seed rows (plus an optional demo set)
// the application depends on. The generator in this package renders
// that document to a single Postgres script — CREATE everything,
// INSERT seeds — that can be applied to an empty schema to bring it
// fully up.
//
// The application no longer carries a forward-only migration chain.
// Schema changes happen by editing declarative.json; dev databases
// are reset by dropping the public schema and re-applying the doc.
package declarative

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// Reference is the foreign-key target of a column. Only single-column
// references are supported; composite FKs are not used anywhere in the
// schema.
type Reference struct {
	Table    string `json:"table"`
	Column   string `json:"column"`
	OnDelete string `json:"on_delete,omitempty"` // "cascade" | "set_null" | ""
}

// Column describes one table column. Type is taken verbatim — the
// generator does not interpret postgres-isms beyond appending NOT NULL
// / DEFAULT / UNIQUE / REFERENCES suffixes. PrimaryKey on a column is
// sugar for a single-column PK; multi-column PKs come through
// Table.PrimaryKey instead.
type Column struct {
	Name       string     `json:"name"`
	Type       string     `json:"type"`
	Nullable   *bool      `json:"nullable,omitempty"`
	Default    string     `json:"default,omitempty"`
	Unique     bool       `json:"unique,omitempty"`
	PrimaryKey bool       `json:"primary_key,omitempty"`
	References *Reference `json:"references,omitempty"`
}

// Index is a table-level CREATE INDEX directive. Columns lists the
// indexed columns in order; Where (when non-empty) renders a partial
// index. Unique flips the statement to CREATE UNIQUE INDEX.
type Index struct {
	Name    string   `json:"name"`
	Columns []string `json:"columns"`
	Unique  bool     `json:"unique,omitempty"`
	Where   string   `json:"where,omitempty"`
}

// Table mirrors one declarative table entry.
type Table struct {
	Name       string     `json:"name"`
	Doc        string     `json:"doc,omitempty"`
	Columns    []Column   `json:"columns"`
	PrimaryKey []string   `json:"primary_key,omitempty"`
	Unique     [][]string `json:"unique,omitempty"`
	Indexes    []Index    `json:"indexes,omitempty"`
}

// SeedRow is one row to INSERT, expressed as a column → value map.
// Values are JSON literals or `{"ref": "tbl", "where": {...}, "column": "id"}`
// objects that resolve to `(SELECT col FROM tbl WHERE ...)` at SQL render time.
type SeedRow map[string]any

// SeedEntry is one step in the seed program. Exactly one of Table+Rows
// or SQL must be set. When Table+Rows is used, OnConflict optionally
// names the conflict-target columns and ResetSequence emits a setval
// after the INSERT (use when rows carry explicit serial ids).
type SeedEntry struct {
	Doc           string    `json:"doc,omitempty"`
	Table         string    `json:"table,omitempty"`
	Rows          []SeedRow `json:"rows,omitempty"`
	OnConflict    []string  `json:"on_conflict,omitempty"`
	ResetSequence string    `json:"reset_sequence,omitempty"` // sequence name, e.g. "user_account_id_seq"
	SQL           string    `json:"sql,omitempty"`
}

// Document is the on-disk shape of declarative.json.
type Document struct {
	Doc    string      `json:"_doc,omitempty"`
	Tables []Table     `json:"tables"`
	Seed   []SeedEntry `json:"seed,omitempty"`
	Demo   []SeedEntry `json:"demo,omitempty"`
}

// Path returns the canonical location of declarative.json. Walks up
// from the package source so tests find it regardless of cwd.
func Path() string {
	_, file, _, _ := runtime.Caller(0)
	dir := filepath.Dir(file)
	for range 8 {
		candidate := filepath.Join(dir, "db", "schema", "declarative.json")
		if st, err := os.Stat(candidate); err == nil && !st.IsDir() {
			return candidate
		}
		dir = filepath.Dir(dir)
	}
	panic("declarative: declarative.json not found above package source")
}

// Load reads + parses the declarative document.
func Load(path string) (*Document, error) {
	if path == "" {
		path = Path()
	}
	buf, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("declarative: read %s: %w", path, err)
	}
	var d Document
	dec := json.NewDecoder(strings.NewReader(string(buf)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&d); err != nil {
		return nil, fmt.Errorf("declarative: decode: %w", err)
	}
	return &d, nil
}

// Options controls which sections GenerateSQL emits.
type Options struct {
	Demo bool // include the Demo seed section after Seed
}

// GenerateSQL renders the document to a single SQL script: CREATE
// TABLE, CREATE INDEX, and INSERT statements in dependency order.
// IF NOT EXISTS / ON CONFLICT are included so the script is safe to
// re-apply to a partially-populated schema.
func GenerateSQL(d *Document, opts Options) string {
	tables := topoSortTables(d.Tables)
	var b strings.Builder
	b.WriteString("-- Auto-generated from db/schema/declarative.json by\n")
	b.WriteString("-- server/cmd/schema-gen. Do not edit by hand.\n\n")

	for _, t := range tables {
		emitTable(&b, t)
		for _, idx := range t.Indexes {
			emitIndex(&b, t.Name, idx)
		}
		b.WriteByte('\n')
	}

	if len(d.Seed) > 0 {
		b.WriteString("-- Seed: built-in system rows.\n")
		for _, e := range d.Seed {
			emitSeed(&b, e)
		}
	}
	if opts.Demo && len(d.Demo) > 0 {
		b.WriteString("\n-- Demo: opt-in fixture data.\n")
		for _, e := range d.Demo {
			emitSeed(&b, e)
		}
	}
	return b.String()
}

// topoSortTables orders tables so that for any FK from A to B, B comes
// first. Ties break alphabetically so the output is stable. Cycles
// panic — the schema model rejects them. Self-references (e.g.
// card.parent_card_id → card.id) are tolerated.
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
			panic(fmt.Sprintf("declarative: cycle in table dependency graph; remaining %d", len(in)-len(out)))
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

// emitIndex writes one CREATE [UNIQUE] INDEX statement for idx on table.
func emitIndex(b *strings.Builder, table string, idx Index) {
	kw := "CREATE INDEX"
	if idx.Unique {
		kw = "CREATE UNIQUE INDEX"
	}
	fmt.Fprintf(b, "%s IF NOT EXISTS %s ON %s (%s)",
		kw, idx.Name, table, strings.Join(idx.Columns, ", "))
	if idx.Where != "" {
		fmt.Fprintf(b, " WHERE %s", idx.Where)
	}
	b.WriteString(";\n")
}

// pkColumns returns the primary-key column names. Prefers the table-level
// PrimaryKey list; otherwise falls back to any column with PrimaryKey=true.
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
// onto the column itself when there's exactly one PK column overall;
// composite PKs are emitted as a separate constraint by emitTable.
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
		case "":
			// default — no clause
		default:
			panic(fmt.Sprintf("declarative: unsupported on_delete %q", c.References.OnDelete))
		}
		parts = append(parts, fk)
	}
	return strings.Join(parts, " ")
}

// emitSeed writes one seed step — either a raw SQL block or an INSERT
// derived from Table+Rows.
func emitSeed(b *strings.Builder, e SeedEntry) {
	if e.Doc != "" {
		b.WriteString("-- ")
		b.WriteString(e.Doc)
		b.WriteByte('\n')
	}
	if e.SQL != "" {
		body := strings.TrimRight(e.SQL, "\n")
		b.WriteString(body)
		if !strings.HasSuffix(body, ";") {
			b.WriteByte(';')
		}
		b.WriteByte('\n')
		return
	}
	if e.Table == "" || len(e.Rows) == 0 {
		return
	}
	colOrder := orderedRowKeys(e.Rows)

	// Rows that reference the same table they're being inserted into
	// (e.g. card_type.parent_card_type_id → card_type.id for 'task'
	// pointing at 'project') must be emitted as separate INSERTs.
	// Subselects in a single multi-row INSERT only see committed rows,
	// not other rows from the same VALUES list, so a batched form
	// resolves the self-ref to NULL. Other refs (FK to a different
	// table) are fine in a batched INSERT.
	if hasSelfRef(e.Table, e.Rows) {
		for _, row := range e.Rows {
			fmt.Fprintf(b, "INSERT INTO %s (%s) VALUES (", e.Table, strings.Join(colOrder, ", "))
			for j, col := range colOrder {
				if j > 0 {
					b.WriteString(", ")
				}
				v, ok := row[col]
				if !ok {
					b.WriteString("DEFAULT")
					continue
				}
				b.WriteString(renderValue(v))
			}
			b.WriteString(")")
			if len(e.OnConflict) > 0 {
				fmt.Fprintf(b, " ON CONFLICT (%s) DO NOTHING", strings.Join(e.OnConflict, ", "))
			}
			b.WriteString(";\n")
		}
	} else {
		fmt.Fprintf(b, "INSERT INTO %s (%s) VALUES\n", e.Table, strings.Join(colOrder, ", "))
		for i, row := range e.Rows {
			fmt.Fprint(b, "    (")
			for j, col := range colOrder {
				if j > 0 {
					b.WriteString(", ")
				}
				v, ok := row[col]
				if !ok {
					b.WriteString("DEFAULT")
					continue
				}
				b.WriteString(renderValue(v))
			}
			if i == len(e.Rows)-1 {
				b.WriteString(")")
			} else {
				b.WriteString("),\n")
			}
		}
		if len(e.OnConflict) > 0 {
			fmt.Fprintf(b, "\nON CONFLICT (%s) DO NOTHING", strings.Join(e.OnConflict, ", "))
		}
		b.WriteString(";\n")
	}
	if e.ResetSequence != "" {
		// Set the sequence so a subsequent INSERT without an explicit
		// id picks up after the last seeded row. GREATEST guards against
		// an empty table or a sequence already past the max.
		fmt.Fprintf(b,
			"SELECT setval('%s', GREATEST((SELECT COALESCE(MAX(id), 0) FROM %s), 1));\n",
			e.ResetSequence, e.Table)
	}
}

// hasSelfRef reports whether any row's value references `table` via a
// ref expression. Such references must resolve against committed rows,
// which forces row-by-row INSERTs (Postgres MVCC: a multi-row INSERT
// can't see its own earlier VALUES tuples from a subselect).
func hasSelfRef(table string, rows []SeedRow) bool {
	for _, r := range rows {
		for _, v := range r {
			m, ok := v.(map[string]any)
			if !ok {
				continue
			}
			if tbl, _ := m["ref"].(string); tbl == table {
				return true
			}
		}
	}
	return false
}

// orderedRowKeys returns the union of keys across rows in a stable
// order: keys from earlier rows come first, then any new keys from
// later rows in their first-appearance order. Within a single row JSON
// objects iterate in undefined order, so we sort alphabetically inside
// each row before merging.
func orderedRowKeys(rows []SeedRow) []string {
	seen := map[string]bool{}
	var out []string
	for _, r := range rows {
		keys := make([]string, 0, len(r))
		for k := range r {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if !seen[k] {
				seen[k] = true
				out = append(out, k)
			}
		}
	}
	return out
}

// renderValue turns one JSON-decoded value into a SQL literal. Strings
// are single-quote-escaped; numbers, bools, and nil render directly.
// A nested map is a ref expression `{ref, where, column}` and renders
// as `(SELECT column FROM ref WHERE k1=v1 AND k2=v2)`.
func renderValue(v any) string {
	switch x := v.(type) {
	case nil:
		return "NULL"
	case bool:
		if x {
			return "TRUE"
		}
		return "FALSE"
	case float64:
		// JSON has only one numeric type; print without trailing zeros.
		if x == float64(int64(x)) {
			return fmt.Sprintf("%d", int64(x))
		}
		return fmt.Sprintf("%g", x)
	case string:
		return sqlString(x)
	case map[string]any:
		return renderRef(x)
	}
	panic(fmt.Sprintf("declarative: unsupported seed value type %T", v))
}

// renderRef compiles a {ref, where, column} object to a SELECT subquery.
// `ref` and `column` are required; `where` is an object whose key/value
// pairs become a chain of `key = value` predicates joined by AND.
func renderRef(m map[string]any) string {
	tbl, _ := m["ref"].(string)
	col, _ := m["column"].(string)
	if tbl == "" || col == "" {
		panic(fmt.Sprintf("declarative: ref requires {ref, column}; got %#v", m))
	}
	where, _ := m["where"].(map[string]any)
	if len(where) == 0 {
		panic(fmt.Sprintf("declarative: ref needs where clause; got %#v", m))
	}
	keys := make([]string, 0, len(where))
	for k := range where {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s = %s", k, renderValue(where[k])))
	}
	return fmt.Sprintf("(SELECT %s FROM %s WHERE %s)", col, tbl, strings.Join(parts, " AND "))
}

// sqlString escapes a Go string into a Postgres single-quoted literal.
func sqlString(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}
