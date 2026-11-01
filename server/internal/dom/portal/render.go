package portal

import (
	"bytes"
	"fmt"
	"html/template"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
)

// Page is one published page as a portal holds it: the snapshot taken
// when the page entered a status that publishes to the portal.
type Page struct {
	ID          int64
	ParentID    int64
	Title       string
	Slug        string
	Body        string // markdown with {{< shortcodes >}}
	Sort        float64
	PublishedAt time.Time
}

// Site is everything a build renders: the portal's title and root page,
// and the pages published to it.
type Site struct {
	Title  string
	RootID int64
	Pages  []Page
}

// File is one rendered file. Path has no leading slash. CardID is the page
// a file renders (0 for site.css / 404.html), recorded so page.publications
// can report where a page lives in the active build.
type File struct {
	Path   string
	MIME   string
	Data   []byte
	CardID int64
}

// Result is a rendered build.
type Result struct {
	Files     []File
	Warnings  []string
	PageCount int
}

// maxDepth caps the page tree walk (CLAUDE.md: tree walks stop at 16).
const maxDepth = 16

// node is a page placed in the site tree.
type node struct {
	page     Page
	path     string // "" for the root, else "a/b"
	depth    int
	parent   *node
	children []*node
}

// Render turns a site into static files: one index.html per reachable page
// (the root at index.html, a page at <path>/index.html), site.css and
// 404.html. Every link a page carries is RELATIVE, so the same build works
// on the public host at "/" and under the signed-in preview prefix.
//
// The site tree is the page tree below the root: a published page whose
// parent isn't published here, or that isn't under the root at all, is
// left out with a warning. A page's path segment is its slug (or its
// title, slugified); siblings that collide get -2, -3, … with a warning.
//
// Page bodies are markdown (GitHub flavour; raw HTML is dropped) with
// Hugo-style placeholders expanded first:
//
//	{{< children >}}      list of this page's child pages
//	{{< nav >}}           the whole site tree
//	{{< toc >}}           this page's headings
//	{{< ref "a/b" >}}     relative URL of the page at path a/b
//	{{< ref 42 >}}        relative URL of page 42
//	{{</* children */>}}  a literal {{< children >}}
//
// A ref to a page that isn't on this portal renders as "#" with a warning,
// so QA can carry a link PROD doesn't have yet without a broken URL.
func Render(s Site) (Result, error) {
	var res Result
	warn := func(format string, a ...any) { res.Warnings = append(res.Warnings, fmt.Sprintf(format, a...)) }

	byID := make(map[int64]Page, len(s.Pages))
	kids := map[int64][]Page{}
	for _, p := range s.Pages {
		byID[p.ID] = p
		kids[p.ParentID] = append(kids[p.ParentID], p)
	}
	for _, list := range kids {
		sort.SliceStable(list, func(i, j int) bool {
			if list[i].Sort != list[j].Sort {
				return list[i].Sort < list[j].Sort
			}
			if a, b := strings.ToLower(list[i].Title), strings.ToLower(list[j].Title); a != b {
				return a < b
			}
			return list[i].ID < list[j].ID
		})
	}

	root, ok := byID[s.RootID]
	switch {
	case s.RootID == 0:
		warn("This portal has no root page yet: choose one in Admin → Portals.")
	case !ok:
		warn("The root page isn't published to this portal yet.")
	}
	css := File{Path: "site.css", MIME: "text/css; charset=utf-8", Data: []byte(siteCSS)}
	if s.RootID == 0 || !ok {
		page, err := renderShell(s.Title, "Nothing published yet", template.HTML(`<p class="empty">Nothing has been published to this site yet.</p>`))
		if err != nil {
			return Result{}, err
		}
		notFound, err := render404(s.Title)
		if err != nil {
			return Result{}, err
		}
		res.Files = []File{{Path: "index.html", MIME: "text/html; charset=utf-8", Data: page}, css, notFound}
		return res, nil
	}

	// Place the tree.
	top := &node{page: root}
	all := []*node{top}
	byPath := map[string]*node{"": top}
	nodeByID := map[int64]*node{root.ID: top}
	var place func(n *node)
	place = func(n *node) {
		if n.depth >= maxDepth {
			if len(kids[n.page.ID]) > 0 {
				warn("Pages below %q are nested too deep (more than %d levels) and were left out.", n.page.Title, maxDepth)
			}
			return
		}
		used := map[string]bool{}
		for _, c := range kids[n.page.ID] {
			if _, seen := nodeByID[c.ID]; seen {
				continue // a parent cycle; the walk already placed it
			}
			seg := slugify(c.Slug)
			if seg == "" {
				seg = slugify(c.Title)
			}
			if seg == "" {
				seg = "page-" + strconv.FormatInt(c.ID, 10)
			}
			base := seg
			for i := 2; used[seg]; i++ {
				seg = base + "-" + strconv.Itoa(i)
			}
			if seg != base {
				warn("%q and a sibling share the path %q; it was published as %q.", c.Title, base, seg)
			}
			used[seg] = true
			p := seg
			if n.path != "" {
				p = n.path + "/" + seg
			}
			child := &node{page: c, path: p, depth: n.depth + 1, parent: n}
			n.children = append(n.children, child)
			all = append(all, child)
			byPath[p] = child
			nodeByID[c.ID] = child
			place(child)
		}
	}
	place(top)
	var stray []string
	for _, p := range s.Pages {
		if _, ok := nodeByID[p.ID]; !ok {
			stray = append(stray, fmt.Sprintf("%q", p.Title))
		}
	}
	if len(stray) > 0 {
		sort.Strings(stray)
		warn("Published but not reachable from the root page (its parent isn't published here): %s.", strings.Join(stray, ", "))
	}

	md := goldmark.New(
		goldmark.WithExtensions(extension.GFM),
		goldmark.WithParserOptions(parser.WithAutoHeadingID()),
	)
	for _, n := range all {
		body := expandShortcodes(n, top, byPath, nodeByID, func(format string, a ...any) {
			warn("%s: "+format, append([]any{fmt.Sprintf("%q", n.page.Title)}, a...)...)
		})
		html, err := renderMarkdown(md, body)
		if err != nil {
			return Result{}, fmt.Errorf("render %q: %w", n.page.Title, err)
		}
		out, err := renderPage(s.Title, n, top, template.HTML(html))
		if err != nil {
			return Result{}, err
		}
		res.Files = append(res.Files, File{Path: filePath(n.path), MIME: "text/html; charset=utf-8", Data: out, CardID: n.page.ID})
	}
	notFound, err := render404(s.Title)
	if err != nil {
		return Result{}, err
	}
	res.Files = append(res.Files, css, notFound)
	res.PageCount = len(all)
	return res, nil
}

// filePath maps a page path to its file: "" → index.html, "a/b" →
// a/b/index.html.
func filePath(p string) string {
	if p == "" {
		return "index.html"
	}
	return p + "/index.html"
}

// rel is the relative URL from page `from` to page `to`. Pages are
// directories, so from a page at depth d the site root is d × "../".
func rel(from, to *node) string {
	up := strings.Repeat("../", from.depth)
	if to.path == "" {
		if up == "" {
			return "./"
		}
		return up
	}
	return up + to.path + "/"
}

var slugStrip = regexp.MustCompile(`[^a-z0-9]+`)

// slugify lowercases s and reduces it to [a-z0-9-] path-segment form.
func slugify(s string) string {
	s = slugStrip.ReplaceAllString(strings.ToLower(strings.TrimSpace(s)), "-")
	s = strings.Trim(s, "-")
	if len(s) > 80 {
		s = strings.Trim(s[:80], "-")
	}
	return s
}

// shortcode matches {{< name args >}}; escaped matches Hugo's comment form
// {{</* name args */>}}, which renders the shortcode literally.
var (
	shortcode = regexp.MustCompile(`\{\{<\s*([a-z]+)\s*([^>]*?)\s*>\}\}`)
	escaped   = regexp.MustCompile(`\{\{</\*\s*(.*?)\s*\*/>\}\}`)
)

// tocMarker stands in for {{< toc >}} through the markdown pass; it
// renders as its own paragraph, which renderMarkdown swaps for the list.
const tocMarker = "KITPTOCMARKER7f3a"

func expandShortcodes(n, top *node, byPath map[string]*node, byID map[int64]*node, warn func(string, ...any)) string {
	// Escapes first, through a placeholder the shortcode pass can't match.
	const open, close = "\x00SCO\x00", "\x00SCC\x00"
	body := escaped.ReplaceAllString(n.page.Body, open+" $1 "+close)
	body = shortcode.ReplaceAllStringFunc(body, func(m string) string {
		sub := shortcode.FindStringSubmatch(m)
		name, arg := sub[1], strings.TrimSpace(sub[2])
		switch name {
		case "children":
			return mdList(n, n.children, 1)
		case "nav":
			return mdList(n, top.children, maxDepth)
		case "toc":
			return "\n\n" + tocMarker + "\n\n"
		case "ref":
			target := strings.Trim(arg, `"' `)
			var to *node
			if id, err := strconv.ParseInt(target, 10, 64); err == nil {
				to = byID[id]
			} else {
				to = byPath[strings.Trim(target, "/")]
			}
			if to == nil {
				warn("{{< ref %s >}} doesn't match a page on this portal", arg)
				return "#"
			}
			return rel(n, to)
		default:
			warn("unknown placeholder {{< %s >}}", name)
			return m
		}
	})
	body = strings.ReplaceAll(body, open, "{{<")
	return strings.ReplaceAll(body, close, ">}}")
}

// mdList renders child pages as a nested markdown list of relative links.
func mdList(from *node, list []*node, depth int) string {
	if len(list) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("\n\n")
	var walk func([]*node, int)
	walk = func(ns []*node, level int) {
		for _, c := range ns {
			b.WriteString(strings.Repeat("  ", level))
			fmt.Fprintf(&b, "- [%s](%s)\n", mdEscape(c.page.Title), rel(from, c))
			if level+1 < depth {
				walk(c.children, level+1)
			}
		}
	}
	walk(list, 0)
	b.WriteString("\n")
	return b.String()
}

var mdSpecial = strings.NewReplacer(`\`, `\\`, `[`, `\[`, `]`, `\]`, `*`, `\*`, `_`, `\_`, "`", "\\`", `<`, `\<`)

func mdEscape(s string) string { return mdSpecial.Replace(s) }

type heading struct {
	level int
	id    string
	text  string
}

// renderMarkdown renders one body, swapping the toc marker for a list of
// the page's level-2 and level-3 headings.
func renderMarkdown(md goldmark.Markdown, body string) (string, error) {
	src := []byte(body)
	doc := md.Parser().Parse(text.NewReader(src))
	var heads []heading
	err := ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		h, ok := n.(*ast.Heading)
		if !ok || h.Level < 2 || h.Level > 3 {
			return ast.WalkContinue, nil
		}
		id, _ := h.AttributeString("id")
		idb, _ := id.([]byte)
		heads = append(heads, heading{level: h.Level, id: string(idb), text: nodeText(h, src)})
		return ast.WalkSkipChildren, nil
	})
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	if err := md.Renderer().Render(&buf, src, doc); err != nil {
		return "", err
	}
	out := buf.String()
	if strings.Contains(out, tocMarker) {
		var t strings.Builder
		if len(heads) > 0 {
			t.WriteString(`<nav class="toc" aria-label="On this page"><ul>`)
			for _, h := range heads {
				fmt.Fprintf(&t, `<li class="toc-%d"><a href="#%s">%s</a></li>`, h.level,
					template.HTMLEscapeString(h.id), template.HTMLEscapeString(h.text))
			}
			t.WriteString(`</ul></nav>`)
		}
		out = strings.ReplaceAll(out, "<p>"+tocMarker+"</p>", t.String())
		out = strings.ReplaceAll(out, tocMarker, "")
	}
	return out, nil
}

// nodeText concatenates the text segments under n.
func nodeText(n ast.Node, src []byte) string {
	var b strings.Builder
	_ = ast.Walk(n, func(c ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			if t, ok := c.(*ast.Text); ok {
				b.Write(t.Segment.Value(src))
			}
		}
		return ast.WalkContinue, nil
	})
	return b.String()
}

type crumb struct {
	Href  string
	Title string
}

type pageView struct {
	SiteTitle string
	PageTitle string
	Base      string // relative prefix to the site root ("" at the root)
	Home      string
	Crumbs    []crumb
	Nav       template.HTML
	Content   template.HTML
	Published string
}

func renderPage(site string, n, top *node, content template.HTML) ([]byte, error) {
	v := pageView{
		SiteTitle: site,
		PageTitle: n.page.Title,
		Base:      strings.Repeat("../", n.depth),
		Home:      rel(n, top),
		Nav:       navHTML(n, top),
		Content:   content,
	}
	if !n.page.PublishedAt.IsZero() {
		v.Published = n.page.PublishedAt.UTC().Format("2 January 2006")
	}
	var chain []*node
	for p := n.parent; p != nil; p = p.parent {
		chain = append([]*node{p}, chain...)
	}
	for _, p := range chain {
		v.Crumbs = append(v.Crumbs, crumb{Href: rel(n, p), Title: p.page.Title})
	}
	var buf bytes.Buffer
	if err := pageTmpl.Execute(&buf, v); err != nil {
		return nil, fmt.Errorf("layout %q: %w", n.page.Title, err)
	}
	return buf.Bytes(), nil
}

func renderShell(site, title string, content template.HTML) ([]byte, error) {
	var buf bytes.Buffer
	err := pageTmpl.Execute(&buf, pageView{SiteTitle: site, PageTitle: title, Home: "./", Content: content})
	if err != nil {
		return nil, fmt.Errorf("layout: %w", err)
	}
	return buf.Bytes(), nil
}

// NotFoundBase is replaced, when 404.html is served, with the relative or
// absolute prefix of the site root for the request's path: a 404 can be
// served at any depth, so it can't carry a fixed relative link.
const NotFoundBase = "__KITP_SITE_BASE__"

func render404(site string) (File, error) {
	var buf bytes.Buffer
	err := pageTmpl.Execute(&buf, pageView{
		SiteTitle: site,
		PageTitle: "Page not found",
		Base:      NotFoundBase,
		Home:      NotFoundBase,
		Content:   template.HTML(`<p class="empty">There's no page at this address. It may have moved, or not be published here.</p>`),
	})
	if err != nil {
		return File{}, fmt.Errorf("layout 404: %w", err)
	}
	return File{Path: "404.html", MIME: "text/html; charset=utf-8", Data: buf.Bytes()}, nil
}

// navHTML renders the site tree with the current page marked.
func navHTML(cur, top *node) template.HTML {
	var b strings.Builder
	homeCls := ""
	if cur == top {
		homeCls = ` aria-current="page"`
	}
	fmt.Fprintf(&b, `<ul><li><a href="%s"%s>%s</a></li>`, template.HTMLEscapeString(rel(cur, top)), homeCls, template.HTMLEscapeString(top.page.Title))
	var walk func([]*node)
	walk = func(ns []*node) {
		for _, c := range ns {
			attr := ""
			if c == cur {
				attr = ` aria-current="page"`
			}
			fmt.Fprintf(&b, `<li><a href="%s"%s>%s</a>`, template.HTMLEscapeString(rel(cur, c)), attr, template.HTMLEscapeString(c.page.Title))
			if len(c.children) > 0 {
				b.WriteString("<ul>")
				walk(c.children)
				b.WriteString("</ul>")
			}
			b.WriteString("</li>")
		}
	}
	walk(top.children)
	b.WriteString("</ul>")
	return template.HTML(b.String())
}

var pageTmpl = template.Must(template.New("page").Parse(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{.PageTitle}} · {{.SiteTitle}}</title>
<link rel="stylesheet" href="{{.Base}}site.css">
</head>
<body>
<header class="site-header"><a class="site-title" href="{{.Home}}">{{.SiteTitle}}</a></header>
<div class="site-body">
{{if .Nav}}<nav class="site-nav" aria-label="Site">{{.Nav}}</nav>{{end}}
<main class="page">
{{if .Crumbs}}<ol class="crumbs">{{range .Crumbs}}<li><a href="{{.Href}}">{{.Title}}</a></li>{{end}}</ol>{{end}}
<h1>{{.PageTitle}}</h1>
<article class="prose">{{.Content}}</article>
{{if .Published}}<footer class="page-footer">Published {{.Published}}</footer>{{end}}
</main>
</div>
</body>
</html>
`))

const siteCSS = `:root {
  --bg: #f7f8fa; --surface: #fff; --text: #1d2330; --muted: #5d6675;
  --line: #e3e6eb; --accent: #2f6bdb; --accent-soft: #e8effc; --radius: 14px;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--text); background: var(--bg);
}
* { box-sizing: border-box; }
body { margin: 0; line-height: 1.6; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.site-header { background: var(--surface); border-bottom: 1px solid var(--line); padding: 14px 24px; }
.site-title { font-weight: 650; font-size: 1.05rem; color: var(--text); }
.site-body { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 24px; max-width: 1080px; margin: 24px auto; padding: 0 24px; }
.site-nav { font-size: .92rem; }
.site-nav ul { list-style: none; margin: 0; padding: 0; }
.site-nav ul ul { padding-left: 14px; border-left: 1px solid var(--line); margin-left: 6px; }
.site-nav a { display: block; padding: 4px 10px; border-radius: 8px; color: var(--muted); }
.site-nav a[aria-current="page"] { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.page { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 28px 36px; min-width: 0; }
.page h1 { margin: 0 0 12px; font-size: 1.9rem; line-height: 1.25; }
.crumbs { list-style: none; display: flex; flex-wrap: wrap; gap: 6px; padding: 0; margin: 0 0 8px; font-size: .85rem; color: var(--muted); }
.crumbs li + li::before { content: "›"; margin-right: 6px; }
.prose h2 { margin-top: 1.8em; font-size: 1.35rem; }
.prose h3 { margin-top: 1.4em; font-size: 1.1rem; }
.prose code { background: #f0f2f5; border-radius: 6px; padding: 1px 5px; font-size: .9em; }
.prose pre { background: #f0f2f5; border-radius: 10px; padding: 12px 14px; overflow-x: auto; }
.prose pre code { background: none; padding: 0; }
.prose table { border-collapse: collapse; }
.prose th, .prose td { border: 1px solid var(--line); padding: 6px 10px; }
.prose blockquote { margin: 0; padding: 4px 16px; border-left: 3px solid var(--line); color: var(--muted); }
.toc { background: var(--bg); border-radius: 10px; padding: 10px 16px; margin: 0 0 16px; font-size: .92rem; }
.toc ul { list-style: none; margin: 0; padding: 0; }
.toc .toc-3 { padding-left: 16px; }
.empty { color: var(--muted); }
.page-footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid var(--line); font-size: .82rem; color: var(--muted); }
@media (max-width: 760px) {
  .site-body { grid-template-columns: 1fr; }
  .page { padding: 20px; }
}
`
