# Svelte 5 + TypeScript + Vite Migration Plan

Replaces the Flutter web client at `client/` with a Svelte 5 + TypeScript +
Vite SPA. The Go server, batch API, OIDC flow, and Postgres schema are
**unchanged** — the new client speaks the exact same `POST /api/v1/batch`
contract via the same per-frame coalescing dispatcher.

This plan is the authoritative spec. Implementation tasks are tracked via
the in-session task list (granular, one per concrete deliverable).

---

## 1. Goals

1. **Drop the CanvasKit canvas.** Render real DOM so screen readers, find-in-page,
   browser zoom, copy-paste, devtools, and webdriver-based E2E all work.
2. **Strict TypeScript everywhere** with hand-written codecs (mirroring Dart's
   `toJson`/`fromJson` style — no codegen).
3. **Preserve the dispatcher contract.** One `POST /api/v1/batch` per render
   tick, regardless of how many components called `request()` that tick.
4. **Normalize the navigation frame** across every screen.
5. **Normalize and improve filter/search.** Predefined filter presets per
   screen; enum-typed attributes render as dropdowns, not free text.
6. **Keyboard-first.** Every screen registers shortcuts; `Ctrl+/` (and
   `?`) opens a per-page cheatsheet listing every active shortcut.
7. **Quick multi-entry.** `n` opens a quick-create overlay; `title` →
   `Tab` → `description` → `Ctrl+Enter` submits and re-opens the overlay
   for the next entry.
8. **Better drag/drop.** Fat drop-target placeholders that grow as the
   pointer enters them; never lose a drop because the gap between cards
   was 4 px.
9. **More flexible admin.** Attribute defs editable inline; bound card
   types managed via a 2-pane picker; value-card management for ref-typed
   attributes works without a page reload.
10. **Real DOM E2E.** Screenshot every screen at every state transition;
    chromedriver via WebDriver protocol; assertions hit DOM (not just API).

## 2. Non-goals

- No server-side changes beyond pointing `WEB_DIR` at `client/dist`.
- No OIDC protocol changes. Same PKCE + bearer-on-batch flow.
- No SSR (Vite SPA is enough; this is an internal app).
- No new routes or domain endpoints.

---

## 3. Stack

| Concern | Choice | Why |
|---|---|---|
| Framework | **Svelte 5** with runes (`$state`, `$derived`, `$effect`) | Closest mental match to Flutter widgets; fine-grained reactivity composes naturally with the dispatcher's per-tick flush. |
| Language | **TypeScript 5.x** strict | `noImplicitAny`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`. |
| Build | **Vite 5.x** | Zero-config Svelte+TS; `vite build` outputs static assets to `client/dist`. |
| Router | **`@mateothegreat/svelte5-router`** or **`svelte-spa-router`** | Hash-free SPA routing; declarative route table; supports route guards for the auth gate. Final pick at scaffold time — both viable. |
| Component primitives | **Custom + Tailwind utilities** | No heavyweight UI lib; we write small, focused components (`<Button>`, `<Modal>`, `<Menu>`, `<DatePicker>`, `<Combobox>`). Material Web is a fallback if a primitive proves too costly. |
| Styling | **Tailwind v4 + CSS variables for theme tokens** | Single source for color/typography/spacing. Dark mode is a `data-theme` toggle, not a separate sheet. |
| Drag & Drop | **Native HTML5 DnD wrapped in a small `useDnd` rune** | Pointer-Events fallback for sub-50px drop targets so tightly-packed kanban columns work without a library. |
| Testing | **Vitest** for unit + **WebDriver (chromedriver) via Node** for E2E | Vitest handles dispatcher/registry/predicate units; E2E driver replaces today's Dart driver. |
| Lint/format | **ESLint + Prettier + svelte-check** | Strict; runs in `make web-test`. |

---

## 4. Layout

```
client/
  index.html
  package.json
  pnpm-lock.yaml          # or package-lock.json
  vite.config.ts
  tsconfig.json
  svelte.config.js
  tailwind.config.ts
  postcss.config.js
  src/
    main.ts                    # bootstraps app, registers handlers, mounts <App>
    App.svelte                 # router host + global key listener + auth bootstrap
    env.ts                     # reads import.meta.env.VITE_KITP_API_BASE etc.
    dispatch/
      dispatcher.ts            # per-tick batched POST /api/v1/batch
      errors.ts                # SubRequestError, BatchAbortedError
      subrequest.ts            # SubRequest/SubResponse wire types
      context.ts               # Svelte context key helpers (getDispatcher())
    reg/
      handler_registry.ts      # generic register<I,R>() + lookup
      handlers.ts              # every (endpoint, action) ports from Dart
      handlers_admin.ts        # admin endpoints
      types.ts                 # shared row types (CardRow, ActivityRow, …)
    auth/
      auth_state.svelte.ts     # rune-based store; isSignedIn/accessToken
      oidc_client.ts           # PKCE flow (build URL, exchange code)
      oidc_session.ts          # bootstrap + refresh
      session_storage.ts       # PKCE verifier persistence (sessionStorage)
    routing/
      routes.ts                # route table (path → component + guard)
      guards.ts                # requireAuth, requireAdmin
    shell/
      AppShell.svelte          # sidebar + header + outlet
      NavSidebar.svelte
      UserMenu.svelte
      CommandPalette.svelte    # Ctrl+K — global search/jump
      ShortcutHelp.svelte      # Ctrl+/ — per-page cheatsheet overlay
    keys/
      shortcut.ts              # `useShortcut(scope, binding, handler, label)` rune
      scopes.ts                # type-safe scope tokens (one per screen)
      registry.svelte.ts       # active shortcut store per scope
    filter/
      predicate.ts             # AST + toJson/fromJson + flatten helpers
      attribute_schema.ts      # FilterAttribute + AttributeOption types
      FilterBar.svelte         # chip row + presets
      FilterTreeEditor.svelte  # nested AND/OR/NOT editor
      FilterPresets.svelte     # save/load presets per screen (localStorage)
      ValueInput.svelte        # dispatches text/number/date/select by type
    quick_entry/
      QuickEntryOverlay.svelte # title/desc/ctrl+enter; re-open on submit
    dnd/
      use_dnd.svelte.ts        # drag/drop rune; emits enter/leave/drop
      DropZone.svelte          # fat placeholder; grows on hover
      DragHandle.svelte
    ui/
      Button.svelte
      IconButton.svelte
      Modal.svelte
      Combobox.svelte          # enum dropdown (single + multi)
      DatePicker.svelte
      Toast.svelte
      Spinner.svelte
      EmptyState.svelte
      ConfirmDialog.svelte
      Chip.svelte
      Avatar.svelte
    screens/
      ProjectsScreen.svelte
      InboxScreen.svelte
      GridScreen.svelte
      KanbanScreen.svelte
      TaskDetailScreen.svelte
      ProjectDetailScreen.svelte
      ActivityScreen.svelte
      LoginScreen.svelte
      AuthCallbackScreen.svelte
      admin/
        AdminUsersScreen.svelte
        AdminAttributesScreen.svelte
    util/
      uuid.ts
      date.ts
      class_names.ts
  test/
    unit/                      # vitest
      dispatcher.test.ts
      predicate.test.ts
      registry.test.ts
    e2e/                       # webdriver
      driver.ts                # session + screenshot helpers
      journeys/
        login.ts
        projects.ts
        inbox_drag.ts
        grid_filter.ts
        kanban_drag.ts
        task_detail.ts
        admin_attributes.ts
        keyboard.ts
        quick_entry.ts
      run.ts                   # orchestrates boot → journeys → screenshots
```

The old `client/lib/` and `client/web/` directories are deleted at the
end of Phase 4. `client/build/` is replaced by `client/dist/` and
referenced from `WEB_DIR` in the Makefile.

---

## 5. Framework implementation plan

### 5.1 Dispatcher port (TS)

```ts
// dispatch/dispatcher.ts
import { v4 as uuid } from 'uuid';

export type Encode<I> = (input: I) => unknown;
export type Decode<R> = (raw: unknown) => R;

export interface HandlerSpec<I, R> {
  endpoint: string;
  action: string;
  encode: Encode<I>;
  decode: Decode<R>;
}

interface Pending<R = unknown> {
  sub: SubRequest;
  decode: Decode<R>;
  resolve: (v: R) => void;
  reject: (e: unknown) => void;
}

export class Dispatcher {
  private queue: Pending[] = [];
  private flushScheduled = false;

  constructor(
    private readonly apiBase: string,
    private readonly registry: HandlerRegistry,
    private readonly authState?: AuthState,
    private readonly onUnauthorized?: () => Promise<boolean>,
    private readonly schedule: (cb: () => void) => void = defaultSchedule,
  ) {}

  request<I, R>(args: {
    endpoint: string; action: string;
    type?: string; ref?: object; key?: object;
    data?: I;
  }): Promise<R> {
    const spec = this.registry.lookup<I, R>(args.endpoint, args.action);
    if (!spec) return Promise.reject(new SubRequestError('unknown_handler', `${args.endpoint}.${args.action}`));
    return new Promise<R>((resolve, reject) => {
      this.queue.push({
        sub: {
          id: uuid(),
          type: args.type ?? 'data',
          endpoint: args.endpoint,
          action: args.action,
          ref: args.ref ?? {},
          key: args.key ?? {},
          data: args.data === undefined ? null : spec.encode(args.data),
        },
        decode: spec.decode,
        resolve, reject,
      });
      this.maybeScheduleFlush();
    });
  }

  flushNow(): Promise<void> { return this.flush(); }

  private maybeScheduleFlush() {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.schedule(() => this.flush());
  }

  private async flush() { /* POST, fan out by id, fail-all on 4xx/5xx, refresh-on-401 */ }
}

const defaultSchedule = (cb: () => void) => {
  // rAF coalesces a render burst; queueMicrotask is the fallback for tests.
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(cb);
  else queueMicrotask(cb);
};
```

Tests inject a synchronous schedule (`(cb) => cb()` after a manual
`flushNow()`) for "exactly one HTTP call" assertions.

### 5.2 Handler registry

```ts
// reg/handler_registry.ts
export class HandlerRegistry {
  private by = new Map<string, HandlerSpec<unknown, unknown>>();
  register<I, R>(spec: HandlerSpec<I, R>): void {
    const k = `${spec.endpoint}.${spec.action}`;
    if (this.by.has(k)) throw new Error(`handler ${k} already registered`);
    this.by.set(k, spec as HandlerSpec<unknown, unknown>);
  }
  lookup<I, R>(endpoint: string, action: string): HandlerSpec<I, R> | undefined {
    return this.by.get(`${endpoint}.${action}`) as HandlerSpec<I, R> | undefined;
  }
}
```

Each handler in `handlers.ts` is a single `register({ endpoint, action,
encode, decode })` call with hand-written encode/decode functions that
mirror the Dart `toJson` / `fromJson`. Strict TS row types live in
`reg/types.ts`. **Codecs are total** — they always produce a value or
throw a `BatchAbortedError('decode_error: …')`.

### 5.3 Svelte integration: per-tick coalescing

Svelte 5 runes are the right hooking point:

```ts
// In a screen's component:
let projects = $state<CardWithAttrs[]>([]);
let users = $state<UserRow[]>([]);
let loading = $state(true);

$effect(() => {
  loading = true;
  Promise.all([
    dispatcher.request<CardSelectWithAttributesInput, CardSelectWithAttributesOutput>({
      endpoint: 'card', action: 'select_with_attributes',
      data: { card_type_name: 'project' },
    }),
    dispatcher.request<UserSelectInput, UserSelectOutput>({
      endpoint: 'user', action: 'select',
    }),
  ]).then(([p, u]) => {
    projects = p.rows;
    users = u.rows;
    loading = false;
  });
});
```

Both `request()` calls happen synchronously within one effect tick. The
dispatcher's `requestAnimationFrame` flush coalesces them into one
`POST /api/v1/batch` — same N-CLI-1/2/3 contract as today.

Dispatcher is provided via Svelte context at the App root, retrieved via
`getDispatcher()` helper to keep typing tight.

### 5.4 Auth + dispatcher integration

`auth_state.svelte.ts` is a rune store:

```ts
class AuthState {
  isSignedIn = $state(false);
  accessToken = $state<string | null>(null);
  claims = $state<Claims | null>(null);
  // ...
}
```

`Dispatcher` reads `authState.accessToken` synchronously per flush. On
401, calls `onUnauthorized()`; if it returns true, retries the same
batch body once. Second 401 → fail-all + redirect to `/login`. Identical
semantics to today's Dart dispatcher.

### 5.5 Routing & guards

Route table is plain TypeScript:

```ts
export const routes: Route[] = [
  { path: '/login',          component: LoginScreen,         guard: redirectIfSignedIn },
  { path: '/auth/callback',  component: AuthCallbackScreen },
  { path: '/projects',       component: ProjectsScreen,      guard: requireAuth, shell: true },
  { path: '/inbox',          component: InboxScreen,         guard: requireAuth, shell: true },
  { path: '/grid',           component: GridScreen,          guard: requireAuth, shell: true },
  { path: '/kanban',         component: KanbanScreen,        guard: requireAuth, shell: true },
  { path: '/activity',       component: ActivityScreen,      guard: requireAuth, shell: true },
  { path: '/project/:id',    component: ProjectDetailScreen, guard: requireAuth, shell: true },
  { path: '/task/:id',       component: TaskDetailScreen,    guard: requireAuth, shell: true },
  { path: '/admin/users',    component: AdminUsersScreen,    guard: requireAdmin, shell: true },
  { path: '/admin/attributes', component: AdminAttributesScreen, guard: requireAdmin, shell: true },
];
```

### 5.6 Keyboard shortcut system

Every screen declares its shortcuts via a single rune helper:

```ts
useShortcut('inbox', 'n',           openQuickEntry,    'New task');
useShortcut('inbox', 'j',           focusNext,         'Move selection down');
useShortcut('inbox', 'k',           focusPrev,         'Move selection up');
useShortcut('inbox', 'Enter',       openSelected,     'Open task');
useShortcut('inbox', 'Mod+/',       toggleHelp,        'Show shortcuts');
useShortcut('inbox', '?',           toggleHelp,        'Show shortcuts');
```

The registry stores `{scope, binding, handler, label}`. `<ShortcutHelp>`
overlay reads the registry filtered by the current route's scope and
shows a 2-column cheatsheet. `Mod+` is `Ctrl` on Linux/Windows and `⌘`
on macOS.

A single global keydown listener at `<App>` consults the registry,
matches the active scope, and invokes the handler. Inputs swallow
keydowns by default; bindings can opt into "fire even in inputs" via a
flag (used for `Mod+Enter` and `Esc`).

Global shortcuts (always active):

| Binding | Action |
|---|---|
| `Mod+K` | Command palette (jump to project, task, or screen) |
| `Mod+/` or `?` | Toggle shortcut help overlay |
| `Esc` | Close active overlay; if none, blur focused input |
| `g p` / `g i` / `g g` / `g k` / `g a` | Go to projects/inbox/grid/kanban/activity (vim-style chord) |

### 5.7 Quick-entry mode

`<QuickEntryOverlay>` opens via `n` from any list screen. It contains:

- title input (auto-focused)
- description textarea (`Tab` to focus it from the title)
- assignee combobox (optional, screen-aware — kanban defaults to current
  column's assignee; inbox defaults to current user)
- footer: "Enter to add another, Ctrl+Enter to add and close, Esc to cancel"

Submission flow:

1. `Ctrl+Enter` (or just `Enter` in title with no whitespace pending):
   issue `card.insert` (+ optional `attribute.update` for description /
   assignee) in one batch.
2. On success: clear inputs, refocus title, keep overlay open. A toast
   shows "Task created" with an Undo button (5s) that triggers
   `card.delete`.
3. `Esc` closes; `Ctrl+Esc` closes without consuming the toast.

Screens reuse the overlay by supplying:

- `defaultCardType` (e.g. `'task'`)
- `parentCardId` (project context, if any)
- `prefill` (e.g. inbox prefills `assignee=me`)
- `onCreated` (refresh hook)

### 5.8 Drag-drop with fat placeholders

`use_dnd.svelte.ts` is a small rune wrapping pointer events (not native
HTML5 DnD — pointer events let us style the dragged element and
control the drop zone size):

- A `<DragHandle>` starts a drag on `pointerdown` + threshold movement.
- Each `<DropZone>` accepts a `target` payload + lists itself in a
  global "active zones" set while the drag is live.
- On every `pointermove`, the rune hit-tests against the active zones'
  bounding rects **inflated by `padding`** (default 24 px above and
  below the visible band). The hit zone "highlights" — its placeholder
  expands to twice its idle height, locking visual feedback well before
  the pointer enters the literal gap between cards.
- `pointerup` over a highlighted zone fires `onDrop(payload, target)`.
- `Esc` cancels.

Result: the drop placeholder visually grows the moment the pointer is
within ~24 px, and the kanban-column algorithm computes the new
`sort_order` halfway between neighbors exactly as today.

### 5.9 Filter / predicate redesign

**Predicate AST** ports 1:1 from `predicate.dart` → `predicate.ts` (sealed
class becomes a discriminated union: `type Predicate = Leaf | Group`,
discriminator `'leaf' | 'group'`). `toJson`/`fromJson`/`flattenLeaves`/
`isFlatAndOfLeaves`/`predicateFromLeaves` all port directly. Wire shape
on the `tree` field is unchanged.

**Attribute schema discovery (new):** today every screen hardcodes its
`FilterAttribute` list. We replace this with a server-driven schema fetch:

- One `attribute_def.select` call at app boot (cached in a rune store
  for the session).
- Each `AttributeDef` carries `value_type` (`text`, `number`, `bool`,
  `date`, `enum`, `ref:<card_type_name>`).
- The `<ValueInput>` component dispatches on `value_type`:
  - `text` → free-text input.
  - `number` → numeric input.
  - `bool` → checkbox.
  - `date` → `<DatePicker>`.
  - `enum` → `<Combobox>` populated from the def's option list.
  - `ref:<type>` → `<Combobox>` populated by a `card.select_with_attributes`
    query for that card_type, label = title.

**Status today is a hardcoded list per screen.** We promote it to a
server-side enum on the `status` attribute_def (migration 0011 — see
Server addendum below). Once that lands, no screen needs the literal
`['todo', 'doing', 'review', 'done']` array.

**Filter presets:** new feature. Each screen has a "Saved filters" menu
that lists a per-user, per-screen set of named predicates stored in
`localStorage` (key: `kitp.filter.<scope>`). MVP is local-only; a future
phase can persist them server-side via a new `filter_preset.{select,save,
delete}` handler.

**Quick chips:** the FilterBar gains a "Quick filters" row above its
chips with sticky pre-defined options pulled from each attribute's
`value_type`:
- enums: one chip per enum value
- ref: a chip per parent of the active project, or "Mine" for assignee
- date: presets like "Today / This week / Overdue"

Click a quick chip → it injects the corresponding leaf into the active
predicate (replacing any existing leaf for the same attribute).

### 5.10 Admin screen redesign

**AdminAttributesScreen** rebuild:

- 3-pane layout (master / detail / preview):
  - **Left pane:** searchable list of attribute defs grouped by
    `is_built_in`. Inline "+ New attribute" creates a draft row.
  - **Center pane:** edit form for the selected def — name (read-only
    if built-in), value_type (locked once any value exists),
    enum-options editor (when `value_type == 'enum'`),
    ref card-type picker (when `value_type` starts with `ref:`).
  - **Right pane:** "Bound to" matrix listing every `card_type` with
    a checkbox + ordering + required toggle. Edits issue
    `edge.insert` / `edge.delete` immediately.
- "Value cards" sub-tab (only for `ref:` types) lists every value card,
  inline rename, soft-delete. Drag to reorder via `user_card_sort.set`
  (admin-scoped).
- All mutations dispatch through the same one-batch-per-tick path; bulk
  edits (e.g. toggling 5 bindings in a row) hit the server in one POST.

**AdminUsersScreen** rebuild:

- Master/detail. Master = user list with display_name + email + a
  badge per role. Detail = role assignments table with scope chips
  (global vs. project), inline "+ Assign role" combobox, inline
  "Revoke" button per row.
- New: search by display_name; filter by role; CSV export of role
  table (client-side stringify, no new endpoint).

### 5.11 Navigation frame

`<AppShell>` becomes one place that renders:

- Persistent left sidebar (collapsible) with the same five top-level
  links + Admin submenu. Active route highlighted; admin links hidden
  unless `authState.isAdmin`.
- Header: breadcrumbs derived from the current route (e.g.
  `Projects › Acme Co › Task #42`), search input
  (`Mod+K` to focus), user menu.
- Main outlet: routed screen.
- Toast slot (top-right).
- Help overlay slot (rendered above everything else when open).

Every screen renders inside this frame; screens never paint their own
chrome. Mobile (≤ 700 px): sidebar collapses behind a hamburger.

---

## 6. Server-side addendum

Server changes are minimized but two land alongside the rewrite:

1. **`make web-build` becomes `cd client && pnpm build`** (output
   `client/dist`). `WEB_DIR` defaults change from `client/build/web`
   to `client/dist`. The existing `spaHandler` in `server/internal/api/api.go`
   (already fall-back-to-index.html) needs no change.

2. **Migration 0011** promotes `status` to an enum-typed attribute def
   with options `['todo', 'doing', 'review', 'done']`. This removes the
   per-screen hardcoded list and lets the new `<Combobox>` value input
   render it server-driven.

3. *(Optional, gated)* server-side filter preset endpoints:
   `filter_preset.{select,save,delete}`. Defer to a follow-up phase;
   MVP uses localStorage.

---

## 7. Per-screen implementation plan

Each screen below is a single deliverable. Estimated effort assumes one
focused pass per screen including the e2e journey.

### 7.1 ProjectsScreen

- Source: `client/lib/ui/screens/projects_screen.dart` (418 LOC)
- Functional carryover: list projects with title + description; "+ New
  project" via `<QuickEntryOverlay>` (overlay reused — projects screen
  passes `defaultCardType='project'`).
- New: filter bar with quick-chips for "Has open tasks", "Mine"
  (assignee filter on tasks), search by title.
- Keyboard:
  - `n` quick-create
  - `j`/`k` move selection; `Enter` open; `g p` already focuses screen
  - `/` focus search
- Initial batch: 1 call coalescing `card.select_with_attributes` (project),
  `attribute_def.select` (cached after first hit).

### 7.2 InboxScreen

- Source: `client/lib/ui/screens/inbox_screen.dart` (562 LOC)
- Functional carryover: per-user open-tasks list with personal sort;
  drag-drop reorder writes `user_card_sort.set`.
- New: fat-placeholder drop zones (Section 5.8); FilterBar with
  quick-chips for status, milestone, component (these are server enums
  / refs once 0011 lands); preset menu.
- Keyboard:
  - `n` quick-create (parent_card_id = none, assignee = me)
  - `j`/`k` move row selection; `Space` toggles "done" on selected row
    via `attribute.update`
  - `Enter` opens task detail
  - `Mod+↑/↓` reorders selected row by ± `_kSortOrderStep / 2`
- Initial batch: same 3 sub-requests as today (`inbox.select`,
  `user.select`, `card.select_with_attributes` for refs).

### 7.3 GridScreen

- Source: `client/lib/ui/screens/grid_screen.dart` (565 LOC)
- Functional carryover: virtualized table with server sort + filter;
  columns ID/Title/Status/Assignee/Priority/Milestone/Component/Tags/Created.
- New: column-header click sorts (ascending → descending → off);
  per-column filter dropdowns derived from attribute_def value_type
  (Combobox for enums and refs, no free text); FilterBar shared with
  Inbox/Kanban.
- Keyboard:
  - `j`/`k` row selection; `Enter` open; `n` quick-create
  - `s` cycles sort on focused column header
  - `f` opens filter bar's add-leaf editor focused on focused column
- Initial batch: `card.select_with_attributes` (with order + tree),
  `user.select`, refs.

### 7.4 KanbanScreen

- Source: `client/lib/ui/screens/kanban_screen.dart` (973 LOC)
- Functional carryover: column + swim-lane board, drag between columns
  and lanes; drop computes new `sort_order` halfway between neighbors,
  one batch per drop.
- New: fat-placeholder drop zones (drag a card and the column or lane
  highlights with the placeholder doubling in height); column/lane
  picker as server-driven `<Combobox>` (no hardcoded options); empty
  columns still render a tall droppable placeholder.
- Keyboard:
  - `n` quick-create (defaults: column=current, lane=current)
  - `j`/`k`/`h`/`l` move selection within / across columns
  - `Mod+←/→` move selected card to prev/next column
  - `Mod+Shift+↑/↓` move selected card up/down within column
- Initial batch: tasks + users + refs (3 sub-requests, one POST).

### 7.5 TaskDetailScreen

- Source: `client/lib/ui/screens/task_detail_screen.dart` (759 LOC)
- Functional carryover: title + description (inline edit, Ctrl+Enter
  save), activity stream, comments (Ctrl+Enter post), right-rail
  attribute picker, tags drag-target.
- New: attribute panel renders via `<ValueInput>` so any new
  attribute_def shows up automatically with the right input type;
  comment composer expands on focus; tag picker is a Combobox + chip row.
- Keyboard:
  - `e` enter title edit; `Esc` cancel
  - `c` focus comment composer
  - `Mod+Enter` save current edit
  - `t` toggle tags picker
- Initial batch: 6 sub-requests as today.

### 7.6 ProjectDetailScreen

- Source: `client/lib/ui/screens/project_detail_screen.dart` (516 LOC)
- Functional carryover: project header + child task list.
- New: child tasks render via the same TaskRow component used by Inbox
  / Grid; quick-entry overlay (`n`) creates a task with this project as
  parent; FilterBar with same quick-chips as Grid.
- Keyboard: same nav set as Grid.

### 7.7 ActivityScreen

- Source: `client/lib/ui/screens/activity_screen.dart` (293 LOC)
- Functional carryover: cross-card activity stream.
- New: filter chips for "kind" (insert / attr_update / comment /
  tag_apply / tag_remove) and "actor"; date-range filter; tap a row to
  jump to the linked task.
- Keyboard: `j`/`k`/`Enter`; `f` focus filter.

### 7.8 LoginScreen + AuthCallbackScreen

- Sources: `login_screen.dart` (123 LOC), callback handler in `app.dart`.
- Functional carryover: PKCE redirect, code/state parse, token exchange.
- No keyboard work beyond `Enter` to start auth.

### 7.9 AdminUsersScreen

- Source: `admin_users_screen.dart` (225 LOC)
- See Section 5.10.

### 7.10 AdminAttributesScreen

- Source: `admin_attributes_screen.dart` (908 LOC)
- See Section 5.10.

---

## 8. E2E harness rebuild

### 8.1 Goals

1. Real DOM driving (chromedriver via WebDriver protocol from Node).
2. One screenshot per state per journey, named
   `<screen>_<state>.png` under `docs/screenshots/svelte/<journey>/`.
3. **Visual regression check**: run a pixel diff against a committed
   baseline; fail if any screen drifts > 0.5%.
4. Keyboard journey: every screen's shortcuts exercised at least once
   (typed via WebDriver `actions().keyDown(…)`).

### 8.2 Stack

- Node 20 + TypeScript.
- `chromedriver` Node package (matches Chrome 147).
- `selenium-webdriver` for the WebDriver protocol (mature, types ship).
- `pixelmatch` + `pngjs` for visual diff.
- A small orchestration script (`test/e2e/run.ts`) that:
  - Resets DB (calls existing `make db-reset` + `make migrate`).
  - Builds Vite bundle to `client/dist`.
  - Starts kitpd on `:18080` with `WEB_DIR=client/dist`.
  - Starts chromedriver.
  - Runs each journey, captures screenshots.
  - Tears everything down.
  - Diff vs baseline; report.

### 8.3 Journey list

| Journey | What it covers |
|---|---|
| `boot.ts` | App loads, login redirect, OIDC code exchange (mocked or real dex). |
| `projects.ts` | Render projects, quick-create via `n`, FilterBar quick-chip. |
| `inbox.ts` | Render inbox, drag a row up/down, FilterBar preset save+load. |
| `grid.ts` | Sort by status, filter by enum dropdown (no free text), column resize. |
| `kanban.ts` | Drag card column → column with fat placeholder visible; drag across swim lanes; quick-create in current column. |
| `task_detail.ts` | Edit title (e shortcut), post comment, change status via combobox, apply/remove tag. |
| `admin_attributes.ts` | Create new enum attribute, bind to card_type, edit options, set as filter target on Grid. |
| `keyboard.ts` | On every screen, open `Mod+/` shortcut help and verify the listed bindings actually fire. |
| `quick_entry.ts` | `n` opens overlay; create 3 tasks in a row without leaving the overlay; verify all 3 land in one batch each. |

### 8.4 Screenshot inventory

Each journey emits screenshots at every meaningful state. Targets per
screen:

- ProjectsScreen: empty, populated, filter applied, quick-entry open.
- InboxScreen: populated, drag in flight (fat placeholder), filter
  preset menu open.
- GridScreen: default sort, sorted by status desc, filter dropdown
  open, filter applied.
- KanbanScreen: full board, drag in flight, swim lanes on, lane drag
  in flight.
- TaskDetailScreen: read mode, title editing, comment composer focused,
  attribute picker open.
- AdminAttributesScreen: list mode, edit mode (enum options visible),
  bound-to matrix.
- ShortcutHelp: overlay open per screen (one screenshot each).

Total: ~30 screenshots, all under `docs/screenshots/svelte/`.

### 8.5 Visual diff baseline

First successful run commits its screenshots as the baseline. Subsequent
runs diff against committed PNGs. A `--update-baselines` flag overwrites.

---

## 9. Build / dev flow

`make` targets become:

```
web-build:        cd client && pnpm install --frozen-lockfile && pnpm build
web:              alias for web-build
web-dev:          cd client && pnpm dev      # vite dev server on :5173, proxies /api → :18080
web-test:         cd client && pnpm test     # vitest + svelte-check + eslint
e2e:              cd client && pnpm e2e      # node test/e2e/run.ts
run:              unchanged (kitpd serves WEB_DIR)
```

`WEB_DIR` default in the Makefile flips from `$(REPO_ROOT)/client/build/web`
to `$(REPO_ROOT)/client/dist`.

`vite.config.ts` configures a dev proxy so `pnpm dev` can hit kitpd
without CORS:

```ts
server: {
  port: 5173,
  proxy: { '/api': 'http://127.0.0.1:18080' },
},
```

Env vars (consumed via `import.meta.env`):

- `VITE_KITP_API_BASE` (default `''` — meaning same-origin)
- `VITE_KITP_OIDC_ISSUER`, `VITE_KITP_OIDC_CLIENT_ID`,
  `VITE_KITP_OIDC_REDIRECT_URI`, `VITE_KITP_OIDC_SCOPES`

---

## 10. Phased rollout

| Phase | Deliverable | Definition of done |
|---|---|---|
| **P1 — Scaffold** | Vite + Svelte 5 + TS + Tailwind in `client-svelte/` (parallel to `client/`); strict TS config; ESLint+Prettier wired; `pnpm dev` boots blank app. | `pnpm build` succeeds; `pnpm test` runs zero tests successfully. |
| **P2 — Core plumbing** | Dispatcher + handler registry + every (endpoint, action) ported with hand-written codecs; auth_state rune store; OIDC client; routing + guards; AppShell + NavSidebar + UserMenu. | Vitest unit tests for dispatcher batching and one full predicate round-trip pass. Manual smoke: app lands on /projects when signed in. |
| **P3 — Shared UI primitives** | Button, IconButton, Modal, Combobox, DatePicker, Toast, Spinner, Chip, ConfirmDialog, EmptyState, ShortcutHelp overlay, QuickEntryOverlay, useDnd + DropZone. | Storybook-style demo route at `/_dev/components` shows every primitive. |
| **P4 — Filter + predicate** | predicate.ts ported; FilterBar + FilterTreeEditor + FilterPresets; ValueInput dispatches on value_type. | Unit tests for predicate AST round-trip; one screen (Grid) consumes the new FilterBar. |
| **P5 — Screens** | Each screen ported (one task per screen). Order: Projects, Inbox, Grid, Kanban, TaskDetail, ProjectDetail, Activity, AdminUsers, AdminAttributes, Login/Callback. | Screen renders, calls land in one batch where the Dart version did, keyboard shortcuts work, `Ctrl+/` lists them. |
| **P6 — E2E rebuild** | New Node WebDriver harness + journey scripts + screenshot inventory + visual-diff baseline. | `make e2e` passes from a clean DB. |
| **P7 — Cutover** | Delete `client/lib/`, rename `client-svelte/` → `client/`, flip Makefile, update README/REQUIREMENTS/IMPLEMENTATION_PLAN. | `make up && make migrate && make web && make run` brings up the new client end-to-end. |

P1–P4 are sequential; P5 screens are parallelizable across agents
(each screen is self-contained once primitives + filter are in place);
P6 starts as soon as 2–3 screens exist; P7 is mechanical.

---

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Drag-drop hit-testing differs from Flutter, breaking kanban UX. | Pointer-events + inflated bounds + visual placeholder doubles during drag; e2e drag journey includes a screenshot of mid-drag state to catch regressions. |
| Material 3 polish loss (typography, focus rings, ripples). | Tailwind preset that mimics M3 tokens (color, motion, elevation); component primitives ship with focus-visible rings + reduced-motion query support. |
| Bundle size regression vs. expectations. | Vite + Svelte 5 should land < 100 KB gz for the whole app; tracked in CI via `pnpm build --report`. |
| OIDC PKCE bugs on the new auth path. | Port `oidc_client.dart` line-for-line; add unit tests around verifier persistence + token exchange. |
| E2E flakiness from real DOM + animations. | Disable animations in test mode (`prefers-reduced-motion: reduce` is auto-applied); WebDriver waits use explicit conditions, not sleeps. |
| User unhappy with new visual style. | Phase 3 demo route lets you preview every primitive before any screen is built; iterate there cheaply. |

---

## 12. Open questions to resolve during P1

- **Router pick:** `svelte-spa-router` vs `@mateothegreat/svelte5-router`.
  Pick the one with active maintenance and named-param support after a
  30-min spike.
- **Tailwind v4 vs v3:** v4 is newer and lighter but alpha; v3 is
  stable. Default to v3 unless v4 GA by start of P1.
- **Pixelmatch threshold:** start at 0.5% per screenshot; tune after first
  three runs.
- **Storage of PKCE verifier:** continue using `sessionStorage` (matches
  current behavior).

---

## 13. What stays unchanged

- `server/`, `db/`, `docker-compose.yml`, `Makefile` recipes that don't
  touch the client.
- The wire shape of every batch sub-request and sub-response.
- `REQUIREMENTS.md` invariants N-CLI-1/2/3 (one POST per tick).
- The OIDC PKCE flow and dex dev profile.
- `docs/traceability.md` requirement tags (each is just re-pointed at
  the new test names).

---

## 14. Acceptance checklist (final)

- [ ] `make up && make migrate && make web && make run` works on a clean
      checkout; `http://localhost:18080` renders the Svelte app.
- [ ] Every legacy screen has a Svelte equivalent; no functional
      regressions.
- [ ] Every screen registers `Mod+/` showing its shortcuts.
- [ ] `n` opens quick-entry on every list screen; rapid-fire creation
      works.
- [ ] Filter bar uses dropdowns / pickers driven by `attribute_def.select`
      (no hardcoded enums in screen code).
- [ ] Drag-drop placeholders visibly grow on hover; drop targets are
      easy to hit.
- [ ] AdminAttributes lets you create an enum attribute end-to-end
      without a page reload.
- [ ] `make e2e` passes; baseline screenshots committed; one visual-diff
      run produces zero diffs.
- [ ] `pnpm test` (Vitest) covers dispatcher, registry, predicate AST,
      shortcut registry; all green.
- [ ] Bundle size < 150 KB gz total; first paint < 800 ms on local dev.
