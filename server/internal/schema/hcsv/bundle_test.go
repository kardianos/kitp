package hcsv

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestLoadCatalogShipped loads db/schema/bundles and checks the shipped
// features and presets render: every preset names known features, and each
// bundle's SQL creates its source project with its bundle_key.
func TestLoadCatalogShipped(t *testing.T) {
	schema, err := Load("")
	if err != nil {
		t.Fatalf("load schema: %v", err)
	}
	seedPath, _ := SeedPaths()
	seedBuf, err := os.ReadFile(seedPath)
	if err != nil {
		t.Fatal(err)
	}
	seedDoc, err := Parse(seedBuf)
	if err != nil {
		t.Fatal(err)
	}
	cat, err := LoadCatalog("", schema, collectAttributeValueTypes(seedDoc.Root))
	if err != nil {
		t.Fatalf("load catalog: %v", err)
	}
	var keys []string
	for _, b := range cat.Features {
		keys = append(keys, b.Key)
		if !strings.Contains(b.SQL, "to_jsonb('"+b.Key+"'::text)") && !strings.Contains(b.SQL, "'"+b.Key+"'") {
			t.Errorf("bundle %s SQL never writes its bundle_key", b.Key)
		}
		if len(b.Checksum) != 64 {
			t.Errorf("bundle %s checksum %q", b.Key, b.Checksum)
		}
	}
	if got, want := strings.Join(keys, ","), "tracker,helpdesk,conversations,publishing"; got != want {
		t.Errorf("features = %s, want %s", got, want)
	}
	var presets []string
	for _, p := range cat.Presets {
		presets = append(presets, p.Key+"="+strings.Join(p.Features, "+"))
	}
	if got, want := strings.Join(presets, ","), "issue_tracker=tracker,help_desk=helpdesk+conversations,shared_inbox=conversations,content=tracker+publishing"; got != want {
		t.Errorf("presets = %s, want %s", got, want)
	}
}

// TestLoadCatalogRejects is the error table: each case is one bad file in an
// otherwise empty bundle directory.
func TestLoadCatalogRejects(t *testing.T) {
	schema, err := Load("")
	if err != nil {
		t.Fatalf("load schema: %v", err)
	}
	src := "## table card | alias=bundle_src\n### rows\ncard_type_id, title, is_template, bundle_key\n"
	cases := []struct {
		name, file, want string
	}{
		{"bad key", "# bundle | key=Bad-Key | title=\"X\"\n" + src + "$card_type.project, \"Bundle: X\", true, x\n", "lowercase"},
		{"no title", "# bundle | key=x\n" + src + "$card_type.project, \"Bundle: X\", true, x\n", "no title"},
		{"key mismatch", "# bundle | key=x | title=\"X\"\n" + src + "$card_type.project, \"Bundle: X\", true, y\n", "bundle_key is \"y\""},
		{"not template", "# bundle | key=x | title=\"X\"\n" + src + "$card_type.project, \"Bundle: X\", false, x\n", "is_template"},
		{"no source", "# bundle | key=x | title=\"X\"\n## table card\n### rows\ncard_type_id, title\n$card_type.project, \"P\"\n", "exactly one"},
		{"unknown feature", "# presets\n## table preset\n### rows\nkey, title, features\np, \"P\", `[\"nope\"]`\n", "unknown feature"},
		{"empty features", "# presets\n## table preset\n### rows\nkey, title, features\np, \"P\", `[]`\n", "names no features"},
		{"wrong root", "# seed\n", "root section"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, "b.hcsv"), []byte(c.file), 0o644); err != nil {
				t.Fatal(err)
			}
			_, err := LoadCatalog(dir, schema, nil)
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("err = %v, want it to mention %q", err, c.want)
			}
		})
	}
}
