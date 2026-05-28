/**
 * Test-only barrel. Bundles the core framework + the real screen controls so
 * `node --test` can drive them through ONE shared `Control` singleton (same
 * reasoning as src/core/index.ts — separate bundles would each get their own
 * registry + NotFound wiring). Not imported by the app; main.ts imports the
 * modules directly (esbuild dedupes within the one app bundle).
 */

export * from './core/index.js';

// Auth-state service: the current-user identity landed by the boot /auth/me
// probe + the reactive helpers the role-aware UI reads.
export {
  AUTH_USER_PATH,
  loadAuthUser,
  fetchMe,
  authUserFromWire,
  authUser,
  peekAuthUser,
  isAdmin as authIsAdmin,
  peekIsAdmin as authPeekIsAdmin,
  currentUserId as authCurrentUserId,
  peekCurrentUserId as authPeekCurrentUserId,
  currentPersonId as authCurrentPersonId,
  peekCurrentPersonId as authPeekCurrentPersonId,
  type AuthUser,
  type MeProbe,
} from './auth/auth-state.js';

// Pure helpers + specs.
export * from './kanban/kanban-helpers.js';
export { SPEC } from './kanban/specs.js';
export { registerKanbanSpecs } from './kanban/specs.js';
export * from './projects/project-helpers.js';
export { PROJECT_SPEC, registerProjectSpecs } from './projects/specs.js';

// Grid: pure helpers + the card_ref priming + the bulk-action write specs.
export * from './grid/grid-helpers.js';
export {
  registerGridCardRefAttrs,
  registerGridBulkSpecs,
  GRID_SPEC,
  type TaskMoveInput,
  type TaskMoveOutput,
  type TaskPurgeInput,
  type TaskPurgeOutput,
} from './grid/specs.js';
export { BulkActionBar, registerBulkActionBar, type BulkActionBarConfig } from './grid/bulk-action-bar.js';

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
  topLevelLeafForAttr,
  upsertTopLevelLeaf,
  removeTopLevelLeaf,
  topLevelPhases,
  withTopLevelPhases,
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
export {
  QuickChips,
  registerQuickChips,
  DEFAULT_TASK_CHIPS,
  type QuickChipsConfig,
  type QuickChipDef,
} from './filter/quick-chips.js';
export {
  NamedFilters,
  registerNamedFilters,
  SNIPPET_ATTR,
  snippetLeaf,
  selectedSnippetIds,
  setSelectedSnippets,
  type NamedFiltersConfig,
} from './filter/named-filters.js';
export { registerFilterSpecs } from './filter/specs.js';
export {
  FilterPresetSelector,
  registerFilterPresetSelector,
  type FilterPresetSelectorConfig,
} from './filter/filter-preset-selector.js';
export {
  registerFilterCardSpecs,
  type CardDeleteInput,
  type CardDeleteOutput,
} from './filter/filter-card-specs.js';
export {
  loadScreenAndFilters,
  layoutRequiresGroup,
  defaultGroupForLayout,
  viewActionsForLayout,
  KANBAN_DEFAULT_GROUP_ATTR,
  screenStatePath,
  readSlug,
  readLayout,
  readTitle as readScreenTitle,
  readDefaultFilterID,
  readGroupByAttr,
  readSortBy,
  readPredicate,
  readPhaseToggles,
  type ScreenPresetSet,
  type PhaseToggle,
} from './filter/screen-resolve.js';

// Real screen controls + their registrars.
export { Kanban, Column, TaskCard, registerKanbanControls, _resetDragState } from './kanban/kanban.js';
export { ScreenHost, layoutToControlType, registerScreenHost } from './shell/screen-host.js';
export { AccountPage, registerAccountPage } from './shell/account-page.js';
export { logout, LOGOUT_PATH } from './shell/logout.js';
export { ScreenFilterBar, registerScreenFilterBar, focusScreenSearch } from './shell/screen-filter-bar.js';
export { Grid, registerGrid } from './grid/grid.js';
export { GridColumns, registerGridColumns } from './grid/grid-columns.js';
export { TagChip, registerTagChip } from './grid/tag-chip.js';

// Inbox (list layout): the control + its registrar, the pure reorder helpers,
// and the write specs (user_card_sort.set / user_card_agent.set|clear).
export { Inbox, registerInbox, _resetInboxDragState } from './inbox/inbox.js';
export { InboxViewToggles, registerInboxViewToggles } from './inbox/inbox-view-toggles.js';
export { NewTaskButton, registerNewTaskButton } from './quick-entry/new-task-button.js';
export {
  planPersonalReorder,
  applyPersonalReorder,
  sortByPersonal,
  move as inboxMove,
  type PersonalSortUpdate,
} from './inbox/inbox-helpers.js';
export {
  registerInboxSpecs,
  INBOX_SPEC,
  type UserCardSortSetInput,
  type UserCardSortSetOutput,
  type UserCardAgentSetInput,
  type UserCardAgentClearInput,
} from './inbox/specs.js';
export { AppShell, registerAppShell, shellHotkeys, applyStoredTheme } from './shell/app-shell.js';
export {
  matchRoute,
  navigate,
  activityUrl,
  installRouter,
  currentRoute,
  peekRoute,
  routeGuard,
  helpTopicForRoute,
  projectUrl,
  screenUrl,
  taskUrl,
  adminUrl,
  ROUTER_PATH,
  _resetRouterForTest,
  type RouteMatch,
  type RouteName,
  type GuardResult,
} from './shell/router.js';
export {
  HelpOverlay,
  registerHelpOverlay,
  groupSnapshot,
  type HelpOverlayConfig,
  type HotkeySnapshot,
} from './shell/help-overlay.js';
export {
  registerConfigSpecs,
  loadServerConfig,
  CONFIG_GET_SPEC,
  WORKSPACE_TITLE_PATH,
  DEFAULT_WORKSPACE_TITLE,
  type ServerConfig,
} from './shell/config-specs.js';
export { publishTaskNav, taskNavListUrl, taskNavNeighbor } from './shell/task-nav.js';
export { attrNameToTargetType, collectRefIdsByType, loadActivityLabels } from './task-detail/activity-labels.js';
export { Activity, registerActivity, activityRowsToCsv, isoDaysAgo, ACTIVITY_DEFAULT_LOOKBACK_DAYS } from './activity/activity.js';
export { ProjectList, registerProjectList } from './projects/project-list.js';

// Project detail (the `project` layout body): the ProjectLayout control + its
// slide-over properties panel + the pure client-narrow helpers.
export {
  ProjectLayout,
  registerProjectLayout,
  type ProjectLayoutConfig,
} from './project-detail/project-layout.js';
export {
  ProjectPropertiesPanel,
  registerProjectPropertiesPanel,
  type ProjectPropertiesPanelConfig,
} from './project-detail/project-properties-panel.js';
export {
  matchesLeaf,
  matchesLeaves,
  type WhereLeaf,
} from './project-detail/project-detail-helpers.js';

// Admin: the reusable MasterDetail control + its config-building helpers + the
// two proof-of-reuse screen configs + the user.* specs.
export { EnumManager, registerEnumManager } from './admin/enum-manager.js';
export { PeopleManager, registerPeopleManager } from './admin/people-manager.js';
export { SchedulerJobs, registerSchedulerJobs } from './admin/scheduler-jobs.js';
export { RecordForm, registerRecordForm } from './admin/record-form.js';
export {
  MasterDetail,
  registerMasterDetail,
  masterDetailScreen,
  listQuery,
  updateAction,
  createAction,
  deleteAction,
  relationActions,
  needsReloadTrigger,
  normaliseRow,
  filterItems,
  fieldText,
  readPath,
} from './admin/master-detail.js';
export { registerAdminSpecs, ADMIN_SPEC } from './admin/specs.js';
export {
  NestedEditor,
  registerNestedEditor,
  groupStepsByFrom,
  boundMatrix,
  validateStepDraft,
  parseSortOrder,
  formatBlockers,
  emptyChannelDraft,
  channelRowToDraft,
  validateChannelDraft,
  channelDraftToSet,
  emptySinkDraft,
  sinkRowToDraft,
  validateSinkDraft,
  sinkDraftToSet,
  CHANNEL_STATUS_OPTIONS,
  type NestedEditorConfig,
  type CommChannelDraft,
  type ActivitySinkDraft,
} from './admin/nested-editor.js';
export {
  workflowRowToDraft,
  workflowDraftToInput,
  WORKFLOW_FORM,
} from './admin/workflow-form.js';
export {
  type ActivityPredicate,
  ACTIVITY_LEAF_OPS,
  ACTIVITY_KIND_OPTIONS,
  activityPredicateFromString,
  activityPredicateFromJson,
  activityPredicateToString,
  activityPredicateToJson,
  appendLeaf as activityAppendLeaf,
  removeLeafAt as activityRemoveLeafAt,
  setConnective as activitySetConnective,
  topLevelLeaves as activityTopLevelLeaves,
  summarizeActivityPredicate,
} from './admin/activity-predicate.js';
export {
  CONTACTS_SCREEN,
  USERS_SCREEN,
  SCREENS_SCREEN,
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
  ADMIN_SECTION,
  MANAGER_ADMIN_VIEWS,
} from './admin/screens.js';

// Reusable anchored-UI primitives: the single floating impl + the two controls
// that compose it.
export { Popover, type PopoverOptions, type Placement } from './ui/popover.js';
export {
  Combobox,
  registerCombobox,
  type ComboboxConfig,
  type ComboboxOption,
  type ComboboxLoad,
} from './ui/combobox.js';
export { DatePicker, registerDatePicker, type DatePickerConfig } from './ui/datepicker.js';
export { registerRefPicker, type RefPicker } from './ui/ref-picker.js';
export { registerCardSearchSpec, CARD_SEARCH_SPEC } from './ui/specs.js';

// Task detail (#33): the /task/:id shell + attribute side panel.
export { TaskDetail, registerTaskDetail, type TaskDetailConfig } from './task-detail/task-detail.js';

// Task detail (#34): the TransitionBar status changer + its spec + bucket helpers.
export {
  TransitionBar,
  registerTransitionBar,
  type TransitionBarConfig,
} from './task-detail/transition-bar.js';
export {
  registerTransitionSpecs,
  FLOW_STEP_LIST_FOR_CARD_SPEC,
  type FlowStepListForCardInput,
  type FlowStepListForCardOutput,
} from './task-detail/specs.js';
export {
  asTransitionPhase,
  bucketOf,
  bucketFor,
  groupByBucket,
  compareTransitions,
  hasAnyTransition,
  ALL_BUCKETS,
  BUCKET_TONE,
  type TransitionBucket,
  type TransitionPhase,
  type TransitionRow,
  type BucketMap,
  type BucketTone,
} from './task-detail/transition-buckets.js';

// Task detail (#35): the comments + activity feed control, its specs, and the
// pure activity-text / comment-derivation helpers.
export {
  TaskComments,
  registerTaskComments,
  type TaskCommentsConfig,
} from './task-detail/task-comments.js';
export {
  registerCommentSpecs,
  ACTIVITY_SELECT_SPEC,
  COMMENT_INSERT_SPEC,
  COMMENT_UPDATE_SPEC,
  ACTIVITY_LIMIT,
  type ActivitySelectInput,
  type ActivitySelectOutput,
  type ActivityRow,
  type CommentInsertInput,
  type CommentInsertOutput,
  type CommentUpdateInput,
  type CommentUpdateOutput,
} from './task-detail/comment-specs.js';
export { registerCommThreadSpecs } from './task-detail/comm-specs.js';
export { loadView, saveView } from './filter/view-persistence.js';
export { trapFocus, captureFocus } from './util/focus-trap.js';
export {
  formatActivityText,
  humaniseAttribute,
  tagDiff,
  deriveComments,
  sortActivityDesc as sortActivityDescNewestFirst,
  formatRelativeTime,
  type CommentEntry,
  type IdMap,
} from './task-detail/activity-text.js';

// Task detail (#36): the attachments / tags / related controls, the upload
// service, and the attachment + tag specs.
export {
  registerAttachmentSpecs,
  CAS_MISSING_CHUNKS_SPEC,
  FILE_CREATE_SPEC,
  ATTACHMENT_CREATE_SPEC,
  ATTACHMENT_LIST_SPEC,
  ATTACHMENT_DELETE_SPEC,
  TAG_APPLY_SPEC,
  TAG_REMOVE_SPEC,
  type AttachmentRow,
  type AttachmentKind,
} from './task-detail/attachment-specs.js';
export {
  uploadFile,
  fetchPostChunk,
  downloadUrl,
  viewUrl,
  thumbUrl,
  FALLBACK_CHUNK_BYTES,
  type UploadPhase,
  type UploadProgress,
  type PostChunk,
  type ChunkPostResult,
} from './task-detail/upload.js';
export {
  AttachmentsSection,
  registerAttachmentsSection,
  formatBytes,
  type AttachmentsSectionConfig,
} from './task-detail/attachments-section.js';
export {
  TagsEditor,
  registerTagsEditor,
  type TagsEditorConfig,
} from './task-detail/tags-editor.js';
export {
  RelatedTasksPanel,
  registerRelatedTasksPanel,
  type RelatedTasksPanelConfig,
} from './task-detail/related-tasks-panel.js';

// Quick-entry (the global `n` fast-task-create overlay): the overlay control +
// its registrar, the pure default-create-status chain, and the submission
// builders (parent resolution, attribute merge, coalesced submit + undo).
export {
  QuickEntry,
  registerQuickEntry,
  type QuickEntryConfig,
} from './quick-entry/quick-entry.js';
export {
  resolveDefaultCreateStatus,
  type FlowRow,
  type ResolveDefaultCreateStatusOpts,
  type ResolveDefaultCreateStatusResult,
} from './quick-entry/default-status.js';
export {
  resolveParentForInsert,
  buildInsertAttributes,
  buildInsertInput,
  submitQuickEntry,
  undoQuickEntry,
  QE_CARD_INSERT_SPEC,
  QE_TAG_APPLY_SPEC,
  QE_ATTACHMENT_CREATE_SPEC,
  QE_CARD_DELETE_SPEC,
  type NamedAttribute,
  type QuickEntryPrefill,
  type QuickEntrySubmitInput,
} from './quick-entry/submission.js';
export { prepareFile, type PrepareFileConfig } from './task-detail/upload.js';

// Import wizard (#41): the four-step CSV-import control + its registrar, the
// project.import.* specs + their registrar, and the pure helpers (auto-mapping
// + the CSV-upload callback).
export {
  ImportWizard,
  registerImportWizard,
  type ImportWizardConfig,
  type WizardStep,
} from './import/import-wizard.js';
export {
  registerImportSpecs,
  IMPORT_SPEC,
  TARGET_ATTRS as IMPORT_TARGET_ATTRS,
  IGNORE_COLUMN,
  RESOLUTION_CATEGORIES,
  type ResolutionMode,
  type ResolutionCategory,
  type ImportResolution,
  type ImportCounts,
  type ImportError,
  type UploadOutput,
  type SetMappingOutput,
  type PreviewOutput,
  type CommitOutput,
} from './import/specs.js';
export { autoMapping, uploadCsv, type UploadCsvCallbacks } from './import/import-helpers.js';

// Project export (#42): the ExportMenu control + its registrar, and the pure
// URL-builders / download triggers it composes.
export { ExportMenu, registerExportMenu, type ExportMenuConfig } from './export/export-menu.js';
export {
  type ExportFormat,
  type ExportToggles,
  type BlobDownloadDeps,
  defaultToggles,
  formatExtension,
  exportNavUrl,
  fallbackFilename,
  parseAttachmentFilename,
  downloadViaAnchor,
  downloadViaBlob,
} from './export/export-helpers.js';

// Mock data for the canned-backend tests.
export {
  mockTransport,
  DEMO_PROJECT_ID,
  FAULT_CARD_ID,
  CREATED_PROJECT_ID,
  FAULT_CREATE_TITLE,
} from './kanban/mock-data.js';
