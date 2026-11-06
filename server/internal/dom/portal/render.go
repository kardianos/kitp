package portal

import (
	"bytes"
	"fmt"
	"html/template"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

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
	// NavHidden leaves the page (and everything under it) out of the
	// site's navigation and its automatic lists of child pages; it is
	// still published, and {{< children >}} still lists it.
	NavHidden bool
	// NavHideChildren keeps the page in the navigation but not its child
	// pages (a changelog section without its hundred entries).
	NavHideChildren bool
	// Moved: the page is no longer under the portal's root in its live
	// tree, though its snapshot still says it is. It isn't built, so the
	// site doesn't link it; serving refuses it too (review 2026-11-03
	// round 4 #14).
	Moved bool
}

// SiteFile is an attachment on a published page, which a page body may
// show (![x](/api/v1/attachment/12/view)) or link to: a build publishes
// the ones bodies use under _files/.
type SiteFile struct {
	ID     int64
	CardID int64
	Name   string
	MIME   string
	Size   int64
}

// MaxPublishedFileBytes caps an attachment a build publishes.
const MaxPublishedFileBytes = 25 << 20

// Site is everything a build renders: the portal's title and root page,
// the pages published to it, their attachments and the theme.
// RootTitle / RootProject name the root page even when it isn't published
// here, for the build warnings.
type Site struct {
	Title       string
	RootID      int64
	RootTitle   string
	RootProject string
	Pages       []Page
	// Files are the attachments on the published pages, by attachment id.
	Files map[int64]SiteFile
	// Theme is the resolved theme; nil = the default base theme.
	Theme *Theme
	// Notes are warnings found while loading the site (a deleted theme),
	// reported with the build's own.
	Notes []string
}

// File is one rendered file. Path has no leading slash. Either Data holds
// the bytes or Addr names a CAS blob already stored (a theme card's own
// files). CardID is the page a file renders (0 for theme files and
// 404.html), recorded so page.publications can report where a page lives
// in the active build.
type File struct {
	Path   string
	MIME   string
	Data   []byte
	Addr   string
	Size   int64 // with Addr: the blob's size
	CardID int64
}

// FileRef is an attachment a build publishes: the builder reads its bytes.
type FileRef struct {
	ID   int64
	Path string
	MIME string
	// CardID is the page the attachment is on (portal_build_file.card_id,
	// so serving re-checks that page).
	CardID int64
}

// Result is a rendered build.
type Result struct {
	Files       []File
	Attachments []FileRef
	Warnings    []string
	PageCount   int
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
	// Filled while rendering bodies.
	html     string
	headings []headingView
	summary  string
	image    string // root-relative ("_files/…") or absolute URL; "" = none
}

// rootRel is the node's URL relative to the site root: "" for the root,
// "a/b/" otherwise.
func (n *node) rootRel() string {
	if n.path == "" {
		return ""
	}
	return n.path + "/"
}

// base is the relative prefix from the node's own page to the site root.
func (n *node) base() string { return strings.Repeat("../", n.depth) }

// hrefAt joins a page's base and a root-relative target into a link.
func hrefAt(base, rootRel string) string {
	if rootRel == "" && base == "" {
		return "./"
	}
	return base + rootRel
}

// isAbsURL reports whether s has a scheme (https:, mailto:, …) or is
// protocol-relative.
func isAbsURL(s string) bool {
	return strings.HasPrefix(s, "//") || urlScheme.MatchString(s)
}

var urlScheme = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9+.-]*:`)

// Render turns a site into static files: one index.html per reachable page
// (the root at index.html, a page at <path>/index.html), the extra pages
// of a paged list (<path>/page/2/index.html), 404.html, the theme's files
// under _theme/ and the attachments page bodies use under _files/. Every
// link a page carries is RELATIVE, so the same build works on the public
// host at "/", under the signed-in preview prefix and inside kitp.
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
//
// A placeholder inside a code span or code block is left as written, which
// is how a page shows one literally.
//
// Links to other pages use the ref: scheme, resolved to relative URLs:
//
//	[Install](ref:guide/install)   the page at path guide/install
//	[Install](ref:42)              page 42
//	[Home](ref:)                   the root page
//	[Setup](ref:guide#setup)       a heading on another page
//
// A ref: link is an ordinary markdown link, so the rich-text editor shows
// it as a link and saves it unchanged (a placeholder in link position
// isn't a valid link target, and the editor escaped it into plain text).
// A ref: link to a page that isn't on this portal renders as "#" with a
// warning, so QA can carry a link PROD doesn't have yet without a broken
// URL.
//
// An image or link to an attachment (/api/v1/attachment/12/view, or
// attachment:12) publishes the file when it is attached to a page on this
// portal, and is "#" with a warning otherwise. Links to other sites open
// in a new tab.
//
// The page HTML comes from the theme's page.html template; see view.
func Render(s Site) (Result, error) {
	r := &renderer{site: s, theme: s.Theme}
	if r.theme == nil {
		t, err := ResolveTheme(ThemeSettings{Base: DefaultThemeKey}, nil)
		if err != nil {
			return Result{}, fmt.Errorf("default theme: %w", err)
		}
		r.theme = t
	}
	return r.render()
}

type renderer struct {
	site    Site
	theme   *Theme
	res     Result
	md      goldmark.Markdown
	top     *node
	all     []*node
	byPath  map[string]*node
	byID    map[int64]*node
	reading []*node
	files   map[int64]string // attachment id → published path
}

func (r *renderer) warn(format string, a ...any) {
	r.res.Warnings = append(r.res.Warnings, fmt.Sprintf(format, a...))
}

func (r *renderer) render() (Result, error) {
	s := r.site
	r.res.Warnings = append(r.res.Warnings, s.Notes...)
	byID := make(map[int64]Page, len(s.Pages))
	kids := map[int64][]Page{}
	for _, p := range s.Pages {
		byID[p.ID] = p
		if !p.Moved {
			kids[p.ParentID] = append(kids[p.ParentID], p)
		}
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
		r.warn("This portal has no root page yet: choose one in Admin → Portals.")
	case !ok:
		if s.RootTitle != "" {
			r.warn("The root page, %q in %q, isn't published to this portal yet.", s.RootTitle, s.RootProject)
		} else {
			r.warn("The root page isn't published to this portal yet.")
		}
		// Pages are here but the root isn't: most likely the root is a
		// different page than the one published (another project's Home).
		if len(s.Pages) > 0 {
			titles := make([]string, 0, len(s.Pages))
			for _, p := range s.Pages {
				titles = append(titles, strconv.Quote(p.Title))
			}
			sort.Strings(titles)
			r.warn("Published here but not under the root page: %s.", strings.Join(titles, ", "))
		}
	}
	if s.RootID == 0 || !ok {
		if err := r.renderEmpty(); err != nil {
			return Result{}, err
		}
		return r.res, nil
	}

	for _, p := range s.Pages {
		if p.Moved {
			r.warn("%q was moved out from under the root page, so it isn't on the site; publish it again where it is now.", p.Title)
		}
	}
	r.place(root, kids)
	r.md = goldmark.New(
		goldmark.WithExtensions(extension.GFM),
		goldmark.WithParserOptions(parser.WithAutoHeadingID()),
	)
	r.files = map[int64]string{}
	for _, n := range r.all {
		if err := r.renderBody(n); err != nil {
			return Result{}, fmt.Errorf("render %q: %w", n.page.Title, err)
		}
	}
	r.reading = r.readingOrder()
	for _, n := range r.all {
		if err := r.renderPages(n); err != nil {
			return Result{}, err
		}
	}
	if err := r.render404(); err != nil {
		return Result{}, err
	}
	r.addThemeFiles()
	r.res.PageCount = len(r.all)
	return r.res, nil
}

// place lays out the site tree below root.
func (r *renderer) place(root Page, kids map[int64][]Page) {
	r.top = &node{page: root}
	r.all = []*node{r.top}
	r.byPath = map[string]*node{"": r.top}
	r.byID = map[int64]*node{root.ID: r.top}
	var place func(n *node)
	place = func(n *node) {
		if n.depth >= maxDepth {
			if len(kids[n.page.ID]) > 0 {
				r.warn("Pages below %q are nested too deep (more than %d levels) and were left out.", n.page.Title, maxDepth)
			}
			return
		}
		used := map[string]bool{}
		for _, c := range kids[n.page.ID] {
			if _, seen := r.byID[c.ID]; seen {
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
				r.warn("%q and a sibling share the path %q; it was published as %q.", c.Title, base, seg)
			}
			used[seg] = true
			p := seg
			if n.path != "" {
				p = n.path + "/" + seg
			}
			child := &node{page: c, path: p, depth: n.depth + 1, parent: n}
			n.children = append(n.children, child)
			r.all = append(r.all, child)
			r.byPath[p] = child
			r.byID[c.ID] = child
			place(child)
		}
	}
	place(r.top)
	var stray []string
	for _, p := range r.site.Pages {
		if _, ok := r.byID[p.ID]; !ok {
			stray = append(stray, fmt.Sprintf("%q", p.Title))
		}
	}
	if len(stray) > 0 {
		sort.Strings(stray)
		r.warn("Published but not reachable from the root page (its parent isn't published here): %s.", strings.Join(stray, ", "))
	}
}

// renderBody renders n's markdown at n's own location, and records its
// headings, summary and first image for the theme.
func (r *renderer) renderBody(n *node) error {
	pageWarn := func(format string, a ...any) {
		r.warn("%s: "+format, append([]any{fmt.Sprintf("%q", n.page.Title)}, a...)...)
	}
	body, err := r.expandPlaceholders(n, pageWarn)
	if err != nil {
		return err
	}
	refs := func(target string) (string, bool) {
		p, frag, _ := strings.Cut(target, "#")
		var to *node
		if id, err := strconv.ParseInt(p, 10, 64); err == nil {
			to = r.byID[id]
		} else {
			to = r.byPath[strings.Trim(p, "/")]
		}
		if to == nil {
			pageWarn("ref:%s doesn't match a page on this portal", target)
			return "", false
		}
		out := to.rootRel()
		if frag != "" {
			out += "#" + frag
		}
		return out, true
	}
	files := func(dest string) (string, bool, bool) {
		id, ok := attachmentID(dest)
		if !ok {
			return "", false, false
		}
		f, ok := r.site.Files[id]
		// Only an attachment on a page placed in this site: a page
		// published here from elsewhere (not under the root) doesn't lend
		// its files to a placed page's body (review A6).
		if _, placed := r.byID[f.CardID]; !ok || !placed {
			pageWarn("%s isn't attached to a page on this portal", dest)
			return "", true, false
		}
		if f.Size > MaxPublishedFileBytes {
			pageWarn("%s (%s) is larger than %d MB and wasn't published", dest, f.Name, MaxPublishedFileBytes>>20)
			return "", true, false
		}
		p, ok := r.files[id]
		if !ok {
			p = "_files/" + strconv.FormatInt(id, 10) + "/" + fileSegment(f.Name)
			r.files[id] = p
			r.res.Attachments = append(r.res.Attachments, FileRef{ID: id, Path: p, MIME: f.MIME, CardID: f.CardID})
		}
		return p, true, true
	}
	out, err := renderMarkdown(r.md, body, n.base(), refs, files)
	if err != nil {
		return err
	}
	n.html, n.headings, n.summary, n.image = out.html, out.headings, out.summary, out.image
	return nil
}

// attachmentID reads an attachment id from /api/v1/attachment/<id>/view
// (or /download, /thumb) or attachment:<id>.
func attachmentID(dest string) (int64, bool) {
	if s, ok := strings.CutPrefix(dest, "attachment:"); ok {
		id, err := strconv.ParseInt(s, 10, 64)
		return id, err == nil && id > 0
	}
	m := attachmentURL.FindStringSubmatch(dest)
	if m == nil {
		return 0, false
	}
	id, err := strconv.ParseInt(m[1], 10, 64)
	return id, err == nil && id > 0
}

var attachmentURL = regexp.MustCompile(`^(?:https?://[^/]+)?/api/v1/attachment/(\d+)/(?:view|download|thumb)(?:[?#].*)?$`)

var fileStrip = regexp.MustCompile(`[^a-z0-9._-]+`)

// fileSegment is a safe file name for a published attachment.
func fileSegment(name string) string {
	s := strings.Trim(fileStrip.ReplaceAllString(strings.ToLower(name), "-"), "-.")
	if len(s) > 80 {
		s = s[len(s)-80:]
	}
	if s == "" {
		s = "file"
	}
	return s
}

// readingOrder is the site in reading order (depth first, as the
// navigation lists it), leaving out pages hidden from navigation.
func (r *renderer) readingOrder() []*node {
	var out []*node
	var walk func(n *node)
	walk = func(n *node) {
		out = append(out, n)
		for _, c := range n.children {
			if !c.page.NavHidden {
				walk(c)
			}
		}
	}
	walk(r.top)
	return out
}

// listed is n's children as the theme lists them (.Children): pages
// hidden from navigation left out, in the theme's order.
func (r *renderer) listed(n *node) []*node {
	var out []*node
	for _, c := range n.children {
		if !c.page.NavHidden {
			out = append(out, c)
		}
	}
	if r.theme.Order == OrderNewest {
		sort.SliceStable(out, func(i, j int) bool {
			return out[i].page.PublishedAt.After(out[j].page.PublishedAt)
		})
	}
	return out
}

// renderPages renders n's page, and the extra pages of its list of child
// pages when the theme pages it.
func (r *renderer) renderPages(n *node) error {
	list := r.listed(n)
	per := r.theme.Paginate
	pages := 1
	if per > 0 && len(list) > per {
		if _, clash := r.byPath[strings.TrimPrefix(n.path+"/page", "/")]; clash {
			r.warn("%q has a child page at %q, so its list of pages wasn't split into pages.", n.page.Title, n.rootRel()+"page/")
		} else {
			pages = int(math.Ceil(float64(len(list)) / float64(per)))
		}
	}
	for k := 1; k <= pages; k++ {
		base := n.base()
		file := filePath(n.path)
		if k > 1 {
			base += "../../"
			file = n.rootRel() + "page/" + strconv.Itoa(k) + "/index.html"
		}
		v := r.pageView(n, base)
		if k == 1 {
			v.Content = template.HTML(n.html)
			v.Headings = n.headings
		}
		items := list
		if pages > 1 {
			lo := (k - 1) * per
			items = list[lo:min(lo+per, len(list))]
		}
		for _, c := range items {
			v.Children = append(v.Children, r.article(c, base))
		}
		if pages > 1 {
			v.Pager = r.pager(n, base, k, pages)
		}
		out, err := r.execute(v)
		if err != nil {
			return fmt.Errorf("theme, page %q: %w", n.page.Title, err)
		}
		r.res.Files = append(r.res.Files, File{Path: file, MIME: "text/html; charset=utf-8", Data: out, CardID: n.page.ID})
	}
	return nil
}

func (r *renderer) pager(n *node, base string, cur, pages int) *pager {
	at := func(k int) string {
		if k == 1 {
			return hrefAt(base, n.rootRel())
		}
		return base + n.rootRel() + "page/" + strconv.Itoa(k) + "/"
	}
	p := &pager{Page: cur, Pages: pages}
	if cur > 1 {
		p.Prev = at(cur - 1)
	}
	if cur < pages {
		p.Next = at(cur + 1)
	}
	for k := 1; k <= pages; k++ {
		p.Links = append(p.Links, pagerLink{Number: k, Href: at(k), Current: k == cur})
	}
	return p
}

// pageView is the template data for node n rendered at base.
func (r *renderer) pageView(n *node, base string) view {
	v := r.siteView(base)
	v.Page = pageInfo{
		Title:  n.page.Title,
		IsHome: n == r.top,
		Kind:   "page",
	}
	if !n.page.PublishedAt.IsZero() {
		v.Page.Published = n.page.PublishedAt.UTC().Format("2 January 2006")
		v.Page.PublishedISO = n.page.PublishedAt.UTC().Format("2006-01-02")
	}
	v.Root.Current = n == r.top
	var chain []*node
	for p := n.parent; p != nil; p = p.parent {
		chain = append([]*node{p}, chain...)
	}
	for _, p := range chain {
		v.Crumbs = append(v.Crumbs, navLink{Title: p.page.Title, Href: hrefAt(base, p.rootRel())})
	}
	v.Nav = r.navItems(r.top.children, n, base)
	for _, it := range v.Nav {
		if it.InPath {
			v.Section = it
		}
	}
	for i, x := range r.reading {
		if x != n {
			continue
		}
		if i > 0 {
			v.Prev = &navLink{Title: r.reading[i-1].page.Title, Href: hrefAt(base, r.reading[i-1].rootRel())}
		}
		if i+1 < len(r.reading) {
			v.Next = &navLink{Title: r.reading[i+1].page.Title, Href: hrefAt(base, r.reading[i+1].rootRel())}
		}
	}
	if n.parent != nil {
		v.Parent = &navLink{Title: n.parent.page.Title, Href: hrefAt(base, n.parent.rootRel())}
	}
	return v
}

// siteView is the part of the template data every page shares.
func (r *renderer) siteView(base string) view {
	v := view{
		Base:  base,
		Theme: base + "_theme/",
		Site:  siteInfo{Title: r.site.Title},
	}
	if lp := r.theme.logoPath(); lp != "" {
		v.Site.Logo = v.Theme + lp
	}
	if ip := r.theme.iconPath(); ip != "" {
		v.Site.Icon = v.Theme + ip
	}
	if r.theme.Footer != "" {
		var buf bytes.Buffer
		if err := footerMarkdown.Convert([]byte(r.theme.Footer), &buf); err == nil {
			v.Site.Footer = template.HTML(buf.String())
		}
	}
	if r.top != nil {
		v.Root = navItem{Title: r.top.page.Title, Href: hrefAt(base, "")}
	} else {
		v.Root = navItem{Title: r.site.Title, Href: hrefAt(base, "")}
	}
	return v
}

var footerMarkdown = goldmark.New(goldmark.WithExtensions(extension.Linkify))

// navItems is the navigation below list, as seen from page cur, with
// links relative to base, pruned to the theme's navigation mode.
func (r *renderer) navItems(list []*node, cur *node, base string) []*navItem {
	var out []*navItem
	for _, c := range list {
		if c.page.NavHidden {
			continue
		}
		inPath := cur != nil && ancestorOrSelf(c, cur)
		it := &navItem{
			Title:   c.page.Title,
			Href:    hrefAt(base, c.rootRel()),
			Current: c == cur,
			InPath:  inPath,
		}
		if !c.page.NavHideChildren {
			for _, g := range c.children {
				if !g.page.NavHidden {
					it.HasChildren = true
					break
				}
			}
		}
		if it.HasChildren && (r.theme.Nav != NavSection || inPath) {
			it.Children = r.navItems(c.children, cur, base)
		}
		it.Open = r.theme.Nav == NavFull || inPath
		it.Collapsible = r.theme.Nav == NavCollapsible && len(it.Children) > 0
		out = append(out, it)
	}
	return out
}

func ancestorOrSelf(a, n *node) bool {
	for x := n; x != nil; x = x.parent {
		if x == a {
			return true
		}
	}
	return false
}

// article is child page c as listed on a page rendered at base.
func (r *renderer) article(c *node, base string) article {
	a := article{
		Title:   c.page.Title,
		Href:    hrefAt(base, c.rootRel()),
		Summary: c.summary,
	}
	for _, g := range c.children {
		if !g.page.NavHidden {
			a.HasChildren = true
			break
		}
	}
	if c.image != "" {
		if isAbsURL(c.image) {
			a.Image = c.image
		} else {
			a.Image = base + c.image
		}
	}
	if !c.page.PublishedAt.IsZero() {
		a.Published = c.page.PublishedAt.UTC().Format("2 January 2006")
		a.PublishedISO = c.page.PublishedAt.UTC().Format("2006-01-02")
	}
	return a
}

// maxPageBytes caps one rendered page: a template that writes without
// end stops at this, as an error (review A20).
const maxPageBytes = 8 << 20

// capWriter is a bytes.Buffer that refuses to grow past max.
type capWriter struct {
	buf bytes.Buffer
	max int
}

func (w *capWriter) Write(p []byte) (int, error) {
	if w.buf.Len()+len(p) > w.max {
		return 0, fmt.Errorf("a page came out larger than %d MB", w.max>>20)
	}
	return w.buf.Write(p)
}

func (r *renderer) execute(v view) ([]byte, error) {
	w := &capWriter{max: maxPageBytes}
	if err := r.theme.tmpl.ExecuteTemplate(w, "page.html", v); err != nil {
		return nil, templateError(err)
	}
	return w.buf.Bytes(), nil
}

// renderEmpty is the build of a portal with nothing to show yet.
func (r *renderer) renderEmpty() error {
	v := r.siteView("")
	v.Page = pageInfo{Title: "Nothing published yet", Kind: "empty", IsHome: true}
	v.Root.Current = true
	v.Content = `<p class="empty">Nothing has been published to this site yet.</p>`
	out, err := r.execute(v)
	if err != nil {
		return fmt.Errorf("theme, empty site: %w", err)
	}
	r.res.Files = append(r.res.Files, File{Path: "index.html", MIME: "text/html; charset=utf-8", Data: out})
	if err := r.render404(); err != nil {
		return err
	}
	r.addThemeFiles()
	return nil
}

// NotFoundBase is replaced, when 404.html is served, with the relative or
// absolute prefix of the site root for the request's path: a 404 can be
// served at any depth, so it can't carry a fixed relative link.
const NotFoundBase = "__KITP_SITE_BASE__"

func (r *renderer) render404() error {
	v := r.siteView(NotFoundBase)
	v.Page = pageInfo{Title: "Page not found", Kind: "notfound"}
	v.Content = `<p class="empty">There's no page at this address. It may have moved, or not be published here.</p>`
	if r.top != nil {
		v.Nav = r.navItems(r.top.children, nil, NotFoundBase)
	}
	out, err := r.execute(v)
	if err != nil {
		return fmt.Errorf("theme, 404 page: %w", err)
	}
	r.res.Files = append(r.res.Files, File{Path: "404.html", MIME: "text/html; charset=utf-8", Data: out})
	return nil
}

// addThemeFiles publishes the theme's files under _theme/.
func (r *renderer) addThemeFiles() {
	paths := make([]string, 0, len(r.theme.assets))
	for p := range r.theme.assets {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for _, p := range paths {
		a := r.theme.assets[p]
		r.res.Files = append(r.res.Files, File{Path: "_theme/" + p, MIME: a.MIME, Data: a.Data, Addr: a.Addr, Size: a.Size})
	}
	r.res.Files = append(r.res.Files, File{Path: "_theme/custom.css", MIME: "text/css; charset=utf-8", Data: r.theme.customCSSFile()})
}

// filePath maps a page path to its file: "" → index.html, "a/b" →
// a/b/index.html.
func filePath(p string) string {
	if p == "" {
		return "index.html"
	}
	return p + "/index.html"
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

// placeholder matches {{< name args >}}.
var placeholder = regexp.MustCompile(`\{\{<\s*([a-z]+)\s*([^>]*?)\s*>\}\}`)

// tocMarker stands in for {{< toc >}} through the markdown pass; it
// renders as its own paragraph, which renderMarkdown swaps for the list.
const tocMarker = "KITPTOCMARKER7f3a"

// expandPlaceholders returns n's body with its placeholders replaced by
// markdown. Placeholders inside code spans and code blocks are skipped, so
// `{{< children >}}` in backticks shows as written.
//
// The page editor's Insert menu and its placeholder warnings use a copy of
// this list (web/src/bundles/placeholders.ts): add a placeholder in both.
func (r *renderer) expandPlaceholders(n *node, warn func(string, ...any)) (string, error) {
	body := n.page.Body
	if len(body) > maxBodyBytes {
		warn("is too large to publish (over %d KB of text); published without its text", maxBodyBytes>>10)
		return "", nil
	}
	code, err := codeRanges(r.md, []byte(body))
	if err != nil {
		return "", err
	}
	var b strings.Builder
	last := 0
	for _, m := range placeholder.FindAllStringSubmatchIndex(body, -1) {
		if inRanges(code, m[0]) {
			continue
		}
		b.WriteString(body[last:m[0]])
		last = m[1]
		name, arg := body[m[2]:m[3]], strings.TrimSpace(body[m[4]:m[5]])
		if b.Len() > maxExpandedBytes {
			warn("its placeholders make it too large to publish (over %d KB); published without its text", maxExpandedBytes>>10)
			return "", nil
		}
		switch name {
		case "children":
			b.WriteString(mdList(n, n.children, 1, false))
		case "nav":
			b.WriteString(mdList(n, r.top.children, maxDepth, true))
		case "toc":
			b.WriteString("\n\n" + tocMarker + "\n\n")
		case "ref":
			// The first slice of portals had a ref placeholder; the editor
			// can't keep it inside a link, so links use ref: now.
			target := strings.Trim(arg, `"' `)
			warn("{{< ref %s >}} isn't supported; link with [text](ref:%s)", arg, target)
			b.WriteString("#")
		default:
			warn("unknown placeholder {{< %s >}}", name)
			b.WriteString(body[m[0]:m[1]])
		}
	}
	b.WriteString(body[last:])
	if b.Len() > maxExpandedBytes {
		warn("its placeholders make it too large to publish (over %d KB); published without its text", maxExpandedBytes>>10)
		return "", nil
	}
	return b.String(), nil
}

// maxBodyBytes caps a page's own text, and maxExpandedBytes what its
// placeholders make of it ({{< nav >}} is the whole site's list each
// time): goldmark builds a page in memory at about 200 bytes per byte of a
// list, so one large page took kitpd down at every build (review
// 2026-11-06 #6). attribute.update and card.insert refuse a page text past
// 512 KB; one stored before that is published empty, with a warning.
const (
	maxBodyBytes     = 1 << 20
	maxExpandedBytes = 2 << 20
)

// span is a half-open byte range of a page body.
type span struct{ start, stop int }

// codeRanges returns the byte ranges of src's code spans and code blocks.
func codeRanges(md goldmark.Markdown, src []byte) ([]span, error) {
	var out []span
	doc := md.Parser().Parse(text.NewReader(src))
	err := ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		switch n.(type) {
		case *ast.CodeSpan:
			for c := n.FirstChild(); c != nil; c = c.NextSibling() {
				if t, ok := c.(*ast.Text); ok {
					out = append(out, span{t.Segment.Start, t.Segment.Stop})
				}
			}
			return ast.WalkSkipChildren, nil
		case *ast.FencedCodeBlock, *ast.CodeBlock:
			lines := n.Lines()
			for i := 0; i < lines.Len(); i++ {
				seg := lines.At(i)
				out = append(out, span{seg.Start, seg.Stop})
			}
			return ast.WalkSkipChildren, nil
		}
		return ast.WalkContinue, nil
	})
	return out, err
}

func inRanges(rs []span, at int) bool {
	for _, r := range rs {
		if at >= r.start && at < r.stop {
			return true
		}
	}
	return false
}

// mdList renders pages as a nested markdown list of links relative to
// page `from`, depth levels deep. inNav leaves out pages hidden from
// navigation and the children of pages that hide theirs.
func mdList(from *node, list []*node, depth int, inNav bool) string {
	var b strings.Builder
	var walk func([]*node, int)
	walk = func(ns []*node, level int) {
		for _, c := range ns {
			if inNav && c.page.NavHidden {
				continue
			}
			b.WriteString(strings.Repeat("  ", level))
			fmt.Fprintf(&b, "- [%s](%s)\n", mdEscape(c.page.Title), hrefAt(from.base(), c.rootRel()))
			if level+1 < depth && !(inNav && c.page.NavHideChildren) {
				walk(c.children, level+1)
			}
		}
	}
	walk(list, 0)
	if b.Len() == 0 {
		return ""
	}
	return "\n\n" + b.String() + "\n"
}

var mdSpecial = strings.NewReplacer(`\`, `\\`, `[`, `\[`, `]`, `\]`, `*`, `\*`, `_`, `\_`, "`", "\\`", `<`, `\<`)

func mdEscape(s string) string { return mdSpecial.Replace(s) }

// rendered is one rendered body.
type rendered struct {
	html     string
	headings []headingView
	summary  string
	image    string
}

// renderMarkdown renders one body for a page at base:
//   - ref: link targets go through refs (target → root-relative URL);
//   - attachment images and links go through files (dest → root-relative
//     published path; isFile says dest named an attachment at all);
//   - links to other sites open in a new tab;
//   - the toc marker becomes a list of the level-2 and level-3 headings.
//
// It also returns the headings, a plain-text summary (the first
// paragraph, at most summaryLen characters) and the first image
// (root-relative or absolute).
func renderMarkdown(md goldmark.Markdown, body, base string,
	refs func(target string) (string, bool),
	files func(dest string) (path string, isFile, ok bool),
) (rendered, error) {
	src := []byte(body)
	doc := md.Parser().Parse(text.NewReader(src))
	var out rendered
	err := ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		switch v := n.(type) {
		case *ast.Link:
			dest := string(v.Destination)
			if target, ok := strings.CutPrefix(dest, "ref:"); ok {
				if p, ok := refs(target); ok {
					v.Destination = []byte(hrefAt(base, p))
				} else {
					v.Destination = []byte("#")
				}
			} else if p, isFile, ok := files(dest); isFile {
				if ok {
					v.Destination = []byte(base + p)
				} else {
					v.Destination = []byte("#")
				}
			} else if strings.HasPrefix(dest, "http://") || strings.HasPrefix(dest, "https://") {
				v.SetAttributeString("target", []byte("_blank"))
				v.SetAttributeString("rel", []byte("noopener noreferrer"))
			}
		case *ast.AutoLink:
			// A bare URL in the text (GFM linkify) is a link to another
			// site like any other: it opens in a new tab — inside the kitp
			// frame it would otherwise navigate the frame.
			if u := string(v.URL(src)); v.AutoLinkType == ast.AutoLinkURL &&
				(strings.HasPrefix(u, "http://") || strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "www.")) {
				v.SetAttributeString("target", []byte("_blank"))
				v.SetAttributeString("rel", []byte("noopener noreferrer"))
			}
		case *ast.Image:
			dest := string(v.Destination)
			if p, isFile, ok := files(dest); isFile {
				if ok {
					v.Destination = []byte(base + p)
					if out.image == "" {
						out.image = p
					}
				} else {
					v.Destination = []byte("#")
				}
			} else if out.image == "" && (strings.HasPrefix(dest, "https://") || strings.HasPrefix(dest, "http://")) {
				out.image = dest
			}
		case *ast.Heading:
			if v.Level >= 2 && v.Level <= 3 {
				id, _ := v.AttributeString("id")
				idb, _ := id.([]byte)
				out.headings = append(out.headings, headingView{Level: v.Level, ID: string(idb), Text: nodeText(v, src)})
			}
		case *ast.Paragraph:
			// The summary is the first top-level paragraph with words in it
			// (a picture's alt text doesn't count).
			if out.summary == "" && n.Parent() == doc {
				if t := strings.Join(strings.Fields(proseText(v, src)), " "); t != "" && t != tocMarker {
					out.summary = truncateWords(t, summaryLen)
				}
			}
		}
		return ast.WalkContinue, nil
	})
	if err != nil {
		return rendered{}, err
	}
	var buf bytes.Buffer
	if err := md.Renderer().Render(&buf, src, doc); err != nil {
		return rendered{}, err
	}
	html := buf.String()
	if strings.Contains(html, tocMarker) {
		var t strings.Builder
		if len(out.headings) > 0 {
			t.WriteString(`<nav class="toc" aria-label="On this page"><ul>`)
			for _, h := range out.headings {
				fmt.Fprintf(&t, `<li class="toc-%d"><a href="#%s">%s</a></li>`, h.Level,
					template.HTMLEscapeString(h.ID), template.HTMLEscapeString(h.Text))
			}
			t.WriteString(`</ul></nav>`)
		}
		html = strings.ReplaceAll(html, "<p>"+tocMarker+"</p>", t.String())
		html = strings.ReplaceAll(html, tocMarker, "")
	}
	out.html = html
	return out, nil
}

// summaryLen caps a page's summary, in characters.
const summaryLen = 240

// truncateWords cuts s to at most n characters at a word boundary.
func truncateWords(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	rs := []rune(s)[:n]
	cut := strings.LastIndexByte(string(rs), ' ')
	out := string(rs)
	if cut > n/2 {
		out = out[:cut]
	}
	return strings.TrimRight(out, " ,.;:") + "…"
}

// proseText is nodeText without images' alt text.
func proseText(n ast.Node, src []byte) string {
	var b strings.Builder
	_ = ast.Walk(n, func(c ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		switch t := c.(type) {
		case *ast.Image:
			return ast.WalkSkipChildren, nil
		case *ast.Text:
			b.Write(t.Segment.Value(src))
			if t.SoftLineBreak() {
				b.WriteByte(' ')
			}
		}
		return ast.WalkContinue, nil
	})
	return b.String()
}

// nodeText concatenates the text segments under n.
func nodeText(n ast.Node, src []byte) string {
	var b strings.Builder
	_ = ast.Walk(n, func(c ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			if t, ok := c.(*ast.Text); ok {
				b.Write(t.Segment.Value(src))
				if t.SoftLineBreak() {
					b.WriteByte(' ')
				}
			}
		}
		return ast.WalkContinue, nil
	})
	return b.String()
}

// view is the data every theme template receives. It is the template
// API: rename nothing without updating every base theme and the help
// topic (admin_themes.md).
type view struct {
	// Site is what every page shares.
	Site siteInfo
	// Page is this page.
	Page pageInfo
	// Base is the relative prefix from this page to the site root ("",
	// "../", …); Theme is Base + "_theme/", where the theme's files are.
	Base  string
	Theme string
	// Root is the home page (Current on the home page).
	Root navItem
	// Content is the page body as HTML (empty on the 2nd, 3rd… page of a
	// paged list).
	Content template.HTML
	// Crumbs are the pages above this one, home first.
	Crumbs []navLink
	// Parent is the page above this one (nil on the home page).
	Parent *navLink
	// Nav is the home page's children, pruned to the navigation mode.
	Nav []*navItem
	// Section is the top-level Nav item this page is under (nil on the
	// home page).
	Section *navItem
	// Children are this page's child pages (this page of them, when the
	// theme pages its lists), in the theme's order, with summaries.
	Children []article
	// Pager is set when the list of child pages is split into pages.
	Pager *pager
	// Prev and Next are the neighbouring pages in reading order.
	Prev, Next *navLink
	// Headings are the page's level-2 and level-3 headings.
	Headings []headingView
}

type siteInfo struct {
	Title string
	// Logo and Icon are URLs of the theme's logo.* / favicon.*; "" = none.
	Logo, Icon string
	// Footer is the theme's footer, rendered from markdown.
	Footer template.HTML
}

type pageInfo struct {
	Title  string
	IsHome bool
	// Kind is "page", "notfound" (the 404 page) or "empty" (a site with
	// nothing published yet).
	Kind string
	// Published is the date this copy was published ("2 January 2006");
	// PublishedISO the same as 2006-01-02.
	Published, PublishedISO string
}

type navLink struct {
	Title, Href string
}

type navItem struct {
	Title, Href string
	// Current marks this page; InPath this page and the pages above it.
	Current, InPath bool
	// HasChildren: the page has child pages in the navigation, whether or
	// not Children lists them (the "section" mode lists only the current
	// branch's).
	HasChildren bool
	// Open: show the branch open; Collapsible: draw it as a
	// <details> the reader can open and close.
	Open, Collapsible bool
	Children          []*navItem
}

type article struct {
	Title, Href string
	// Summary is the page's first paragraph as plain text, shortened.
	Summary string
	// Image is the URL of the page's first image; "" = none.
	Image                   string
	Published, PublishedISO string
	HasChildren             bool
}

type pager struct {
	Page, Pages int
	// Prev / Next are "" on the first / last page.
	Prev, Next string
	Links      []pagerLink
}

type pagerLink struct {
	Number  int
	Href    string
	Current bool
}

type headingView struct {
	Level int
	ID    string
	Text  string
}
