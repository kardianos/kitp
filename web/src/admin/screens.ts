/**
 * The admin screens — EACH is JUST a MasterDetailConfig, NO bespoke control
 * code. They prove ONE config-driven control generalises across both CARD
 * sources (`card.select_with_attributes` keyed by card_type) and NON-CARD
 * sources (a registered `*.list` / `*.select` spec), editable + read-only, and
 * project-scoped reads that refire on the shared scope.
 *
 * CARD-backed (editable via attribute.update; each carries a structured
 * `list.predicateFilter` so the list ANDs a PredicateFilter tree into its
 * card.select_with_attributes query — where[]/tree):
 *   - Contacts        person cards
 *   - Projects        project cards INCLUDING templates (no is_template filter)
 *   - Screens         screen cards (title/layout/hotkey/sort_order editable);
 *                     the per-screen nested editor curates that screen's filter
 *                     cards + their predicates (no separate Named Filters screen)
 *
 * NON-CARD (spec-registered in admin/specs.ts; read-only unless noted):
 *   - Users           user.list_with_roles      (roles as badges)
 *   - Attributes      attribute_def.select      (bound_to as badges)
 *   - Workflows       flow.list
 *   - Roles           role.list                 (grants as badges)
 *   - Agents          user.select { is_agent }
 *   - Comm Channels   comm_channel.list         (project-scoped; secrets omitted)
 *   - Activity Sinks  activity_sink.list        (project-scoped; secret omitted)
 *   - Comm Log        comm_log.list             (project-scoped; event list)
 *
 * Nested-detail FOLLOW-UPS (deliberately NOT blocking; basic list+detail ship):
 *   - Screens → per-screen filter cards
 *   - Attributes → bound-edge bind/unbind editor
 *   - Workflows → flow_step transition rows
 *
 * `masterDetailScreen(cfg)` builds each config's declarative list query +
 * (when an updateSpec is set) the editable-field update action FROM the config,
 * so the AppShell can mount it with `Control.New('MasterDetail', screen, ctx)`.
 */

import {
  masterDetailScreen,
  type MasterDetailConfig,
} from './master-detail.js';
import type { EnumManagerConfig } from './enum-manager.js';
import type { PeopleManagerConfig } from './people-manager.js';
import type { NestedEditorConfig } from './nested-editor.js';
import type { SchedulerJobsConfig } from './scheduler-jobs.js';
import { COMM_CHANNEL_FORM } from './comm-channel-form.js';
import { WORKFLOW_FORM } from './workflow-form.js';

/** An admin screen is a MasterDetail or its own control (Enums / People /
 *  the standalone OIDC Claims editor / the Jobs screen). */
type AdminScreenConfig =
  | MasterDetailConfig
  | EnumManagerConfig
  | PeopleManagerConfig
  | NestedEditorConfig
  | SchedulerJobsConfig;

/* -------------------------------------------------------------------------- */
/* Contacts = person cards (CARD source).                                      */
/* -------------------------------------------------------------------------- */

/**
 * The PERSON_KIND options for the inline select. `member` = assignable;
 * `contact` = inbound-only (mirrors the Svelte AdminContactsScreen axis). Left
 * read-only here by default; flip `editable: true` to make it a live select.
 */
const PERSON_KIND_OPTIONS = [
  { value: 'member', label: 'Member (assignable)' },
  { value: 'contact', label: 'Contact (inbound only)' },
];

/**
 * The TIER axis for the Contacts create dialog (person.create). Tier subsumes
 * person_kind server-side: contact → kind 'contact'; assignee → kind 'member';
 * user → kind 'member' PLUS a provisioned user_account (email REQUIRED there).
 */
const PERSON_TIER_OPTIONS = [
  { value: 'contact', label: 'Contact (inbound only)' },
  { value: 'assignee', label: 'Assignee (member, no login)' },
  { value: 'user', label: 'User (member + login account)' },
];

export const CONTACTS_SCREEN: MasterDetailConfig = {
  type: 'MasterDetail',
  title: 'Contacts',
  scopeKey: 'admin.contacts',
  list: {
    spec: 'card.select_with_attributes',
    input: { cardTypeName: { lit: 'person' } },
    rowHeight: 56,
    search: { field: 'attributes.title', placeholder: 'Search by name or email…' },
    row: {
      title: 'attributes.title',
      subtitle: 'attributes.email',
      badge: 'attributes.person_kind',
    },
    // Structured filter over person attributes (card-backed screen).
    predicateFilter: { cardType: 'person' },
  },
  detail: {
    titleField: 'attributes.title',
    empty: 'Select a contact to view and edit their details.',
    updateSpec: 'attribute.update',
    fields: [
      { name: 'attributes.title', label: 'Name', kind: 'text', editable: true },
      { name: 'attributes.email', label: 'Email', kind: 'text', editable: true },
      {
        name: 'attributes.person_kind',
        label: 'Kind',
        kind: 'select',
        editable: true,
        options: PERSON_KIND_OPTIONS,
      },
    ],
  },
  // Create a person via person.create — the TIER select (contact/assignee/user)
  // is the classification axis; the 'user' tier provisions a user_account
  // server-side (email is required there). The tier passes through verbatim.
  create: {
    spec: 'person.create',
    title: 'New contact',
    buttonLabel: '+ New',
    fields: [
      { name: 'title', label: 'Name', kind: 'text', required: true, placeholder: 'Full name' },
      { name: 'email', label: 'Email', kind: 'text', placeholder: 'name@example.com' },
      { name: 'tier', label: 'Tier', kind: 'select', required: true, options: PERSON_TIER_OPTIONS },
    ],
    input: {
      title: { payload: 'title' },
      email: { payload: 'email' },
      tier: { payload: 'tier' },
    },
    // The new card surfaces in the list immediately; person.create returns
    // person_card_id, so promote the temp row to that id.
    optimisticRaw: (p) => ({
      attributes: {
        title: typeof p['title'] === 'string' ? p['title'] : '',
        email: typeof p['email'] === 'string' ? p['email'] : '',
        person_kind: p['tier'] === 'contact' ? 'contact' : 'member',
      },
    }),
    resultIdField: 'personCardId',
  },
  delete: {
    spec: 'card.delete',
    confirm: 'Delete this contact?',
    input: { cardId: { payload: 'id' } },
  },
};

/* -------------------------------------------------------------------------- */
/* Users (NON-CARD source).                                                    */
/* -------------------------------------------------------------------------- */

export const USERS_SCREEN: MasterDetailConfig = {
  type: 'MasterDetail',
  title: 'Users',
  scopeKey: 'admin.users',
  // The assignable roles are DATA-DRIVEN from `role.list` (not a hardcoded list
  // that drifts — the old literal was already missing the seeded `commenter`
  // role). Lands {value,label}[] at admin.users.roleOptions for the role select.
  prefetch: [
    { spec: 'role.list', landAt: 'admin.users.roleOptions', valueField: 'name', labelField: 'name' },
  ],
  list: {
    spec: 'user.list_with_roles',
    rowHeight: 56,
    search: { field: 'display_name', placeholder: 'Search users…' },
    row: { title: 'display_name', subtitle: 'email' },
  },
  detail: {
    titleField: 'display_name',
    empty: 'Select a user to view their roles and account details.',
    // Read-only profile fields; role + person relations are the editable surface.
    fields: [
      { name: 'display_name', label: 'Display name', kind: 'readonly' },
      { name: 'email', label: 'Email', kind: 'readonly' },
      { name: 'is_agent', label: 'Is agent', kind: 'readonly' },
    ],
    // The detail-pane relation editors. Each fires a declarative spec and then
    // RELOADS the user row (user.list_with_roles) so the detail reflects the
    // server truth (a re-grant can collapse a duplicate; an unlink touches the
    // sibling user_account_person table).
    relations: [
      {
        title: 'Roles',
        listField: 'roles',
        itemLabel: 'role_name',
        itemSubLabel: 'scope_project_title',
        // Revoke fires user_role.revoke with the user id + the entry's role/scope.
        remove: {
          intent: 'revokeRole',
          spec: 'user_role.revoke',
          label: 'Revoke',
          input: {
            userId: { payload: 'id' },
            roleName: { payload: 'role_name' },
            scopeProjectId: { payload: 'scope_project_id' },
          },
        },
        // Assign fires user_role.set (role + optional project scope id).
        add: {
          intent: 'assignRole',
          spec: 'user_role.set',
          label: '+ Assign role',
          fields: [
            { name: 'role_name', label: 'Role', kind: 'select', required: true, options: { fromPath: 'admin.users.roleOptions' } },
            { name: 'scope_project_id', label: 'Project scope (optional)', kind: 'text', placeholder: 'project card id' },
          ],
          input: {
            userId: { payload: 'id' },
            roleName: { payload: 'role_name' },
            scopeProjectId: { payload: 'scope_project_id' },
          },
        },
      },
      {
        title: 'Linked person',
        // A SINGULAR link: show the linked person card id with an Unlink button
        // when present, else '— (none)'. Unlink fires user.unlink_person and
        // reloads the row. (Linking a person to a user is a nested follow-up.)
        valueField: 'person_card_id',
        remove: {
          intent: 'unlinkPerson',
          spec: 'user.unlink_person',
          label: 'Unlink person',
          input: { userAccountId: { payload: 'id' } },
        },
      },
    ],
  },
};

/* -------------------------------------------------------------------------- */
/* Screens = screen cards (CARD source).                                       */
/* -------------------------------------------------------------------------- */

/** The six built-in layouts a screen card can carry. */
const SCREEN_LAYOUT_OPTIONS = [
  { value: 'kanban', label: 'Kanban' },
  { value: 'grid', label: 'Grid' },
  { value: 'list', label: 'List' },
  { value: 'calendar', label: 'Calendar' },
  { value: 'timeline', label: 'Timeline' },
  { value: 'detail', label: 'Detail' },
];

/**
 * Screen cards. title/hotkey/sort_order are inline-editable; layout is an
 * editable select over the built-in layouts; slug is read-only (it is a URL
 * path segment whose uniqueness the Svelte editor enforces — left read-only
 * here, a slug editor is a nested follow-up). Per-screen FILTER cards (filter
 * cards parent under a screen) are a nested follow-up, NOT a blocker.
 */
export const SCREENS_SCREEN: MasterDetailConfig = {
  type: 'MasterDetail',
  title: 'Screens',
  scopeKey: 'admin.screens',
  // Editing a screen here (rename / hotkey / sort_order / add / delete) should
  // refresh the data-driven sidebar nav, which watches this nonce.
  refreshNonce: 'shell.navRefresh',
  list: {
    spec: 'card.select_with_attributes',
    // Screen cards are parented to their project (card_type_name='screen',
    // parent=project), so scope the list to the active project — the admin
    // Screens list is per-project, never a cross-project mix. Refires when the
    // header project switches; idle until a project resolves.
    input: {
      cardTypeName: { lit: 'screen' },
      parentCardId: { from: 'scope.projectId' },
      // Order by sort_order so the admin list matches the sidebar nav order.
      order: { lit: [{ field: 'attributes.sort_order', direction: 'ASC' }] },
    },
    when: { signal: 'scope.projectId' },
    skipWhenNull: ['parentCardId'],
    rowHeight: 56,
    search: { field: 'attributes.title', placeholder: 'Search screens…' },
    row: {
      title: 'attributes.title',
      subtitle: 'attributes.slug',
      badge: 'attributes.layout',
    },
    // NO predicateFilter: a project has few screens, so the advanced filter is
    // unneeded — and it forced the list onto a `listVersion` trigger seeded once
    // at mount, so when scope.projectId wasn't ready yet the `skipWhenNull` query
    // was skipped and never retried (the "sometimes doesn't show" bug). Without
    // it the list keeps its `{ signal: scope.projectId }` trigger, which fires on
    // mount + every project switch.
  },
  detail: {
    titleField: 'attributes.title',
    empty: 'Select a screen to view its layout, routing, and filters.',
    updateSpec: 'attribute.update',
    fields: [
      { name: 'attributes.title', label: 'Title', kind: 'text', editable: true },
      {
        name: 'attributes.layout',
        label: 'Layout',
        kind: 'select',
        editable: true,
        options: SCREEN_LAYOUT_OPTIONS,
      },
      { name: 'attributes.slug', label: 'Slug', kind: 'readonly' },
      { name: 'attributes.hotkey', label: 'Hotkey', kind: 'text', editable: true },
      { name: 'attributes.sort_order', label: 'Sort order', kind: 'text', editable: true },
    ],
    // Nested filter-card manager: the screen's filter cards (add / edit
    // title+predicate / remove) + the screen's default_filter.
    nested: { kind: 'screenFilters' },
  },
  create: {
    spec: 'card.insert',
    title: 'New screen',
    buttonLabel: '+ New',
    // A screen card REQUIRES title + layout + slug (is_required edges), so the
    // create must collect all three — title-only used to fail an edge_violation
    // (the "New screen doesn't work" bug). layout + slug ride in attributes.
    fields: [
      { name: 'title', label: 'Title', kind: 'text', required: true, placeholder: 'Screen title' },
      { name: 'layout', label: 'Layout', kind: 'select', required: true, options: SCREEN_LAYOUT_OPTIONS, attribute: true },
      { name: 'slug', label: 'Slug', kind: 'text', required: true, placeholder: 'url-slug (unique)', attribute: true },
    ],
    // Parent the new screen to the active project (screens are project-owned).
    input: {
      cardTypeName: { lit: 'screen' },
      parentCardId: { from: 'scope.projectId' },
      attributes: { payload: 'attributes' },
      title: { payload: 'title' },
    },
  },
  delete: {
    spec: 'card.delete',
    confirm: 'Delete this screen?',
    input: { cardId: { payload: 'id' } },
  },
};

/* -------------------------------------------------------------------------- */
/* Attributes = attribute_def.select (NON-CARD source, read-only).             */
/* -------------------------------------------------------------------------- */

/** The value_type axis for the create-attribute dialog (mirrors the Go enum:
 *  text / bool / number / date / card_ref / card_ref[]). The card_ref target is
 *  configured via the bind matrix post-create (no target-on-insert path). */
const ATTR_VALUE_TYPE_OPTIONS = [
  { value: 'text', label: 'Text' },
  { value: 'bool', label: 'Boolean' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'card_ref', label: 'Card reference (single)' },
  { value: 'card_ref[]', label: 'Card reference (multi)' },
];

/**
 * Attribute definitions. Scalar fields read-only (defs are structural). The
 * detail mounts the nested EDGE MATRIX: a bind/unbind toggle over every
 * card_type with per-edge `required` + `ordering` (edge.insert / edge.delete) —
 * see `admin/nested-editor.ts`. Create fires attribute_def.insert (name +
 * value_type); initial binds are made via the matrix after create (the insert
 * has no target-card-type path — the matrix is the bind surface).
 */
export const ATTRIBUTES_SCREEN: MasterDetailConfig = {
  type: 'MasterDetail',
  title: 'Custom attributes',
  scopeKey: 'admin.attributes',
  // Card-type options for the "picker" target select in the create dialog.
  prefetch: [
    { spec: 'card_type.select', landAt: 'admin.attributes.cardTypeOptions', valueField: 'name', labelField: 'name' },
  ],
  list: {
    spec: 'attribute_def.select',
    rowHeight: 56,
    // Hide built-in attributes (title/status/…): they're structural and just
    // make this list confusing. Only user-defined CUSTOM attributes show here.
    rowFilter: (raw) => raw['is_built_in'] !== true,
    search: { field: 'name', placeholder: 'Search custom attributes…' },
    row: { title: 'name', subtitle: 'value_type', badge: 'target_card_type_name' },
  },
  detail: {
    titleField: 'name',
    empty: 'Select a custom attribute to bind / unbind it to card types.',
    fields: [
      { name: 'name', label: 'Name', kind: 'readonly' },
      { name: 'value_type', label: 'Value type', kind: 'readonly' },
      { name: 'target_card_type_name', label: 'Target card type', kind: 'readonly' },
    ],
    // Nested bind/unbind matrix over card_types (required + ordering per edge).
    nested: { kind: 'edgeMatrix' },
  },
  // Create a custom attribute: a SCALAR (text/number/date/bool) or a PICKER
  // (card_ref / card_ref[] → a target card type, like milestone / component).
  // The target is only used for the card_ref value types (the server ignores it
  // otherwise). Binds (which card types USE the attribute) happen via the matrix.
  create: {
    spec: 'attribute_def.insert',
    title: 'New custom attribute',
    buttonLabel: '+ New',
    fields: [
      { name: 'name', label: 'Name', kind: 'text', required: true, placeholder: 'attribute name' },
      { name: 'value_type', label: 'Value type', kind: 'select', required: true, options: ATTR_VALUE_TYPE_OPTIONS },
      { name: 'target_card_type', label: 'Picker target (card_ref only)', kind: 'select', options: { fromPath: 'admin.attributes.cardTypeOptions' } },
    ],
    input: {
      name: { payload: 'name' },
      valueType: { payload: 'value_type' },
      targetCardType: { payload: 'target_card_type' },
    },
    // attribute_def.select rows are flat (name/value_type at the top level), so
    // the optimistic row is flat too — not card-shaped.
    optimisticRaw: (p) => ({
      name: typeof p['name'] === 'string' ? p['name'] : '',
      value_type: typeof p['value_type'] === 'string' ? p['value_type'] : '',
      target_card_type_name: typeof p['target_card_type'] === 'string' ? p['target_card_type'] : '',
      is_built_in: false,
      bound_to: [],
    }),
    resultIdField: 'id',
  },
};

/* -------------------------------------------------------------------------- */
/* Workflows = flow.list (NON-CARD source, read-only).                         */
/* -------------------------------------------------------------------------- */

/**
 * Flows (workflows). The scalar fields (name / attribute / scope) are read-only
 * (a flow's governing attribute + project scope are structural), but the detail
 * mounts the nested flow-step TRANSITION editor: the selected flow's steps
 * grouped by `from` status, with add/edit/delete (flow_step.set/delete) and the
 * flow-delete GUARD (flow.preview_delete → flow.delete) — see
 * `admin/nested-editor.ts`.
 */
export const WORKFLOWS_SCREEN: MasterDetailConfig = {
  type: 'MasterDetail',
  title: 'Workflows',
  scopeKey: 'admin.workflows',
  // The project is IMPLICIT (the active scope), so no project option list is
  // loaded. Only the governed attribute_def needs a populated select.
  prefetch: [
    {
      spec: 'attribute_def.select',
      landAt: 'admin.workflows.attrOptions',
      valueField: 'id',
      labelField: 'name',
    },
  ],
  list: {
    spec: 'flow.list',
    rowHeight: 56,
    search: { field: 'name', placeholder: 'Search workflows…' },
    row: { title: 'name', subtitle: 'doc', badge: 'attribute_def_name' },
    // Scope to the active project like every other admin screen: flow.list
    // filters on scope_card_id, refires on a project switch, and stays idle
    // until a project resolves.
    input: { scopeCardId: { from: 'scope.projectId' } },
    when: { signal: 'scope.projectId' },
    skipWhenNull: ['scopeCardId'],
  },
  // Create a flow (flow.set with id absent → insert). The governed attribute
  // (typically status) is picked from the prefetched defs; the PROJECT is
  // implicit — the flow is created under the ACTIVE project (scope.projectId),
  // not chosen from a list.
  create: {
    spec: 'flow.set',
    title: 'New workflow',
    buttonLabel: '+ New',
    resultIdField: 'id',
    fields: [
      { name: 'name', label: 'Name', kind: 'text', required: true, placeholder: 'Workflow name' },
      { name: 'attribute_def_id', label: 'Governs attribute', kind: 'select', required: true, options: { fromPath: 'admin.workflows.attrOptions' } },
    ],
    input: {
      name: { payload: 'name' },
      // Implicit project scope — the active project, not a form field.
      scopeCardId: { from: 'scope.projectId' },
      attributeDefId: { payload: 'attribute_def_id' },
    },
    // flow.list rows are FLAT ({ name, doc, … }), so the optimistic row must
    // carry `name` (titleField) — otherwise the new row reads "(untitled)"
    // until the post-create server reload lands the canonical row.
    optimisticRaw: (p) => ({ name: typeof p['name'] === 'string' ? p['name'] : '' }),
  },
  detail: {
    titleField: 'name',
    empty: 'Select a workflow to edit it and its transitions.',
    // The generic RecordForm owns the editable scalar fields (name, description,
    // default-create status); the readonly detail header is gone (it couldn't
    // edit doc / default_create_status). Creation stays in the create dialog
    // above (it collects the governed attribute), so the form has allowCreate:
    // false. The flow-step transition editor mounts below it.
    fields: [],
    form: WORKFLOW_FORM,
    // Nested flow-step transition editor (grouped by `from` + delete guard).
    nested: { kind: 'flowSteps' },
  },
};

/* -------------------------------------------------------------------------- */
/* Roles = role.list (NON-CARD source, read-only).                             */
/* -------------------------------------------------------------------------- */

/**
 * Roles. The (card_type, process) GRANTS are READ-ONLY badges: no
 * `role_grant.set` / `role_grant.revoke` handler exists in the backend — grants
 * are seed-managed (db/schema declarative.json), so editing them here is out of
 * scope (would need a new server handler). The OIDC claim_value → role mapping
 * editor used to live nested in this screen; it now has its own Workspace screen
 * ({@link OIDC_CLAIMS_SCREEN}), so this screen is a pure role OVERVIEW.
 */
export const ROLES_SCREEN: MasterDetailConfig = {
  type: 'MasterDetail',
  title: 'Roles',
  scopeKey: 'admin.roles',
  list: {
    spec: 'role.list',
    rowHeight: 56,
    search: { field: 'name', placeholder: 'Search roles…' },
    row: { title: 'name', subtitle: 'doc' },
  },
  detail: {
    titleField: 'name',
    empty: 'Select a role to view its grants. Map OIDC claims to roles on the OIDC Claims screen.',
    fields: [
      { name: 'name', label: 'Name', kind: 'readonly' },
      { name: 'doc', label: 'Description', kind: 'readonly' },
      // Each grant is a {card_type, process} object; show the process verb.
      // Read-only: grants are seed-managed (no set/revoke handler exists).
      { name: 'grants', label: 'Grants (read-only, seed-managed)', kind: 'badges', badgeField: 'process' },
    ],
  },
};

/* -------------------------------------------------------------------------- */
/* OIDC Claims = the standalone role_mapping editor (Workspace screen).         */
/* -------------------------------------------------------------------------- */

/**
 * OIDC Claims. The global `role_mapping` table (claim_value → role) lifted out
 * of the Roles screen into its own Workspace screen. It's the standalone use of
 * the `roleMappings` NestedEditor — which loads independently of any selection,
 * so it needs no parent MasterDetail. `parentScope`/`scopeKey` just namespace
 * its own loaded data; no master row is ever read.
 */
export const OIDC_CLAIMS_SCREEN: NestedEditorConfig = {
  type: 'NestedEditor',
  kind: 'roleMappings',
  title: 'OIDC Claims',
  parentScope: 'admin.oidc_claims',
  scopeKey: 'admin.oidc_claims',
};

/* -------------------------------------------------------------------------- */
/* Agents = user.select { is_agent: true } (NON-CARD source, read-only).       */
/* -------------------------------------------------------------------------- */

/**
 * Agents are user_account rows with is_agent=true owned by a parent user. There
 * is no dedicated agent-list handler; the lighter `user.select` read carries the
 * is_agent + parent_user_id columns this screen needs. Create (agent.create) /
 * delete (agent.delete) via the generic MasterDetail affordances; the nested
 * `agentTokens` editor manages BOTH the agent's roles (the "acts as" grants —
 * loaded per-selection via user_role.list, set/revoked via user_role.set /
 * user_role.revoke, with the parent-grants-subset rule enforced server-side)
 * and its API tokens (secret surfaced ONCE on mint / list / revoke).
 */
export const AGENTS_SCREEN: MasterDetailConfig = {
  type: 'MasterDetail',
  title: 'Agents',
  scopeKey: 'admin.agents',
  list: {
    spec: 'user.select',
    input: { isAgent: { lit: true } },
    rowHeight: 56,
    search: { field: 'display_name', placeholder: 'Search agents…' },
    row: { title: 'display_name', subtitle: 'parent_user_name' },
  },
  detail: {
    titleField: 'display_name',
    empty: 'Select an agent to manage its API tokens, or add one.',
    fields: [
      { name: 'parent_user_name', label: 'Owner', kind: 'readonly' },
      { name: 'email', label: 'Email', kind: 'readonly' },
    ],
    // Nested token manager: mint (one-shot secret reveal) / list / revoke.
    nested: { kind: 'agentTokens' },
  },
  // Create an agent owned by the calling user (agent.create → user_id). The
  // optimistic row is a flat user.select-shaped row; promote to the server id.
  create: {
    spec: 'agent.create',
    title: 'New agent',
    buttonLabel: '+ New',
    fields: [
      { name: 'display_name', label: 'Display name', kind: 'text', required: true, placeholder: 'e.g. research-agent' },
    ],
    input: { displayName: { payload: 'display_name' } },
    optimisticRaw: (p) => ({
      display_name: typeof p['display_name'] === 'string' ? p['display_name'] : '',
      is_agent: true,
    }),
    resultIdField: 'userId',
  },
  delete: {
    spec: 'agent.delete',
    confirm: 'Delete this agent? Active tokens will be revoked.',
    input: { userId: { payload: 'id' } },
  },
};

/* -------------------------------------------------------------------------- */
/* Comm Channels = comm_channel.list (NON-CARD source, project-scoped, RO).    */
/* -------------------------------------------------------------------------- */

/**
 * Comm channels are project-scoped cards; the list endpoint REQUIRES a
 * project_id, so the screen threads `{ from: 'scope.projectId' }` and refires on
 * the shared project scope (`{ signal }` trigger), staying idle until a project
 * resolves (`skipWhenNull`). Read-only; secrets are NEVER on the wire (only
 * has_*_password flags), so nothing sensitive can leak.
 */
export const COMM_CHANNELS_SCREEN: MasterDetailConfig = {
  type: 'MasterDetail',
  title: 'Comm Channels',
  scopeKey: 'admin.comm_channels',
  list: {
    spec: 'comm_channel.list',
    input: { projectId: { from: 'scope.projectId' } },
    when: { signal: 'scope.projectId' },
    skipWhenNull: ['projectId'],
    rowHeight: 56,
    search: { field: 'name', placeholder: 'Search channels…' },
    // Rows are the camelCase CommChannel decoded by the generic codec.
    row: { title: 'name', subtitle: 'fromAddress', badge: 'channelStatus' },
  },
  detail: {
    titleField: 'name',
    empty: 'Pick a project, then select a channel. (Secrets are write-only.)',
    // The generic RecordForm (COMM_CHANNEL_FORM) owns the ENTIRE editable detail
    // — name, hosts/ports/usernames, write-only passwords, the intake-status
    // picker, status, + New, and save + list refresh. No readonly header fields
    // (they'd just duplicate the form), so `fields` is empty.
    fields: [],
    form: COMM_CHANNEL_FORM,
  },
};

/* -------------------------------------------------------------------------- */
/* Activity Sinks = activity_sink.list (NON-CARD, project-scoped, RO).         */
/* -------------------------------------------------------------------------- */

export const ACTIVITY_SINKS_SCREEN: MasterDetailConfig = {
  type: 'MasterDetail',
  title: 'Activity Sinks',
  scopeKey: 'admin.activity_sinks',
  list: {
    spec: 'activity_sink.list',
    input: { projectId: { from: 'scope.projectId' } },
    when: { signal: 'scope.projectId' },
    skipWhenNull: ['projectId'],
    rowHeight: 56,
    search: { field: 'name', placeholder: 'Search sinks…' },
    row: { title: 'name', subtitle: 'sink_kind', badge: 'channel_status' },
  },
  detail: {
    titleField: 'name',
    empty: 'Pick a project, then select a sink. (Client secret is write-only.)',
    // Scalar header summary; the nested config editor owns the full form INCLUDING
    // the write-only msgraph_client_secret + the activity-filter predicate editor.
    fields: [
      { name: 'sink_kind', label: 'Sink kind', kind: 'readonly' },
      { name: 'channel_status', label: 'Status', kind: 'readonly' },
    ],
    nested: { kind: 'activitySinkConfig' },
  },
};

/* -------------------------------------------------------------------------- */
/* Comm Log = comm_log.list (NON-CARD, project-scoped, READ-ONLY list).        */
/* -------------------------------------------------------------------------- */

/**
 * Comm log rows (events). project_id REQUIRED → same scope-thread/idle posture
 * as channels/sinks. Read-only list (kind / at / channel) + a read-only detail
 * of one entry. The kind-specific `detail` jsonb is shown verbatim (the Svelte
 * client has per-kind formatters; a structured detail renderer is a follow-up).
 */
export const COMM_LOG_SCREEN: MasterDetailConfig = {
  type: 'MasterDetail',
  title: 'Comm Log',
  scopeKey: 'admin.comm_log',
  list: {
    spec: 'comm_log.list',
    input: { projectId: { from: 'scope.projectId' } },
    when: { signal: 'scope.projectId' },
    skipWhenNull: ['projectId'],
    rowHeight: 56,
    search: { field: 'kind', placeholder: 'Search by kind…' },
    row: { title: 'kind', subtitle: 'at', badge: 'channel_name' },
  },
  detail: {
    titleField: 'kind',
    empty: 'Pick a project, then select a log entry.',
    fields: [
      { name: 'kind', label: 'Kind', kind: 'readonly' },
      { name: 'at', label: 'At', kind: 'readonly' },
      { name: 'channel_name', label: 'Channel', kind: 'readonly' },
      { name: 'channel_id', label: 'Channel id', kind: 'readonly' },
    ],
  },
};

/* -------------------------------------------------------------------------- */
/* Ready-to-mount configs (declarative queries/actions built from each).       */
/* -------------------------------------------------------------------------- */

/** The Contacts screen config, ready for `Control.New('MasterDetail', …)`. */
export function contactsScreen(): MasterDetailConfig {
  return masterDetailScreen(CONTACTS_SCREEN);
}

/** The Users screen config, ready for `Control.New('MasterDetail', …)`. */
export function usersScreen(): MasterDetailConfig {
  return masterDetailScreen(USERS_SCREEN);
}

/**
 * Admin view key → its built config. Used by the AppShell admin-view router.
 * EVERY entry is config-only: a `MasterDetailConfig` passed through
 * `masterDetailScreen`. No per-screen control code exists.
 */
export type AdminView =
  | 'people'
  | 'agents'
  | 'screens'
  | 'attributes'
  | 'enums'
  | 'workflows'
  | 'roles'
  | 'oidc_claims'
  | 'comm_channels'
  | 'activity_sinks'
  | 'comm_log'
  | 'jobs';

/** The data-driven "Enums" screen — NOT a MasterDetail (one screen spans many
 *  card types). A plain control config; resolved as-is below. */
export const ENUMS_SCREEN: EnumManagerConfig = {
  type: 'EnumManager',
  title: 'Values',
  projectScopePath: 'scope.projectId',
};

/** The unified "People" screen (replaces Contacts + Users): one list with
 *  Users / Assignees / Contacts segment toggles + promote/demote. Its own
 *  control (it merges person cards + user accounts), not a MasterDetail. */
export const PEOPLE_SCREEN: PeopleManagerConfig = {
  type: 'PeopleManager',
  title: 'People',
};

/** The workspace "Background Jobs" screen — lists the server's hard-coded
 *  scheduler jobs with a per-job "Run now". Its own control (data source is
 *  the in-memory scheduler, not a card/DB list), not a MasterDetail. */
export const JOBS_SCREEN: SchedulerJobsConfig = {
  type: 'SchedulerJobs',
  title: 'Background Jobs',
};

// Most admin screens are MasterDetail; a few (Enums) are their own control. The
// registry holds ChildConfig so adding a non-MasterDetail admin screen is one
// entry here + a control — no resolver branch.
// Key order drives the rail-link order within each section (ADMIN_VIEWS =
// Object.keys). Agents sits directly under People in the WORKSPACE section.
const ADMIN_SCREENS: Record<AdminView, AdminScreenConfig> = {
  people: PEOPLE_SCREEN,
  agents: AGENTS_SCREEN,
  screens: SCREENS_SCREEN,
  attributes: ATTRIBUTES_SCREEN,
  enums: ENUMS_SCREEN,
  workflows: WORKFLOWS_SCREEN,
  roles: ROLES_SCREEN,
  oidc_claims: OIDC_CLAIMS_SCREEN,
  comm_channels: COMM_CHANNELS_SCREEN,
  activity_sinks: ACTIVITY_SINKS_SCREEN,
  comm_log: COMM_LOG_SCREEN,
  jobs: JOBS_SCREEN,
};

/** Every admin view key (drives the rail-link list + the resolver). */
export const ADMIN_VIEWS = Object.keys(ADMIN_SCREENS) as AdminView[];

/**
 * Admin views a (project-scoped) MANAGER may open — not just an admin. Today
 * only "Manage values" (enums): managers curate a project's milestone /
 * component / tag value-cards. Everything else stays admin-only. The backend
 * enforces the real per-project manager scope on every write (card.insert /
 * attribute.update / card.delete are worker/manager/admin + project-anchored),
 * so this set only governs UI reachability (rail link + route guard).
 */
export const MANAGER_ADMIN_VIEWS: ReadonlySet<AdminView> = new Set<AdminView>(['enums']);

export type AdminSection = 'workspace' | 'project';

/**
 * Which rail section each admin view belongs to. WORKSPACE = install-wide global
 * data (no project to filter by): People, Agents, Roles, Attributes. PROJECT =
 * always scoped to the active project: Screens, Workflows, Values, and the
 * per-project comm config. Single source of truth for the rail's two
 * sections; every PROJECT view's list query already threads scope.projectId.
 * (Projects themselves are created/edited/deleted on the user-facing overview —
 * the ProjectList — so there's no admin Projects screen.)
 */
export const ADMIN_SECTION: Record<AdminView, AdminSection> = {
  people: 'workspace',
  agents: 'workspace',
  roles: 'workspace',
  oidc_claims: 'workspace',
  attributes: 'workspace',
  screens: 'project',
  enums: 'project',
  workflows: 'project',
  comm_channels: 'project',
  activity_sinks: 'project',
  comm_log: 'project',
  // Workspace-wide: the jobs are global process state, not project-scoped.
  jobs: 'workspace',
};

export function adminScreenConfig(view: AdminView): AdminScreenConfig {
  const cfg = ADMIN_SCREENS[view] ?? CONTACTS_SCREEN;
  // MasterDetail configs are compiled (list query + actions); other control
  // configs (e.g. EnumManager) pass through as-is.
  return cfg.type === 'MasterDetail' ? masterDetailScreen(cfg) : cfg;
}
