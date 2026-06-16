The app pairs a matched superfamily — **Source Sans 3** for UI chrome and
**Source Serif 4** for long-form reading content. They share proportions and
design DNA, so the chrome-sans / content-serif split reads as one system
(`--font-sans` / `--font-serif` in `web/design/tokens.css`).

Both are vendored from their `@fontsource-variable/*` packages (the upstream
Adobe releases, https://github.com/adobe-fonts), latin-ext subset, as two
variable faces each (normal + italic), referenced by `@font-face` rules in
`web/styles.css` via absolute `/assets/fonts/…` URLs (esbuild leaves absolute
url()s untouched; the `web` make target copies `assets/` into `dist/assets/`).

# Source Sans 3

The UI sans (`--font-sans`): chrome, headings, controls, labels, dense data.

- `SourceSans3Variable.woff2` — variable font, weight axis 200–900, normal.
- `SourceSans3Variable-Italic.woff2` — same, italic.
- `SourceSans3-OFL.txt` — the SIL Open Font License 1.1.

# Source Serif 4

The content serif (`--font-serif`): long-form / dense reading surfaces — task
& project descriptions, comments, task titles, and the activity log — where
a sans reads less comfortably for sustained text.

- `SourceSerif4Variable.woff2` — variable font, weight axis 200–900, normal.
- `SourceSerif4Variable-Italic.woff2` — same, italic.
- `SourceSerif4-OFL.txt` — the SIL Open Font License 1.1.

Two faces each, fetched on demand — italic only when a page renders italic
text.
