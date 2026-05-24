# F7 — `downloadAttachment` uses the server-supplied filename as the `<a download>` value

- **Severity:** informational
- **Status:** ✅ RESOLVED 2026-05-22 (fixed server-side at upload)
- **Agent:** frontend
- **Location:** `client/src/attachments/upload.ts:344-350`

## Resolution

Per project owner's call, the fix lives server-side at upload —
sanitize once, store clean, every read path benefits without
per-consumer code. `client/src/attachments/upload.ts` is
unchanged.

New helper `textnorm.Filename(s) (string, error)` in
`server/internal/textnorm/normalize.go`. Wired into
`file.create` (the single upload ingress). Rules:

1. **NFC normalisation** — `café.pdf` and `café.pdf` (decomposed)
   collapse to one canonical form.
2. **Strip non-graphic runes** — Unicode Cc (control), Cf
   (format, including bidi-override `U+202E` that turns
   `image‮gnp.exe` into `imageexe.png` in most UIs), Cs
   (surrogate), Co (private use). DEL is also stripped.
3. **Strip path separators** — `/` and `\`.
4. **Trim leading/trailing whitespace and dots** — leading `.`
   hides files on Unix; trailing `.` is interpreted as
   "no extension" on Windows.
5. **Require an extension** — at least one `.` with characters
   on both sides after the trims above. This closes the
   Windows DOS-device-name class (NUL, CON, AUX, PRN,
   COM1–COM9, LPT1–LPT9) without an explicit reserved-name
   table — all of those are bare names with no extension.

Returns `ErrEmptyFilename` or `ErrMissingExtension`; the
handler surfaces these as `validation` errors. Test coverage
in `normalize_test.go` (16 sanitisation cases + 14 error
cases) pins each rule including the U+202E bidi-attack
case.

## What

`a.download = filename;` where `filename` is the uploader-chosen
name. Browsers sanitize the download attribute, so script / HTML
payloads here don't execute. Theoretical path-traversal in the
save dialog is mitigated by the browser.

Worth mentioning only for completeness.

## Why it matters

Not exploitable in modern browsers.

## Suggested fix

None required; consider stripping `\r\n` defensively if you want to
be paranoid.
