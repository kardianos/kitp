// Package declarative loads the declarative DB-schema document and
// emits Postgres DDL from it. A parity test
// (server/internal/schema/declarative/parity_test.go) asserts the
// generated SQL produces the same structure as the forward-only
// migration chain in db/migrations.
//
// Scope is intentionally limited (see db/schema/declarative.json).
// Once parity is proved for the covered subset, more tables will
// migrate over and eventually the document becomes the source of
// truth — at which point the migration runner generates new
// migrations from doc diffs rather than the other way around.
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
// references are supported in v1 — multi-column FKs are rare in this
// schema (only the composite PK on process_step uses multiple columns,
// and it's not a foreign key).
type Reference struct {
	Table  string `json:"table"`
	Column string `json:"column"`
}

// Column describes one table column. `Type` is taken verbatim — the
// generator does not interpret postgres-isms beyond appending NOT NULL
// / DEFAULT / UNIQUE / REFERENCES suffixes.
//
// PrimaryKey on a column is sugar for a single-column PK; multi-column
// PKs come through Table.PrimaryKey instead. The generator treats the
// two paths identically at emit time.
type Column struct {
	Name       string     `json:"name"`
	Type       string     `json:"type"`
	Nullable   *bool      `json:"nullable,omitempty"`
	Default    string     `json:"default,omitempty"`
	Unique     bool       `json:"unique,omitempty"`
	PrimaryKey bool       `json:"primary_key,omitempty"`
	References *Reference `json:"references,omitempty"`
}

// Table mirrors one declarative table entry.
type Table struct {
	Name       string   `json:"name"`
	Doc        string   `json:"doc,omitempty"`
	Columns    []Column `json:"columns"`
	PrimaryKey []string `json:"primary_key,omitempty"`
}

// Document is the on-disk shape of declarative.json.
type Document struct {
	Doc    string  `json:"_doc,omitempty"`
	Tables []Table `json:"tables"`
}

// Path returns the canonical location of the declarative JSON. Walks up
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

// Load reads + parses the declarative document. Tables come back in
// the order they're declared so the generator output is deterministic.
func Load(path string) (*Document, error) {
	if path == "" {
		path = Path()
	}
	buf, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("declarative: read %s: %w", path, err)
	}
	var d Document
	if err := json.Unmarshal(buf, &d); err != nil {
		return nil, fmt.Errorf("declarative: decode: %w", err)
	}
	return &d, nil
}

// GenerateSQL renders the document to a single CREATE-everything SQL
// script. Statements are ordered so foreign-key targets always appear
// before their dependents — we do a topological sort over the
// references graph and emit ties alphabetically for stability.
//
// IF NOT EXISTS is included on every CREATE so the script can be
// applied to a partially-populated schema (e.g. after a failed run)
// without manual intervention.
func GenerateSQL(d *Document) string {
	tables := topoSortTables(d.Tables)
	var b strings.Builder
	b.WriteString("-- Auto-generated from db/schema/declarative.json by\n")
	b.WriteString("-- server/cmd/schema-gen. Do not edit by hand.\n\n")
	for _, t := range tables {
		emitTable(&b, t)
		b.WriteByte('\n')
	}
	return b.String()
}

// topoSortTables orders tables so that for any FK from A to B, B comes
// first. Ties are broken alphabetically so the output is stable across
// runs. Cycles cause a panic — the schema model rejects them.
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
	// Kahn-style: repeatedly pick any node whose deps are all emitted.
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

	// Determine the PK shape up front so we can render either an
	// inline PRIMARY KEY column or a trailing constraint.
	pkCols := pkColumns(t)

	parts := make([]string, 0, len(t.Columns)+1)
	for _, c := range t.Columns {
		parts = append(parts, "    "+columnDDL(c, len(pkCols) <= 1))
	}
	if len(pkCols) > 1 {
		parts = append(parts, fmt.Sprintf("    PRIMARY KEY (%s)", strings.Join(pkCols, ", ")))
	}
	b.WriteString(strings.Join(parts, ",\n"))
	b.WriteString("\n);\n")
}

// pkColumns returns the primary-key column names. Prefers the table-level
// PrimaryKey list when set; otherwise falls back to any column with
// PrimaryKey=true.
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
	} else if c.Nullable == nil && !c.PrimaryKey {
		// Default in this codebase is NULLABLE unless explicitly set;
		// the migrations are explicit so we follow the same convention.
		// No NOT NULL emitted.
	}
	if c.Default != "" {
		parts = append(parts, "DEFAULT "+c.Default)
	}
	if c.Unique {
		parts = append(parts, "UNIQUE")
	}
	if c.References != nil {
		parts = append(parts, fmt.Sprintf("REFERENCES %s(%s)", c.References.Table, c.References.Column))
	}
	return strings.Join(parts, " ")
}
