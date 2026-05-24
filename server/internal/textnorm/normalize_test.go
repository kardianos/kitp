package textnorm_test

import (
	"errors"
	"testing"

	"github.com/kitp/kitp/server/internal/textnorm"
)

func TestName(t *testing.T) {
	cases := []struct {
		in, want, label string
	}{
		{"", "", "empty passes through"},
		{"  Alice  ", "Alice", "trims whitespace"},
		// "é" can be a single precomposed code point (U+00E9) or
		// e + combining acute (U+0065 U+0301). Both render as the
		// same glyph; NFC collapses the decomposed form to the
		// precomposed.
		{"André", "André", "NFC composes combining marks"},
		{"André", "André", "already-composed stays"},
		// Display-only — case is preserved.
		{"MÜLLER", "MÜLLER", "case preserved for display names"},
	}
	for _, c := range cases {
		t.Run(c.label, func(t *testing.T) {
			got := textnorm.Name(c.in)
			if got != c.want {
				t.Errorf("Name(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

func TestFilename(t *testing.T) {
	cases := []struct {
		in, want, label string
	}{
		{"report.pdf", "report.pdf", "plain ASCII passes through"},
		{"  spaced  .pdf  ", "spaced  .pdf", "trims leading/trailing whitespace, keeps interior"},
		{"foo/bar.pdf", "foobar.pdf", "strips forward slash"},
		{"foo\\bar.pdf", "foobar.pdf", "strips backslash"},
		{"foo/bar\\baz.pdf", "foobarbaz.pdf", "strips both separator flavours"},
		// U+202E RIGHT-TO-LEFT OVERRIDE — the canonical filename
		// spoofing rune. "image‮gnp.exe" displays as
		// "imageexe.png" in most UIs. Stripping it leaves the real
		// extension visible.
		{"image‮gnp.exe", "imagegnp.exe", "strips RTL override (bidi attack)"},
		// U+200B ZERO WIDTH SPACE — invisible, can hide chars or
		// produce confusables with other filenames.
		{"in​voice.pdf", "invoice.pdf", "strips zero-width space"},
		// NUL — fatal on most filesystems if it ever leaks through.
		{"foo\x00bar.pdf", "foobar.pdf", "strips NUL"},
		// Other C0 controls.
		{"foo\tbar\nbaz.pdf", "foobarbaz.pdf", "strips tab and newline"},
		// DEL (U+007F).
		{"foobar.pdf", "foobar.pdf", "strips DEL"},
		// Decomposed café — NFC composes to single code point.
		{"café.pdf", "café.pdf", "NFC composes decomposed marks"},
		// Already composed — survives unchanged.
		{"café.pdf", "café.pdf", "already-composed stays"},
		// Leading dots = Unix hidden file marker — strip.
		{"...image.png", "image.png", "trims leading dots"},
		// Trailing dots = Windows interprets as no extension — strip.
		{"image.png...", "image.png", "trims trailing dots"},
		// Mixed leading/trailing whitespace + dots — strings.Trim
		// strips greedily from each end until it hits a non-cutset
		// rune, so an arbitrary run of "  . . ." in either direction
		// is removed.
		{" . . report.pdf .", "report.pdf", "trims runs of leading/trailing dots+spaces"},
	}
	for _, c := range cases {
		t.Run(c.label, func(t *testing.T) {
			got, err := textnorm.Filename(c.in)
			if err != nil {
				t.Fatalf("Filename(%q) returned err %v, want %q", c.in, err, c.want)
			}
			if got != c.want {
				t.Errorf("Filename(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

func TestFilename_Errors(t *testing.T) {
	cases := []struct {
		in, label string
		wantErr   error
	}{
		{"", "empty input", textnorm.ErrEmptyFilename},
		{"   ", "only whitespace", textnorm.ErrEmptyFilename},
		{"...", "only dots", textnorm.ErrEmptyFilename},
		{" . . ", "whitespace + dots only", textnorm.ErrEmptyFilename},
		{"‮​\x00", "only invisible/control runes", textnorm.ErrEmptyFilename},
		{"/\\/\\", "only path separators", textnorm.ErrEmptyFilename},
		// Reserved DOS device names — all bare, no extension. The
		// extension requirement closes the class without an explicit
		// allowlist table.
		{"CON", "DOS device name CON", textnorm.ErrMissingExtension},
		{"NUL", "DOS device name NUL", textnorm.ErrMissingExtension},
		{"COM1", "DOS device name COM1", textnorm.ErrMissingExtension},
		{"LPT9", "DOS device name LPT9", textnorm.ErrMissingExtension},
		{"PRN", "DOS device name PRN", textnorm.ErrMissingExtension},
		// Bare names without an extension.
		{"readme", "extension-less name", textnorm.ErrMissingExtension},
		// `.pdf` becomes `pdf` after trim-leading-dots → no extension.
		{".pdf", "leading-dot only is no extension after trim", textnorm.ErrMissingExtension},
		// `report.` becomes `report` after trim-trailing-dots.
		{"report.", "trailing-dot only is no extension after trim", textnorm.ErrMissingExtension},
	}
	for _, c := range cases {
		t.Run(c.label, func(t *testing.T) {
			got, err := textnorm.Filename(c.in)
			if err == nil {
				t.Fatalf("Filename(%q) = %q, want error %v", c.in, got, c.wantErr)
			}
			if !errors.Is(err, c.wantErr) {
				t.Errorf("Filename(%q) err = %v, want %v", c.in, err, c.wantErr)
			}
		})
	}
}

func TestEmail(t *testing.T) {
	cases := []struct {
		in, want, label string
	}{
		{"", "", "empty passes through"},
		{"  Foo@Example.COM  ", "foo@example.com", "trims + lowercases"},
		// Decomposed local-part collapses to precomposed; full address
		// also lowercases. Two visually identical addresses → same key.
		{"émile@x.com", "émile@x.com", "NFC composes local-part"},
		{"Émile@x.com", "émile@x.com", "uppercase precomposed lowercases"},
	}
	for _, c := range cases {
		t.Run(c.label, func(t *testing.T) {
			got := textnorm.Email(c.in)
			if got != c.want {
				t.Errorf("Email(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}
