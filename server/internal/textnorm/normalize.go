// Package textnorm centralises the Unicode-normalisation rules for
// user-supplied strings that flow through ingress points (OIDC
// provisioning, person.create, person.upsert_by_email, bootstrap).
//
// Two flavours:
//
//   - Name  — display_name, person card title. NFC (canonical
//             composition, UAX #15). Preserves the user's visual
//             intent (ligatures, combining marks) while ensuring
//             that two strings that look the same compare equal.
//
//   - Email — local-part: NFC + lowercase. Bytewise distinctions in
//             RFC 5321 are honoured by no MTA we ship today, and
//             RFC 6532 requires NFC for internationalised
//             local-parts. The domain part is lowercased ASCII.
//             Together this means "Foo@Example.COM" and
//             "foo@example.com" hash to the same key.
//
// Tabs / newlines / leading & trailing whitespace are stripped — a
// pasted display name often picks those up by accident and they
// don't read well in dropdowns.
package textnorm

import (
	"errors"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// Name returns the NFC-normalised, trimmed form of [s]. Empty inputs
// pass through unchanged so callers can preserve "user did not
// supply this field" semantics without a second branch.
func Name(s string) string {
	t := strings.TrimSpace(s)
	if t == "" {
		return ""
	}
	return norm.NFC.String(t)
}

// ErrEmptyFilename is returned by [Filename] when the input is empty
// or reduces to empty after sanitisation.
var ErrEmptyFilename = errors.New("filename is empty")

// ErrMissingExtension is returned by [Filename] when the input has
// no `.ext` suffix after sanitisation. Requiring an extension closes
// the Windows DOS-device-name class (NUL, CON, AUX, PRN, COM1–COM9,
// LPT1–LPT9) without an explicit reserved-name table — all of those
// are bare names with no extension.
var ErrMissingExtension = errors.New("filename must have an extension")

// Filename normalises and validates a user-supplied filename for safe
// storage. The returned string is suitable for the `file.filename`
// column and for echoing back to the client in Content-Disposition
// (after the existing `sanitizeFilename` quote-strip pass).
//
// Rules applied in order:
//
//  1. NFC normalisation — `café.pdf` (composed) and `café.pdf`
//     (decomposed `café`) collapse to the same string.
//
//  2. Strip non-graphic runes — Unicode categories Cc (control),
//     Cf (format, including bidi-override `U+202E` that lets
//     `image‮gnp.exe` display as `imageexe.png`), Cs
//     (surrogate), Co (private use), and noncharacter code points.
//     Also strips ASCII DEL (`U+007F`).
//
//  3. Strip path separators — `/` and `\`. We never echo the
//     filename into a filesystem path, but downstream consumers
//     (browser Save-As, archive entries) sometimes do, and the
//     audit's defence-in-depth concern is cheap to address here.
//
//  4. Trim leading and trailing whitespace and `.` — a pasted name
//     often picks these up; a leading `.` would hide the file on
//     Unix and a trailing `.` is interpreted as "no extension" on
//     Windows.
//
//  5. Require an extension — must contain `.` with at least one
//     graphic character on either side after the trims above.
//     Empty → [ErrEmptyFilename]; no extension → [ErrMissingExtension].
func Filename(s string) (string, error) {
	t := norm.NFC.String(s)

	var b strings.Builder
	b.Grow(len(t))
	for _, r := range t {
		switch {
		case r == '/' || r == '\\':
			// Path separators — drop.
		case unicode.IsGraphic(r):
			// IsGraphic = L* | M* | N* | P* | S* | Zs.
			// Excludes Cc (control), Cf (format / bidi),
			// Cs (surrogate), Co (private use), noncharacter
			// (which aren't valid runes in Go strings anyway).
			b.WriteRune(r)
		}
	}

	out := strings.Trim(b.String(), " \t\n\r\v\f.")
	if out == "" {
		return "", ErrEmptyFilename
	}

	// Extension check: there must be a `.` with content on both
	// sides. After the trim above, leading/trailing `.` are gone, so
	// any remaining `.` necessarily has content on the side facing
	// the trim — but the OTHER side could still be empty in edge
	// cases like a name that was all dots. strings.LastIndex catches
	// the rightmost dot; we require it to be > 0 and < len-1.
	dot := strings.LastIndex(out, ".")
	if dot <= 0 || dot >= len(out)-1 {
		return "", ErrMissingExtension
	}
	return out, nil
}

// Email returns the NFC-normalised, trimmed, lowercased form of
// [s]. Empty inputs pass through unchanged.
//
// We lowercase the whole address rather than only the domain
// because every MTA we interoperate with today (Gmail / Outlook /
// generic IMAP) folds case on the local-part too; honouring
// per-letter casing would mean two visually identical addresses
// could land in different person cards.
func Email(s string) string {
	t := strings.TrimSpace(s)
	if t == "" {
		return ""
	}
	return strings.ToLower(norm.NFC.String(t))
}
