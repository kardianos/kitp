# web/ — Design Language

> **Direction (2026-06-11):** the `web/` client takes its feel from
> **Linear** (linear.app) — compact, fast, typographically confident, with
> colorful state iconography and snappy micro-motion — while keeping the
> full power filters and data-grid display. This supersedes the earlier
> One UI + UniFi blend (2026-05-24), whose clean-chrome/dense-data lineage
> still shows in the two density registers below.

## The vibe

- **Linear** — one tight, compact surface; hierarchy from weight and
  spacing more than size. 14px body, shallow heading ramp, rounded-rect
  (not pill) controls, crisp hairlines, neutral near-black dark mode,
  one confident indigo accent, and per-state colorful icons (the status
  shapes). Motion is fast and decisive: 70–160ms, snappy decel, nothing
  unhurried.
- Kept from the previous language: light **and** dark are both designed,
  first-class surfaces; dense data is a feature, not a compromise;
  hairline borders on data, soft shadows only on floating surfaces.

## The governing rule: one compact language, two density registers

The registers survive, but they're a half-step apart now (Linear-compact),
not a contrast:

| Register | Where | Feel |
|---|---|---|
| **Comfortable** | app shell / rail / topbar, dialogs, project cards, primary buttons, empty states | tight-but-breathing: 8–12px pads, 44px topbar, 32px buttons |
| **Compact** | data grid rows, ScreenFilterBar, kanban cards, attribute key/value tables | hairline borders, tabular numerals, 4–12px pads — never cramped, never dumbed-down |

## Tokens (web/design/tokens.css)

- **Typography** — Inter Variable, vendored in `assets/fonts/` (OFL) and
  actually shipped (`@font-face` in styles.css + preload in index.html).
  Body 14px (`--text-base`), ramp md 15 / lg 17 / xl 20 / 2xl 24.
  `cv05`/`ss01` alternates on the root. Tabular-nums + `--leading-data`
  on data surfaces.
- **Radius** — Linear-squarer: controls 6–8px (`--radius-sm/md`), panels
  10–12px (`--radius-lg/xl`); buttons are rounded-rect (`--radius-md`),
  NOT pill. Chips/badges/counts stay pills. Grid cells near-square.
- **Color** — light keeps the cool-neutral ramp; dark is a **neutral
  near-black** (page `#0f1011`, surface `#17181a` — no blue cast).
  Accent is **Linear indigo** (`#5e6ad2` light / `#7b83eb` dark). Both
  were isolated single commits — revert one commit to undo either.
- **Phase palette** — `--phase-triage` (gray) / `--phase-active`
  (yellow) / `--phase-terminal` (indigo) + `-soft` fills, defined in all
  three theme blocks. Every status surface (chips, icons, kanban
  headers, grid cells) reads these — never hardcode a state color.
- **Motion** — `--duration-micro` 70ms (hover/press), `--duration-fast`
  100ms (popover/menu enter), `--duration-base` 160ms (screen mount,
  modals), `--ease-out` for enters. ALL durations zero out under
  `prefers-reduced-motion` via the tokens block — never bypass it.

## Icons

- **Chrome icons** — `src/ui/icons.ts`: one typed `icon(name, size?)`
  factory over vendored Lucide path data (ISC — license + add-an-icon
  recipe in `web/vendor/lucide/`). Stroke 1.75, `currentColor`, so icons
  tint with the surrounding text. No unicode glyph icons; the `?` help
  button is the one deliberate text glyph.
- **Status icons** — `src/ui/status-icon.ts`: hand-drawn phase shapes
  (dashed ring = triage, ring + half-pie = active, filled disc + check =
  terminal, dotted = unknown) tinted by the `--phase-*` tokens via
  `.status-icon[data-phase]`. Shape encodes progress, so state reads
  without color. Badge labels always remain the element's `textContent`
  (icons are decorative, `aria-hidden`).

## Motion idioms

- Hover/press feedback at `--duration-micro`; pressed buttons scale
  (0.97 / 0.94 for icon buttons).
- Floating surfaces enter via the shared `pop-enter` keyframe (3px
  drop-in + settle, `--duration-fast --ease-out`). The Popover helper
  adds `kf-popover--enter` on first resolved position.
- Route swaps re-add `.shell__outlet--enter` (AppShell) — the new screen
  rises in 4px + fade at `--duration-base`.
- Virtualized rows transition **background only** — never layout
  properties.
- The kanban FLIP reflow (`--duration-flip`) is its own system; leave it.

## How this gets applied

1. Tokens first: if a change can land in `tokens.css`, it must.
   `styles.css` references `var(--…)` only and never redefines tokens.
2. The dark theme is TWO blocks (`[data-theme="dark"]` + the
   `prefers-color-scheme` duplicate). Every `--color-*` change must land
   in both, byte-identical; `--neutral-*` lives only in the data-theme
   block.
3. Selectors/`data-*` hooks are load-bearing (tests) — new classes are
   additive only.
4. Every future control follows this doc + the tokens.
