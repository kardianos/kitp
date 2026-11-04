package store_test

// The (attribute_def_id, value) btree is partial: WHERE value_type_id < 50
// (scalars; migration 0034). A query reaches it only when its own guard
// implies that predicate, and `value_type_id < 1000` — the guard from
// before 0034 — doesn't: such a lookup scans every row of the attribute
// instead (review 2026-11-03 round 4 #2). This keeps the old guard out of
// every function and Go query.

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestNoStaleBtreeGuard(t *testing.T) {
	stale := regexp.MustCompile(`value_type_id\s*<\s*1000`)
	for _, root := range []string{"../../../db/schema/functions", "../../internal"} {
		err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || !(strings.HasSuffix(path, ".sql") || strings.HasSuffix(path, ".go")) {
				return nil
			}
			// Shipped migrations keep their text; tests may name the old
			// predicate to build an older install.
			if strings.HasSuffix(path, "_test.go") || strings.HasSuffix(path, "store/migrate.go") {
				return nil
			}
			b, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			for i, line := range strings.Split(string(b), "\n") {
				if stale.MatchString(line) {
					t.Errorf("%s:%d uses the old btree guard (value_type_id < 1000); use < 50 for scalars", path, i+1)
				}
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}
