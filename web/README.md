# kitp `web/` — toolchain & dependency strategy

The web client is hand-authored TypeScript with a deliberately tiny toolchain.
The architecture is in [`ARCHITECTURE.md`](ARCHITECTURE.md); this file is the
one-page rule for **dependencies and tooling**.

## The rule

| Concern | Tool | Notes |
| --- | --- | --- |
| **Runtime deps** | **vendored under `web/vendor/`** | If — and only if — a library is needed *at runtime*, copy it into `web/vendor/` as ESM and import it by relative path. **Keep this set minimal.** |
| **Build / bundle** | **esbuild** | Strips TS types and bundles `src/main.ts` + `styles.css` to a self-contained `dist/`. The only build tool. |
| **Typecheck** | **`tsgo` (or `tsc`) `--noEmit`** | The type authority. esbuild does *not* type-check — it only emits. |
| **Everything else** | **test-only** | Any other `node_modules` package exists solely to run `node --test`. |

## Runtime dependencies → `web/vendor/`

A runtime dependency is one whose code must end up in the shipped bundle. We do
**not** import such a library as an npm package; we vendor it:

1. Copy the library's ESM build into `web/vendor/` (e.g. `web/vendor/marked.js`).
2. Import it by **relative path** from `src/` (e.g.
   `import { marked } from '../../vendor/marked.js'`).
3. esbuild bundles it from there. No npm runtime/build dependency is added.

**Minimize this set.** Today it is exactly three, all behind a single consumer:

- `dompurify` + `marked` — the markdown / XSS boundary (`src/util/markdown.ts`).
- `@floating-ui/dom` — popover positioning.

There are **no bare npm specifier imports anywhere in `src/`**. The shipped
`dist/app.js` contains zero `node_modules` code — the runtime is `src/` + the
vendored libs, nothing else.

## `node_modules` is dev/test toolchain only

`web/package.json` declares just two `devDependencies`:

- **`esbuild`** — the bundler (used by `build.mjs` and the on-the-fly test
  compile in `test/build-for-test.mjs`).
- **`jsdom`** — a real DOM for tests only. DOMPurify and the DOM-touching
  control tests need a `document`/`DOMParser` that Node lacks. jsdom is **never
  bundled into `dist/`**.

Everything else under `node_modules/` is a transitive dependency of those two
(mostly jsdom's: parse5, saxes, whatwg-url, …). `node_modules/` is gitignored
and regenerable — `rm -rf node_modules && npm install` rebuilds it. It is not a
runtime dependency of the client.

## Scripts

```
npm run build     # node build.mjs            → self-contained web/dist/
npm run dev       # node build.mjs --serve     → esbuild watch + static serve
npm run typecheck # tsc --noEmit               → type authority (prefer tsgo)
npm test          # node --test test/*.test.mjs (esbuild-compiled on the fly)
```

Typecheck with `tsgo` when available (`tsgo --noEmit`); plain `tsc --noEmit` is
the same authority.

## Adding a dependency — decision

- **Needed at runtime (ships in the bundle)?** Vendor it into `web/vendor/`,
  import by relative path, and question whether it's truly necessary first.
- **Needed only to build or test?** Add it to `devDependencies`. It must never
  be imported from `src/` by a bare specifier, or it leaks into the runtime
  bundle.
