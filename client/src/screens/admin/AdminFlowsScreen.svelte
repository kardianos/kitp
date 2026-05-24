<!--
  AdminFlowsScreen — admin-only authoring surface for flows + transitions
  (Task #14 on top of FLOW_AND_SCREEN_KERNEL).

  A `flow` binds one attribute_def (typically `status`) to one project; its
  `flow_step` rows enumerate the allowed (from → to) transitions. The
  runtime UI (TransitionBar) reads the same rows via flow_step.list_for_card;
  this screen lets an admin author them without writing SQL.

  Layout (3 panes mirroring AdminAttributesScreen / AdminScreensScreen):

    LEFT (~280px):  project picker (header) + list of flows for the project.
                    "+ New flow" opens a dialog.
    CENTER:         selected-flow header (editable name / doc /
                    default_create_status). attribute_def is read-only after
                    creation (it's the bound attribute, V18 fixes one flow
                    per attribute per project anyway). Steps list below,
                    grouped by from-card.
    RIGHT:          step editor (inline). Pick from-card / to-card /
                    label / requires_role / sort_order. Save calls
                    flow_step.set (upserts by id when present).

  Edits debounce-save via flow.set for header fields. Delete (flow) opens
  a preview-delete dialog showing the V16 affected-task structure before
  the destructive call. Delete (step) opens a small confirm with the
  step's labels.

  Wire surface:
    - flow.list / flow.set / flow.delete / flow.preview_delete
    - flow_step.list / flow_step.set / flow_step.delete
    - attribute_def.select (to label the bound attr / pick the type for new)
    - role.list (for requires_role dropdown)
    - card.select_with_attributes (projects + value-cards of the bound type)
-->
<script lang="ts">
  import { onMount, tick } from 'svelte';

  import { getDispatcher } from '../../dispatch/context';
  import { BatchAbortedError, SubRequestError } from '../../dispatch/errors';
  import { clearHelpTopic, setHelpTopic } from '../../help/help_context.svelte';
  import { setActiveScope, useShortcut } from '../../keys/shortcut';
  import {
    attributeDefSelect,
    cardSelectWithAttributes,
  } from '../../reg/handlers';
  import {
    flowDelete,
    flowList,
    flowPreviewDelete,
    flowSet,
    flowStepDelete,
    flowStepList,
    roleList,
  } from '../../reg/handlers_admin';
  import type {
    AttributeDefRow,
    AttributeDefSelectInput,
    AttributeDefSelectOutput,
    CardSelectWithAttributesInput,
    CardSelectWithAttributesOutput,
    CardWithAttrs,
    FlowDeleteInput,
    FlowDeleteOutput,
    FlowListInput,
    FlowListOutput,
    FlowPreviewDeleteInput,
    FlowPreviewDeleteOutput,
    FlowRow,
    FlowSetInput,
    FlowSetOutput,
    FlowStepDeleteInput,
    FlowStepDeleteOutput,
    FlowStepListInput,
    FlowStepListOutput,
    FlowStepRow,
    ID,
    RoleListInput,
    RoleListOutput,
    RoleRow,
  } from '../../reg/types';
  import { errMsg } from './admin_screens_helpers';
  import Button from '../../ui/Button.svelte';
  import Chip from '../../ui/Chip.svelte';
  import Combobox from '../../ui/Combobox.svelte';
  import ConfirmDialog from '../../ui/ConfirmDialog.svelte';
  import EmptyState from '../../ui/EmptyState.svelte';
  import ErrorAlert from '../../ui/ErrorAlert.svelte';
  import IconButton from '../../ui/IconButton.svelte';
  import Modal from '../../ui/Modal.svelte';
  import PageShell from '../../ui/PageShell.svelte';
  import Spinner from '../../ui/Spinner.svelte';
  import TextInput from '../../ui/inputs/TextInput.svelte';
  import {
    Form,
    FormErrors,
    NumberInput,
    Select,
    SubmitButton,
    TextInput as FormTextInput,
    Textarea as FormTextarea,
  } from '../../forms';
  import { notify } from '../../ui/toast.svelte';
  import { projectScope } from '../../shell/project_scope.svelte';
  import { projectsStore, watchProjects } from '../../shell/projects_store.svelte';
  import { cx } from '../../util/class_names';

  import {
    applyFlowSearch,
    formatRoleBadge,
    groupStepsByFrom,
    lookupCardTitle,
    valueCardCacheKey,
    valueCardTitleMap,
  } from './admin_flows_helpers';

  setActiveScope('admin_flows');

  // Publish the per-page help topic. Cleared on unmount so the next
  // screen's mount overwrites cleanly.
  $effect(() => {
    setHelpTopic({ kind: 'topic', topic: 'admin.flows' });
    return () => clearHelpTopic();
  });

  /* ---------------------------------------------------------- dependencies */

  const dispatcher = getDispatcher();
  // Project list lives in the shared `projectsStore` (the title-bar
  // picker is now the only project picker on this screen). Keeping the
  // cache warm here means an admin who lands on /admin/flows directly
  // still gets a populated picker.
  $effect(watchProjects(dispatcher));

  /* ----------------------------------------------------------------- state */

  let flows = $state<FlowRow[]>([]);
  let steps = $state<FlowStepRow[]>([]);
  let attributeDefs = $state<AttributeDefRow[]>([]);
  let roles = $state<RoleRow[]>([]);
  /** Loaded lazily — keyed by `valueCardCacheKey(projectId, card_type)` so
   *  switching projects doesn't surface another project's value-cards in
   *  the from/to pickers. Holds the value-cards that may appear as
   *  from/to on the selected flow (e.g. status / milestone cards). */
  let valueCardsByType = $state<Record<string, CardWithAttrs[]>>({});

  /**
   * The title-bar `ProjectTitlePicker` is now the only project picker
   * on this screen — `selectedProjectId` is purely a $derived view of
   * the global scope so flow / step fetches re-fire when the admin
   * picks a different project from the breadcrumb.
   */
  const selectedProjectId = $derived(projectScope.projectId);
  /** Shared, template-aware project cache for title lookups. */
  const projects = $derived(projectsStore.projects);
  let selectedFlowId = $state<ID | null>(null);
  let search = $state('');

  let loading = $state(true);
  let error = $state<string | null>(null);

  /** "+ New flow" dialog. <Form> kernel owns the draft. */
  let creating = $state(false);

  /** "+ New transition" / edit-step dialog. <Form> kernel owns the
   *  draft; the screen tracks which step (if any) is being edited so
   *  the dialog title and initial seed flip. */
  let stepDialogOpen = $state(false);
  let editingStep = $state<FlowStepRow | null>(null);

  /** Preview-delete dialog state. */
  let previewOpen = $state(false);
  let previewLoading = $state(false);
  let previewData = $state<FlowPreviewDeleteOutput | null>(null);
  let pendingDeleteFlowId = $state<ID | null>(null);

  /** Step delete confirm dialog. */
  let stepConfirmOpen = $state(false);
  let pendingDeleteStep = $state<FlowStepRow | null>(null);

  const SEARCH_INPUT_ID = 'admin-flows-search';

  /* ------------------------------------------- form initial seeds */

  /** flow.set initial draft for the create dialog. snake_case keys match
   *  the handler's JSON Schema. */
  const newFlowInitial = $derived.by((): Record<string, unknown> => ({
    name: '',
    doc: '',
    attribute_def_id: 0n,
    scope_card_id: selectedProjectId ?? 0n,
    default_create_status_id: 0n,
  }));

  /** flow_step.set initial draft for the new / edit transition dialog.
   *  For new transitions, suggest a sort_order at the next step bucket. */
  const stepInitial = $derived.by((): Record<string, unknown> => {
    if (selectedFlowId === null) return {};
    if (editingStep === null) {
      return {
        flow_id: selectedFlowId,
        from_card_id: 0n,
        to_card_id: 0n,
        label: '',
        sort_order: (steps.length + 1) * 10,
        requires_role_id: 0n,
      };
    }
    return {
      id: editingStep.id,
      flow_id: selectedFlowId,
      from_card_id: editingStep.from_card_id,
      to_card_id: editingStep.to_card_id,
      label: editingStep.label,
      sort_order: editingStep.sort_order,
      requires_role_id: editingStep.requires_role_id,
    };
  });

  /* ------------------------------------------------------------ derivations */

  const visibleFlows = $derived(applyFlowSearch(flows, search));

  const selectedFlow = $derived<FlowRow | null>(
    selectedFlowId === null
      ? null
      : (flows.find((f) => f.id === selectedFlowId) ?? null),
  );

  /** attribute_def bound to the selected flow. */
  const selectedAttrDef = $derived<AttributeDefRow | null>(
    selectedFlow === null
      ? null
      : (attributeDefs.find((d) => d.id === selectedFlow.attribute_def_id) ?? null),
  );

  /**
   * Card type whose value-cards are valid `from` / `to` values for this
   * flow's transitions. For a `status` attribute this is typically the
   * `status` card_type. For non-card_ref bound attributes there is no
   * value-card pool — flow.set would have refused the binding.
   */
  const valueCardType = $derived.by<string | null>(() => {
    if (selectedAttrDef === null) return null;
    const t = selectedAttrDef.target_card_type_name;
    return t !== undefined && t !== '' ? t : null;
  });

  /** Value-cards loaded for the current flow's bound card_type, scoped to
   *  the selected project. flow_step.set rejects cross-project from/to
   *  references, so a flow's transitions can only reference value-cards
   *  in the same project — and that project equals selectedProjectId
   *  once `loadFlowsFor` settles (flows are loaded per the current
   *  project picker). */
  const valueCards = $derived.by<CardWithAttrs[]>(() => {
    if (valueCardType === null) return [];
    if (selectedProjectId === null) return [];
    return valueCardsByType[valueCardCacheKey(selectedProjectId, valueCardType)] ?? [];
  });

  const valueTitles = $derived(valueCardTitleMap(valueCards));

  const fromBuckets = $derived(groupStepsByFrom(steps));

  /* card-ref-typed defs only — the bind to a card_ref attribute is the
   * precondition for transitions to make sense (Gate 3 server validation
   * rejects non-card_ref defs in flow.set). */
  const cardRefDefs = $derived<AttributeDefRow[]>(
    attributeDefs.filter(
      (d) => d.target_card_type_name !== undefined && d.target_card_type_name !== '',
    ),
  );

  /* Combobox options. The inline header pickers (default_create_status
   * etc.) still use the legacy string-stringified pattern because they
   * fire single-field updates through the raw dispatcher. The dialog
   * pickers use the bigint pattern so the form draft holds wire-ready
   * ids. */
  const projectOptionsStr = $derived(
    projects.map((p) => ({
      value: p.id.toString(),
      label: typeof p.attributes['title'] === 'string'
        ? (p.attributes['title'] as string)
        : `#${p.id}`,
    })),
  );

  const attrDefOptions = $derived<{ value: ID; label: string }[]>([
    { value: 0n, label: 'Pick an attribute…' },
    ...cardRefDefs.map((d) => ({
      value: d.id,
      label:
        d.target_card_type_name !== undefined
          ? `${d.name} (${d.target_card_type_name})`
          : d.name,
    })),
  ]);

  const projectOptionsId = $derived<{ value: ID; label: string }[]>([
    { value: 0n, label: 'Pick a project…' },
    ...projects.map((p) => ({
      value: p.id,
      label: typeof p.attributes['title'] === 'string'
        ? (p.attributes['title'] as string)
        : `#${p.id}`,
    })),
  ]);

  const valueCardOptionsId = $derived<{ value: ID; label: string }[]>([
    { value: 0n, label: 'Pick a value…' },
    ...valueCards.map((c) => ({
      value: c.id,
      label: lookupCardTitle(valueTitles, c.id),
    })),
  ]);

  /** Inline default-create picker still uses string values (single-field
   *  update path, not part of any <Form>). */
  const valueCardOptionsStr = $derived(
    valueCards.map((c) => ({
      value: c.id.toString(),
      label: lookupCardTitle(valueTitles, c.id),
    })),
  );

  const roleOptionsId = $derived<{ value: ID; label: string }[]>([
    { value: 0n, label: '(any authenticated user)' },
    ...roles
      .filter((r) => r.name !== 'system')
      .map((r) => ({ value: r.id, label: r.name })),
  ]);

  /* ------------------------------------------------------------- data fetch */

  /**
   * Fetch the screen's static reference data (attribute defs + roles).
   * Projects come from `projectsStore` (kept warm by the watchProjects
   * effect above) so this screen no longer issues its own card.select
   * for them — the title-bar picker is the single source of truth.
   */
  async function loadInitial(): Promise<void> {
    loading = true;
    error = null;
    try {
      const defsP = dispatcher.request<
        AttributeDefSelectInput,
        AttributeDefSelectOutput
      >({
        endpoint: attributeDefSelect.endpoint,
        action: attributeDefSelect.action,
        data: {},
      });
      const rolesP = dispatcher.request<RoleListInput, RoleListOutput>({
        endpoint: roleList.endpoint,
        action: roleList.action,
        data: {},
      });
      const [defsOut, rolesOut] = await Promise.all([defsP, rolesP]);
      attributeDefs = defsOut.rows;
      roles = rolesOut.rows;
      loading = false;
    } catch (e) {
      loading = false;
      if (e instanceof SubRequestError) error = e.message;
      else if (e instanceof BatchAbortedError) error = e.reason;
      else error = errMsg(e);
    }
  }

  async function loadFlowsFor(projectId: ID): Promise<void> {
    try {
      const out = await dispatcher.request<FlowListInput, FlowListOutput>({
        endpoint: flowList.endpoint,
        action: flowList.action,
        data: { scopeCardId: projectId },
      });
      if (selectedProjectId !== projectId) return; // user switched mid-flight
      flows = out.rows;
      if (
        selectedFlowId === null ||
        !flows.some((f) => f.id === selectedFlowId)
      ) {
        const first = flows[0];
        selectedFlowId = first?.id ?? null;
      }
    } catch (e) {
      notify({ type: 'error', message: `Load flows failed: ${errMsg(e)}` });
    }
  }

  async function loadStepsFor(flowId: ID): Promise<void> {
    try {
      const out = await dispatcher.request<
        FlowStepListInput,
        FlowStepListOutput
      >({
        endpoint: flowStepList.endpoint,
        action: flowStepList.action,
        data: { flowId },
      });
      if (selectedFlowId !== flowId) return;
      steps = out.rows;
    } catch (e) {
      notify({ type: 'error', message: `Load steps failed: ${errMsg(e)}` });
    }
  }

  async function loadValueCards(cardTypeName: string, parent: ID): Promise<void> {
    try {
      const data: CardSelectWithAttributesInput = {
        cardTypeName,
        parentCardId: parent,
        order: [{ field: 'attributes.sort_order', direction: 'ASC' }],
        limit: 500,
      };
      const out = await dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data,
      });
      valueCardsByType = {
        ...valueCardsByType,
        [valueCardCacheKey(parent, cardTypeName)]: out.rows,
      };
    } catch (e) {
      notify({ type: 'error', message: `Load values failed: ${errMsg(e)}` });
    }
  }

  // Reload flows when the project pick flips.
  $effect(() => {
    const pid = selectedProjectId;
    if (pid === null) {
      flows = [];
      selectedFlowId = null;
      return;
    }
    void loadFlowsFor(pid);
  });

  // Reload flow_steps + value-cards when the flow pick flips.
  $effect(() => {
    const fid = selectedFlowId;
    if (fid === null) {
      steps = [];
      return;
    }
    void loadStepsFor(fid);
  });

  $effect(() => {
    const t = valueCardType;
    const pid = selectedProjectId;
    // Load value cards scoped to the picked project. flows are
    // loaded per the picker, so the flow's own scope_card_id always
    // converges to pid once loadFlowsFor settles — we key off pid
    // directly to keep the effect's tracked dependencies primitive
    // (an earlier version read `selectedFlow.scope_card_id`, which
    // pulled the whole derived chain into the dep set and tripped
    // Svelte's effect-update depth limit on project switch).
    if (t === null || pid === null) return;
    const key = valueCardCacheKey(pid, t);
    if (valueCardsByType[key] === undefined) {
      void loadValueCards(t, pid);
    }
  });

  /* ---------------------------------------------------------- mutations */

  /** Generic flow.set caller. Returns true on success. */
  async function saveFlow(input: FlowSetInput, failLabel: string): Promise<ID | null> {
    try {
      const out = await dispatcher.request<FlowSetInput, FlowSetOutput>({
        endpoint: flowSet.endpoint,
        action: flowSet.action,
        data: input,
      });
      return out.id;
    } catch (e) {
      notify({ type: 'error', message: `${failLabel}: ${errMsg(e)}` });
      return null;
    }
  }

  /* ----- Inline-edit on the flow header -------------------------------- */

  /** Build a FlowSetInput from a current flow row + the field being edited,
   *  carrying over every other field so the upsert is faithful. */
  function buildFlowUpdate(
    f: FlowRow,
    overrides: { name?: string; doc?: string; defaultCreateStatusId?: ID | null },
  ): FlowSetInput {
    const out: FlowSetInput = {
      id: f.id,
      name: overrides.name ?? f.name,
      attributeDefId: f.attribute_def_id,
      scopeCardId: f.scope_card_id,
    };
    const doc = overrides.doc ?? f.doc;
    if (doc !== '') out.doc = doc;
    const def =
      overrides.defaultCreateStatusId === undefined
        ? f.default_create_status_id
        : overrides.defaultCreateStatusId;
    if (def !== null && def !== 0n) out.defaultCreateStatusId = def;
    return out;
  }

  async function renameSelectedFlow(nextName: string): Promise<void> {
    const f = selectedFlow;
    if (f === null) return;
    const trimmed = nextName.trim();
    if (trimmed === '' || trimmed === f.name) return;
    const id = await saveFlow(
      buildFlowUpdate(f, { name: trimmed }),
      'Rename failed',
    );
    if (id !== null) {
      await loadFlowsFor(f.scope_card_id);
      notify({ type: 'success', message: 'Flow renamed.' });
    }
  }

  async function setSelectedFlowDoc(nextDoc: string): Promise<void> {
    const f = selectedFlow;
    if (f === null) return;
    if (nextDoc === f.doc) return;
    const id = await saveFlow(
      buildFlowUpdate(f, { doc: nextDoc }),
      'Update failed',
    );
    if (id !== null) {
      await loadFlowsFor(f.scope_card_id);
    }
  }

  async function setSelectedFlowDefault(next: ID | null): Promise<void> {
    const f = selectedFlow;
    if (f === null) return;
    const id = await saveFlow(
      buildFlowUpdate(f, { defaultCreateStatusId: next }),
      'Update default failed',
    );
    if (id !== null) {
      await loadFlowsFor(f.scope_card_id);
      notify({ type: 'success', message: 'Default updated.' });
    }
  }

  /* ----- Create flow --------------------------------------------------- */

  function openCreate(): void {
    creating = true;
  }

  function onFlowCreated(out: unknown): void {
    const r = (out ?? {}) as { id?: unknown };
    const newId = typeof r.id === 'bigint' ? r.id : null;
    creating = false;
    notify({ type: 'success', message: `Flow created.` });
    if (selectedProjectId !== null) void loadFlowsFor(selectedProjectId);
    if (newId !== null) selectedFlowId = newId;
  }

  /* ----- Delete flow with preview -------------------------------------- */

  async function openPreviewDelete(flowId: ID): Promise<void> {
    pendingDeleteFlowId = flowId;
    previewData = null;
    previewLoading = true;
    previewOpen = true;
    try {
      const out = await dispatcher.request<
        FlowPreviewDeleteInput,
        FlowPreviewDeleteOutput
      >({
        endpoint: flowPreviewDelete.endpoint,
        action: flowPreviewDelete.action,
        data: { flowId },
      });
      previewData = out;
    } catch (e) {
      previewOpen = false;
      pendingDeleteFlowId = null;
      notify({ type: 'error', message: `Preview failed: ${errMsg(e)}` });
    } finally {
      previewLoading = false;
    }
  }

  async function confirmDeleteFlow(): Promise<void> {
    const id = pendingDeleteFlowId;
    if (id === null) return;
    try {
      const out = await dispatcher.request<FlowDeleteInput, FlowDeleteOutput>({
        endpoint: flowDelete.endpoint,
        action: flowDelete.action,
        data: { flowId: id },
      });
      if (!out.ok) {
        notify({ type: 'error', message: 'Delete refused.' });
        return;
      }
      const pid = selectedProjectId;
      previewOpen = false;
      pendingDeleteFlowId = null;
      previewData = null;
      if (selectedFlowId === id) selectedFlowId = null;
      if (pid !== null) await loadFlowsFor(pid);
      notify({ type: 'success', message: 'Flow deleted.' });
    } catch (e) {
      notify({ type: 'error', message: `Delete failed: ${errMsg(e)}` });
    }
  }

  /* ----- Step dialog --------------------------------------------------- */

  function openNewStep(): void {
    if (selectedFlow === null) return;
    editingStep = null;
    stepDialogOpen = true;
  }

  function openEditStep(s: FlowStepRow): void {
    editingStep = s;
    stepDialogOpen = true;
  }

  function onStepSaved(): void {
    const wasEdit = editingStep !== null;
    stepDialogOpen = false;
    editingStep = null;
    if (selectedFlowId !== null) void loadStepsFor(selectedFlowId);
    notify({
      type: 'success',
      message: wasEdit ? 'Transition updated.' : 'Transition added.',
    });
  }

  /* ----- Step delete --------------------------------------------------- */

  function openDeleteStep(s: FlowStepRow): void {
    pendingDeleteStep = s;
    stepConfirmOpen = true;
  }

  async function confirmDeleteStep(): Promise<void> {
    const s = pendingDeleteStep;
    if (s === null) return;
    try {
      const out = await dispatcher.request<
        FlowStepDeleteInput,
        FlowStepDeleteOutput
      >({
        endpoint: flowStepDelete.endpoint,
        action: flowStepDelete.action,
        data: { flowStepId: s.id },
      });
      if (!out.ok) {
        notify({ type: 'error', message: 'Delete refused.' });
        return;
      }
      pendingDeleteStep = null;
      stepConfirmOpen = false;
      const fid = selectedFlowId;
      if (fid !== null) await loadStepsFor(fid);
      notify({ type: 'success', message: 'Transition deleted.' });
    } catch (e) {
      notify({ type: 'error', message: `Delete failed: ${errMsg(e)}` });
    }
  }

  /* ------------------------------------------------------ combobox glue */

  /**
   * Inline default-status picker — still wired to the raw dispatcher
   * because the screen treats it as a single-field update (no other
   * fields are co-edited at this point). The dialog form pickers below
   * use Select + form context instead.
   */
  function pickDefaultStatus(v: unknown): void {
    if (typeof v !== 'string' || v === '') {
      void setSelectedFlowDefault(null);
      return;
    }
    try {
      void setSelectedFlowDefault(BigInt(v));
    } catch {
      /* ignore */
    }
  }

  /* ------------------------------------------------------ keyboard glue */

  async function focusSearch(): Promise<void> {
    await tick();
    const el = document.getElementById(SEARCH_INPUT_ID);
    if (el instanceof HTMLInputElement) {
      el.focus();
      el.select();
    }
  }

  function moveSelection(delta: number): void {
    const list = visibleFlows;
    if (list.length === 0) return;
    const cur = list.findIndex((f) => f.id === selectedFlowId);
    let next = cur + delta;
    if (cur === -1) next = delta > 0 ? 0 : list.length - 1;
    if (next < 0) next = 0;
    if (next > list.length - 1) next = list.length - 1;
    const target = list[next];
    if (target !== undefined) selectedFlowId = target.id;
  }

  useShortcut('admin_flows', '/', () => void focusSearch(), 'Focus search', {
    fireInInputs: false,
  });
  useShortcut('admin_flows', 'j', () => moveSelection(+1), 'Next flow', {
    fireInInputs: false,
  });
  useShortcut('admin_flows', 'k', () => moveSelection(-1), 'Previous flow', {
    fireInInputs: false,
  });
  useShortcut('admin_flows', 'n', () => openCreate(), 'New flow', {
    fireInInputs: false,
  });

  onMount(() => {
    void loadInitial();
  });
</script>

<PageShell title="Admin · Flows" pad="none">
  {#snippet actions()}
    <Button variant="primary" size="sm" onclick={openCreate}>
      {#snippet children()}+ New flow{/snippet}
    </Button>
  {/snippet}
  {#snippet children()}
  {#if loading && flows.length === 0 && projects.length === 0}
    <div class="flex h-full items-center justify-center">
      <Spinner size="lg" />
    </div>
  {:else if error !== null}
    <ErrorAlert
      class="m-4"
      message={`Failed to load: ${error}`}
      onRetry={() => void loadInitial()}
    />
  {:else}
    <div class="grid h-full min-h-0 grid-cols-[280px_1fr]">
      <!-- LEFT: flow list -->
      <aside
        class="flex flex-col border-r border-border min-h-0"
        aria-label="Flow list"
      >
        <div class="flex flex-col gap-2 border-b border-border p-2">
          <TextInput
            id={SEARCH_INPUT_ID}
            type="search"
            bind:value={search}
            placeholder="Search flows (press /)"
            aria-label="Search flows"
          />
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto" data-testid="flow-list">
          {#if selectedProjectId === null}
            <div class="p-4 text-center text-sm text-muted">
              Pick a project to manage its flows.
            </div>
          {:else if visibleFlows.length === 0}
            <div class="p-4 text-center text-sm text-muted">
              {search === ''
                ? 'No flows in this project yet.'
                : 'No flows match.'}
            </div>
          {:else}
            <ul>
              {#each visibleFlows as f (f.id)}
                <li>
                  <button
                    type="button"
                    data-testid={`flow-row-${f.id}`}
                    class={cx(
                      'flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm',
                      'hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                      f.id === selectedFlowId ? 'bg-surface' : '',
                    )}
                    onclick={() => (selectedFlowId = f.id)}
                  >
                    <span class="flex min-w-0 flex-col">
                      <span class="truncate font-medium text-fg">{f.name}</span>
                      <span class="truncate text-xs text-muted"
                        >{f.attribute_def_name}</span
                      >
                    </span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      </aside>

      <!-- RIGHT: detail -->
      <section
        class="flex min-h-0 flex-col overflow-y-auto"
        aria-label="Flow detail"
      >
        {#if selectedFlow === null}
          <div class="flex flex-1 items-center justify-center p-6">
            {#if selectedProjectId === null}
              <EmptyState
                title="No flow selected"
                description="Pick a project from the header."
              />
            {:else}
              <EmptyState
                title="No flow selected"
                description="Pick a flow on the left, or create a new one."
                action={{ label: '+ New flow', onClick: openCreate }}
              />
            {/if}
          </div>
        {:else}
          {@const f = selectedFlow}
          <div class="flex flex-col gap-4 p-4" data-testid="flow-detail">
            <!-- Header: name + doc + delete -->
            <div class="flex items-start justify-between gap-3">
              <div class="flex min-w-0 flex-1 flex-col gap-2">
                <label class="flex flex-col gap-1 text-sm">
                  <span class="text-muted">Flow name</span>
                  <span data-testid="flow-name">
                    <TextInput
                      value={f.name}
                      onblur={(e) =>
                        void renameSelectedFlow((e.target as HTMLInputElement).value)}
                      onkeydown={(e) => {
                        if (e.key === 'Enter') {
                          (e.target as HTMLInputElement).blur();
                        } else if (e.key === 'Escape') {
                          (e.target as HTMLInputElement).value = f.name;
                          (e.target as HTMLInputElement).blur();
                        }
                      }}
                    />
                  </span>
                </label>
                <label class="flex flex-col gap-1 text-sm">
                  <span class="text-muted">Description (optional)</span>
                  <textarea
                    value={f.doc}
                    data-testid="flow-doc"
                    rows="2"
                    class={cx(
                      'rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-fg',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                    )}
                    onblur={(e) =>
                      void setSelectedFlowDoc((e.target as HTMLTextAreaElement).value)}
                  ></textarea>
                </label>
              </div>
              <div class="flex shrink-0 flex-col items-end gap-2" data-testid="flow-delete">
                <IconButton
                  aria-label={`Delete flow ${f.name}`}
                  size="sm"
                  variant="danger"
                  onclick={() => void openPreviewDelete(f.id)}
                >
                  {#snippet children()}🗑{/snippet}
                </IconButton>
              </div>
            </div>

            <!-- Bound attribute (read-only) + default create -->
            <div class="flex flex-wrap items-center gap-4 rounded border border-border bg-surface px-3 py-2 text-sm">
              <div class="flex items-center gap-2">
                <span class="text-muted">Attribute:</span>
                <Chip label={f.attribute_def_name} size="sm" />
                {#if valueCardType !== null}
                  <span class="text-muted">→</span>
                  <Chip label={valueCardType} size="sm" />
                {/if}
              </div>
              <div class="flex flex-1 items-center gap-2 min-w-[240px]">
                <span class="text-muted">Default on create:</span>
                <span class="flex-1">
                  <Combobox
                    aria-label="Default status on task create"
                    options={[{ value: '', label: '(none)' }, ...valueCardOptionsStr]}
                    value={
                      f.default_create_status_id === 0n
                        ? ''
                        : f.default_create_status_id.toString()
                    }
                    searchable={valueCardOptionsStr.length > 8}
                    placeholder="(none)"
                    onchange={pickDefaultStatus}
                  />
                </span>
              </div>
            </div>

            <!-- Transitions section -->
            <div class="flex flex-col gap-2">
              <div class="flex items-center justify-between">
                <h2 class="text-base font-semibold">Transitions</h2>
                <span data-testid="new-step">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={valueCardType === null}
                    onclick={openNewStep}
                  >
                    {#snippet children()}+ New transition{/snippet}
                  </Button>
                </span>
              </div>

              {#if steps.length === 0}
                <p class="rounded border border-dashed border-border px-3 py-4 text-center text-sm text-muted">
                  No transitions yet. Click "+ New transition" to add one.
                </p>
              {:else}
                {#each fromBuckets as bucket (bucket.fromCardId.toString())}
                  {@const fromTitle = lookupCardTitle(valueTitles, bucket.fromCardId)}
                  <div class="rounded border border-border" data-testid={`from-bucket-${bucket.fromCardId}`}>
                    <div class="border-b border-border bg-surface px-3 py-1 text-xs font-semibold uppercase tracking-wide text-muted">
                      From: {fromTitle}
                    </div>
                    <ul>
                      {#each bucket.steps as step (step.id)}
                        {@const toTitle = lookupCardTitle(valueTitles, step.to_card_id)}
                        {@const role = formatRoleBadge(step)}
                        <li
                          data-testid={`step-row-${step.id}`}
                          class="flex items-center gap-3 border-b border-border px-3 py-2 text-sm last:border-b-0"
                        >
                          <span class="font-medium text-fg">{step.label}</span>
                          <span class="text-muted">→ {toTitle}</span>
                          {#if role !== null}
                            <Chip label={`role: ${role}`} size="sm" />
                          {/if}
                          <span class="ml-auto flex items-center gap-2">
                            <span class="text-xs text-muted">sort: {step.sort_order}</span>
                            <button
                              type="button"
                              class="rounded border border-border bg-bg px-2 py-0.5 text-xs text-fg hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                              onclick={() => openEditStep(step)}
                              data-testid={`step-edit-${step.id}`}
                            >Edit</button>
                            <IconButton
                              aria-label={`Delete transition ${step.label}`}
                              size="sm"
                              variant="danger"
                              onclick={() => openDeleteStep(step)}
                            >
                              {#snippet children()}🗑{/snippet}
                            </IconButton>
                          </span>
                        </li>
                      {/each}
                    </ul>
                  </div>
                {/each}
              {/if}
            </div>
          </div>
        {/if}
      </section>
    </div>
  {/if}
  {/snippet}
</PageShell>

<!-- New-flow dialog -->
<Modal bind:open={creating} title="New flow" size="md" onClose={() => (creating = false)}>
  {#snippet children()}
    {#key creating}
      <Form
        spec="flow.set"
        initial={newFlowInitial}
        onSaved={onFlowCreated}
        class="flex flex-col gap-3"
      >
        <div data-testid="new-flow-dialog" class="flex flex-col gap-3">
          <FormErrors />
          <span data-testid="new-flow-name">
            <FormTextInput path="name" label="Name" />
          </span>
          <FormTextarea path="doc" label="Description (optional)" rows={2} />
          <Select
            path="scope_card_id"
            label="Project"
            options={projectOptionsId}
            searchable={projectOptionsId.length > 8}
            placeholder="Pick a project…"
            aria-label="Project for new flow"
          />
          <Select
            path="attribute_def_id"
            label="Attribute (card_ref-typed only)"
            options={attrDefOptions}
            searchable={attrDefOptions.length > 8}
            placeholder="Pick an attribute…"
            aria-label="Attribute"
          />
          <span class="text-xs text-muted">
            Typically "status". One flow per attribute per project.
          </span>
          <div class="mt-2 flex items-center justify-end gap-2 border-t border-border pt-3">
            <Button variant="ghost" onclick={() => (creating = false)}>
              {#snippet children()}Cancel{/snippet}
            </Button>
            <SubmitButton>Create</SubmitButton>
          </div>
        </div>
      </Form>
    {/key}
  {/snippet}
</Modal>

<!-- New / edit transition dialog -->
<Modal
  bind:open={stepDialogOpen}
  title={editingStep === null ? 'New transition' : 'Edit transition'}
  size="md"
  onClose={() => (stepDialogOpen = false)}
>
  {#snippet children()}
    {#key editingStep?.id ?? 'new'}
      <Form
        spec="flow_step.set"
        initial={stepInitial}
        onSaved={onStepSaved}
        class="flex flex-col gap-3"
      >
        <div data-testid="step-dialog" class="flex flex-col gap-3">
          <FormErrors />
          <Select
            path="from_card_id"
            label="From"
            options={valueCardOptionsId}
            searchable={valueCardOptionsId.length > 8}
            placeholder="Pick a starting value…"
            aria-label="From value"
          />
          <Select
            path="to_card_id"
            label="To"
            options={valueCardOptionsId}
            searchable={valueCardOptionsId.length > 8}
            placeholder="Pick a destination value…"
            aria-label="To value"
          />
          <span data-testid="step-label">
            <FormTextInput path="label" label="Button label" />
          </span>
          <Select
            path="requires_role_id"
            label="Requires role (optional)"
            options={roleOptionsId}
            searchable={roleOptionsId.length > 8}
            placeholder="(any authenticated user)"
            aria-label="Requires role"
          />
          <NumberInput path="sort_order" label="Sort order (optional)" />
          <div class="mt-2 flex items-center justify-end gap-2 border-t border-border pt-3">
            <Button variant="ghost" onclick={() => (stepDialogOpen = false)}>
              {#snippet children()}Cancel{/snippet}
            </Button>
            <SubmitButton>Save</SubmitButton>
          </div>
        </div>
      </Form>
    {/key}
  {/snippet}
</Modal>

<!-- Flow preview-delete dialog -->
<Modal bind:open={previewOpen} title="Delete flow?" size="md" onClose={() => (previewOpen = false)}>
  <div class="flex flex-col gap-3 text-sm" data-testid="preview-delete-dialog">
    {#if previewLoading || previewData === null}
      <div class="flex items-center gap-2 text-muted">
        <Spinner size="sm" />
        <span>Computing preview…</span>
      </div>
    {:else}
      {@const p = previewData}
      <p>
        Delete flow <strong>{p.flow_name}</strong>?
      </p>
      <ul class="space-y-1 rounded border border-border bg-surface px-3 py-2 text-fg">
        <li>Steps removed: <strong>{p.step_count}</strong></li>
        <li>
          Tasks currently at a value in this flow: <strong
            >{p.tasks_currently_in_flow_states}</strong
          >
          {#if p.tasks_currently_in_flow_states > 0}
            <span class="text-muted"
              >(triage {p.tasks_by_phase.triage} · active
              {p.tasks_by_phase.active} · terminal
              {p.tasks_by_phase.terminal})</span
            >
          {/if}
        </li>
      </ul>
      {#if p.sample_step_labels.length > 0}
        <div>
          <p class="mb-1 text-muted">Sample transitions:</p>
          <ul class="ml-4 list-disc space-y-0.5 text-fg">
            {#each p.sample_step_labels as lbl}
              <li>{lbl}</li>
            {/each}
          </ul>
        </div>
      {/if}
      <p class="text-muted">
        Tasks keep their attribute values — only the gating flow + transitions
        are removed.
      </p>
    {/if}
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (previewOpen = false)}>
      {#snippet children()}Cancel{/snippet}
    </Button>
    <Button
      variant="danger"
      disabled={previewLoading || previewData === null}
      onclick={() => void confirmDeleteFlow()}
    >
      {#snippet children()}Delete{/snippet}
    </Button>
  {/snippet}
</Modal>

<!-- Step delete confirm -->
{#if pendingDeleteStep !== null}
  {@const s = pendingDeleteStep}
  {@const fromTitle = lookupCardTitle(valueTitles, s.from_card_id)}
  {@const toTitle = lookupCardTitle(valueTitles, s.to_card_id)}
  <ConfirmDialog
    bind:open={stepConfirmOpen}
    title="Delete transition?"
    message={`Delete the "${s.label}" transition (${fromTitle} → ${toTitle})? Tasks currently at "${fromTitle}" will no longer be able to fire this step.`}
    confirmLabel="Delete"
    danger
    onConfirm={() => void confirmDeleteStep()}
    onCancel={() => {
      stepConfirmOpen = false;
      pendingDeleteStep = null;
    }}
  />
{:else}
  <!-- Keep ConfirmDialog instance off the DOM when nothing's pending so
       the modal's portal doesn't open with stale labels. -->
{/if}
