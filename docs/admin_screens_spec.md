# AdminScreensScreen — Spec

Admin-only UI for managing screen + filter cards across all projects. Complements the in-screen `<ScreenFilterBar>` CRUD (which handles per-screen quick edits) by surfacing every project's screens + filters in one place.

## Files

| Path | Purpose |
| --- | --- |
| `client/src/screens/admin/AdminScreensScreen.svelte` | The component. Mirrors AdminAttributesScreen's structure. |
| `client/src/screens/admin/admin_screens_helpers.ts` | Pure helpers (testable without DOM). |
| `client/test/unit/admin_screens.test.ts` | Vitest data-table tests for the helpers. |
| `client/src/routing/routes.ts` | Add route entry. |
| `client/src/shell/NavSidebar.svelte` | Add admin-nav entry. |

## Route + nav

Route entry at `/admin/screens`:

```ts
{
  path: '/admin/screens',
  component: () => import('../screens/admin/AdminScreensScreen.svelte'),
  guard: 'requireAdmin',
  shell: true,
  scope: 'admin_screens',
}
```

NavSidebar `adminItems` entry:
```ts
{ href: '/admin/screens', label: 'Screens' },
```

## Data layer (no new endpoints)

Reads:
- `card.select_with_attributes` `cardTypeName:'project'` — list every project
- `card.select_with_attributes` `cardTypeName:'screen', parentCardId:<project>` — screens for a project
- `card.select_with_attributes` `cardTypeName:'filter', parentCardId:<screen>` — filters for a screen

Writes (all existing endpoints — no new server code):
- `card.insert` `cardTypeName:'screen', parentCardId:<project>, title, attributes:{layout, slug, sort_order}` — create a missing screen
- `card.insert` `cardTypeName:'filter', parentCardId:<screen>, title, attributes:{predicate?, column_attr?, lane_attr?}` — create a filter
- `attribute.update` `cardId:<filter>, attributeName:'title'|'predicate'|'column_attr'|'lane_attr'` — edit
- `attribute.update` `cardId:<screen>, attributeName:'default_filter', value:<filter_id>` — set default
- `card.delete` `cardId:<filter>` — delete a filter
- `card.delete` `cardId:<screen>` — delete a screen

## Layout — 3 panes (mirrors AdminAttributesScreen)

```
┌──────────────┬────────────────────────┬──────────────────────────┐
│ Projects     │ Screens for project    │ Filters for screen       │
│              │                        │                          │
│ [search /]   │ project title          │ screen title + layout    │
│ - Project A  │                        │                          │
│ - Project B* │ + Add screen           │ Default: [combobox▼]     │
│ - Project C  │                        │                          │
│              │ Inbox    (Default: A) │ - Filter A  [Default]    │
│ + New        │ Grid     (Default: B) │   [Rename] [Edit] [Del]  │
│              │ Kanban*  (Default: C) │ - Filter B               │
│              │ Project  (Default: D) │   [Rename] [Edit] [Del]  │
│              │                        │                          │
│              │                        │ + Add filter             │
└──────────────┴────────────────────────┴──────────────────────────┘
* = selected
```

### LEFT pane (~280px)
- Search input (`/` focuses it).
- Scrollable project list, click selects.
- "+ New project" opens quick-entry overlay (reuses `useQuickEntry`).

### CENTER pane
- Header: selected project title.
- List of screen cards (sorted by `sort_order` asc, then id asc):
  - Title + `layout` chip + small "Default: <filter title>" hint.
  - Click selects → loads filters in RIGHT pane.
- "+ Add screen" button: opens a small inline dialog
  - `layout` combobox: `missingLayouts(screens, LAYOUTS)` (so already-present layouts are excluded)
  - `title` defaults to the friendly label for that layout (e.g. "Pair" for `pair`); `slug` defaults to the layout name.
  - Sets `sort_order` to `screens.length + 1` to land at the bottom.
- "Delete screen" action on each row (icon button, with `window.confirm`).
- When the project has every layout from `LAYOUTS`, "+ Add screen" is hidden / disabled.

### RIGHT pane
- Header: selected screen's title + layout chip.
- "Default filter:" combobox listing the screen's filter cards by title. Picking one fires `attribute.update default_filter` on the screen card. The current value is read from `default_filter` on the screen.
- List of filter cards (sorted by `sort_order` asc):
  - Inline-editable title (blur commits via `attribute.update title`).
  - Small chips for `column_attr` / `lane_attr` when set.
  - "Edit predicate" button → `window.prompt` with current JSON; commit via `attribute.update predicate` (text JSON).
  - "Delete" → `window.confirm` + `card.delete`.
- "+ Add filter" button: opens a small inline dialog
  - `title` (required)
  - Empty predicate by default (the filter starts with no predicate; the in-screen FilterBar can refine it later).

## Helpers — `admin_screens_helpers.ts`

Each helper is a small pure function, exhaustively covered by a vitest `it.each(...)` table.

```ts
import type { CardWithAttrs, ID } from '../../reg/types';
import type { Layout } from '../../filter/screen_preset.svelte';

/**
 * Return the layouts from `all` that aren't present in `screens`.
 * Preserves order of `all` so the UI's "+ Add screen" combobox lists
 * missing layouts in the same order the application defines them.
 */
export function missingLayouts(
  screens: readonly CardWithAttrs[],
  all: readonly Layout[],
): Layout[]

/**
 * Sort screens by sort_order ASC, then by id ASC. Non-numeric / missing
 * sort_order values sort after numeric ones (NULLS LAST semantics).
 */
export function sortScreensByOrder(
  screens: readonly CardWithAttrs[],
): CardWithAttrs[]

/**
 * Parse a predicate-JSON string. Returns
 *   { ok: true, predicate }  on success
 *   { ok: false, error }     on JSON parse failure OR predicate shape error
 * Empty / whitespace-only strings are valid and mean "no predicate"
 *   ({ ok: true, predicate: null }).
 */
export function validatePredicateJson(raw: string):
  | { ok: true; predicate: Predicate | null }
  | { ok: false; error: string }

/**
 * Friendly label for a layout name. Capitalises and replaces
 * underscores ('multi_word' → 'Multi word').
 */
export function friendlyScreenLabel(layout: string): string
```

## Tests — `admin_screens.test.ts`

Every helper gets `describe.each` / `it.each` coverage. Minimum cases:

**missingLayouts** (5+ rows):
- empty screens → returns full `all`
- all present → returns []
- one missing → returns just that one
- duplicates in `screens` → still correctly reports remaining
- preserves order of `all`

**sortScreensByOrder** (5+ rows):
- numeric sort_orders → ascending
- ties broken by id
- missing sort_order → sorts last
- mix of present/absent → present first, absent last
- empty input → empty output

**validatePredicateJson** (6+ rows):
- empty string → ok, null
- whitespace → ok, null
- invalid JSON → not ok
- valid JSON but bad predicate shape → not ok
- valid leaf predicate → ok, decoded leaf
- valid group predicate → ok, decoded group

**friendlyScreenLabel** (4+ rows):
- 'list' → 'List'
- 'pair' → 'Pair'
- 'kanban' → 'Kanban'
- 'multi_word_thing' → 'Multi word thing'
- '' → '' (or some sane fallback)

## Acceptance checks (for the verifier)

1. Route `/admin/screens` resolves and renders.
2. NavSidebar `adminItems` has a `Screens` link pointing to `/admin/screens`.
3. Picking a project loads its screens; picking a screen loads its filters.
4. All four helpers exist and are exported from `admin_screens_helpers.ts`.
5. `admin_screens.test.ts` exists, runs, and has `it.each(...)` tables for every helper with the case counts listed above.
6. No new attribute_defs / card_types / server endpoints introduced.
7. No status / hardcoded layout strings beyond what `LAYOUTS` exports.
8. `cd client && npx svelte-check` → 0 errors, 0 warnings.
9. `cd client && npx vitest run` → all tests pass.
10. `cd server && go test ./...` → all tests pass.
11. Net new code count is "small" — uses existing components and patterns. Specifically: the .svelte file is < 600 lines and the helpers file is < 120 lines (sanity ceiling, not a target).

## Constraints / non-goals

- Don't duplicate ScreenFilterBar's CRUD logic; both surfaces hit the same endpoints, but they don't share code beyond `screen_preset.svelte.ts` helpers.
- Don't add a new card_type or attribute_def.
- Don't add a new server endpoint.
- Use `window.prompt` / `window.confirm` for inputs (matches existing AdminAttributesScreen style).
- Don't hardcode layout strings; read from `LAYOUTS`.
- Don't introduce a new authz mechanism; rely on existing `role_grant` rows.

## Reference patterns to follow

- AdminAttributesScreen.svelte for the 3-pane layout and keyboard shortcuts (`/`, `j`/`k`, `Enter`).
- screen_preset.test.ts for the data-table test style.
- ScreenFilterBar.svelte for the predicate-edit / set-default semantics (use the same endpoints).
