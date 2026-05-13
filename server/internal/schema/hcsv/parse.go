// Package hcsv parses the hierarchical-CSV (hcsv) file format and
// renders the schema half of it to SQL. The format is markdown-ish:
//
//   - Lines beginning with one or more `#` then a space are section
//     headings. The leading `#` count is the depth (1, 2, 3, ...).
//     After the `#`s, the first word is the section kind (e.g. `db`,
//     `table`, `prop`, `columns`, `indexes`, `meta`, `rows`). A single
//     optional positional name token follows the kind. Anything after
//     a `|` is a pipe-delimited list of `key=value` modifiers; quoted
//     values are supported.
//
//   - Lines beginning with `--` (after optional leading whitespace) are
//     comments and stripped before parsing.
//
//   - Blank lines are ignored.
//
//   - Inside a section, the first non-blank line is treated as the CSV
//     column header. Subsequent non-blank lines are CSV data rows. The
//     CSV grammar is standard: comma-delimited, double-quote-quoted,
//     `""` to escape an embedded quote, leading/trailing whitespace on
//     a cell is stripped unless the cell is quoted.
//
//   - A cell may also be wrapped in backticks: `` `…` ``. Backtick
//     strings carry their contents verbatim (commas, quotes, newlines,
//     `--` sequences — anything but a lone backtick), which makes them
//     ideal for embedded JSON values. Doubled backticks `` `` `` inside
//     a backtick string escape to a single backtick. A backtick string
//     may span multiple lines; the parser gathers lines until the
//     backtick balance is even before parsing the row.
//
//   - Sections nest by depth: a `### columns` block under a `## table`
//     becomes a child of that table section, and so on.
//
// Phase 1 only needs the schema half; the seed/demo loaders read the
// AST too but live in a later patch.
package hcsv

import (
	"fmt"
	"strings"
)

// backtickPrefix marks the start of a backtick-quoted cell value carried
// out of parseRow. The downstream cell parser strips this prefix and
// emits a verbatim (ckBacktick) cell — preventing leading `[` / `@` /
// `$` inside the quoted content from triggering array expansion / alias
// / lookup interpretation. The chosen prefix uses NUL + a tag byte so it
// can never collide with user content (NUL is rejected upstream by
// rowBalanced).
const backtickPrefix = "\x00\x01b"

// Section is one heading-rooted node in the parsed document.
type Section struct {
	Depth     int               // 1 for `#`, 2 for `##`, 3 for `###`, ...
	Kind      string            // first word after the `#`s, e.g. "table", "columns"
	Name      string            // optional positional name, e.g. "card" in "## table card"
	Modifiers map[string]string // pipe-delimited "| key=value" tail
	Header    []string          // CSV header row (nil if section has no data)
	Rows      [][]string        // CSV data rows
	Children  []*Section        // nested sections (deeper depth)

	// Line is the 1-based source line of the heading; useful in error
	// messages.
	Line int
}

// Document is the top of the parsed AST.
type Document struct {
	Root *Section
}

// Parse turns src into a Document. The first non-blank, non-comment
// line must be a depth-1 heading.
func Parse(src []byte) (*Document, error) {
	lines := strings.Split(string(src), "\n")
	p := &parser{lines: lines}
	if err := p.scan(); err != nil {
		return nil, err
	}
	return &Document{Root: p.root}, nil
}

// parser holds the line cursor and a stack of in-progress sections.
type parser struct {
	lines []string
	idx   int
	root  *Section
	stack []*Section // depth-indexed: stack[len-1] is the current open section
}

// scan walks the lines and builds the AST.
func (p *parser) scan() error {
	for p.idx < len(p.lines) {
		raw := p.lines[p.idx]
		lineNo := p.idx + 1
		p.idx++

		line := stripComment(raw)
		trim := strings.TrimSpace(line)
		if trim == "" {
			continue
		}

		if depth, body, ok := parseHeading(line); ok {
			sec, err := makeHeadingSection(depth, body, lineNo)
			if err != nil {
				return fmt.Errorf("hcsv: line %d: %w", lineNo, err)
			}
			if err := p.attach(sec); err != nil {
				return fmt.Errorf("hcsv: line %d: %w", lineNo, err)
			}
			continue
		}

		// Non-heading, non-blank: must belong to a section.
		if len(p.stack) == 0 {
			return fmt.Errorf("hcsv: line %d: data outside any section", lineNo)
		}
		cur := p.stack[len(p.stack)-1]

		// Gather continuation lines if the first line opened a
		// quoted-cell (double-quote or backtick) that didn't close on
		// the same line.
		full := line
		for !rowBalanced(full) && p.idx < len(p.lines) {
			full = full + "\n" + p.lines[p.idx]
			p.idx++
		}
		if !rowBalanced(full) {
			return fmt.Errorf("hcsv: line %d: unterminated quoted cell in data row", lineNo)
		}
		row, err := parseRow(full)
		if err != nil {
			return fmt.Errorf("hcsv: line %d: %w", lineNo, err)
		}
		if cur.Header == nil {
			cur.Header = row
		} else {
			cur.Rows = append(cur.Rows, row)
		}
	}
	if p.root == nil {
		return fmt.Errorf("hcsv: file is empty or has no depth-1 heading")
	}
	return nil
}

// attach plumbs sec into the AST at its declared depth. Depth 1
// becomes the document root; deeper headings hang off the closest
// open ancestor at depth-1.
func (p *parser) attach(sec *Section) error {
	if sec.Depth == 1 {
		if p.root != nil {
			return fmt.Errorf("multiple depth-1 headings; only one allowed")
		}
		p.root = sec
		p.stack = []*Section{sec}
		return nil
	}
	if p.root == nil {
		return fmt.Errorf("first heading must be depth 1 (e.g. `# db`); got depth %d", sec.Depth)
	}
	// Pop the stack until the parent (depth = sec.Depth-1) is on top.
	// Sections at the same or deeper depth as `sec` close out.
	for len(p.stack) > 0 && p.stack[len(p.stack)-1].Depth >= sec.Depth {
		p.stack = p.stack[:len(p.stack)-1]
	}
	if len(p.stack) == 0 {
		return fmt.Errorf("no parent for depth-%d heading", sec.Depth)
	}
	parent := p.stack[len(p.stack)-1]
	parent.Children = append(parent.Children, sec)
	p.stack = append(p.stack, sec)
	return nil
}

// parseHeading detects markdown-style heading lines. Returns the
// depth (number of leading `#`) and the rest-of-line body.
func parseHeading(line string) (depth int, body string, ok bool) {
	// allow leading whitespace before the `#`s
	i := 0
	for i < len(line) && (line[i] == ' ' || line[i] == '\t') {
		i++
	}
	start := i
	for i < len(line) && line[i] == '#' {
		i++
	}
	if i == start {
		return 0, "", false
	}
	// Require space (or end-of-line) after the `#`s.
	if i < len(line) && line[i] != ' ' && line[i] != '\t' {
		return 0, "", false
	}
	depth = i - start
	body = strings.TrimSpace(line[i:])
	return depth, body, true
}

// makeHeadingSection parses the body of a heading line: the kind, an
// optional positional name, and a pipe-delimited modifier tail.
func makeHeadingSection(depth int, body string, lineNo int) (*Section, error) {
	if body == "" {
		return nil, fmt.Errorf("heading missing content")
	}
	head, tail := splitOnUnquotedPipe(body)
	head = strings.TrimSpace(head)
	if head == "" {
		return nil, fmt.Errorf("heading missing kind")
	}
	fields := strings.Fields(head)
	sec := &Section{
		Depth:     depth,
		Kind:      fields[0],
		Modifiers: map[string]string{},
		Line:      lineNo,
	}
	if len(fields) > 1 {
		// Join any remaining tokens — single names are most common
		// (`table card`) but the syntax tolerates a multi-word name.
		sec.Name = strings.Join(fields[1:], " ")
	}
	if err := parseModifiers(tail, sec.Modifiers); err != nil {
		return nil, err
	}
	return sec, nil
}

// splitOnUnquotedPipe splits body at the first `|` that is not inside
// a quoted string. Returns (head, tail) with tail being everything
// after the pipe (still possibly containing further `|` delimiters
// inside parseModifiers).
func splitOnUnquotedPipe(body string) (head, tail string) {
	inQ := false
	for i := 0; i < len(body); i++ {
		c := body[i]
		switch c {
		case '"':
			// Toggle, but treat `""` inside a quoted region as escape.
			if inQ && i+1 < len(body) && body[i+1] == '"' {
				i++
				continue
			}
			inQ = !inQ
		case '|':
			if !inQ {
				return body[:i], body[i+1:]
			}
		}
	}
	return body, ""
}

// parseModifiers consumes the tail of a heading (everything after the
// first `|`) and fills dst. The tail is a pipe-delimited list of
// `key=value` pairs; values may be quoted to include `|` or `=`.
func parseModifiers(tail string, dst map[string]string) error {
	tail = strings.TrimSpace(tail)
	if tail == "" {
		return nil
	}
	for {
		part, rest := splitOnUnquotedPipe(tail)
		part = strings.TrimSpace(part)
		if part != "" {
			eq := indexUnquotedRune(part, '=')
			if eq < 0 {
				return fmt.Errorf("modifier %q missing `=`", part)
			}
			key := strings.TrimSpace(part[:eq])
			val := strings.TrimSpace(part[eq+1:])
			if key == "" {
				return fmt.Errorf("modifier %q missing key", part)
			}
			unq, err := unquoteCell(val)
			if err != nil {
				return fmt.Errorf("modifier %q: %w", part, err)
			}
			dst[key] = unq
		}
		if rest == "" {
			break
		}
		tail = rest
	}
	return nil
}

// indexUnquotedRune returns the byte index of the first occurrence of
// r in s outside of a double-quoted region, or -1.
func indexUnquotedRune(s string, r byte) int {
	inQ := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch c {
		case '"':
			if inQ && i+1 < len(s) && s[i+1] == '"' {
				i++
				continue
			}
			inQ = !inQ
		default:
			if c == r && !inQ {
				return i
			}
		}
	}
	return -1
}

// unquoteCell removes surrounding double-quotes (if present) and
// resolves the `""` escape inside. Bare values pass through unchanged.
func unquoteCell(s string) (string, error) {
	if len(s) < 2 || s[0] != '"' {
		return s, nil
	}
	if s[len(s)-1] != '"' {
		return "", fmt.Errorf("unterminated quoted value %q", s)
	}
	inner := s[1 : len(s)-1]
	// Disallow stray quotes outside the `""` escape.
	var b strings.Builder
	for i := 0; i < len(inner); i++ {
		c := inner[i]
		if c == '"' {
			if i+1 < len(inner) && inner[i+1] == '"' {
				b.WriteByte('"')
				i++
				continue
			}
			return "", fmt.Errorf("stray quote in %q", s)
		}
		b.WriteByte(c)
	}
	return b.String(), nil
}

// parseRow parses one logical CSV-like row using a small state
// machine. A cell takes one of three forms, determined by its first
// non-whitespace character:
//
//   - `"…"`  — double-quoted; `""` escapes to a literal `"`.
//   - `` `…` `` — backtick-quoted; `` `` `` escapes to a literal
//     `` ` ``. Backtick cells preserve newlines verbatim, making them
//     well suited to embedded JSON.
//   - bare — anything else; reads up to the next unquoted comma or
//     newline; leading/trailing whitespace is trimmed.
//
// Commas are cell delimiters only outside of quoted cells. Newlines
// inside a quoted cell are part of the cell content; newlines outside
// any quote end the row. A trailing comma yields one extra empty cell.
func parseRow(s string) ([]string, error) {
	var cells []string
	n := len(s)
	i := 0

	for {
		// Skip leading whitespace at the start of each cell.
		for i < n && (s[i] == ' ' || s[i] == '\t') {
			i++
		}

		var cell strings.Builder
		switch {
		case i < n && s[i] == '"':
			i++
			for {
				if i >= n {
					return nil, fmt.Errorf("unterminated double-quoted cell at byte %d", i)
				}
				c := s[i]
				if c == '"' {
					if i+1 < n && s[i+1] == '"' {
						cell.WriteByte('"')
						i += 2
						continue
					}
					i++
					goto closed
				}
				cell.WriteByte(c)
				i++
			}
		case i < n && s[i] == '`':
			// Prefix backtick-quoted cells with a NUL-+-marker so the
			// downstream cell parser can identify them as "verbatim
			// literal — do not interpret as array / lookup / alias".
			// Backtick cells often contain JSON arrays / objects whose
			// leading `[` would otherwise trigger cross-product expansion.
			cell.WriteString(backtickPrefix)
			i++
			for {
				if i >= n {
					return nil, fmt.Errorf("unterminated backtick cell at byte %d", i)
				}
				c := s[i]
				if c == '`' {
					if i+1 < n && s[i+1] == '`' {
						cell.WriteByte('`')
						i += 2
						continue
					}
					i++
					goto closed
				}
				cell.WriteByte(c)
				i++
			}
		default:
			start := i
			for i < n && s[i] != ',' && s[i] != '\n' {
				i++
			}
			cell.WriteString(strings.TrimRight(s[start:i], " \t"))
		}
	closed:
		cells = append(cells, cell.String())

		// Skip whitespace after a closing quote.
		for i < n && (s[i] == ' ' || s[i] == '\t') {
			i++
		}
		if i >= n {
			return cells, nil
		}
		if s[i] == '\n' {
			// Newline outside any quote ends the row. Anything after
			// is leftover; gather-on-unbalance should have prevented
			// this for valid input.
			i++
			if strings.TrimSpace(s[i:]) != "" {
				return nil, fmt.Errorf("extra content after row at byte %d", i)
			}
			return cells, nil
		}
		if s[i] != ',' {
			return nil, fmt.Errorf("expected comma at byte %d, got %q", i, s[i])
		}
		i++ // consume comma; loop parses the next cell
	}
}

// stripComment removes a trailing `--` comment from line unless the
// `--` appears inside a quoted string. For Phase 1 we only strip when
// `--` is at the very start of the (left-trimmed) line; mid-line
// comments are not supported.
func stripComment(line string) string {
	trim := strings.TrimLeft(line, " \t")
	if strings.HasPrefix(trim, "--") {
		return ""
	}
	return line
}

// rowBalanced reports whether s is at a valid row-end point: i.e.
// not inside an open double-quoted or backtick cell. The scan loop
// uses this to decide whether to gather another continuation line.
//
// The state machine mirrors parseRow's: a `"` or `` ` `` at the
// start of a cell opens a quoted region; the matching unescaped
// closer ends it. Doubled `""` / `` `` `` inside an open region is
// an escape, not a balance toggle. Bare cells have no quoted state.
func rowBalanced(s string) bool {
	const (
		stCellStart = iota // about to read a cell (post-comma, or start of row)
		stBare             // inside a bare cell
		stDQuote           // inside a "..." cell
		stBacktick         // inside a `...` cell
	)
	state := stCellStart
	n := len(s)
	for i := 0; i < n; i++ {
		c := s[i]
		switch state {
		case stCellStart:
			switch {
			case c == ' ' || c == '\t':
				// skip leading whitespace
			case c == '"':
				state = stDQuote
			case c == '`':
				state = stBacktick
			case c == ',':
				// empty cell, next cell starts immediately
			case c == '\n':
				// blank-cell row end
				state = stCellStart
			default:
				state = stBare
			}
		case stBare:
			switch c {
			case ',':
				state = stCellStart
			case '\n':
				state = stCellStart
			}
		case stDQuote:
			if c == '"' {
				if i+1 < n && s[i+1] == '"' {
					i++ // escaped quote, stay in quoted state
					continue
				}
				state = stCellStart
				// after closing quote, eat optional whitespace
				for i+1 < n && (s[i+1] == ' ' || s[i+1] == '\t') {
					i++
				}
			}
		case stBacktick:
			if c == '`' {
				if i+1 < n && s[i+1] == '`' {
					i++ // escaped backtick, stay
					continue
				}
				state = stCellStart
				for i+1 < n && (s[i+1] == ' ' || s[i+1] == '\t') {
					i++
				}
			}
		}
	}
	return state != stDQuote && state != stBacktick
}
