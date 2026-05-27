# web/ Feature Gaps — vs the Svelte `client/`

Date: 2026-05-25 (revised after the data-driven sweep + UX punch-list). The
Svelte `client/` remains the full feature reference. The `web/` client has closed
every screen-level gap and is now ahead of `client/` in places (the filter/
column vocabularies are fully data-driven from the server schema).

**Health:** `tsgo --noEmit` (the project typechecker; `src/**/*.ts` only) is
clean; `npm test` is green (**460 tests**). Remaining gaps below are narrow
richness/polish items, each documented inline at the cited source location.

> Status legend: ✅ done · 🟡 partial · ❌ missing in `web/`.

---

## Landed this session (2026-05-25)

- **Data-driven vocabulary sweep** — group picker options, quick-filter chips,
  the ref-picker option lists, the bulk-action-bar assignable attrs, AND the
  Grid column set are all derived from the project's `attribute_def.select` /
  `card_type.select` schema + the screen's `extra_columns` / `tag_prefix_columns`
  config — no hardcoded attribute/role lists. New seams: `filter/vocabulary.ts`
  (`refAxesForCardType`), `filter/group-axis.ts` (`groupAxisForAttr`),
  `grid/grid-helpers.ts` (`buildGridColumns`/`tagPrefixValue`). Admin role-assign
  options now come from `role.list` (a new MasterDetail `prefetch`).
- **Grid columns data-driven** (#17) — ref columns from the schema axes, the
  Priority column from `tag_prefix_columns`, Due from `extra_columns`; the table
  rebuilds its header + list when the column set resolves.
- **Task-detail UX** — flow/transition controls moved into the header beside the
  title; description ✎ on its label row; auto-growing description + comment
  textareas (`util/autosize.ts`); condensed comment meta (`author · time`);
  click-an-attribute opens its picker directly; **+ New sub-task** (quick-entry
  prefilled `parent_task`); `e t`/`e d`/`e c`/`e p` edit chords; `[`/`]` + `j`/`k`
  prev/next **jump navigation** through the source list (`shell/task-nav.ts`).
- **Filter/grid** — "No group" option; quick chips populated on every screen;
  Grid refetches on task-create (`tasks.createdNonce`); View actions collapsed
  into a "⋯" overflow menu; removed the `SparkleChart` demo child.
- **Hotkeys** — a chord prefix (e.g. `g`) is no longer swallowed while typing in
  an input/textarea/contenteditable.
- **Dev auth** — on a 401 the client auto-`dev-login`s + reloads in
  `AUTH_MODE=off`, else bounces to SSO (self-configuring, no env flag), so the
  SPA is usable locally without an OIDC provider.

---

## Built & wired (was ❌ in earlier revisions)

- **Routing** — History-API router: deep-links, back/forward,
  `/project/:id/screen/:slug`, `/task/:id`, `/admin/:key`, `requireAdmin`.
- **Task detail** — two-column layout; title/description inline markdown edit;
  **attribute side panel** (inline edit by `value_type`); **TransitionBar**
  (bucketed flow transitions + role-gating + rejection banner); **Comments +
  Activity feed**; **Attachments** (chunked CAS upload + gallery); **Tags
  editor**; **Related/parent tasks** + **+ New sub-task**.
- **Inbox / List**, **Project detail** (+ ProjectPropertiesPanel), **Project
  list**.
- **Filter / view system** — structured predicate tree, data-driven quick chips,
  named/saved filters + preset selector, group-by axis, default-filter-on-first-
  visit.
- **Admin (12 views on MasterDetail)** — list/search/predicate + create + delete
  + inline edit + nested editors (flow steps, edge matrix, screen filters,
  comm/activity-sink secrets, agent tokens, role mappings); role assign/revoke;
  `person.create`.
- **Quick-entry overlay**, **Import wizard** (#41), **Export menu** (#42).
- **Primitives** — Combobox, DatePicker, RefPicker, Popover, markdown render+
  sanitize, Help (`?`) overlay.
- **Kanban** — group-by-axis picker, within-column reorder, generalized cross-
  column move, virtualized columns.
- **Grid** — **data-driven column set** (#17, ref + tag-prefix + extra columns),
  **row grouping** (`group_by_attr` walk), sortable headers, tag chips,
  virtualized rows, **bulk-action bar** (assign / move / purge).

---

## Recently closed (2026-05-25, second pass)

- ✅ **Comms / email threads** (task detail) — `comm.list_for_task` / `comm.create`
  / `comm.set_recipients` / `reply.post`; the `CommThreads` control (start-comm
  form + per-comm recipients editor + reply composer) in the task-detail `comms` slot.
- ✅ **Grid per-column filters** (ref-column header funnels → `attr in […]` leaf)
  + **column show/hide/reorder** (a "Columns" menu, persisted to `screen.columnConfig`).
- ✅ **Grid Created / Last-activity** now decode from the top-level wire fields.
- ✅ **Kanban per-column quick-add `+`** (wired) + **card richness** (assignee +
  tag chips) + **hjkl card nav** (h/l columns · j/k cards · Shift+H/L move-card).
- ✅ **Workflow create + rename** (`flow.set`: MasterDetail create + nested-editor rename).
- ✅ **Server-driven help** — the `?` overlay loads `help.get_topic` for a
  route-derived topic and renders the markdown above the keybindings.
- ✅ **Kanban swim lanes** — a 2nd LANE axis (filter-bar picker → `screen.laneAxis`)
  splits the board into lanes × columns; cross-lane drag re-keys both axes.

## Recently closed (2026-05-25, third pass — grid + a11y polish)

- ✅ **Grid view persistence** — the active group/lane axis (and restored filter
  state) caches per `(project, slug)` to `localStorage` (`filter/view-persistence.ts`)
  and rehydrates on a cold reload to a bare URL.
- ✅ **Grid column resize** — header grabber drags a column width, flushed to
  `screen.columnConfig.widths`; the CSS grid tracks recompute from the dynamic set.
- ✅ **a11y focus-trap/restore** — overlays trap Tab within their boundary and
  restore focus to the opener on close (`util/focus-trap.ts`).
- ✅ **Grid inline cell edit** — double-click an editable cell (ref → RefPicker,
  date → DatePicker, scalar → input); commit optimistically patches `grid.tasks`
  and fires `attribute.update`, reverting via refetch on error. Recycling-safe:
  the editor survives re-renders of the same card and tears down when the pooled
  row recycles to another card.

## Genuinely remaining

### Backend capabilities with no web caller (from the wire-contract diff)
Every `endpoint.action` the web client calls resolves to a backend handler (0
mismatches). The remaining un-ported ones are minor:
- 🟡 **Minor / verify** — `project.stamp`, `card.move` (reparent),
  `card.set_phase`, `card.undelete`, `person.upsert_by_email`, `help.get_screen`
  (the `?` overlay uses `help.get_topic`; the per-screen variant is unused).

### Cross-cutting polish
- 🟡 **per-row keyboard nav** — task-detail jump nav (`[`/`]`,`j`/`k`) ✅; grid
  rows open on Enter/`o` + select on Space ✅; per-row arrow-key cursor movement
  on grid/inbox/list is still partial; **roving tabindex** across grid rows /
  kanban cards not yet wired (focus-trap shipped).

### Intentional non-ports / verify-only
- **No dev-login screen** — SSO-only by design; the 401 auto-recovery (above)
  covers local dev in `AUTH_MODE=off`.
- **Standalone global ActivityScreen** — the old client carries it but does not
  route to it; `activity.select` is fully used inside task-detail. Confirm before
  porting.
