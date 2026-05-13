package hcsv

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestStrawmanSchemaToSQL(t *testing.T) {
	src := readStrawman(t, "schema.hcsv")
	doc, err := Parse(src)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	s, err := BuildSchema(doc)
	if err != nil {
		t.Fatalf("BuildSchema: %v", err)
	}
	got := GenerateSQL(s)

	goldenPath := testdataPath(t, "schema.golden.sql")
	if os.Getenv("UPDATE_GOLDEN") == "1" {
		if err := os.WriteFile(goldenPath, []byte(got), 0o644); err != nil {
			t.Fatalf("write golden: %v", err)
		}
	}
	want, err := os.ReadFile(goldenPath)
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	if string(want) != got {
		t.Fatalf("SQL output diverged from golden file %s.\n--- want ---\n%s\n--- got ---\n%s", goldenPath, want, got)
	}
}

func TestBuildSchemaErrors(t *testing.T) {
	cases := []struct {
		name string
		src  string
		want string
	}{
		{
			"missing table name",
			"# db\n## table\n### columns\nname, type\nid, bigint\n",
			"missing name",
		},
		{
			"no columns block",
			"# db\n## table foo\n",
			"no `### columns`",
		},
		{
			"bad reference",
			"# db\n## table foo\n### columns\nname, type, references\nuid, bigint, badref\n",
			"expected `table.column`",
		},
		{
			"unsupported top-level",
			"# db\n## wat\nname\nx\n",
			"unsupported top-level",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			doc, err := Parse([]byte(c.src))
			if err != nil {
				t.Fatalf("Parse: %v", err)
			}
			_, err = BuildSchema(doc)
			if err == nil {
				t.Fatalf("expected error containing %q", c.want)
			}
			if !strings.Contains(err.Error(), c.want) {
				t.Fatalf("err = %v, want substring %q", err, c.want)
			}
		})
	}
}

func TestSchemaBasicEmit(t *testing.T) {
	src := `# db
## prop
name, value
extension, pg_trgm

## table a | doc="A table."
### columns
name, type, pk, nullable, default
id, bigserial, true, false,
val, text, false, true,
`
	doc, err := Parse([]byte(src))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	s, err := BuildSchema(doc)
	if err != nil {
		t.Fatalf("BuildSchema: %v", err)
	}
	got := GenerateSQL(s)
	want := `CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- A table.
CREATE TABLE IF NOT EXISTS a (
    id bigserial PRIMARY KEY,
    val text
);

`
	if got != want {
		t.Fatalf("SQL = %q\nwant %q", got, want)
	}
}

func readStrawman(t *testing.T, name string) []byte {
	t.Helper()
	// Walk up from package source to repo root.
	_, file, _, _ := runtime.Caller(0)
	dir := filepath.Dir(file)
	for range 8 {
		candidate := filepath.Join(dir, "docs", "hcsv_strawman", name)
		if _, err := os.Stat(candidate); err == nil {
			b, err := os.ReadFile(candidate)
			if err != nil {
				t.Fatalf("read %s: %v", candidate, err)
			}
			return b
		}
		dir = filepath.Dir(dir)
	}
	t.Fatalf("strawman %s not found", name)
	return nil
}

func testdataPath(t *testing.T, name string) string {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "testdata", name)
}
