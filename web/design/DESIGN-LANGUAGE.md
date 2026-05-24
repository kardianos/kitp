# web/ — Design Language

> **Owner direction (2026-05-24):** the `web/` client should feel appealing to a
> **Samsung phone (One UI)** and **Ubiquiti/UniFi** user — *while still* carrying
> the full power filters and data-grid display. This file is the design north
> star for the token evolution + control styling pass; the existing mocks
> (`mock-*.md`) define layout/structure, this defines *feel*.

## The vibe (two references, blended)

- **Samsung One UI** — calm, rounded, spacious, friendly. Large corner radii,
  pill-shaped primary buttons, generous padding, big touch targets, smooth and
  unhurried. Light **and** dark are both first-class. Content-forward; chrome
  recedes.
- **Ubiquiti / UniFi** — clean, professional dashboard. Cool neutral palette
  with one confident accent, crisp 1px hairline borders, restrained soft
  shadows, a strong deep-neutral dark mode, and **dense, information-rich data
  tables/grids that still look elegant**. Technical but approachable.

## The governing rule: clean chrome, dense data

Do **not** trade power for minimalism. The clean/friendly aesthetic applies to
the *chrome* (nav, dialogs, project cards, primary actions); the *data
surfaces* (grid rows, the filter bar, kanban cards, attribute tables) stay
**dense and fully powerful** — just crisp and well-organized. Two density
registers, one language:

| Register | Where | Feel |
|---|---|---|
| **Comfortable** | app shell / rail / topbar, dialogs, project cards, primary buttons, empty states | generous spacing, large radius, big targets, One-UI calm |
| **Compact** | data grid rows, ScreenFilterBar, kanban cards, attribute key/value tables | tight spacing, hairline borders, tabular numerals, Ubiquiti density — never cramped, never dumbed-down |

## Token directions (for the tokens.css evolution)

This is a deliberate **divergence** from the byte-matched-to-Svelte tokens —
the new client gets its own language. Evolve, don't just inherit:

- **Radius** — bump up: cards/dialogs ~12–16px, buttons pill/large, inputs
  ~8–10px. Data-grid cells stay near-square (crisp).
- **Spacing** — add a comfortable track (cards/dialogs/nav) and a compact track
  (grid/filter rows) off one base scale; expose a density var so data surfaces
  opt into compact.
- **Color** — calm cool-neutral base (grays with a faint blue cast), ONE
  confident accent (UniFi-blue family), restrained semantics. Dark mode is a
  deep neutral (not pure black), high-legibility — designed, not inverted.
- **Borders** — crisp 1px hairlines on data tables/rows; near-borderless soft
  cards in the chrome.
- **Elevation** — subtle, soft shadows for *floating* surfaces (popovers,
  dialogs, dropdowns); flat + hairline for inline/data.
- **Typography** — clear hierarchy, slightly larger comfortable base;
  **tabular-nums** + tighter line-height in grids/tables. One type family.
- **Motion** — subtle, smooth, One-UI-calm; always honor
  `prefers-reduced-motion`.
- **Input modality** — comfortable targets that work for both touch (Samsung
  phone) and precise pointer (Ubiquiti desktop dashboard).

## How this gets applied

1. Evolve `web/design/tokens.css` toward the above (new radius/spacing/color/
   shadow scales + a density var). It will no longer be byte-identical to
   `client/src/app.css` — that's intended.
2. Restyle `web/styles.css` (AppShell, ProjectList, Kanban, ScreenFilterBar) to
   the evolved tokens, applying the comfortable/compact split.
3. Every future control follows this doc + the tokens; the mocks' structure
   stays, the feel upgrades.
