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
};

/* -------------------------------------------------------------------------- */
/* Users (NON-CARD source).                                                    */
/* -------------------------------------------------------------------------- */

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
    // No updateSpec: a read-only viewer (proving graceful degradation).
    fields: [
      { name: 'display_name', label: 'Display name', kind: 'readonly' },
      { name: 'email', label: 'Email', kind: 'readonly' },
      { name: 'roles', label: 'Roles', kind: 'badges', badgeField: 'role_name' },
      { name: 'is_agent', label: 'Is agent', kind: 'readonly' },
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
    empty: 'Select a screen to view its layout and routing.',
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
};

/* -------------------------------------------------------------------------- */
/* Attributes = attribute_def.select (NON-CARD source, read-only).             */
/* -------------------------------------------------------------------------- */

/**
 * Attribute definitions. Read-only viewer (no inline update handler — defs are
 * structural). The bound card_types render as read-only badges; a structured
 * edge editor (bind / unbind to card_types) is a nested follow-up.
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
    empty: 'Select an attribute to view its type and bindings.',
    fields: [
      { name: 'name', label: 'Name', kind: 'readonly' },
      { name: 'value_type', label: 'Value type', kind: 'readonly' },
      { name: 'target_card_type_name', label: 'Target card type', kind: 'readonly' },
      { name: 'is_built_in', label: 'Built-in', kind: 'readonly' },
      // Bound card_types (edge rows) as read-only chips; edge editing = follow-up.
      { name: 'bound_to', label: 'Bound to', kind: 'badges', badgeField: 'card_type_name' },
    ],
  },
};

/* -------------------------------------------------------------------------- */
/* Workflows = flow.list (NON-CARD source, read-only).                         */
/* -------------------------------------------------------------------------- */

/**
 * Flows (workflows). Read-only viewer; flow STEPS (the transition rows under a
 * flow, via flow_step.list) are a nested follow-up — listed here as a flag, not
 * a blocker.
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
    empty: 'Select a workflow to view its governing attribute + scope.',
    fields: [
      { name: 'name', label: 'Name', kind: 'readonly' },
      { name: 'doc', label: 'Description', kind: 'readonly' },
      { name: 'attribute_def_name', label: 'Attribute', kind: 'readonly' },
      { name: 'scope_card_id', label: 'Scope (project card id)', kind: 'readonly' },
      { name: 'default_create_status_id', label: 'Default create status', kind: 'readonly' },
    ],
  },
};

/* -------------------------------------------------------------------------- */
/* Roles = role.list (NON-CARD source, read-only).                             */
/* -------------------------------------------------------------------------- */

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
    empty: 'Select a role to view its granted (card_type, process) pairs.',
    fields: [
      { name: 'name', label: 'Name', kind: 'readonly' },
      { name: 'doc', label: 'Description', kind: 'readonly' },
      // Each grant is a {card_type, process} object; show the process verb.
      { name: 'grants', label: 'Grants', kind: 'badges', badgeField: 'process' },
    ],
  },
};

/* -------------------------------------------------------------------------- */
/* Agents = user.select { is_agent: true } (NON-CARD source, read-only).       */
/* -------------------------------------------------------------------------- */

/**
 * Agents are user_account rows with is_agent=true owned by a parent user. There
 * is no dedicated agent-list handler; the lighter `user.select` read carries the
 * is_agent + parent_user_id columns this screen needs. Read-only (token mint /
 * revoke is a nested follow-up).
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
    empty: 'Select an agent to view its owner.',
    fields: [
      { name: 'display_name', label: 'Display name', kind: 'readonly' },
      { name: 'parent_user_id', label: 'Owner (parent user id)', kind: 'readonly' },
      { name: 'email', label: 'Email', kind: 'readonly' },
    ],
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
    fields: [
      { name: 'name', label: 'Name', kind: 'readonly' },
      { name: 'channel_type', label: 'Channel type', kind: 'readonly' },
      { name: 'imap_host', label: 'IMAP host', kind: 'readonly' },
      { name: 'smtp_host', label: 'SMTP host', kind: 'readonly' },
      { name: 'from_address', label: 'From address', kind: 'readonly' },
      { name: 'channel_status', label: 'Status', kind: 'readonly' },
    ],
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
    fields: [
      { name: 'name', label: 'Name', kind: 'readonly' },
      { name: 'sink_kind', label: 'Sink kind', kind: 'readonly' },
      { name: 'msgraph_tenant_id', label: 'MS Graph tenant', kind: 'readonly' },
      { name: 'msgraph_team_id', label: 'MS Graph team', kind: 'readonly' },
      { name: 'msgraph_channel_id', label: 'MS Graph channel', kind: 'readonly' },
      { name: 'channel_status', label: 'Status', kind: 'readonly' },
    ],
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
