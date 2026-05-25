# web/ Feature Gaps — vs the Svelte `client/`

Date: 2026-05-24. The Svelte `client/` is the full feature reference; the new
`web/` client has a solid framework + a slice of screens built. This is the
screen-by-screen gap list (✅ done / 🟡 partial / ❌ missing in `web/`).

**Built so far in `web/`:** framework (signal/control/data/dispatch/hotkeys/
virtual-list), AppShell + rail (signal-driven `shell.view`, **not** URL routing),
ProjectList, Kanban, Grid, ScreenFilterBar (group + search + Advanced predicate),
PredicateFilter, MasterDetail (12 admin screens, mostly read-only).
Many gaps below are **deliberately staged** — the source documents each deferral
and several pure helpers are already ported + unit-tested, awaiting UI wiring.

---

## 1. Task screens

### Kanban (`web/src/kanban` vs `KanbanLayout.svelte`)
- ✅ milestone columns, cross-column drag-move (optimistic+rollback), virtualized columns, h-scroll, empty-column drop.
- ❌ **group-by-axis picker** (re-key columns by status/component/assignee — fixed to milestone).
- ❌ **swim lanes** (2nd `group_by_attr` axis).
- ❌ **within-column reorder** (`sort_order`) — helpers ported, drag UI is cross-column only.
- ❌ **per-column quick-add `+`** (button present but disabled).
- ❌ **card field richness** — cards show title+`#id` only; no assignee/tags on cards.
- ❌ keyboard nav (hjkl / shift-move / Enter-open), open-card → task detail.

### Grid (`web/src/grid` vs `GridLayout.svelte`)
- ✅ full column set, sortable headers (asc→desc→off), tag chips, h+v scroll, virtualized rows.
- 🟡 Created / Last-activity columns render `—` (shared decode doesn't carry those wire fields yet).
- 🟡 persisted sort from a filter card — helpers ported but unused (no active-filter-card wiring).
- ❌ **row grouping** (`group_by_attr` sections + headers) — `walkGrouped` not ported.
- ❌ **per-column filter dropdowns** (header popover leaf).
- ❌ **tag-prefix synthetic columns** (`priority` etc.).
- ❌ **`extra_columns`** screen config.
- ❌ **bulk selection + bulk actions** (assign attrs / move project / purge).
- ❌ inline cell edit; column reorder/resize/show-hide; keyboard nav.

### Inbox / List (`InboxLayout.svelte`) — ❌ **entire screen missing**
`layout:'list'` → NotFound. Missing: personal sorted inbox (`personal_sort_order`),
drag + keyboard manual reorder (`user_card_sort.set`), routed-to-me agent view,
per-row delegate-to-agent (`user_card_agent.set`), in-row comm-status flow steps,
`mine_only` toggle.

---

## 2. Filter / View system (`web/src/filter` + ScreenFilterBar vs `client/src/filter/*`)
- ✅ **structured predicate tree** (AND/OR/NOT, attr/op/value leaves) — `PredicateFilter`, op-catalog matches the backend.
- 🟡 text search (title-only `contains`; Svelte has `in:` multi-scope OR).
- 🟡 group-by picker writes `screen.group` but **nothing reads it** (kanban/grid ignore it).
- ❌ **named / saved filters** (filter cards: pick / save / set-default / rename / delete — `FilterPresetSelector`). *(user-flagged)*
- ❌ **default-filter-per-screen** (first-visit apply, fallback `status notTerminal`).
- ❌ **quick filters / quick chips** (`QuickFilterDropdown`, one-tap per-attr). *(user-flagged)*
- 🟡 **predicate snippets** — `snippet` op exists in the model, but no store/fetch/"Named" multi-select UI.
- ❌ **screen presets / per-screen overrides** (`screen_preset`: layout/slug/hotkey/flow/default_filter/group_by/sort/tag_prefix/extra_columns accessors).
- ❌ toggle_groups UI ("Show closed status").
- 🟡 **view persistence** — predicate/search live only in-session; no (slug, project) cache, no URL, lost on reload.
- ❌ **Export menu** (CSV/xlsx/zip).

---

## 3. Detail & collaboration

### Task detail (`/task/:id`, `TaskDetailScreen.svelte` ~2000 LOC) — ❌ **the single biggest gap**
No route, no control — clicking a card has no destination. Missing:
- **Attribute side panel** — per-attribute inline edit by type (text/number/date/bool/card_ref pickers); needs `card.search`-backed ref pickers.
- **Status changer / TransitionBar** (863 LOC) — phase-bucketed flow transitions, role-gating, `flow_disallowed` rejection banner; needs `flow_step.list_for_card`.
- **Comments** (list + add + edit, markdown) — needs `comment.insert`/`comment.update` + activity derivation + a markdown renderer.
- **Comms / email threads** — comm cards, replies, recipients, start-comm; needs `comm.create`/`comm.list_for_task`/`reply.post`.
- **Attachments** — upload (CAS chunked), list, download, thumbnails, inline image/pdf gallery.
- **Activity feed** — `activity.select` stream + row rendering.
- **Tags editor**, **related/parent tasks** panel, title/description inline edit (markdown), keyboard chords, prev/next-in-list nav, move/delete dialogs.

### Project detail (`/project/:id/screen/:slug`, `ProjectLayout.svelte`) — ❌ **missing** (→ NotFound)
Project header, **ProjectPropertiesPanel** (attribute editor + **export** + **import wizard**), project-scoped task board, per-project screen routing, `n`/`j`/`k` keys.

### Project list (`web/src/projects/project-list.ts`) — ✅ **near parity**
List+search ✅, create ✅ (richer than Svelte), open-tasks `—` ✅, j/k/Enter ✅.
🟡 ✎ edit covers only title/description (Svelte's panel edits all project attrs + export/import). 🟡 ArrowDown search→list focus handoff missing.

### Quick entry (`client/src/quick_entry/*`) — ❌ **missing**
The global `n` → fast task-create overlay (title/desc + assignee/tags/attachments/
"+ Add field", attachments pre-uploaded, success-toast Undo, default-status chain).
`web/` only has a project-create dialog.

### Collaboration API specs not yet registered in `web/`
`card.search`, `comment.insert/update`, `comm.create/list_for_task`, `reply.post`,
`activity.select`, `tag.apply/remove`, `flow_step.list_for_card`, `attachment.create/
list/delete`, `file.create`, `cas.missing_chunks` (+ raw `POST /api/v1/cas/chunk`).

---

## 4. Admin screens (12 configs on `MasterDetail`)
The control does list + search + (card screens) predicate filter + **inline edit of
existing scalar fields only**. **No create, no delete, no nested-collection editors,
no role/token/secret mgmt** anywhere. (The `card.insert` create pattern exists in
ProjectList but isn't surfaced by MasterDetail.)

| Screen | web/ status | Missing |
|---|---|---|
| Users | 🟡 read-only + roles badges | role assign/revoke, link/unlink person, token mint/revoke, agent mgmt |
| Contacts | 🟡 edit name/email/kind | create person (AddPersonDialog), provision-as-user |
| Attributes | 🟡 read-only | create attribute_def, **edge bind/unbind matrix** (required/ordering) |
| Screens | 🟡 edit scalars | create, **nested filter-card management**, slug edit |
| Named Filters | 🟡 edit title/sort/group | create, **predicate editor on the stored predicate**, column config |
| Workflows | 🟡 read-only | create flow, **flow_step transition editor**, delete-with-guards |
| Roles | 🟡 read-only badges | grant matrix edit, role_mapping (claim→role) |
| Agents | 🟡 read-only | create/delete agent, token mint/revoke, per-card routing |
| Comm Channels | 🟡 read-only | create/edit, IMAP/SMTP + **write-only secrets**, intake/status |
| Activity Sinks | 🟡 read-only | create/edit, MS-Graph + secret, **activity filter editor** |
| Comm Log | 🟡 read-only list | `since`/kind server filters, pagination, per-kind formatters |
| Import Wizard | ❌ missing | the whole upload→map→preview→commit flow |
| Export | ❌ missing | project CSV/xlsx/zip |

---

## 5. Cross-cutting
- ❌ **URL routing / deep-links / route guards** — `web/` uses a `shell.view` signal; no shareable URLs, no back/forward, no deep-link to screen/task/admin, no `requireAdmin` guard. Affects every screen.
- 🟡 **keyboard** — strong chord engine + global `g p/a/i/g/k`/`?` ✅; per-screen/per-row `j/k/Enter/n//` ❌.
- ❌ **Help (`?`) overlay** — `toggleHelp` intent is emitted but **unhandled** (no overlay control). Low-effort, high-value (the hotkey registry can render itself).
- ❌ **Markdown render+sanitize** — `marked`/`dompurify` not even imported in `web/src` (needed for descriptions/comments/help).
- ❌ **Popover / floating-ui** — native `<select>` everywhere; no anchored dropdowns/combobox/date-picker.
- 🟡 **auth** — SSO-bounce only (intended); no dev-login path (harder local dev without an OIDC provider).
- ❌ **attachment gallery** (no attachment code at all).
- 🟡 **a11y** — some aria; no focus trap/restore, no roving tabindex.
- ✅ toast/fault funnel, theme toggle.
- (Idempotency keys on writes: neither client sends one — parity, but open if the server wants it.)

---

## Top gaps, ranked by user-visible impact
1. **Task detail screen (`/task/:id`)** — the biggest single hole; everything below it (transitions, comments, attributes, attachments, activity) hangs off it.
2. **Named/saved filters + default-per-screen + quick filters** — the backbone of the view system, explicitly flagged by the owner.
3. **URL routing / deep-links / guards** — no shareable/navigable URLs across the whole app.
4. **Inbox/List screen** — a whole primary screen renders NotFound.
5. **Admin create/delete + nested editors** — 11/12 admin screens are view/edit-scalar only (edge matrix, flow steps, screen filters, role grants, secrets, agent/token mgmt).
6. **Status changer / TransitionBar** — the core workflow-move action.
7. **Grid row grouping + tag-prefix columns + bulk actions**; **Kanban group-by-axis + swim lanes + within-column reorder + quick-add**.
8. **Quick-entry overlay**, **Import wizard**, **Export**.
9. **Supporting primitives** blocking the above: markdown render, popover/combobox, attachment/CAS pipeline, `card.search`.

## Staged-deferral note
Several gaps are wiring-not-rewrite: within-column reorder, `walkGrouped` (grid
grouping), tag-prefix, `sortStatesFromFilter` are **already ported + tested** in
`web/`, awaiting UI; the deferrals are documented inline (`kanban.ts:38-44`,
`grid.ts:43-48`, `grid-helpers.ts:19-23`, `screen-filter-bar.ts:22-27`,
`screens.ts:26-30`).
