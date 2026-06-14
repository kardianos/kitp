# Inter Variable

Vendored from the official Inter release, v4.1:
https://github.com/rsms/inter/releases/tag/v4.1 (Inter-4.1.zip, `web/` directory).

Files:

- `InterVariable.woff2` — variable font, weight axis 100–900, normal style.
- `InterVariable-Italic.woff2` — same, italic.
- `OFL.txt` — the SIL Open Font License 1.1 (the release's LICENSE.txt).

Referenced by the `@font-face` rules at the top of `web/styles.css` via
absolute `/assets/fonts/…` URLs (esbuild leaves absolute url()s untouched;
build.mjs copies `assets/` into `dist/assets/`). `web/index.html` preloads
the normal face.
