package portal

import (
	"bytes"
	"errors"
	"fmt"

	"github.com/yuin/goldmark"
	gast "github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	grenderer "github.com/yuin/goldmark/renderer"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

// What a page's markdown may make. The text caps (maxBodyBytes,
// maxExpandedBytes) count bytes of markdown, but a GFM table pads every row
// to its header's width, so a 5 KB body of 1,000 header cells and 1,000
// one-word rows is a million cells: hundreds of MB of syntax tree, and a
// 15 KB one took kitpd past its memory limit (review 2026-11-06 round 8
// #7). A table past these limits isn't made a table: it shows as the text
// it was written as, with a warning.
const (
	// maxTableColumns caps one table's columns.
	maxTableColumns = 64
	// maxTableCells caps the cells of all the tables on one page.
	maxTableCells = 50_000
	// maxBodyHTMLBytes caps one page's text as HTML; a page past it is
	// published without its text, with a warning.
	maxBodyHTMLBytes = 4 << 20
)

// maxSiteTextBytes caps the pages' text, as HTML, over the whole site: the
// build holds every page in memory until it is stored. Pages past it are
// published without their text, with a warning. A var for the tests.
var maxSiteTextBytes = 128 << 20

// errTooLarge is what a capWriter answers once it is full.
var errTooLarge = errors.New("too large")

// newMarkdown is GFM (linkify, tables, strikethrough, task lists) with the
// tables capped, and heading ids.
func newMarkdown() goldmark.Markdown {
	return goldmark.New(
		goldmark.WithExtensions(extension.Linkify, cappedTables{}, extension.Strikethrough, extension.TaskList),
		goldmark.WithParserOptions(parser.WithAutoHeadingID()),
	)
}

// parseMarkdown parses src with a fresh table budget, and says whether a
// table was left as text for passing the limits.
func parseMarkdown(md goldmark.Markdown, src []byte) (gast.Node, bool) {
	pc := parser.NewContext()
	doc := md.Parser().Parse(text.NewReader(src), parser.WithContext(pc))
	b, _ := pc.Get(tableBudgetKey).(*tableBudget)
	return doc, b != nil && b.refused
}

// cappedTables is goldmark's table extension behind a size check.
type cappedTables struct{}

func (cappedTables) Extend(m goldmark.Markdown) {
	m.Parser().AddOptions(
		parser.WithParagraphTransformers(
			util.Prioritized(cappedTableTransformer{inner: extension.NewTableParagraphTransformer()}, 200),
		),
		parser.WithASTTransformers(
			util.Prioritized(extension.NewTableASTTransformer(), 0),
		),
	)
	m.Renderer().AddOptions(grenderer.WithNodeRenderers(
		util.Prioritized(extension.NewTableHTMLRenderer(), 500),
	))
}

var tableBudgetKey = parser.NewContextKey()

// tableBudget is what one parse has left of maxTableCells.
type tableBudget struct {
	left    int
	refused bool
}

type cappedTableTransformer struct{ inner parser.ParagraphTransformer }

// Transform hands the paragraph to goldmark's table transformer only when
// the table it could make is within the limits. It doesn't parse the table
// the way goldmark does; it bounds it: goldmark makes at most one table of
// a paragraph, its header and delimiter rows are two of the paragraph's
// lines, every later line is a row, and a row has as many cells as the
// delimiter row has columns (delimColumns of a line that could be one).
func (t cappedTableTransformer) Transform(node *gast.Paragraph, reader text.Reader, pc parser.Context) {
	lines := node.Lines()
	n := lines.Len()
	if n < 2 {
		return
	}
	src := reader.Source()
	first, cols := -1, 0
	for i := 1; i < n; i++ {
		seg := lines.At(i)
		line := seg.Value(src)
		if !mayBeTableDelim(line) {
			continue
		}
		if first < 0 {
			first = i
		}
		cols = max(cols, delimColumns(line))
	}
	if first < 0 {
		return // no table here
	}
	b, _ := pc.Get(tableBudgetKey).(*tableBudget)
	if b == nil {
		b = &tableBudget{left: maxTableCells}
		pc.Set(tableBudgetKey, b)
	}
	cells := cols * (n - first + 1)
	if cols > maxTableColumns || cells > b.left {
		b.refused = true
		return
	}
	b.left -= cells
	t.inner.Transform(node, reader, pc)
}

// mayBeTableDelim is true of every line goldmark could take as a table's
// delimiter row (and of some it wouldn't): only spaces, '-', '|' and ':'.
func mayBeTableDelim(line []byte) bool {
	dash := false
	for _, c := range line {
		switch {
		case c == '-':
			dash = true
		case c == '|' || c == ':' || util.IsSpace(c):
		default:
			return false
		}
	}
	return dash
}

// delimColumns is at least the columns goldmark reads from a delimiter
// row: one more than the '|'s between its first and last cells (a leading
// and a trailing '|' only bound cells).
func delimColumns(line []byte) int {
	line = bytes.TrimFunc(line, func(r rune) bool { return r < 0x80 && util.IsSpace(byte(r)) })
	line = bytes.TrimPrefix(line, []byte{'|'})
	line = bytes.TrimSuffix(line, []byte{'|'})
	return bytes.Count(line, []byte{'|'}) + 1
}

// tooLargeTableWarning is the warning for a page whose table was left as
// text.
func tooLargeTableWarning() string {
	return fmt.Sprintf("has a table too large to publish (more than %d columns, or %d cells on the page); it shows as text",
		maxTableColumns, maxTableCells)
}
