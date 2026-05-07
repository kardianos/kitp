# Project-scoped edges and attribute values — design

Status: draft, not yet implemented. Authored 2026-05-06 in response to the
"available edges should be constrained to a given project type and
propagated down; attribute values should be either unique to the project
or unique to the project type" feedback.

## What we have today (2026-05-06)

- `card_type` is global. There is one `task`, one `milestone`, one
  `component`, one `tag` row in `card_type` for the entire installation.
- `attribute_def` is global. One `status`, one `assignee`, one custom
  attribute, etc. Adding an attribute or changing its `value_type` is a
  schema-level event, not a project-level one.
- `edge` couples `(card_type_id, attribute_def_id)` and is also global.
  Binding `priority` to `task` makes priority show up on every task card
  in the system.
- `attribute_def_option` (migration 0012) seeds enum options globally —
  e.g., the `status` enum has the same `todo / doing / review / done`
  values everywhere.
- The seed assumes one project hierarchy. `card.parent_card_id` is a
  loose tree; cards descend from their project ultimately. There is no
  notion of "this `priority` only applies inside Project A".

The result: every project sees the same fields. Two teams that want
different statuses, different milestones, or even different *names* for
their components must either fork the database or share a single global
schema and tolerate clutter.

## What the user is asking for

> Available edges should be constrained to a given project [type] and
> propagated down; individual attribute values should be either unique to
> the project or unique to the project type.

Restated:

1. **Edge scoping** — a `(card_type, attribute_def)` binding should be
   scopable to a project (or a project *type*, if/when projects gain
   subtypes). When a user navigates inside Project A they should only
   see attribute fields A is configured for, not Project B's fields.

2. **Edge propagation** — a binding declared at a project (or project
   type) flows down to every descendant card. Adding a `priority`
   attribute on Project A should make every task in Project A acquire a
   priority field, without re-binding it on each child card type.

3. **Attribute value scoping** — for ref-typed attributes (milestone,
   component, tag) the value cards belong to a project. "Milestone M3"
   on Project A is *not* selectable in Project B. For enum-typed
   attributes the *option list* is scopable: Project A's `priority`
   enum can have `urgent/high/normal/low`; Project B's can have
   `now/next/later`.

The two halves are related but separable. (1)+(2) is a schema-shape
question. (3) is a value-set question. Both need to land before the
"see everything OR see one project" UX feels honest, because
"everything" today still shows a single global enum that doesn't
correspond to any one project's working vocabulary.

## Design

### Concept: project-typed schemas

Introduce `project_type` as a sibling of `card_type`:

```
project_type
  id          serial PK
  name        text UNIQUE
  doc         text
  is_built_in bool
```

Each `card` of card_type='project' carries a `project_type_id`. Existing
projects backfill to a "default" project type so the migration is
non-breaking.

Project types are the unit of schema customization. "Bugs", "Roadmap",
"Marketing campaigns" are project types. Two roadmap projects share
schema; a roadmap and a bug tracker do not.

### Edge scoping

Add `project_type_id` (nullable) to `edge`:

```
ALTER TABLE edge ADD COLUMN project_type_id int REFERENCES project_type(id);
ALTER TABLE edge DROP CONSTRAINT edge_card_type_id_attribute_def_id_key;
ALTER TABLE edge ADD CONSTRAINT edge_uniq UNIQUE (
    card_type_id, attribute_def_id, COALESCE(project_type_id, 0)
);
```

Semantics:

- `project_type_id IS NULL` — global binding. Same shape as today; behaves
  as the catch-all so System User dev mode keeps working.
- `project_type_id = X` — scoped binding. Only cards descended from a
  project of project_type X carry this attribute.

The dispatcher's effective-edge resolver walks `card.parent_card_id` up
to the enclosing project, reads `project.project_type_id`, then unions:
- every global edge for `(card_type_id, *)`
- every edge for `(card_type_id, project_type_id)`

That union is the card's effective attribute set.

### Edge propagation

Edge propagation is implicit in the resolver: a binding on
`(card_type='task', attribute='priority', project_type='Bugs')` shows up
on every task whose enclosing project has `project_type='Bugs'`. Sub-tasks
inherit because the resolver walks parents until it finds a project.

We don't denormalize this into per-card rows; we re-derive on read. The
cost is a small extra join in `card.select_with_attributes` (filter
`edge.project_type_id IS NULL OR edge.project_type_id = $project_type`).

### Attribute value scoping

Two flavors:

#### Ref-typed values (milestone, component, tag)

Already half-scoped by parent: today every milestone is parented to a
project, so "Project A's M3" is a different `card` row from "Project B's
M3". The picker for `milestone_ref` should restrict to milestones whose
parent project ancestor matches the editing card's enclosing project.

Server change: `card.select_with_attributes` already accepts
`parent_card_id`; the client picker pre-fetches with the active project
scope rather than fetching globally.

No schema change required for ref-typed scoping. We just need to wire
the picker's parentCardId to the card's enclosing project.

#### Enum-typed options

Today `attribute_def_option` is a flat list. Add `project_type_id`
(nullable):

```
ALTER TABLE attribute_def_option
    ADD COLUMN project_type_id int REFERENCES project_type(id);
```

Same null-as-wildcard convention as edges. `is_active` (migration 0011)
applies per-option; archiving an option in one project type leaves it
active in the others.

The enum-resolver `attribute_def.select` (and the cached
AttributeSchemaCache on the client) gains a `projectTypeId` parameter.
The client passes the active scope's project type; the server unions
global options with project-type-specific options.

### UI implications

1. **Project type picker (admin)** — new screen at
   `/admin/project-types`. Mirrors `/admin/attributes` (CRUD on
   `project_type` rows + a "Default for projects without an explicit
   type" flag).

2. **Project create flow** — the existing project create dialog gains a
   "Type" combobox. Defaults to the installation's default project type.
   Read-only after creation in the v1 surface; type-migration is hard
   enough that we'll defer it to a follow-up.

3. **Admin/Attributes "Bound to" matrix** — gains a third dimension. The
   current matrix is `card_type × {bound, ordering, required}`. New
   matrix: `(card_type, project_type) × {bound, ordering, required}`,
   with `project_type='*'` meaning "global". The default rendering
   collapses identical rows so simple installations don't see noise.

4. **Inbox / Grid / Kanban** — the existing global project scope (added
   in the same iteration as this doc) already pins a project. Once
   projects carry types, the scope effectively pins a project type too;
   downstream readers (`schemaCache`, picker ref-resolver) read the
   scope's project type.

### Migration order

Forward-only migrations, one per step:

1. **0014 — `project_type` table**, plus a `default` row, plus a
   `project_type_id` column on `card` populated to the default for every
   existing project (and recursively for descendants if we want to denorm,
   though the resolver can derive it on the fly so we only really need
   it on `card_type='project'` rows). Backfill is `WHERE
   card_type_id = (SELECT id FROM card_type WHERE name='project')`.

2. **0015 — `edge.project_type_id`**, nullable, referencing
   `project_type(id)`. Drop and re-add the unique constraint to include
   it. No data backfill needed — every existing edge stays global.

3. **0016 — `attribute_def_option.project_type_id`**, same shape.

4. **0017 — server resolver changes.** Update
   `card.select_with_attributes`, `attribute.update`, `edge.insert`, and
   the dispatcher's effective-edge cache to honor project_type_id. This
   is a code-only migration but it's coupled to the schema migrations
   above; we mark it explicit so a partial rollout is debuggable.

5. **Client follow-ups** (no migration; ship behind a flag if needed):
   admin screens, picker resolver changes, the project-create
   "Type" combobox.

### Risk + open questions

- **Existing card.select_with_attributes consumers.** The handler
  returns *all* attributes today. If we filter to only those bound under
  the active project type, callers that read a project-A task while
  scoped to project-B would lose data. We mitigate by always returning
  attributes the card has a value for, even if no edge is currently
  in-scope. The picker / form UI hides them; the activity stream and
  audit trails still see them.

- **Authz scope.** `role_grant` is `(role, card_type, process)`. Adding
  project_type to the grant tuple is a natural extension; we punt on it
  here because the user's stated need is schema customization, not
  finer-grained authz. A follow-up doc can lift the constraint.

- **Project-type changes.** What happens when a project is moved to a
  different type? Existing cards may carry attribute values for edges
  no longer in scope. The pragmatic answer: keep the values, hide them
  in pickers, surface them as "stale" in the side panel until the user
  clears them. A migration tool that walks values and reports drift is
  a separate deliverable.

- **Performance.** Adding `project_type_id` filters to every read
  doubles the size of the predicate. The candidate join column has
  reasonable selectivity (`project_type` count ≪ `card` count), so the
  planner should be fine, but the server tests need an explicit
  EXPLAIN ANALYZE under realistic seed data before we ship.

- **Inheritance edge cases.** If a sub-task is "donated" across projects
  (legal under `task.allow_self_parent` + a future cross-project move),
  its effective schema flips mid-life. The resolver derives on read so
  it's correct; UX should warn at move time.

### Out of scope for this design

- Per-user attribute customization. ("My status colors.") The model
  here scopes by project, not by viewer.
- Workflow / state-machine constraints attached to enums (statuses
  that can only transition along a graph). This is a separate concern
  that can layer on top of project-scoped enum options.
- Time-bound schema versioning (one project's schema changes; old
  cards keep the old shape). Not asked for; deferred.

## What this iteration ships (without this design)

The companion code changes ship the *infrastructure* the user can build
on:

- A persistent project scope picker (sidebar `<ProjectSelector>` and
  `projectScope` rune store, persisted to sessionStorage). Inbox,
  Grid, and Kanban honor it via a new `parent_card_id` filter on
  `inbox.select` and the existing one on `card.select_with_attributes`.
- Admin "Add value" (milestone / component / tag) now requires an
  active project scope (parents the new card under that project),
  fixing the `card_type "milestone" requires a parent` error.
- An archive flag on value cards (`is_active`) and the back-nav
  preserves the previous list view's filter state.

These are user-visible improvements that don't need the schema-level
changes above. The work in this doc is the next step once the project
scope concept has settled in the UI.
