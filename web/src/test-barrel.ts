/**
 * Test-only barrel. Bundles the core framework + the real screen controls so
 * `node --test` can drive them through ONE shared `Control` singleton (same
 * reasoning as src/core/index.ts — separate bundles would each get their own
 * registry + NotFound wiring). Not imported by the app; main.ts imports the
 * modules directly (esbuild dedupes within the one app bundle).
 */

export * from './core/index.js';

// Pure helpers + specs.
export * from './kanban/kanban-helpers.js';
export { SPEC } from './kanban/specs.js';
export { registerKanbanSpecs } from './kanban/specs.js';
export * from './projects/project-helpers.js';
export { PROJECT_SPEC, registerProjectSpecs } from './projects/specs.js';

// Grid: pure helpers + the card_ref priming.
export * from './grid/grid-helpers.js';
export { registerGridCardRefAttrs } from './grid/specs.js';

// Filter: the predicate model + op-catalog, the attribute-schema model, the
// PredicateFilter control + its spec registrar. (CardWherePredicate is already
// re-exported via project-helpers above; we re-export the rest explicitly to
// avoid an `export *` name clash on it.)
export {
  type Op,
  type OpArity,
  type ValueType,
  type Phase,
  type Predicate,
  type PredicateLeaf,
  type PredicateGroup,
  type WireNode,
  OP_TO_WIRE,
  OP_LABELS,
  OPS_BY_VALUE_TYPE,
  PHASES,
  opToWire,
  opFromWire,
  opArity,
  opLabel,
  opsForValueType,
  isPhase,
  toWire,
  fromWire,
  isValid,
  isFlatAndOfLeaves,
  toWhereLeaves,
  fromWhereLeaves,
  leaf,
  group,
  andOf,
  orOf,
  notOf,
  emptyRoot,
} from './filter/predicate.js';
export {
  type AttrSchema,
  type SchemaSource,
  friendlyLabel,
  normalizeValueType,
  attrSchemaFromDef,
  schemaForCardType,
  resolveSchema,
  findAttr,
} from './filter/attribute-schema.js';
export {
  PredicateFilter,
  registerPredicateFilter,
  type PredicateFilterConfig,
} from './filter/predicate-filter.js';
export { registerFilterSpecs } from './filter/specs.js';

// Real screen controls + their registrars.
export { Kanban, Column, TaskCard, registerKanbanControls, _resetDragState } from './kanban/kanban.js';
export { ScreenHost, layoutToControlType, registerScreenHost } from './shell/screen-host.js';
export { ScreenFilterBar, registerScreenFilterBar } from './shell/screen-filter-bar.js';
export { Grid, registerGrid } from './grid/grid.js';
export { TagChip, registerTagChip } from './grid/tag-chip.js';
export { AppShell, registerAppShell, shellHotkeys } from './shell/app-shell.js';
export { ProjectList, registerProjectList } from './projects/project-list.js';

// Admin: the reusable MasterDetail control + its config-building helpers + the
// two proof-of-reuse screen configs + the user.* specs.
export {
  MasterDetail,
  registerMasterDetail,
  masterDetailScreen,
  listQuery,
  updateAction,
  normaliseRow,
  filterItems,
  fieldText,
  readPath,
} from './admin/master-detail.js';
export { registerAdminSpecs, ADMIN_SPEC } from './admin/specs.js';
export {
  CONTACTS_SCREEN,
  USERS_SCREEN,
  PROJECTS_SCREEN,
  SCREENS_SCREEN,
  NAMED_FILTERS_SCREEN,
  ATTRIBUTES_SCREEN,
  WORKFLOWS_SCREEN,
  ROLES_SCREEN,
  AGENTS_SCREEN,
  COMM_CHANNELS_SCREEN,
  ACTIVITY_SINKS_SCREEN,
  COMM_LOG_SCREEN,
  contactsScreen,
  usersScreen,
  adminScreenConfig,
  ADMIN_VIEWS,
} from './admin/screens.js';

// Mock data for the canned-backend tests.
export {
  mockTransport,
  DEMO_PROJECT_ID,
  FAULT_CARD_ID,
  CREATED_PROJECT_ID,
  FAULT_CREATE_TITLE,
} from './kanban/mock-data.js';
