// Package mailmd converts inbound email bodies into Markdown suitable for
// a card's `description` field (which the web client renders through the
// ProseMirror/markdown-it sink).
//
// Two entry points:
//
//   - FromText — a plain-text body. The motivating bug: markdown-it (the
//     renderer) treats a single "\n" as a SOFT break and collapses it to a
//     space, so a plain-text email that relied on line breaks renders as
//     one run-on paragraph. FromText preserves the sender's line breaks by
//     emitting hard breaks (two trailing spaces) between adjacent non-blank
//     lines, keeps blank lines as paragraph separators, and escapes the
//     characters that would otherwise be interpreted as Markdown so the text
//     renders verbatim.
//
//   - FromHTML — an HTML body. An intentionally APPROXIMATE conversion: we
//     parse the document with golang.org/x/net/html and walk it, mapping the
//     common structural + inline elements (headings, lists, blockquotes,
//     emphasis, links, code, images, rules, line breaks) onto their Markdown
//     equivalents. Anything we don't recognise degrades to its inline text.
//     This is a best-effort "make the initial description readable" pass, not
//     a faithful round-trip; the data-table tests in mailmd_test.go document
//     where the edges are.
//
// Both functions are pure (no I/O), so they are cheap to unit test in a
// table-driven style and safe to call from the IMAP ingest path.
package mailmd

import (
	"regexp"
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// FromText converts a plain-text email body to Markdown that renders with
// the line breaks the sender intended. The transformation, in order:
//
//  1. Normalise CRLF / CR to LF.
//  2. Strip trailing whitespace from each line (so a stray "  " in the
//     source doesn't become an unintended hard break of our own making).
//  3. Escape Markdown-significant characters so the text renders literally.
//  4. Join adjacent non-blank lines with a hard break ("  \n"); keep blank
//     lines as paragraph separators and preserve a wider vertical gap (2+
//     blank lines in a row) as &nbsp; spacer paragraphs — a lone blank line
//     between blocks renders as the usual paragraph break, but extra blank
//     lines would otherwise collapse away, so each extra one becomes an
//     &nbsp;-only paragraph (the only Markdown construct this editor renders
//     as a durable gap; see expandBlankRuns).
func FromText(s string) string {
	s = normalizeNewlines(s)
	lines := strings.Split(s, "\n")
	for i, ln := range lines {
		lines[i] = escapeLine(strings.TrimRight(ln, " \t"))
	}

	var b strings.Builder
	for i, ln := range lines {
		b.WriteString(ln)
		if i == len(lines)-1 {
			break
		}
		// A hard break only makes sense between two lines that both carry
		// content. A blank on either side is a paragraph boundary, which a
		// bare "\n" already expresses.
		if ln != "" && lines[i+1] != "" {
			b.WriteString("  \n")
		} else {
			b.WriteString("\n")
		}
	}

	return expandBlankRuns(strings.TrimSpace(b.String()))
}

// FromHTML converts an HTML email body to approximate Markdown. See the
// package doc for the scope; unknown elements fall through to their text.
func FromHTML(s string) string {
	doc, err := html.Parse(strings.NewReader(s))
	if err != nil {
		// html.Parse only errors on a read failure from the reader, which a
		// strings.Reader never produces — but if it ever did, fall back to the
		// plain-text path rather than dropping the body entirely.
		return FromText(s)
	}
	body := findBody(doc)
	if body == nil {
		body = doc
	}
	md := renderBlocks(body, "")
	return strings.TrimSpace(collapseBlankRuns(md))
}

// ---- plain-text helpers ----

func normalizeNewlines(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	return s
}

var blankRunRegexp = regexp.MustCompile(`\n{3,}`)

// collapseBlankRuns reduces any run of 3+ newlines (2+ blank lines) to a
// single blank line so paragraph spacing stays uniform. Used by the HTML
// path, where extra blank lines are layout noise rather than intent.
func collapseBlankRuns(s string) string {
	return blankRunRegexp.ReplaceAllString(s, "\n\n")
}

// nbspSpacer is an &nbsp;-only paragraph: the one Markdown construct this
// editor renders as a durable empty paragraph (a vertical gap) and that also
// survives an edit round-trip — markdown-it decodes the entity to U+00A0, the
// schema keeps the one-char paragraph, and it serialises back to a stable
// fixed point. A run of plain blank lines, by contrast, collapses on render.
const nbspSpacer = "&nbsp;"

// maxSpacerParagraphs caps the spacers emitted for one blank-line run so a
// pathological inbound message (thousands of blank lines) can't bloat the
// stored description.
const maxSpacerParagraphs = 10

// expandBlankRuns turns each run of 3+ newlines (a vertical gap wider than one
// paragraph break) into a paragraph break plus one &nbsp; spacer paragraph per
// extra blank line, so the sender's intentional vertical spacing renders
// instead of collapsing. A plain "\n\n" (one blank line) is left untouched.
func expandBlankRuns(s string) string {
	return blankRunRegexp.ReplaceAllStringFunc(s, func(run string) string {
		// run is K>=3 newlines, i.e. K-1 blank lines. One blank line is the
		// ordinary paragraph break; the remaining K-2 become spacer paragraphs.
		spacers := len(run) - 2
		if spacers > maxSpacerParagraphs {
			spacers = maxSpacerParagraphs
		}
		var b strings.Builder
		b.WriteString("\n\n")
		for i := 0; i < spacers; i++ {
			b.WriteString(nbspSpacer)
			b.WriteString("\n\n")
		}
		return b.String()
	})
}

// inlineEscaper backslash-escapes the characters that carry inline Markdown
// meaning anywhere on a line. Block-level markers that only matter at the
// start of a line (#, >, -, +, ordered-list numerals) are handled separately
// by escapeLine so we don't disfigure mid-line hyphens and dots.
var inlineEscaper = strings.NewReplacer(
	`\`, `\\`,
	"`", "\\`",
	`*`, `\*`,
	`_`, `\_`,
	`[`, `\[`,
	`]`, `\]`,
	`<`, `\<`, // would otherwise open an autolink / inert raw-HTML run
)

// escapeLine escapes a single line so it renders as literal text. Inline
// markers are escaped everywhere; block markers only where they'd start a
// block (leading position, after at most 3 spaces of indent).
//
// What is allowed through as Markdown vs. neutralised:
//   - Numbered lists ("1.", "2)") pass through — an enumerated line is almost
//     always a real list and reads better rendered as one.
//   - '-' bullets pass through anywhere ('-' isn't inline-escaped; a bare
//     hyphen rarely causes trouble).
//   - '*' bullets pass through ONLY at line start ("* x", with ≤3 spaces of
//     indent); every other '*' is escaped, so *emphasis* and "3*4" stay
//     literal text.
//   - '+' bullets ARE escaped — '+' collides with ordinary prose ("+1") far
//     more often than it signals an intended list.
//   - Headings ('#') and blockquotes ('>') are escaped, so a line that merely
//     starts with those punctuation marks stays literal text.
func escapeLine(line string) string {
	if line == "" {
		return ""
	}
	// Leading whitespace is never altered by escaping, so the indent computed
	// on the raw line also describes the escaped line.
	indent := line[:len(line)-len(strings.TrimLeft(line, " "))]
	rest := line[len(indent):]

	// '*' bullet: the one place a '*' passes through. Keep the marker literal
	// but still inline-escape the item text. Only applies within the 3-space
	// indent window; beyond that the line is an indented code block, not a
	// list, so it falls through to plain escaping below.
	if len(indent) <= 3 {
		if rest == "*" {
			return indent + "*"
		}
		if strings.HasPrefix(rest, "* ") {
			return indent + "* " + inlineEscaper.Replace(rest[2:])
		}
	}

	escaped := inlineEscaper.Replace(rest)
	// A 4+ space indent starts an indented code block (a documented
	// limitation — see the tests); no line-start marker handling applies.
	if len(indent) > 3 {
		return indent + escaped
	}
	switch {
	case strings.HasPrefix(escaped, "#"):
		// ATX heading: 1–6 '#' then space or end.
		h := escaped[:len(escaped)-len(strings.TrimLeft(escaped, "#"))]
		if len(h) <= 6 {
			after := escaped[len(h):]
			if after == "" || strings.HasPrefix(after, " ") {
				return indent + `\` + escaped
			}
		}
	case strings.HasPrefix(escaped, ">"):
		return indent + `\` + escaped
	case strings.HasPrefix(escaped, "+ "), escaped == "+":
		return indent + `\` + escaped
	}
	return indent + escaped
}

// ---- HTML helpers ----

func findBody(n *html.Node) *html.Node {
	if n.Type == html.ElementNode && n.DataAtom == atom.Body {
		return n
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if b := findBody(c); b != nil {
			return b
		}
	}
	return nil
}

// renderBlocks renders the block-level content of n. Inline children are
// gathered into paragraphs; block children render to their own units. Blocks
// are joined with a blank line. linePrefix is prepended to every produced
// line (used to nest blockquotes / list item continuations).
func renderBlocks(n *html.Node, linePrefix string) string {
	var blocks []string
	var inline strings.Builder
	flush := func() {
		text := finalizeInline(inline.String())
		inline.Reset()
		if text != "" {
			blocks = append(blocks, text)
		}
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if isBlockElement(c) {
			flush()
			if blk := renderBlockElement(c); blk != "" {
				blocks = append(blocks, blk)
			}
			continue
		}
		inline.WriteString(renderInline(c))
	}
	flush()

	joined := strings.Join(blocks, "\n\n")
	if linePrefix == "" {
		return joined
	}
	return applyLinePrefix(joined, linePrefix)
}

// renderBlockElement renders one block-level element to its Markdown unit
// (no surrounding blank lines — the caller joins units).
func renderBlockElement(n *html.Node) string {
	switch n.DataAtom {
	case atom.H1, atom.H2, atom.H3, atom.H4, atom.H5, atom.H6:
		return strings.Repeat("#", headingLevel(n.DataAtom)) + " " + finalizeInline(renderInlineChildren(n))
	case atom.Br:
		return ""
	case atom.Hr:
		return "---"
	case atom.Pre:
		// Fence with a backtick run longer than anything inside the block, so
		// content that itself contains a ``` fence can't terminate ours early.
		content := strings.Trim(rawText(n), "\n")
		fence := backtickFence(content)
		return fence + "\n" + content + "\n" + fence
	case atom.Blockquote:
		inner := renderBlocks(n, "")
		return applyLinePrefix(inner, "> ")
	case atom.Ul:
		return renderList(n, false)
	case atom.Ol:
		return renderList(n, true)
	case atom.Table:
		return renderTable(n)
	default:
		// p, div, section, article, header, footer, li-at-top-level, … —
		// render their children as blocks (which may themselves be mixed
		// inline + block content).
		return renderBlocks(n, "")
	}
}

func headingLevel(a atom.Atom) int {
	switch a {
	case atom.H1:
		return 1
	case atom.H2:
		return 2
	case atom.H3:
		return 3
	case atom.H4:
		return 4
	case atom.H5:
		return 5
	default:
		return 6
	}
}

// renderList renders a <ul>/<ol>. Ordered lists number from 1 (or the <ol>'s
// start attribute, if present and valid). Nested lists indent by 3 spaces so
// they sit under the marker.
func renderList(n *html.Node, ordered bool) string {
	idx := listStart(n, ordered)
	var items []string
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type != html.ElementNode || c.DataAtom != atom.Li {
			continue
		}
		marker := "- "
		if ordered {
			marker = itoa(idx) + ". "
			idx++
		}
		content := renderBlocks(c, "")
		items = append(items, hangingIndent(marker, content))
	}
	return strings.Join(items, "\n")
}

// hangingIndent prefixes the first line of content with marker and indents
// every continuation line by len(marker) spaces, so multi-line / nested list
// items stay visually under their marker.
func hangingIndent(marker, content string) string {
	pad := strings.Repeat(" ", len(marker))
	lines := strings.Split(content, "\n")
	for i, ln := range lines {
		if i == 0 {
			lines[i] = marker + ln
		} else if ln == "" {
			lines[i] = ""
		} else {
			lines[i] = pad + ln
		}
	}
	return strings.Join(lines, "\n")
}

func listStart(n *html.Node, ordered bool) int {
	if !ordered {
		return 1
	}
	if v := attr(n, "start"); v != "" {
		if k, ok := atoiOK(v); ok {
			return k
		}
	}
	return 1
}

// renderTable renders a simple GFM table. Rows come from <tr>; cells from
// <th>/<td>. The first row is treated as the header (GFM requires one).
// Pipes inside cells are escaped. Irregular tables still produce output; it
// just won't be perfectly aligned.
func renderTable(n *html.Node) string {
	var rows [][]string
	var walk func(*html.Node)
	walk = func(x *html.Node) {
		for c := x.FirstChild; c != nil; c = c.NextSibling {
			if c.Type == html.ElementNode && c.DataAtom == atom.Tr {
				var cells []string
				for d := c.FirstChild; d != nil; d = d.NextSibling {
					if d.Type == html.ElementNode && (d.DataAtom == atom.Td || d.DataAtom == atom.Th) {
						cell := finalizeInline(renderInlineChildren(d))
						cell = strings.ReplaceAll(cell, "|", `\|`)
						cells = append(cells, cell)
					}
				}
				if len(cells) > 0 {
					rows = append(rows, cells)
				}
				continue
			}
			walk(c)
		}
	}
	walk(n)
	if len(rows) == 0 {
		return ""
	}
	cols := 0
	for _, r := range rows {
		if len(r) > cols {
			cols = len(r)
		}
	}
	var b strings.Builder
	writeRow := func(cells []string) {
		b.WriteString("| ")
		for i := 0; i < cols; i++ {
			if i < len(cells) {
				b.WriteString(cells[i])
			}
			b.WriteString(" |")
			if i < cols-1 {
				b.WriteString(" ")
			}
		}
		b.WriteString("\n")
	}
	writeRow(rows[0])
	b.WriteString("|")
	for i := 0; i < cols; i++ {
		b.WriteString(" --- |")
	}
	b.WriteString("\n")
	for _, r := range rows[1:] {
		writeRow(r)
	}
	return strings.TrimRight(b.String(), "\n")
}

// renderInlineChildren renders all children of n as inline content.
func renderInlineChildren(n *html.Node) string {
	var b strings.Builder
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		b.WriteString(renderInline(c))
	}
	return b.String()
}

// renderInline renders an inline node (text or inline element). Block
// elements encountered in inline position degrade to their inline text.
func renderInline(n *html.Node) string {
	switch n.Type {
	case html.TextNode:
		return escapeInlineText(collapseSpaces(n.Data))
	case html.ElementNode:
		switch n.DataAtom {
		case atom.Br:
			return hardBreakSentinel
		case atom.Strong, atom.B:
			return wrapNonEmpty("**", renderInlineChildren(n))
		case atom.Em, atom.I:
			return wrapNonEmpty("*", renderInlineChildren(n))
		case atom.Del, atom.S, atom.Strike:
			return wrapNonEmpty("~~", renderInlineChildren(n))
		case atom.Code:
			return inlineCode(rawText(n))
		case atom.A:
			// Plain text only — never a clickable Markdown link. The href is
			// emitted as inert text (markdown-it runs with linkify off, so a
			// bare URL stays plain), so a hostile URL can't hide behind
			// friendly anchor text. When the anchor text differs from the
			// href, it follows in parentheses.
			text := strings.TrimSpace(renderInlineChildren(n))
			href := strings.TrimSpace(attr(n, "href"))
			if href == "" {
				return text
			}
			escHref := escapeInlineText(href)
			if text == "" || text == escHref {
				return escHref
			}
			return escHref + " (" + text + ")"
		case atom.Img:
			// Never emit the image src: a remote URL is a tracking / content
			// beacon that fetches on render. Acknowledge the image inline
			// with its alt text (if any) instead.
			alt := strings.TrimSpace(attr(n, "alt"))
			if alt == "" {
				return "[image]"
			}
			return "[image: " + escapeInlineText(alt) + "]"
		case atom.Script, atom.Style, atom.Head, atom.Title, atom.Noscript:
			return ""
		default:
			// span, font, u, sub, sup, abbr, … — pass through children.
			return renderInlineChildren(n)
		}
	default:
		return ""
	}
}

func wrapNonEmpty(delim, inner string) string {
	if strings.TrimSpace(inner) == "" {
		return inner
	}
	return delim + inner + delim
}

// escapeInlineText escapes Markdown-significant characters in HTML-derived
// text. Reuses the plain-text inline escaper; block markers don't matter here
// because HTML text never sits at the start of a Markdown line on its own.
func escapeInlineText(s string) string {
	return inlineEscaper.Replace(s)
}

// hardBreakSentinel stands in for a <br> while inline content is assembled,
// because the whitespace-collapsing pass that joins a paragraph's text runs
// would otherwise eat a literal "  \n". finalizeInline swaps it back for a
// real Markdown hard break after collapsing is done.
const hardBreakSentinel = "\x00"

var hbSpaceRegexp = regexp.MustCompile(` *\x00 *`)

// finalizeInline turns assembled inline content into the final paragraph text:
// collapse HTML whitespace runs to single spaces, drop spaces hugging a
// hard-break sentinel, realise the sentinels as Markdown hard breaks, and trim
// the result. Used wherever inline content is closed off (paragraphs,
// headings, table cells).
func finalizeInline(s string) string {
	s = collapseSpaces(s)
	s = hbSpaceRegexp.ReplaceAllString(s, hardBreakSentinel)
	s = strings.ReplaceAll(s, hardBreakSentinel, "  \n")
	return strings.TrimSpace(s)
}

var spaceRun = regexp.MustCompile(`[ \t\r\n\f]+`)

// collapseSpaces collapses any run of HTML whitespace to a single space, the
// way a browser renders non-pre text. Leading/trailing spaces are preserved
// (callers trim where appropriate) so inline runs join with a single space.
func collapseSpaces(s string) string {
	return spaceRun.ReplaceAllString(s, " ")
}

// backtickFence returns a run of backticks long enough to fence content that
// may itself contain backtick runs: one more than the longest run inside
// content, but never fewer than three.
func backtickFence(content string) string {
	n := longestRun(content, '`') + 1
	if n < 3 {
		n = 3
	}
	return strings.Repeat("`", n)
}

// inlineCode wraps t as a Markdown code span. The delimiter is a backtick run
// one longer than any run inside t (so embedded backticks stay literal), and
// t is padded with a space when it begins or ends with a backtick — the
// CommonMark rule for a code span whose content has an edge backtick.
func inlineCode(t string) string {
	if t == "" {
		return ""
	}
	delim := strings.Repeat("`", longestRun(t, '`')+1)
	if strings.HasPrefix(t, "`") || strings.HasSuffix(t, "`") {
		return delim + " " + t + " " + delim
	}
	return delim + t + delim
}

// longestRun returns the length of the longest consecutive run of ch in s.
func longestRun(s string, ch byte) int {
	best, cur := 0, 0
	for i := 0; i < len(s); i++ {
		if s[i] == ch {
			cur++
			if cur > best {
				best = cur
			}
		} else {
			cur = 0
		}
	}
	return best
}

// rawText returns the concatenated text of n's subtree with no whitespace
// collapsing or escaping — used for <pre> and <code> where whitespace is
// significant and Markdown escaping would corrupt the literal content.
func rawText(n *html.Node) string {
	var b strings.Builder
	var walk func(*html.Node)
	walk = func(x *html.Node) {
		if x.Type == html.TextNode {
			b.WriteString(x.Data)
		}
		for c := x.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	return b.String()
}

// applyLinePrefix prepends prefix to every line of s (used for blockquotes).
// Blank lines get the trimmed prefix so "> " doesn't leave trailing spaces.
func applyLinePrefix(s, prefix string) string {
	lines := strings.Split(s, "\n")
	for i, ln := range lines {
		if ln == "" {
			lines[i] = strings.TrimRight(prefix, " ")
		} else {
			lines[i] = prefix + ln
		}
	}
	return strings.Join(lines, "\n")
}

func isBlockElement(n *html.Node) bool {
	if n.Type != html.ElementNode {
		return false
	}
	switch n.DataAtom {
	case atom.P, atom.Div, atom.Section, atom.Article, atom.Header,
		atom.Footer, atom.Main, atom.Aside, atom.Nav,
		atom.H1, atom.H2, atom.H3, atom.H4, atom.H5, atom.H6,
		atom.Ul, atom.Ol, atom.Li, atom.Blockquote, atom.Pre,
		atom.Hr, atom.Table, atom.Figure, atom.Figcaption,
		atom.Dl, atom.Dt, atom.Dd, atom.Fieldset, atom.Form:
		return true
	}
	return false
}

func attr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

// itoa / atoiOK avoid pulling strconv for two trivial conversions and keep
// the numeric handling inline with the list logic.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func atoiOK(s string) (int, bool) {
	if s == "" {
		return 0, false
	}
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0, false
		}
		n = n*10 + int(r-'0')
	}
	return n, true
}
