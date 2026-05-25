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
 *   - Screens         screen cards (title/layout/hotkey/sort_order editable)
 *   - Named Filters   filter cards (predicate read-only)
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

/** The assignable roles (seed.hcsv: viewer / worker / manager / admin). */
const USER_ROLE_OPTIONS = [
  { value: 'viewer', label: 'Viewer' },
  { value: 'worker', label: 'Worker' },
  { value: 'manager', label: 'Manager' },
  { value: 'admin', label: 'Admin' },
];

export const USERS_SCREEN: MasterDetailConfig = {
  type: 'MasterDetail',
  title: 'Users',
  scopeKey: 'admin.users',
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
            { name: 'role_name', label: 'Role', kind: 'select', required: true, options: USER_ROLE_OPTIONS },
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
/* Projects (admin) = project cards (CARD source, INCLUDING templates).        */
/* -------------------------------------------------------------------------- */

/**
 * Unlike the user-facing ProjectList (which ships an `is_template != true`
 * predicate leaf), the admin Projects screen lists EVERY project card so
 * templates are manageable. title/description are editable via attribute.update;
 * is_template is a read-only flag (templating is structural, not an inline edit).
 */
export const PROJECTS_SCREEN: MasterDetailConfig = {
  type: 'MasterDetail',
  title: 'Projects',
  scopeKey: 'admin.projects',
  list: {
    spec: 'card.select_with_attributes',
    input: { cardTypeName: { lit: 'project' } },
    rowHeight: 56,
    search: { field: 'attributes.title', placeholder: 'Search projects…' },
    row: {
      title: 'attributes.title',
      subtitle: 'attributes.description',
      badge: 'attributes.is_template',
    },
    // Structured filter over project attributes (card-backed screen).
    predicateFilter: { cardType: 'project' },
  },
  detail: {
    titleField: 'attributes.title',
    empty: 'Select a project to view and edit it (templates included).',
    updateSpec: 'attribute.update',
    fields: [
      { name: 'attributes.title', label: 'Title', kind: 'text', editable: true },
      { name: 'attributes.description', label: 'Description', kind: 'textarea', editable: true },
      { name: 'attributes.is_template', label: 'Is template', kind: 'readonly' },
    ],
  },
  // Create a top-level project card (title is the key field; description is an
  // inline edit after create). Delete soft-deletes the card.
  create: {
    spec: 'card.insert',
    title: 'New project',
    buttonLabel: '+ New',
    fields: [{ name: 'title', label: 'Title', kind: 'text', required: true, placeholder: 'Project title' }],
    input: {
      cardTypeName: { lit: 'project' },
      title: { payload: 'title' },
    },
  },
  delete: {
    spec: 'card.delete',
    confirm: 'Delete this project? This cannot be undone.',
    input: { cardId: { payload: 'id' } },
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
  list: {
    spec: 'card.select_with_attributes',
    input: { cardTypeName: { lit: 'screen' } },
    rowHeight: 56,
    search: { field: 'attributes.title', placeholder: 'Search screens…' },
    row: {
      title: 'attributes.title',
      subtitle: 'attributes.slug',
      badge: 'attributes.layout',
    },
    // Structured filter over screen attributes (card-backed screen).
    predicateFilter: { cardType: 'screen' },
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
    fields: [{ name: 'title', label: 'Title', kind: 'text', required: true, placeholder: 'Screen title' }],
    input: {
      cardTypeName: { lit: 'screen' },
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
/* Named Filters = filter cards (CARD source).                                 */
/* -------------------------------------------------------------------------- */

/**
 * Filter cards. title/sort/group_by_attr are inline-editable; the predicate is
 * read-only for now (it is a JSON-text predicate tree the Svelte client edits
 * via a structured FilterTreeEditor — a structured predicate editor is a nested
 * follow-up, not a blocker).
 */
export const NAMED_FILTERS_SCREEN: MasterDetailConfig = {
  type: 'MasterDetail',
  title: 'Named Filters',
  scopeKey: 'admin.filters',
  list: {
    spec: 'card.select_with_attributes',
    input: { cardTypeName: { lit: 'filter' } },
    rowHeight: 56,
    search: { field: 'attributes.title', placeholder: 'Search filters…' },
    row: {
      title: 'attributes.title',
      subtitle: 'attributes.predicate',
      badge: 'attributes.group_by_attr',
    },
    // Structured filter over filter-card attributes (card-backed screen).
    predicateFilter: { cardType: 'filter' },
  },
  detail: {
    titleField: 'attributes.title',
    empty: 'Select a named filter to view its predicate.',
    updateSpec: 'attribute.update',
    fields: [
      { name: 'attributes.title', label: 'Title', kind: 'text', editable: true },
      // Predicate stays read-only (structured tree editor = nested follow-up).
      { name: 'attributes.predicate', label: 'Predicate', kind: 'readonly' },
      { name: 'attributes.sort', label: 'Sort', kind: 'text', editable: true },
      { name: 'attributes.group_by_attr', label: 'Group by', kind: 'text', editable: true },
    ],
  },
  create: {
    spec: 'card.insert',
    title: 'New named filter',
    buttonLabel: '+ New',
    fields: [{ name: 'title', label: 'Title', kind: 'text', required: true, placeholder: 'Filter name' }],
    input: {
      cardTypeName: { lit: 'filter' },
      title: { payload: 'title' },
    },
  },
  delete: {
    spec: 'card.delete',
    confirm: 'Delete this named filter?',
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
  title: 'Attributes',
  scopeKey: 'admin.attributes',
  list: {
    spec: 'attribute_def.select',
    rowHeight: 56,
    search: { field: 'name', placeholder: 'Search attributes…' },
    row: { title: 'name', subtitle: 'value_type', badge: 'target_card_type_name' },
  },
  detail: {
    titleField: 'name',
    empty: 'Select an attribute to bind / unbind it to card types.',
    fields: [
      { name: 'name', label: 'Name', kind: 'readonly' },
      { name: 'value_type', label: 'Value type', kind: 'readonly' },
      { name: 'target_card_type_name', label: 'Target card type', kind: 'readonly' },
      { name: 'is_built_in', label: 'Built-in', kind: 'readonly' },
    ],
    // Nested bind/unbind matrix over card_types (required + ordering per edge).
    nested: { kind: 'edgeMatrix' },
  },
  // Create a custom attribute_def (name + value_type). The id lands in the
  // result; promote the optimistic row to it. Binds happen via the matrix.
  create: {
    spec: 'attribute_def.insert',
    title: 'New attribute',
    buttonLabel: '+ New',
    fields: [
      { name: 'name', label: 'Name', kind: 'text', required: true, placeholder: 'attribute name' },
      { name: 'value_type', label: 'Value type', kind: 'select', required: true, options: ATTR_VALUE_TYPE_OPTIONS },
    ],
    input: {
      name: { payload: 'name' },
      valueType: { payload: 'value_type' },
    },
    // attribute_def.select rows are flat (name/value_type at the top level), so
    // the optimistic row is flat too — not card-shaped.
    optimisticRaw: (p) => ({
      name: typeof p['name'] === 'string' ? p['name'] : '',
      value_type: typeof p['value_type'] === 'string' ? p['value_type'] : '',
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
  list: {
    spec: 'flow.list',
    rowHeight: 56,
    search: { field: 'name', placeholder: 'Search workflows…' },
    row: { title: 'name', subtitle: 'doc', badge: 'attribute_def_name' },
  },
  detail: {
    titleField: 'name',
    empty: 'Select a workflow to view its transitions.',
    fields: [
      { name: 'name', label: 'Name', kind: 'readonly' },
      { name: 'doc', label: 'Description', kind: 'readonly' },
      { name: 'attribute_def_name', label: 'Attribute', kind: 'readonly' },
      { name: 'scope_card_id', label: 'Scope (project card id)', kind: 'readonly' },
      { name: 'default_create_status_id', label: 'Default create status', kind: 'readonly' },
    ],
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
 * scope (would need a new server handler). The editable surface is the nested
 * `roleMappings` editor: the global OIDC claim_value → role mapping table
 * (role_mapping.set / role_mapping.delete). The mapping editor renders
 * independently of the role selection (the table is global, not per-role).
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
    empty: 'Select a role to view its grants. Claim→role mappings are below.',
    fields: [
      { name: 'name', label: 'Name', kind: 'readonly' },
      { name: 'doc', label: 'Description', kind: 'readonly' },
      // Each grant is a {card_type, process} object; show the process verb.
      // Read-only: grants are seed-managed (no set/revoke handler exists).
      { name: 'grants', label: 'Grants (read-only, seed-managed)', kind: 'badges', badgeField: 'process' },
    ],
    // Nested OIDC claim_value → role mapping editor (global table).
    nested: { kind: 'roleMappings' },
  },
};

/* -------------------------------------------------------------------------- */
/* Agents = user.select { is_agent: true } (NON-CARD source, read-only).       */
/* -------------------------------------------------------------------------- */

/**
 * Agents are user_account rows with is_agent=true owned by a parent user. There
 * is no dedicated agent-list handler; the lighter `user.select` read carries the
 * is_agent + parent_user_id columns this screen needs. Create (agent.create) /
 * delete (agent.delete) via the generic MasterDetail affordances; the nested
 * `agentTokens` editor mints (secret surfaced ONCE) / lists / revokes API tokens.
 * Role grants for an agent are managed on the Users screen (the parent-grants-
 * subset rule is enforced server-side).
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
    row: { title: 'display_name', subtitle: 'parent_user_id' },
  },
  detail: {
    titleField: 'display_name',
    empty: 'Select an agent to manage its API tokens, or add one.',
    fields: [
      { name: 'parent_user_id', label: 'Owner (parent user id)', kind: 'readonly' },
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
    row: { title: 'name', subtitle: 'from_address', badge: 'channel_status' },
  },
  detail: {
    titleField: 'name',
    empty: 'Pick a project, then select a channel. (Secrets are write-only.)',
    // The scalar header shows the at-a-glance summary; the nested config editor
    // below owns the full editable form INCLUDING the write-only IMAP/SMTP
    // passwords (blank on load; sent only when typed) + a "+ New channel" path.
    fields: [
      { name: 'channel_type', label: 'Channel type', kind: 'readonly' },
      { name: 'from_address', label: 'From address', kind: 'readonly' },
      { name: 'channel_status', label: 'Status', kind: 'readonly' },
    ],
    nested: { kind: 'commChannelConfig' },
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
  | 'contacts'
  | 'users'
  | 'projects'
  | 'screens'
  | 'filters'
  | 'attributes'
  | 'workflows'
  | 'roles'
  | 'agents'
  | 'comm_channels'
  | 'activity_sinks'
  | 'comm_log';

const ADMIN_SCREENS: Record<AdminView, MasterDetailConfig> = {
  contacts: CONTACTS_SCREEN,
  users: USERS_SCREEN,
  projects: PROJECTS_SCREEN,
  screens: SCREENS_SCREEN,
  filters: NAMED_FILTERS_SCREEN,
  attributes: ATTRIBUTES_SCREEN,
  workflows: WORKFLOWS_SCREEN,
  roles: ROLES_SCREEN,
  agents: AGENTS_SCREEN,
  comm_channels: COMM_CHANNELS_SCREEN,
  activity_sinks: ACTIVITY_SINKS_SCREEN,
  comm_log: COMM_LOG_SCREEN,
};

/** Every admin view key (drives the rail-link list + the resolver). */
export const ADMIN_VIEWS = Object.keys(ADMIN_SCREENS) as AdminView[];

export function adminScreenConfig(view: AdminView): MasterDetailConfig {
  const cfg = ADMIN_SCREENS[view];
  // Fall back to Contacts for an unknown key (NotFound is preserved upstream:
  // the AppShell resolver returns null for keys not in ADMIN_VIEWS).
  return masterDetailScreen(cfg ?? CONTACTS_SCREEN);
}
