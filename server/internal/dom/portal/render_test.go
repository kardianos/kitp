package portal

import (
	"strings"
	"testing"
)

func files(t *testing.T, res Result) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, f := range res.Files {
		out[f.Path] = string(f.Data)
	}
	return out
}

// site is the fixture tree:
//
//	Home (1)
//	├── Guide (2, slug "guide")
//	│   ├── Install (4)
//	│   └── Upgrade (5, slug "install" — collides with Install)
//	└── FAQ (3)
//	Orphan (9) — parent 99 isn't published
func site() Site {
	return Site{
		Title:  "Docs",
		RootID: 1,
		Pages: []Page{
			{ID: 1, Title: "Home", Body: "Hello.\n\n{{< children >}}"},
			{ID: 2, ParentID: 1, Title: "Guide", Slug: "guide", Sort: 10, Body: "{{< toc >}}\n\n## Setup\n\ntext\n\n### Details\n\nmore\n\nSee [the FAQ]({{< ref \"faq\" >}}) and [install]({{< ref 4 >}})."},
			{ID: 3, ParentID: 1, Title: "FAQ", Sort: 20, Body: "{{< nav >}}\n\nLiteral: `{{</* children */>}}`\n\nBroken: [x]({{< ref \"nope\" >}})"},
			{ID: 4, ParentID: 2, Title: "Install", Sort: 1, Body: "Back [home]({{< ref \"\" >}})."},
			{ID: 5, ParentID: 2, Title: "Upgrade", Slug: "install", Sort: 2, Body: "<script>alert(1)</script>\n\nUp."},
			{ID: 9, ParentID: 99, Title: "Orphan", Body: "lost"},
		},
	}
}

// TestRenderPaths pins the file layout: directory-style pages, a slug
// collision suffixed, and the orphan left out with a warning.
func TestRenderPaths(t *testing.T) {
	res, err := Render(site())
	if err != nil {
		t.Fatal(err)
	}
	got := files(t, res)
	for _, p := range []string{"index.html", "guide/index.html", "faq/index.html", "guide/install/index.html", "guide/install-2/index.html", "site.css", "404.html"} {
		if _, ok := got[p]; !ok {
			t.Errorf("missing %s (have %v)", p, keys(got))
		}
	}
	if res.PageCount != 5 {
		t.Errorf("page count = %d, want 5", res.PageCount)
	}
	for _, f := range res.Files {
		if f.Path == "guide/install/index.html" && f.CardID != 4 {
			t.Errorf("install file card = %d, want 4", f.CardID)
		}
	}
	warnings := strings.Join(res.Warnings, "\n")
	for _, want := range []string{`share the path "install"`, `"Orphan"`, `ref "nope"`} {
		if !strings.Contains(warnings, want) {
			t.Errorf("warnings %q lack %q", warnings, want)
		}
	}
}

// TestRenderLinksAreRelative is the link table: every page links to the
// stylesheet, home and other pages relative to its own directory.
func TestRenderLinksAreRelative(t *testing.T) {
	res, err := Render(site())
	if err != nil {
		t.Fatal(err)
	}
	got := files(t, res)
	cases := []struct {
		file, want string
	}{
		{"index.html", `href="site.css"`},
		{"index.html", `<a href="guide/">Guide</a>`},          // {{< children >}}
		{"guide/index.html", `href="../site.css"`},            // stylesheet one level up
		{"guide/index.html", `href="../faq/"`},                // ref by path
		{"guide/index.html", `href="../guide/install/"`},      // ref by id (via the site root)
		{"guide/install/index.html", `href="../../site.css"`}, // two levels
		{"guide/install/index.html", `<a href="../../">home</a>`},
		{"guide/install/index.html", `<li><a href="../../guide/">Guide</a></li>`}, // breadcrumb
		{"faq/index.html", `<a href="#">x</a>`},                                   // broken ref
		{"faq/index.html", `{{&lt; children &gt;}}`},                              // escaped shortcode stays literal
		{"faq/index.html", `<a href="../guide/install-2/">Upgrade</a>`},           // {{< nav >}}
	}
	for _, c := range cases {
		if !strings.Contains(got[c.file], c.want) {
			t.Errorf("%s lacks %s", c.file, c.want)
		}
	}
}

// TestRenderTOCAndSafety checks the toc placeholder becomes a heading list
// and raw HTML in a body is dropped, not passed through.
func TestRenderTOCAndSafety(t *testing.T) {
	res, err := Render(site())
	if err != nil {
		t.Fatal(err)
	}
	got := files(t, res)
	guide := got["guide/index.html"]
	if !strings.Contains(guide, `<nav class="toc"`) || !strings.Contains(guide, `<a href="#setup">Setup</a>`) ||
		!strings.Contains(guide, `class="toc-3"><a href="#details">Details</a>`) {
		t.Errorf("guide toc missing: %s", guide)
	}
	if strings.Contains(guide, tocMarker) {
		t.Error("toc marker leaked into output")
	}
	if strings.Contains(got["guide/install-2/index.html"], "<script>") {
		t.Error("raw <script> passed through")
	}
	if !strings.Contains(got["guide/install/index.html"], `aria-current="page">Install</a>`) {
		t.Error("nav doesn't mark the current page")
	}
}

// TestRenderWithoutRoot: no root, or a root that isn't published, renders
// a placeholder home page plus a warning instead of failing.
func TestRenderWithoutRoot(t *testing.T) {
	for _, s := range []Site{
		{Title: "Empty"},
		{Title: "Unpublished root", RootID: 7, Pages: []Page{{ID: 8, ParentID: 7, Title: "Child"}}},
	} {
		res, err := Render(s)
		if err != nil {
			t.Fatalf("%s: %v", s.Title, err)
		}
		got := files(t, res)
		if !strings.Contains(got["index.html"], "Nothing has been published") {
			t.Errorf("%s: index lacks the placeholder", s.Title)
		}
		if len(res.Warnings) == 0 {
			t.Errorf("%s: no warning", s.Title)
		}
		if _, ok := got["404.html"]; !ok {
			t.Errorf("%s: no 404 page", s.Title)
		}
	}
}

func TestSlugify(t *testing.T) {
	for in, want := range map[string]string{
		"Getting Started":  "getting-started",
		"  FAQ & Help!  ":  "faq-help",
		"site.css":         "site-css",
		"Ünïcode only ✓":   "n-code-only",
		"---":              "",
		"Already-a-slug-1": "already-a-slug-1",
	} {
		if got := slugify(in); got != want {
			t.Errorf("slugify(%q) = %q, want %q", in, got, want)
		}
	}
}

func keys(m map[string]string) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}
