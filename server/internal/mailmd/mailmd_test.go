package mailmd

import "testing"

// TestFromText is the data-table for plain-text → Markdown. Each case is a
// (name, in, want) triple; `want` is the exact Markdown we expect to store in
// `description`. The trailing "  " on a line is a Markdown hard break — the
// whole point of this conversion — so the cases keep them explicit rather
// than trimming, to make the break visible in the source.
func TestFromText(t *testing.T) {
	const hb = "  \n" // hard break: two spaces + newline
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "empty",
			in:   "",
			want: "",
		},
		{
			name: "single line unchanged",
			in:   "Just one line.",
			want: "Just one line.",
		},
		{
			// The reported bug: adjacent lines must keep their breaks.
			name: "adjacent lines become hard breaks",
			in:   "Line one.\nLine two.\nLine three.",
			want: "Line one." + hb + "Line two." + hb + "Line three.",
		},
		{
			name: "blank line is a paragraph break",
			in:   "Para one.\n\nPara two.",
			want: "Para one.\n\nPara two.",
		},
		{
			// The screenshot case: body + blank + signature block.
			name: "body then signature",
			in: "This is another testing task.\n" +
				"We are going to verify formatting.\n" +
				"And make it work correctly.\n" +
				"\n" +
				"Then we are going to check it like this.\n" +
				"\n" +
				"-Daniel Theophanes\n" +
				" Solid Core Data Inc\n" +
				" 214-843-1718",
			want: "This is another testing task." + hb +
				"We are going to verify formatting." + hb +
				"And make it work correctly.\n\n" +
				"Then we are going to check it like this.\n\n" +
				// "-Daniel" is a dash with no following space, so it is NOT a
				// bullet and needs no escape — it renders as written.
				"-Daniel Theophanes" + hb +
				" Solid Core Data Inc" + hb +
				" 214-843-1718",
		},
		{
			name: "crlf normalised",
			in:   "a\r\nb\r\n",
			want: "a" + hb + "b",
		},
		{
			name: "lone cr normalised",
			in:   "a\rb",
			want: "a" + hb + "b",
		},
		{
			name: "leading and trailing blank lines trimmed",
			in:   "\n\n\nhello\n\n\n",
			want: "hello",
		},
		{
			// One extra blank line (two in a row) → one &nbsp; spacer.
			name: "double blank line preserved as one spacer",
			in:   "a\n\n\nb",
			want: "a\n\n&nbsp;\n\nb",
		},
		{
			// Three blank lines → two spacers.
			name: "triple blank line preserved as two spacers",
			in:   "a\n\n\n\nb",
			want: "a\n\n&nbsp;\n\n&nbsp;\n\nb",
		},
		{
			name: "single blank line is still just a paragraph break",
			in:   "a\n\nb",
			want: "a\n\nb",
		},
		{
			name: "trailing source spaces stripped before our own break",
			in:   "a   \nb",
			want: "a" + hb + "b",
		},
		// ---- escaping: text must render literally, not as Markdown ----
		{
			// Mid-line '*' is escaped (no emphasis); '_' too.
			name: "inline asterisks and underscores escaped",
			in:   "use *star* not _under_",
			want: `use \*star\* not \_under\_`,
		},
		{
			name: "backticks escaped",
			in:   "run `make test` now",
			want: "run \\`make test\\` now",
		},
		{
			name: "backslash escaped first",
			in:   `path C:\temp`,
			want: `path C:\\temp`,
		},
		{
			name: "brackets escaped so no link",
			in:   "see [the docs](http://x)",
			want: `see \[the docs\](http://x)`,
		},
		{
			name: "leading hash not a heading",
			in:   "# not a heading",
			want: `\# not a heading`,
		},
		{
			name: "mid-line hash left alone",
			in:   "issue #42 filed",
			want: "issue #42 filed",
		},
		{
			name: "leading gt not a blockquote",
			in:   "> quoted text",
			want: `\> quoted text`,
		},
		{
			// '-' bullets pass through as a real list.
			name: "leading dash passes through as bullet",
			in:   "- a point\n- another",
			want: "- a point" + hb + "- another",
		},
		{
			// '*' bullets pass through, but only at line start.
			name: "leading asterisk passes through as bullet",
			in:   "* a point\n* another",
			want: "* a point" + hb + "* another",
		},
		{
			// Indented '*' bullet (within the 3-space window) still passes.
			// (Mid-document so the leading indent isn't trimmed as the
			// document's leading whitespace.)
			name: "indented asterisk bullet passes through",
			in:   "list:\n   * indented",
			want: "list:" + hb + "   * indented",
		},
		{
			// The '*' marker is kept, but the item text is still escaped.
			name: "asterisk bullet keeps marker but escapes item text",
			in:   "* use _emph_ and *stars*",
			want: `* use \_emph\_ and \*stars\*`,
		},
		{
			// '+' is the one bullet marker still neutralised.
			name: "leading plus not a bullet",
			in:   "+ plus point",
			want: `\+ plus point`,
		},
		{
			// Numbered lists pass through unescaped — a leading enumerated
			// line reads better as a real ordered list.
			name: "ordered list marker passes through",
			in:   "1. first\n2. second",
			want: "1. first" + hb + "2. second",
		},
		{
			name: "ordered list paren marker passes through",
			in:   "1) first",
			want: "1) first",
		},
		{
			name: "decimal mid-line left alone",
			in:   "version 1.2 shipped",
			want: "version 1.2 shipped",
		},
		{
			// With '-' no longer escaped, a dash rule passes through as a
			// thematic break.
			name: "dash thematic break passes through",
			in:   "above\n\n---\n\nbelow",
			want: "above\n\n---\n\nbelow",
		},
		{
			// Documented limitation: a line that *starts* a block with 4+
			// spaces of indent is left alone and so renders as an indented
			// code block. Real signatures indent by 1–2 spaces, well under
			// the threshold. (The leading indent survives here because it is
			// not at the very start of the document, where it would be
			// trimmed.)
			name: "four-space indent left as-is (known limitation)",
			in:   "intro\n\n    deeply indented",
			want: "intro\n\n    deeply indented",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := FromText(tc.in)
			if got != tc.want {
				t.Errorf("FromText(%q)\n  got:  %q\n  want: %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestFromHTML is the data-table for the approximate HTML → Markdown pass.
// These document both the supported mappings and the edges of "approximate"
// — when a case looks lossy, that's the contract, not a bug to silently fix.
func TestFromHTML(t *testing.T) {
	const hb = "  \n"
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "empty",
			in:   "",
			want: "",
		},
		{
			name: "plain paragraph",
			in:   "<p>Hello world</p>",
			want: "Hello world",
		},
		{
			name: "two paragraphs separated by blank line",
			in:   "<p>One</p><p>Two</p>",
			want: "One\n\nTwo",
		},
		{
			name: "br becomes hard break",
			in:   "<p>Line one<br>Line two</p>",
			want: "Line one" + hb + "Line two",
		},
		{
			name: "bold and italic",
			in:   "<p>a <b>bold</b> and <i>italic</i></p>",
			want: "a **bold** and *italic*",
		},
		{
			name: "strong and em aliases",
			in:   "<p><strong>x</strong> <em>y</em></p>",
			want: "**x** *y*",
		},
		{
			name: "strikethrough",
			in:   "<p><del>gone</del></p>",
			want: "~~gone~~",
		},
		{
			// Links are never clickable: emit the href as plain text, with
			// the anchor text in parens when it differs.
			name: "link emits href as plain text with label",
			in:   `<p>see <a href="https://x.test">the site</a></p>`,
			want: "see https://x.test (the site)",
		},
		{
			name: "link whose text is the href emits href once",
			in:   `<p><a href="https://x.test">https://x.test</a></p>`,
			want: "https://x.test",
		},
		{
			name: "link without href degrades to text",
			in:   "<p><a>bare</a></p>",
			want: "bare",
		},
		{
			// Images never pull a remote src — acknowledged inline only.
			name: "image acknowledged with alt, no url",
			in:   `<img src="http://x/i.png" alt="a cat">`,
			want: "[image: a cat]",
		},
		{
			name: "image without alt",
			in:   `<img src="http://tracker.test/pixel.gif">`,
			want: "[image]",
		},
		{
			name: "inline code is not escaped inside backticks",
			in:   "<p>call <code>a_b*c</code></p>",
			want: "call `a_b*c`",
		},
		{
			// A backtick inside inline code bumps the delimiter to two; no
			// padding is needed because the content has no edge backtick.
			name: "inline code containing a backtick",
			in:   "<p><code>a`b</code></p>",
			want: "``a`b``",
		},
		{
			// An edge backtick forces the one-space padding.
			name: "inline code with edge backtick is padded",
			in:   "<p><code>`x</code></p>",
			want: "`` `x ``",
		},
		{
			// A fence inside a <pre> can't terminate ours: use a longer fence.
			name: "pre containing a triple-backtick fence",
			in:   "<pre>```\ncode\n```</pre>",
			want: "````\n```\ncode\n```\n````",
		},
		{
			name: "headings h1 through h3",
			in:   "<h1>Title</h1><h2>Sub</h2><h3>Subsub</h3>",
			want: "# Title\n\n## Sub\n\n### Subsub",
		},
		{
			name: "unordered list",
			in:   "<ul><li>one</li><li>two</li></ul>",
			want: "- one\n- two",
		},
		{
			name: "ordered list numbers",
			in:   "<ol><li>first</li><li>second</li></ol>",
			want: "1. first\n2. second",
		},
		{
			name: "ordered list honours start attr",
			in:   `<ol start="3"><li>three</li><li>four</li></ol>`,
			want: "3. three\n4. four",
		},
		{
			name: "nested list indents under marker",
			in:   "<ul><li>top<ul><li>child</li></ul></li></ul>",
			want: "- top\n\n  - child",
		},
		{
			name: "blockquote prefixes lines",
			in:   "<blockquote><p>quoted</p></blockquote>",
			want: "> quoted",
		},
		{
			name: "preformatted preserves whitespace and skips escaping",
			in:   "<pre>line1\n  line2 *raw*</pre>",
			want: "```\nline1\n  line2 *raw*\n```",
		},
		{
			name: "horizontal rule",
			in:   "<p>a</p><hr><p>b</p>",
			want: "a\n\n---\n\nb",
		},
		{
			name: "whitespace runs collapse like a browser",
			in:   "<p>too    many\n\n   spaces</p>",
			want: "too many spaces",
		},
		{
			// HTML text is never a line-start bullet, so '*' (and '_') are
			// escaped there.
			name: "markdown chars in html text are escaped",
			in:   "<p>2 * 3 = 6 and a_b</p>",
			want: `2 \* 3 = 6 and a\_b`,
		},
		{
			name: "script and style stripped",
			in:   "<p>visible</p><script>alert(1)</script><style>.x{}</style>",
			want: "visible",
		},
		{
			name: "div treated as block",
			in:   "<div>one</div><div>two</div>",
			want: "one\n\ntwo",
		},
		{
			name: "simple table to gfm",
			in:   "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>",
			want: "| A | B |\n| --- | --- |\n| 1 | 2 |",
		},
		{
			name: "entities decoded by parser",
			in:   "<p>Hello &amp; welcome &lt;3</p>",
			want: `Hello & welcome \<3`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := FromHTML(tc.in)
			if got != tc.want {
				t.Errorf("FromHTML(%q)\n  got:  %q\n  want: %q", tc.in, got, tc.want)
			}
		})
	}
}
