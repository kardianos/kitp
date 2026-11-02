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
			{ID: 2, ParentID: 1, Title: "Guide", Slug: "guide", Sort: 10, Body: "{{< toc >}}\n\n## Setup\n\ntext\n\n### Details\n\nmore\n\nSee [the FAQ](ref:faq) and [install](ref:4)."},
			{ID: 3, ParentID: 1, Title: "FAQ", Sort: 20, Body: "{{< nav >}}\n\nLiteral: `{{< children >}}`\n\n```\n{{< toc >}}\n```\n\nBroken: [x](ref:nope)"},
			{ID: 4, ParentID: 2, Title: "Install", Sort: 1, Body: "Back [home](ref:).\n\n## Next: [setup](ref:guide#setup)"},
			{ID: 5, ParentID: 2, Title: "Upgrade", Slug: "install", Sort: 2, Body: "<script>alert(1)</script>\n\nUp. Old: [faq]({{< ref \"faq\" >}})"},
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
	for _, p := range []string{"index.html", "guide/index.html", "faq/index.html", "guide/install/index.html", "guide/install-2/index.html", "_theme/site.css", "_theme/custom.css", "404.html"} {
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
	for _, want := range []string{`share the path "install"`, `"Orphan"`, `ref:nope`, `link with [text](ref:faq)`} {
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
		{"index.html", `href="_theme/site.css"`},
		{"index.html", `<a href="guide/">Guide</a>`},                              // {{< children >}}
		{"guide/index.html", `href="../_theme/site.css"`},                         // stylesheet one level up
		{"guide/index.html", `href="../faq/"`},                                    // ref: by path
		{"guide/index.html", `href="../guide/install/"`},                          // ref: by id (via the site root)
		{"guide/install/index.html", `href="../../_theme/site.css"`},              // two levels
		{"guide/install/index.html", `<a href="../../">home</a>`},                 // ref: (the root)
		{"guide/install/index.html", `<a href="../../guide/#setup">setup</a>`},    // ref: in a heading, with a fragment
		{"guide/install/index.html", `<li><a href="../../guide/">Guide</a></li>`}, // breadcrumb
		{"guide/install-2/index.html", `<a href="#">faq</a>`},                     // the old ref placeholder
		{"faq/index.html", `<a href="#">x</a>`},                                   // broken ref:
		{"faq/index.html", `<code>{{&lt; children &gt;}}</code>`},                 // placeholder in a code span stays literal
		{"faq/index.html", "<pre><code>{{&lt; toc &gt;}}\n</code></pre>"},         // and in a code block
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
	if faq := got["faq/index.html"]; strings.Contains(faq, `class="toc"`) || strings.Contains(faq, tocMarker) {
		t.Error("{{< toc >}} in a code block was expanded")
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

// TestRenderRootMismatch: the root is a page that isn't published here
// while other pages are (a portal pointed at the wrong "Home"). The
// warnings name the root and list the pages it is missing.
func TestRenderRootMismatch(t *testing.T) {
	res, err := Render(Site{
		Title: "Docs", RootID: 82, RootTitle: "Home", RootProject: "Bundle: Publishing",
		Pages: []Page{{ID: 106, Title: "Home"}, {ID: 107, ParentID: 106, Title: "Getting started"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		`The root page, "Home" in "Bundle: Publishing", isn't published to this portal yet.`,
		`Published here but not under the root page: "Getting started", "Home".`,
	}
	if strings.Join(res.Warnings, "\n") != strings.Join(want, "\n") {
		t.Errorf("warnings = %q, want %q", res.Warnings, want)
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

// TestEveryBaseThemeRenders renders the sample site (sections, a hidden
// page, a section that hides its children, a long list) with every base
// theme: each page uses the theme's stylesheet, a hidden page stays out of
// the navigation, and the paging themes split the long list.
func TestEveryBaseThemeRenders(t *testing.T) {
	for _, b := range BaseThemes() {
		t.Run(b.Key, func(t *testing.T) {
			th, err := ResolveTheme(ThemeSettings{Base: b.Key}, nil)
			if err != nil {
				t.Fatal(err)
			}
			res, err := Render(sampleSite(th))
			if err != nil {
				t.Fatal(err)
			}
			got := files(t, res)
			for _, p := range []string{"index.html", "guide/index.html", "guide/install/index.html", "news/index.html", "404.html", "_theme/site.css", "_theme/custom.css"} {
				if _, ok := got[p]; !ok {
					t.Fatalf("missing %s (have %v)", p, keys(got))
				}
			}
			install := got["guide/install/index.html"]
			for _, want := range []string{`href="../../_theme/site.css"`, `href="../../_theme/custom.css"`, "<title>Install · Sample</title>", "Install it."} {
				if !strings.Contains(install, want) {
					t.Errorf("install page lacks %s", want)
				}
			}
			if strings.Contains(got["guide/index.html"], "hidden/") {
				t.Error("a page hidden from navigation is linked from the guide page")
			}
			if strings.Contains(got["guide/index.html"], "story-1/") {
				t.Error("News hides its children, but the guide page links a story")
			}
			if b.Paginate > 0 {
				if _, ok := got["news/page/2/index.html"]; !ok {
					t.Errorf("12 stories at %d a page, but no news/page/2/ (have %v)", b.Paginate, keys(got))
				}
			}
			if !strings.Contains(got["404.html"], NotFoundBase+"_theme/site.css") {
				t.Error("the 404 page doesn't link the stylesheet from the site root")
			}
		})
	}
}

// navSite is two sections with a page each: A (a1) and B (b1).
func navSite(th *Theme) Site {
	return Site{Title: "Nav", RootID: 1, Theme: th, Pages: []Page{
		{ID: 1, Title: "Home"},
		{ID: 2, ParentID: 1, Title: "A", Sort: 1},
		{ID: 3, ParentID: 2, Title: "a1"},
		{ID: 4, ParentID: 1, Title: "B", Sort: 2},
		{ID: 5, ParentID: 4, Title: "b1"},
	}}
}

// TestNavModes is the navigation table, seen from page a1 with the Side
// menu theme: full lists both branches, section only a1's, collapsible
// both with only a1's branch open.
func TestNavModes(t *testing.T) {
	for _, c := range []struct {
		nav          string
		want, reject []string
	}{
		{NavFull, []string{`href="../../a/a1/" aria-current="page"`, `href="../../b/b1/"`}, []string{"<details"}},
		{NavSection, []string{`href="../../a/a1/" aria-current="page"`, `href="../../b/">B <span class="more"`}, []string{"b1/"}},
		{NavCollapsible, []string{`<details open><summary><a href="../../a/" class="in-path">A</a>`, `<details><summary><a href="../../b/">B</a>`, `href="../../b/b1/"`}, nil},
	} {
		th, err := ResolveTheme(ThemeSettings{Base: "sidebar", Nav: c.nav}, nil)
		if err != nil {
			t.Fatal(err)
		}
		res, err := Render(navSite(th))
		if err != nil {
			t.Fatal(err)
		}
		page := files(t, res)["a/a1/index.html"]
		nav := page[strings.Index(page, `<nav class="site-nav"`):strings.Index(page, "</nav>")]
		for _, w := range c.want {
			if !strings.Contains(nav, w) {
				t.Errorf("%s: nav lacks %s\n%s", c.nav, w, nav)
			}
		}
		for _, r := range c.reject {
			if strings.Contains(nav, r) {
				t.Errorf("%s: nav has %s\n%s", c.nav, r, nav)
			}
		}
	}
}

// TestPaging: the Blog theme lists five posts a page, newest first, at
// news/, news/page/2/ and news/page/3/; each page's links climb from its
// own depth.
func TestPaging(t *testing.T) {
	th, err := ResolveTheme(ThemeSettings{Base: "blog"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := Render(sampleSite(th))
	if err != nil {
		t.Fatal(err)
	}
	got := files(t, res)
	p1, p2, p3 := got["news/index.html"], got["news/page/2/index.html"], got["news/page/3/index.html"]
	if p1 == "" || p2 == "" || p3 == "" {
		t.Fatalf("pages missing (have %v)", keys(got))
	}
	if !strings.Contains(p1, `href="../news/story-12/">Story 12</a>`) || strings.Contains(p1, "Story 7<") {
		t.Errorf("page 1 should list stories 12 to 8:\n%s", p1)
	}
	if !strings.Contains(p2, `href="../../../news/story-7/">Story 7</a>`) || !strings.Contains(p2, `href="../../../_theme/site.css"`) {
		t.Errorf("page 2 should list story 7, linked from two levels down:\n%s", p2)
	}
	if !strings.Contains(p2, `href="../../../news/">Newer posts`) || !strings.Contains(p2, `href="../../../news/page/3/">← Older posts`) {
		t.Errorf("page 2's pager links:\n%s", p2)
	}
	if !strings.Contains(p3, "Story 1<") || strings.Contains(p3, "Older posts") {
		t.Errorf("page 3 should end the list:\n%s", p3)
	}
}

// TestPublishedFiles: an attachment on a published page is published
// under _files/ and the image points at it; one that isn't attached to a
// page here becomes "#" with a warning; links to other sites open in a
// new tab.
func TestPublishedFiles(t *testing.T) {
	s := Site{Title: "Files", RootID: 1, Pages: []Page{
		{ID: 1, Title: "Home", Body: "![Chart](/api/v1/attachment/7/view)\n\n![Secret](/api/v1/attachment/8/view)\n\n[PDF](attachment:7) and [site](https://example.com)."},
		{ID: 2, ParentID: 1, Title: "Sub", Body: "![Chart](/api/v1/attachment/7/view)"},
	}, Files: map[int64]SiteFile{7: {ID: 7, CardID: 1, Name: "Q3 Chart.PNG", MIME: "image/png", Size: 10}}}
	res, err := Render(s)
	if err != nil {
		t.Fatal(err)
	}
	got := files(t, res)
	if !strings.Contains(got["index.html"], `<img src="_files/7/q3-chart.png" alt="Chart">`) {
		t.Errorf("home image:\n%s", got["index.html"])
	}
	if !strings.Contains(got["sub/index.html"], `<img src="../_files/7/q3-chart.png" alt="Chart">`) {
		t.Errorf("sub image:\n%s", got["sub/index.html"])
	}
	if !strings.Contains(got["index.html"], `<img src="#" alt="Secret">`) || !strings.Contains(got["index.html"], `<a href="_files/7/q3-chart.png">PDF</a>`) {
		t.Errorf("secret image / pdf link:\n%s", got["index.html"])
	}
	if !strings.Contains(got["index.html"], `<a href="https://example.com" target="_blank" rel="noopener noreferrer">site</a>`) {
		t.Errorf("external link:\n%s", got["index.html"])
	}
	if len(res.Attachments) != 1 || res.Attachments[0] != (FileRef{ID: 7, Path: "_files/7/q3-chart.png", MIME: "image/png"}) {
		t.Errorf("attachments = %+v, want just 7, once", res.Attachments)
	}
	if !strings.Contains(strings.Join(res.Warnings, "\n"), "/api/v1/attachment/8/view isn't attached to a page on this portal") {
		t.Errorf("warnings = %q", res.Warnings)
	}
}

// TestCustomTheme: a theme card's own files override the base's —
// page.html, a block file, theme.json, custom.css (published after the
// accent colour) and a logo.
func TestCustomTheme(t *testing.T) {
	page := `<!DOCTYPE html><title>{{.Page.Title}}</title><link rel="stylesheet" href="{{.Theme}}custom.css">` +
		`{{if .Site.Logo}}<img src="{{.Site.Logo}}">{{end}}{{block "foot" .}}base foot{{end}}` +
		`{{range .Children}}[{{.Title}}]{{end}}{{with .Pager}}pages={{.Pages}}{{end}}`
	th, err := ResolveTheme(ThemeSettings{Base: "sidebar", Accent: "#ff0000"}, []ThemeFile{
		{Path: "page.html", Data: []byte(page)},
		{Path: "zz-blocks.html", Data: []byte(`{{define "foot"}}my foot{{end}}`)},
		{Path: "theme.json", Data: []byte(`{"paginate": 2, "order": "newest"}`)},
		{Path: "custom.css", Data: []byte("body { color: red; }")},
		{Path: "logo.png", MIME: "image/png", Addr: "cas-logo", Size: 3},
	})
	if err != nil {
		t.Fatal(err)
	}
	res, err := Render(sampleSite(th))
	if err != nil {
		t.Fatal(err)
	}
	got := files(t, res)
	if !strings.Contains(got["index.html"], `<img src="_theme/logo.png">my foot`) {
		t.Errorf("home:\n%s", got["index.html"])
	}
	if !strings.Contains(got["news/index.html"], "[Story 12][Story 11]pages=6") {
		t.Errorf("news:\n%s", got["news/index.html"])
	}
	if css := got["_theme/custom.css"]; !strings.Contains(css, ":root { --accent: #ff0000; }\nbody { color: red; }") {
		t.Errorf("custom.css:\n%s", css)
	}
	for _, f := range res.Files {
		if f.Path == "_theme/logo.png" && (f.Addr != "cas-logo" || f.Size != 3) {
			t.Errorf("logo published as %+v, want the stored blob", f)
		}
	}
}

// TestBadThemes: a theme that doesn't parse, or doesn't render, names the
// file and line.
func TestBadThemes(t *testing.T) {
	_, err := ResolveTheme(ThemeSettings{Base: "sidebar"}, []ThemeFile{{Path: "page.html", Data: []byte("<p>{{if .Page.Title}}oops</p>")}})
	if err == nil || !strings.Contains(err.Error(), "page.html:1") {
		t.Errorf("unclosed if: %v", err)
	}
	th, err := ResolveTheme(ThemeSettings{Base: "sidebar"}, []ThemeFile{{Path: "page.html", Data: []byte("<p>\n{{.Page.Nope}}</p>")}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Render(sampleSite(th)); err == nil || !strings.Contains(err.Error(), "page.html:2") || !strings.Contains(err.Error(), "Nope") {
		t.Errorf("unknown field: %v", err)
	}
	if _, err := ResolveTheme(ThemeSettings{Base: "sidebar"}, []ThemeFile{{Path: "theme.json", Data: []byte(`{"nav": "sideways"}`)}}); err == nil {
		t.Error("a bad nav mode in theme.json was accepted")
	}
}

func TestThemePathError(t *testing.T) {
	for p, ok := range map[string]bool{
		"page.html": true, "custom.css": true, "fonts/inter.woff2": true, "img/logo-2.svg": true,
		"": false, "Page.html": false, "../x.css": false, ".hidden.css": false, "a/.b/c.css": false,
		"script.js": false, "noext": false, "a b.css": false, "/abs.css": false,
	} {
		if got := ThemePathError(p) == ""; got != ok {
			t.Errorf("ThemePathError(%q) = %q", p, ThemePathError(p))
		}
	}
}

// TestSummary: a list's summary is the first paragraph with words in it —
// not a picture's alt text, not the toc marker — cut at a word boundary.
func TestSummary(t *testing.T) {
	long := strings.Repeat("word ", 80)
	th, err := ResolveTheme(ThemeSettings{Base: "topbar"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := Render(Site{Title: "S", RootID: 1, Theme: th, Pages: []Page{
		{ID: 1, Title: "Home"},
		{ID: 2, ParentID: 1, Title: "Pic", Sort: 1, Body: "![photo](https://example.com/a.png)\n\nThe real opening."},
		{ID: 3, ParentID: 1, Title: "Toc", Sort: 2, Body: "{{< toc >}}\n\n## Head\n\nAfter the contents."},
		{ID: 4, ParentID: 1, Title: "Long", Sort: 3, Body: long},
	}})
	if err != nil {
		t.Fatal(err)
	}
	home := files(t, res)["index.html"]
	for _, want := range []string{"<span>The real opening.</span>", "<span>After the contents.</span>", "word word…</span>"} {
		if !strings.Contains(home, want) {
			t.Errorf("home lacks %s:\n%s", want, home)
		}
	}
	if strings.Contains(home, "<span>photo") {
		t.Error("a picture's alt text became a summary")
	}
}
