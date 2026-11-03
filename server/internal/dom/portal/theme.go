package portal

import (
	"bytes"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io/fs"
	"mime"
	"path"
	"regexp"
	"sort"
	"strings"
	"text/template/parse"
)

// A THEME decides what a portal's pages look like. The server ships a set
// of BASE themes (themes/<key>/, compiled in and read-only); a `theme`
// card picks one as its base, sets a few options (navigation mode, accent
// colour, footer) and may add or override any of the base's files with
// its own (theme_file rows): a template, the stylesheet, a logo, a font.
// That is how a theme is forked: copy a base file, change it, save it as
// the theme's own.
//
// A theme is a set of files:
//
//   - page.html (required) — the html/template every page is rendered
//     with. Other *.html files are parsed into the same template set (a
//     file of {{define "footer"}}…{{end}} blocks overrides those blocks).
//     Templates are never published.
//   - theme.json — options: {"name", "description", "nav", "paginate",
//     "order"} (see themeOptions). A theme card's own theme.json overrides
//     the base's keys it sets.
//   - everything else (site.css, images, fonts) is published under
//     _theme/ in each build. custom.css is special: the build publishes
//     _theme/custom.css as the accent colour plus the theme's custom.css,
//     so templates can link it unconditionally. logo.* and favicon.* set
//     .Site.Logo / .Site.Icon.
//
// The data every template receives is the `view` type below.

//go:embed themes
var themeFS embed.FS

// Navigation modes (theme.json "nav", theme_nav).
const (
	NavFull        = "full"        // the whole tree, every branch open
	NavSection     = "section"     // the top level, plus the branch down to the current page
	NavCollapsible = "collapsible" // the whole tree, closed except along the current page
)

// List orders (theme.json "order").
const (
	OrderSite   = "site"   // sort order, then title (the site tree's order)
	OrderNewest = "newest" // most recently published first
)

// DefaultThemeKey is the base theme a portal without a theme card uses.
const DefaultThemeKey = "sidebar"

// MaxThemeFileBytes caps one theme file.
const MaxThemeFileBytes = 5 << 20

// themeOptions is theme.json.
type themeOptions struct {
	Name        string `json:"name,omitempty"`
	Description string `json:"description,omitempty"`
	// Nav is the default navigation mode.
	Nav string `json:"nav,omitempty"`
	// Paginate splits a page's list of child pages (.Children) into pages
	// of this many, published at <page>/page/2/ and so on; 0 lists them
	// all on the page.
	Paginate *int `json:"paginate,omitempty"`
	// Order is how .Children is sorted.
	Order string `json:"order,omitempty"`
}

// BaseTheme is one of the themes compiled into the server.
type BaseTheme struct {
	Key         string
	Name        string
	Description string
	Nav         string
	Paginate    int
	Order       string
	// Files maps a path ("page.html", "site.css") to its bytes.
	Files map[string][]byte
}

// baseThemeOrder is the order the Themes screen lists the base themes in.
var baseThemeOrder = []string{"sidebar", "topbar", "newspaper", "book", "helpcenter", "blog", "reference"}

var baseThemes = mustLoadBaseThemes()

func mustLoadBaseThemes() map[string]*BaseTheme {
	out := map[string]*BaseTheme{}
	for _, key := range baseThemeOrder {
		bt := &BaseTheme{Key: key, Files: map[string][]byte{}}
		root := "themes/" + key
		err := fs.WalkDir(themeFS, root, func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			data, err := themeFS.ReadFile(p)
			if err != nil {
				return err
			}
			bt.Files[strings.TrimPrefix(p, root+"/")] = data
			return nil
		})
		if err != nil {
			panic(fmt.Sprintf("portal: base theme %s: %v", key, err))
		}
		var opts themeOptions
		if err := json.Unmarshal(bt.Files["theme.json"], &opts); err != nil {
			panic(fmt.Sprintf("portal: base theme %s: theme.json: %v", key, err))
		}
		bt.Name, bt.Description, bt.Nav, bt.Order = opts.Name, opts.Description, opts.Nav, opts.Order
		if opts.Paginate != nil {
			bt.Paginate = *opts.Paginate
		}
		if bt.Name == "" || bt.Files["page.html"] == nil || !validNav(bt.Nav) || !validOrder(bt.Order) {
			panic(fmt.Sprintf("portal: base theme %s: needs a name, page.html, a nav mode and an order", key))
		}
		out[key] = bt
	}
	return out
}

// BaseThemes lists the built-in themes in display order.
func BaseThemes() []*BaseTheme {
	out := make([]*BaseTheme, 0, len(baseThemeOrder))
	for _, k := range baseThemeOrder {
		out = append(out, baseThemes[k])
	}
	return out
}

// LookupBaseTheme returns the built-in theme with key, or nil.
func LookupBaseTheme(key string) *BaseTheme { return baseThemes[key] }

func validNav(n string) bool {
	return n == NavFull || n == NavSection || n == NavCollapsible
}

func validOrder(o string) bool { return o == OrderSite || o == OrderNewest }

// FilePaths lists a base theme's files, sorted.
func (b *BaseTheme) FilePaths() []string {
	out := make([]string, 0, len(b.Files))
	for p := range b.Files {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

// ThemeFile is one of a theme card's own files. Data holds the bytes when
// they are needed (templates, theme.json, custom.css); Addr is the CAS
// blob, which a build publishes without reading.
type ThemeFile struct {
	Path string
	MIME string
	Addr string
	Size int64
	Data []byte
}

// ThemeSettings is a theme card's options.
type ThemeSettings struct {
	Base   string
	Nav    string // "" = the theme's default
	Accent string // "" = the stylesheet's own
	Footer string // markdown; "" = none
}

// Theme is a resolved theme: a base, a theme card's settings and files.
type Theme struct {
	Key      string
	Nav      string
	Paginate int
	Order    string
	Accent   string
	Footer   string
	tmpl     *template.Template
	// assets are the published files (not templates, not theme.json),
	// by path; custom.css is handled separately.
	assets    map[string]ThemeFile
	customCSS []byte
}

// ResolveTheme combines a base theme with a theme card's settings and
// files, and parses its templates. An unknown base falls back to the
// default theme (the error says so; the caller decides whether that's a
// warning or a refusal).
func ResolveTheme(set ThemeSettings, own []ThemeFile) (*Theme, error) {
	var warnErr error
	base := LookupBaseTheme(set.Base)
	if base == nil {
		if set.Base != "" {
			warnErr = fmt.Errorf("theme base %q isn't a built-in theme; using %q", set.Base, DefaultThemeKey)
		}
		base = baseThemes[DefaultThemeKey]
	}
	t := &Theme{
		Key: base.Key, Nav: base.Nav, Paginate: base.Paginate, Order: base.Order,
		Accent: set.Accent, Footer: set.Footer,
		assets: map[string]ThemeFile{},
	}
	templates := map[string][]byte{}
	for p, data := range base.Files {
		switch {
		case p == "theme.json":
		case p == "custom.css":
			t.customCSS = data
		case strings.HasSuffix(p, ".html"):
			templates[p] = data
		default:
			t.assets[p] = ThemeFile{Path: p, MIME: mimeFor(p), Data: data}
		}
	}
	for _, f := range own {
		switch {
		case f.Path == "theme.json":
			var opts themeOptions
			if err := json.Unmarshal(f.Data, &opts); err != nil {
				return nil, fmt.Errorf("theme.json: %w", err)
			}
			if opts.Nav != "" {
				t.Nav = opts.Nav
			}
			if opts.Order != "" {
				t.Order = opts.Order
			}
			if opts.Paginate != nil {
				t.Paginate = *opts.Paginate
			}
		case f.Path == "custom.css":
			t.customCSS = f.Data
		case strings.HasSuffix(f.Path, ".html"):
			templates[f.Path] = f.Data
		default:
			t.assets[f.Path] = f
		}
	}
	if set.Nav != "" {
		t.Nav = set.Nav
	}
	if !validNav(t.Nav) {
		return nil, fmt.Errorf("theme.json: nav %q is not one of full, section, collapsible", t.Nav)
	}
	if !validOrder(t.Order) {
		return nil, fmt.Errorf("theme.json: order %q is not one of site, newest", t.Order)
	}
	if t.Paginate < 0 || t.Paginate > 500 {
		return nil, fmt.Errorf("theme.json: paginate %d is not between 0 and 500", t.Paginate)
	}
	tmpl, err := parseTemplates(templates)
	if err != nil {
		return nil, err
	}
	t.tmpl = tmpl
	return t, warnErr
}

// parseTemplates parses page.html first, then the other templates by path,
// into one set: a later file's {{define}} replaces an earlier block.
func parseTemplates(files map[string][]byte) (*template.Template, error) {
	page, ok := files["page.html"]
	if !ok {
		return nil, errors.New("the theme has no page.html")
	}
	t, err := template.New("page.html").Parse(string(page))
	if err != nil {
		return nil, templateError(err)
	}
	var rest []string
	for p := range files {
		if p != "page.html" {
			rest = append(rest, p)
		}
	}
	sort.Strings(rest)
	for _, p := range rest {
		if _, err := t.New(p).Parse(string(files[p])); err != nil {
			return nil, templateError(err)
		}
	}
	if err := checkTemplateSafety(t, files); err != nil {
		return nil, err
	}
	return t, nil
}

// maxRangeLiteral caps {{range N}} over a number literal: a site's own
// data bounds every other loop, but {{range 1000000000}} would spin a
// build (and file_put's sample render) for minutes.
const maxRangeLiteral = 10000

var (
	scriptTag     = regexp.MustCompile(`(?i)<\s*script\b`)
	eventHandler  = regexp.MustCompile(`(?i)<[^>]*\son[a-z]+\s*=`)
	javascriptURL = regexp.MustCompile(`(?i)javascript\s*:`)
)

// checkTemplateSafety refuses what a published page must not carry, so the
// CSP isn't the only thing keeping script off a site (review A20): a
// <script> tag, an on…= event handler, a javascript: URL, or a {{range}}
// over a number literal above maxRangeLiteral.
func checkTemplateSafety(t *template.Template, files map[string][]byte) error {
	var names []string
	for p := range files {
		names = append(names, p)
	}
	sort.Strings(names)
	for _, p := range names {
		src := files[p]
		switch {
		case scriptTag.Match(src):
			return fmt.Errorf("%s: templates can't hold <script>: a published page runs no script", p)
		case eventHandler.Match(src):
			return fmt.Errorf("%s: templates can't hold on… event handlers: a published page runs no script", p)
		case javascriptURL.Match(src):
			return fmt.Errorf("%s: templates can't hold javascript: links", p)
		}
	}
	for _, tt := range t.Templates() {
		if tt.Tree == nil || tt.Tree.Root == nil {
			continue
		}
		if err := checkRanges(tt.Name(), tt.Tree.Root); err != nil {
			return err
		}
	}
	return nil
}

// checkRanges walks a template's parse tree for {{range N}} over a number
// literal above maxRangeLiteral.
func checkRanges(name string, n parse.Node) error {
	switch x := n.(type) {
	case *parse.ListNode:
		if x == nil {
			return nil
		}
		for _, c := range x.Nodes {
			if err := checkRanges(name, c); err != nil {
				return err
			}
		}
	case *parse.RangeNode:
		if x.Pipe != nil {
			for _, cmd := range x.Pipe.Cmds {
				for _, arg := range cmd.Args {
					if num, ok := arg.(*parse.NumberNode); ok && (!num.IsInt || num.Int64 > maxRangeLiteral) {
						return fmt.Errorf("%s: {{range}} over a number can go up to %d", name, maxRangeLiteral)
					}
				}
			}
		}
		if err := checkRanges(name, x.List); err != nil {
			return err
		}
		return checkRanges(name, x.ElseList)
	case *parse.IfNode:
		if err := checkRanges(name, x.List); err != nil {
			return err
		}
		return checkRanges(name, x.ElseList)
	case *parse.WithNode:
		if err := checkRanges(name, x.List); err != nil {
			return err
		}
		return checkRanges(name, x.ElseList)
	}
	return nil
}

// templateError trims html/template's "html/template:" prefix; the rest
// ("page.html:12: unexpected …") already names the file and line.
func templateError(err error) error {
	msg := strings.TrimPrefix(err.Error(), "html/template:")
	msg = strings.TrimPrefix(strings.TrimSpace(msg), "template: ")
	return errors.New(msg)
}

// logoPath / iconPath are the published logo and favicon, if any.
func (t *Theme) logoPath() string {
	return t.findAsset("logo", ".svg", ".png", ".webp", ".jpg", ".jpeg", ".gif")
}
func (t *Theme) iconPath() string { return t.findAsset("favicon", ".svg", ".png", ".ico") }

func (t *Theme) findAsset(stem string, exts ...string) string {
	for _, e := range exts {
		if _, ok := t.assets[stem+e]; ok {
			return stem + e
		}
	}
	return ""
}

// customCSSFile is _theme/custom.css: the accent colour, then the theme's
// custom.css.
func (t *Theme) customCSSFile() []byte {
	var b bytes.Buffer
	b.WriteString("/* Generated by kitp: the theme's accent colour, then its custom.css. */\n")
	if t.Accent != "" {
		fmt.Fprintf(&b, ":root { --accent: %s; }\n", t.Accent)
	}
	b.Write(t.customCSS)
	return b.Bytes()
}

// ThemePathError explains why path can't name a theme file ("" = it can).
func ThemePathError(p string) string {
	switch {
	case p == "":
		return "a file needs a name"
	case len(p) > 120:
		return "file names are at most 120 characters"
	case !themePath.MatchString(p):
		return "use lower-case letters, digits, '-', '_' and '.', with '/' between folders"
	case strings.Contains(p, ".."), strings.HasPrefix(p, "."), strings.Contains(p, "/."):
		return "file and folder names can't start with '.'"
	case path.Ext(p) == "":
		return "a file name needs an extension, like .css or .png"
	}
	if _, ok := themeMIME[path.Ext(p)]; !ok {
		return "kitp doesn't publish " + path.Ext(p) + " files: use .html, .css, .json, .svg, .png, .jpg, .webp, .gif, .ico, .woff2, .woff, .ttf, .otf or .txt"
	}
	return ""
}

var themePath = regexp.MustCompile(`^[a-z0-9_.-]+(/[a-z0-9_.-]+)*$`)

// themeMIME is every extension a theme may hold, with the type it is
// served as. Scripts aren't on it: portal pages run no script.
var themeMIME = map[string]string{
	".html":  "text/html; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".json":  "application/json",
	".txt":   "text/plain; charset=utf-8",
	".svg":   "image/svg+xml",
	".png":   "image/png",
	".jpg":   "image/jpeg",
	".jpeg":  "image/jpeg",
	".webp":  "image/webp",
	".gif":   "image/gif",
	".ico":   "image/x-icon",
	".woff2": "font/woff2",
	".woff":  "font/woff",
	".ttf":   "font/ttf",
	".otf":   "font/otf",
}

// mimeFor is the type a theme file is served as.
func mimeFor(p string) string {
	if m, ok := themeMIME[path.Ext(p)]; ok {
		return m
	}
	if m := mime.TypeByExtension(path.Ext(p)); m != "" {
		return m
	}
	return "application/octet-stream"
}

// MIMEForThemePath is mimeFor for the theme handlers.
func MIMEForThemePath(p string) string { return mimeFor(p) }

// IsTextThemeFile reports whether a theme file is text (shown and edited
// as text in the Themes screen) rather than an image or font.
func IsTextThemeFile(p string) bool {
	switch path.Ext(p) {
	case ".html", ".css", ".json", ".txt", ".svg":
		return true
	}
	return false
}
