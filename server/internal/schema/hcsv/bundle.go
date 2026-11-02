// Package hcsv — feature bundle + preset loader.
//
// A feature bundle is a demo-style hcsv document under db/schema/bundles/
// whose root heading is `# bundle | key=… | title=… | sort=… | doc=…`.
// Its body declares one project card (alias bundle_src, is_template=true,
// bundle_key=<key>) and the cards / flows / flow_steps under it, exactly
// as demo.hcsv declares a project: auto ids, parents resolved by title.
// BuildSeed renders it to SQL; store.ApplySchema runs that SQL into a
// fresh hidden source project whenever the rendered SQL's checksum
// changes (the bundle tier), and bundle.apply / project.compose copy
// the source into real projects.
//
// presets.hcsv (root `# presets`) holds one `## table preset` whose rows
// name the presets the new-project dialog offers:
//
//	key, title, features, sort, doc
//
// features is a backtick JSON array of feature keys, applied in order.
//
// areas.hcsv (root `# areas`) holds one `## table area` whose rows are the
// switchable areas a project is split into (see docs/AREAS.md):
//
//	key, title, scope, sort, card_types, depends_on, starts, doc
//
// scope is project or workspace; card_types / depends_on / starts are
// backtick JSON arrays (item type names, area keys, feature keys).
package hcsv

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// Bundle is one feature bundle rendered to SQL.
type Bundle struct {
	Key      string
	Title    string
	Doc      string
	Sort     int
	SQL      string // materialises the bundle's source project
	Checksum string // sha256 of SQL; a change re-materialises the source
}

// Preset is a named, ordered list of feature keys.
type Preset struct {
	Key      string
	Title    string
	Doc      string
	Sort     int
	Features []string
}

// Area is one switchable area (docs/AREAS.md).
type Area struct {
	Key   string
	Title string
	Doc   string
	// Scope is "project" (switched per project) or "workspace".
	Scope string
	Sort  int
	// CardTypes are the item types whose data belongs to the area.
	CardTypes []string
	// DependsOn are areas that must be on for this one to be.
	DependsOn []string
	// Starts are the feature bundles the area can start from; the first is
	// the default.
	Starts []string
}

// Catalog is everything under db/schema/bundles/.
type Catalog struct {
	Features []Bundle
	Presets  []Preset
	Areas    []Area
}

// BundleDir returns db/schema/bundles (KITP_SCHEMA_DIR/bundles in
// containers), next to schema.hcsv.
func BundleDir() string {
	return filepath.Join(filepath.Dir(Path()), "bundles")
}

// LoadCatalog reads every bundle under dir (BundleDir() when empty).
// knownAttrTypes carries seed.hcsv's attribute value types, which the
// bundle files reference but don't declare. A missing directory is an
// empty catalog, not an error.
func LoadCatalog(dir string, schema *Schema, knownAttrTypes map[string]string) (Catalog, error) {
	if dir == "" {
		dir = BundleDir()
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return Catalog{}, nil
		}
		return Catalog{}, fmt.Errorf("hcsv: read %s: %w", dir, err)
	}
	var cat Catalog
	features := map[string]bool{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".hcsv") {
			continue
		}
		path := filepath.Join(dir, e.Name())
		buf, err := os.ReadFile(path)
		if err != nil {
			return Catalog{}, fmt.Errorf("hcsv: read %s: %w", path, err)
		}
		doc, err := Parse(buf)
		if err != nil {
			return Catalog{}, fmt.Errorf("hcsv: %s: %w", e.Name(), err)
		}
		switch doc.Root.Kind {
		case "bundle":
			b, err := buildBundle(doc, schema, knownAttrTypes)
			if err != nil {
				return Catalog{}, fmt.Errorf("hcsv: %s: %w", e.Name(), err)
			}
			if features[b.Key] {
				return Catalog{}, fmt.Errorf("hcsv: %s: duplicate bundle key %q", e.Name(), b.Key)
			}
			features[b.Key] = true
			cat.Features = append(cat.Features, b)
		case "presets":
			ps, err := readPresets(doc)
			if err != nil {
				return Catalog{}, fmt.Errorf("hcsv: %s: %w", e.Name(), err)
			}
			cat.Presets = append(cat.Presets, ps...)
		case "areas":
			as, err := readAreas(doc)
			if err != nil {
				return Catalog{}, fmt.Errorf("hcsv: %s: %w", e.Name(), err)
			}
			cat.Areas = append(cat.Areas, as...)
		default:
			return Catalog{}, fmt.Errorf("hcsv: %s: root section must be `# bundle`, `# presets` or `# areas`, got %q", e.Name(), doc.Root.Kind)
		}
	}
	if err := checkAreas(cat.Areas, features); err != nil {
		return Catalog{}, err
	}
	for _, p := range cat.Presets {
		for _, f := range p.Features {
			if !features[f] {
				return Catalog{}, fmt.Errorf("hcsv: preset %q names unknown feature %q", p.Key, f)
			}
		}
	}
	sort.SliceStable(cat.Features, func(i, j int) bool {
		if cat.Features[i].Sort != cat.Features[j].Sort {
			return cat.Features[i].Sort < cat.Features[j].Sort
		}
		return cat.Features[i].Key < cat.Features[j].Key
	})
	sort.SliceStable(cat.Presets, func(i, j int) bool {
		if cat.Presets[i].Sort != cat.Presets[j].Sort {
			return cat.Presets[i].Sort < cat.Presets[j].Sort
		}
		return cat.Presets[i].Key < cat.Presets[j].Key
	})
	return cat, nil
}

// bundleKeyOK is the shape every bundle / preset key must have: it names
// the bundle in card_origin and bundle_key, and in URLs.
func bundleKeyOK(k string) bool {
	if k == "" || len(k) > 40 {
		return false
	}
	for i, r := range k {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= '0' && r <= '9' && i > 0:
		case r == '_' && i > 0:
		default:
			return false
		}
	}
	return true
}

func buildBundle(doc *Document, schema *Schema, knownAttrTypes map[string]string) (Bundle, error) {
	m := doc.Root.Modifiers
	b := Bundle{Key: m["key"], Title: m["title"], Doc: m["doc"]}
	if !bundleKeyOK(b.Key) {
		return Bundle{}, fmt.Errorf("bundle key %q must be lowercase letters, digits and _", b.Key)
	}
	if b.Title == "" {
		return Bundle{}, fmt.Errorf("bundle %q has no title", b.Key)
	}
	if s := m["sort"]; s != "" {
		n, err := strconv.Atoi(s)
		if err != nil {
			return Bundle{}, fmt.Errorf("bundle %q: sort %q is not a number", b.Key, s)
		}
		b.Sort = n
	}
	if err := checkBundleRoot(doc.Root, b.Key); err != nil {
		return Bundle{}, err
	}
	sql, err := BuildSeed(doc, schema, SeedOptions{KnownAttrTypes: knownAttrTypes})
	if err != nil {
		return Bundle{}, err
	}
	sum := sha256.Sum256([]byte(sql))
	b.SQL = sql
	b.Checksum = hex.EncodeToString(sum[:])
	return b, nil
}

// checkBundleRoot insists the document declares exactly one top-level
// project card aliased bundle_src carrying is_template=true and
// bundle_key=<key>: the materialiser finds the source by that key, and
// is_template keeps it out of every project list.
func checkBundleRoot(root *Section, key string) error {
	found := 0
	for _, sec := range root.Children {
		if sec.Kind != "table" || sec.Name != "card" || sec.Modifiers["alias"] != "bundle_src" {
			continue
		}
		for _, rows := range sec.Children {
			if rows.Kind != "rows" {
				continue
			}
			idx := map[string]int{}
			for i, h := range rows.Header {
				idx[strings.TrimSpace(h)] = i
			}
			for _, r := range rows.Rows {
				found++
				get := func(col string) string {
					i, ok := idx[col]
					if !ok || i >= len(r) {
						return ""
					}
					v, err := unquoteCell(strings.TrimSpace(r[i]))
					if err != nil {
						return ""
					}
					return v
				}
				if get("card_type_id") != "$card_type.project" {
					return fmt.Errorf("bundle %q: bundle_src must be a project card", key)
				}
				if get("is_template") != "true" {
					return fmt.Errorf("bundle %q: bundle_src must set is_template=true", key)
				}
				if get("bundle_key") != key {
					return fmt.Errorf("bundle %q: bundle_src bundle_key is %q", key, get("bundle_key"))
				}
			}
		}
	}
	if found != 1 {
		return fmt.Errorf("bundle %q: want exactly one bundle_src project row, got %d", key, found)
	}
	return nil
}

func readPresets(doc *Document) ([]Preset, error) {
	var out []Preset
	for _, sec := range doc.Root.Children {
		if sec.Kind != "table" || sec.Name != "preset" {
			return nil, fmt.Errorf("line %d: presets file holds only `## table preset`", sec.Line)
		}
		for _, rows := range sec.Children {
			if rows.Kind != "rows" {
				continue
			}
			idx := map[string]int{}
			for i, h := range rows.Header {
				idx[strings.TrimSpace(h)] = i
			}
			for _, need := range []string{"key", "title", "features"} {
				if _, ok := idx[need]; !ok {
					return nil, fmt.Errorf("line %d: preset rows need a %q column", rows.Line, need)
				}
			}
			for _, r := range rows.Rows {
				get := func(col string) (string, error) {
					i, ok := idx[col]
					if !ok || i >= len(r) {
						return "", nil
					}
					v := strings.TrimSpace(r[i])
					if strings.HasPrefix(v, backtickPrefix) {
						return v[len(backtickPrefix):], nil
					}
					return unquoteCell(v)
				}
				var p Preset
				var err error
				var feats, sortCell string
				if p.Key, err = get("key"); err != nil {
					return nil, err
				}
				if p.Title, err = get("title"); err != nil {
					return nil, err
				}
				if p.Doc, err = get("doc"); err != nil {
					return nil, err
				}
				if feats, err = get("features"); err != nil {
					return nil, err
				}
				if sortCell, err = get("sort"); err != nil {
					return nil, err
				}
				if !bundleKeyOK(p.Key) {
					return nil, fmt.Errorf("preset key %q must be lowercase letters, digits and _", p.Key)
				}
				if p.Title == "" {
					return nil, fmt.Errorf("preset %q has no title", p.Key)
				}
				if err := json.Unmarshal([]byte(feats), &p.Features); err != nil {
					return nil, fmt.Errorf("preset %q: features must be a JSON array of keys: %w", p.Key, err)
				}
				if len(p.Features) == 0 {
					return nil, fmt.Errorf("preset %q names no features", p.Key)
				}
				if sortCell != "" {
					if p.Sort, err = strconv.Atoi(sortCell); err != nil {
						return nil, fmt.Errorf("preset %q: sort %q is not a number", p.Key, sortCell)
					}
				}
				out = append(out, p)
			}
		}
	}
	return out, nil
}

func readAreas(doc *Document) ([]Area, error) {
	var out []Area
	for _, sec := range doc.Root.Children {
		if sec.Kind != "table" || sec.Name != "area" {
			return nil, fmt.Errorf("line %d: areas file holds only `## table area`", sec.Line)
		}
		for _, rows := range sec.Children {
			if rows.Kind != "rows" {
				continue
			}
			idx := map[string]int{}
			for i, h := range rows.Header {
				idx[strings.TrimSpace(h)] = i
			}
			for _, need := range []string{"key", "title", "scope", "card_types"} {
				if _, ok := idx[need]; !ok {
					return nil, fmt.Errorf("line %d: area rows need a %q column", rows.Line, need)
				}
			}
			for _, r := range rows.Rows {
				get := func(col string) (string, error) {
					i, ok := idx[col]
					if !ok || i >= len(r) {
						return "", nil
					}
					v := strings.TrimSpace(r[i])
					if strings.HasPrefix(v, backtickPrefix) {
						return v[len(backtickPrefix):], nil
					}
					return unquoteCell(v)
				}
				list := func(col string) ([]string, error) {
					v, err := get(col)
					if err != nil || v == "" {
						return nil, err
					}
					var out []string
					if err := json.Unmarshal([]byte(v), &out); err != nil {
						return nil, fmt.Errorf("%s must be a JSON array of names: %w", col, err)
					}
					return out, nil
				}
				var a Area
				var err error
				var sortCell string
				if a.Key, err = get("key"); err != nil {
					return nil, err
				}
				if a.Title, err = get("title"); err != nil {
					return nil, err
				}
				if a.Doc, err = get("doc"); err != nil {
					return nil, err
				}
				if a.Scope, err = get("scope"); err != nil {
					return nil, err
				}
				if sortCell, err = get("sort"); err != nil {
					return nil, err
				}
				if a.CardTypes, err = list("card_types"); err != nil {
					return nil, fmt.Errorf("area %q: %w", a.Key, err)
				}
				if a.DependsOn, err = list("depends_on"); err != nil {
					return nil, fmt.Errorf("area %q: %w", a.Key, err)
				}
				if a.Starts, err = list("starts"); err != nil {
					return nil, fmt.Errorf("area %q: %w", a.Key, err)
				}
				if !bundleKeyOK(a.Key) {
					return nil, fmt.Errorf("area key %q must be lowercase letters, digits and _", a.Key)
				}
				if a.Title == "" {
					return nil, fmt.Errorf("area %q has no title", a.Key)
				}
				if a.Scope != "project" && a.Scope != "workspace" {
					return nil, fmt.Errorf("area %q: scope must be project or workspace, got %q", a.Key, a.Scope)
				}
				if len(a.CardTypes) == 0 {
					return nil, fmt.Errorf("area %q names no card_types", a.Key)
				}
				if sortCell != "" {
					if a.Sort, err = strconv.Atoi(sortCell); err != nil {
						return nil, fmt.Errorf("area %q: sort %q is not a number", a.Key, sortCell)
					}
				}
				out = append(out, a)
			}
		}
	}
	return out, nil
}

// checkAreas validates the area catalog against itself and the features:
// keys are unique, an item type belongs to one area, dependencies name
// areas of the same scope, starts name feature bundles, and a feature
// starts at most one area.
func checkAreas(areas []Area, features map[string]bool) error {
	byKey := map[string]Area{}
	for _, a := range areas {
		if _, dup := byKey[a.Key]; dup {
			return fmt.Errorf("hcsv: duplicate area key %q", a.Key)
		}
		byKey[a.Key] = a
	}
	typeArea := map[string]string{}
	startArea := map[string]string{}
	for _, a := range areas {
		for _, ct := range a.CardTypes {
			if other, ok := typeArea[ct]; ok {
				return fmt.Errorf("hcsv: card type %q is in both area %q and area %q", ct, other, a.Key)
			}
			typeArea[ct] = a.Key
		}
		for _, d := range a.DependsOn {
			dep, ok := byKey[d]
			if !ok {
				return fmt.Errorf("hcsv: area %q depends on unknown area %q", a.Key, d)
			}
			if dep.Scope != a.Scope {
				return fmt.Errorf("hcsv: area %q (%s) can't depend on area %q (%s)", a.Key, a.Scope, d, dep.Scope)
			}
		}
		for _, st := range a.Starts {
			if !features[st] {
				return fmt.Errorf("hcsv: area %q starts from unknown feature %q", a.Key, st)
			}
			if other, ok := startArea[st]; ok {
				return fmt.Errorf("hcsv: feature %q starts both area %q and area %q", st, other, a.Key)
			}
			startArea[st] = a.Key
		}
	}
	return nil
}
