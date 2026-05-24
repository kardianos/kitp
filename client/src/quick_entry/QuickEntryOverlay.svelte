<script lang="ts">
  /**
   * QuickEntryOverlay — `n` shortcut from any list screen lands here.
   *
   * Single source of truth for "New <card_type>" across every screen
   * (Inbox / Kanban / Grid / Project / Projects / Admin). Layout:
   *   - Always-visible: Title input (auto-focused) + Description textarea.
   *     The fast path is "type a title, press Enter" — no widget noise.
   *   - "+ More details" disclosure reveals:
   *       · Assignee picker (when the screen feeds assigneeOptions).
   *       · Tag multi-select (when the screen feeds tagOptions).
   *       · Attachment dropzone + selected-file list.
   *       · "+ Add field" affordance: pick any attribute from the
   *         screen-supplied palette and edit its value via ValueInput.
   *
   * Submission flow:
   *  - Plain Enter inside the title input  -> submit, KEEP overlay open, clear
   *    inputs, refocus title for the next entry.
   *  - Ctrl/Cmd+Enter (anywhere)           -> submit, CLOSE overlay.
   *  - Esc                                  -> close without submission.
   *
   * Attachments are uploaded to CAS + `file.create` BEFORE the batch is
   * dispatched (those steps are out-of-batch HTTP POSTs to the CAS
   * endpoint). Once every file has a `file_id`, we hand off to
   * submitQuickEntry which queues card.insert + tag.apply + attachment.create
   * synchronously so the dispatcher folds them into one POST and the
   * server runs them in one transaction (N-SRV-1).
   *
   * On a successful submit we fire a "Created" toast with an Undo button that
   * dispatches `card.delete`. On error we render the error inline above the
   * form and DO NOT clear or close.
   *
   * The component manages its own focus trap + Escape close. Modal.svelte was
   * inspected and intentionally not used: we need finer-grained control over
   * the keydown chain (Enter vs Ctrl+Enter dispatch) and over when "close on
   * Esc" actually fires.
   */
  import { getContext, tick } from 'svelte';
  import type { AuthState } from '../auth/auth_state.svelte';
  import { prepareAttachmentFile } from '../attachments/upload.js';
  import { getDispatcher } from '../dispatch/context.js';
  import type { FilterAttribute } from '../filter/attribute_schema.svelte.js';
  import ValueInput from '../filter/ValueInput.svelte';
  import { projectScope } from '../shell/project_scope.svelte';
  import Button from '../ui/Button.svelte';
  import Combobox from '../ui/Combobox.svelte';
  import IconButton from '../ui/IconButton.svelte';
  import { notify } from '../ui/toast.svelte.js';
  import { cx } from '../util/class_names.js';
  import {
    resolveParentForInsert,
    submitQuickEntry,
    type QuickEntryPrefill,
    type QuickEntrySubmitInput,
  } from './submission.js';
  import {
    resolveDefaultCreateStatus,
    type FlowRow,
  } from './default_status.svelte.js';
  import type {
    CardDeleteInput,
    CardDeleteOutput,
    CardWithAttrs,
    ID,
  } from '../reg/types.js';

  interface AssigneeOption {
    value: ID;
    label: string;
  }

  interface TagOption {
    value: ID;
    label: string;
  }

  interface Props {
    open: boolean;
    defaultCardType: string;
    parentCardId?: ID;
    prefill?: QuickEntryPrefill;
    /**
     * List of assignee options the Combobox renders. Empty array hides the
     * picker (only relevant when defaultCardType === 'task' or prefill set
     * an assignee). Screens fetch this via `user.select` and pass it through.
     */
    assigneeOptions?: AssigneeOption[];
    /**
     * Gate 6: inputs for the default-create-status resolution chain.
     * Optional — when omitted (or when `defaultCardType !== 'task'`) the
     * overlay skips the chain and lets the server's required-edge check
     * surface the missing status. Screens that have these values in
     * memory (Inbox, Kanban, Grid, ProjectDetail) thread them through so
     * the new task's status is stamped on the same `card.insert`.
     */
    screenCard?: CardWithAttrs | null;
    flow?: FlowRow | null;
    candidateStatuses?: CardWithAttrs[];
    /** Attribute palette for the "+ Add field" picker (FilterAttribute shape). */
    attributePalette?: FilterAttribute[];
    /** Tag-card options for the multi-select tags picker. */
    tagOptions?: TagOption[];
    onCreated?: (newCardId: ID) => void;
    onClose?: () => void;
  }

  let {
    open = $bindable(),
    defaultCardType,
    parentCardId,
    prefill,
    assigneeOptions = [],
    screenCard,
    flow,
    candidateStatuses,
    attributePalette = [],
    tagOptions = [],
    onCreated,
    onClose,
  }: Props = $props();

  const dispatcher = getDispatcher();
  const authState = getContext<AuthState | undefined>('authState');

  /* ------------------------------------------------------------------ state */

  let title = $state('');
  let description = $state('');
  let assigneeId = $state<ID | null>(null);
  let submitting = $state(false);
  let errorMessage = $state<string | null>(null);

  /** Disclosure flag — "+ More details" toggles this. Persists across
   *  rapid-fire entries so a user who's working in expanded mode doesn't
   *  have to re-open it on every Enter. */
  let detailsOpen = $state(false);

  /** Tag selections. Multi-select Combobox returns an array of ids. */
  let selectedTagIds = $state<ID[]>([]);

  /** User-added attribute rows. Each row carries the attribute name and
   *  the current value; we look the FilterAttribute up at render time so
   *  the palette can refresh without rebuilding rows. */
  type AttrRow = { id: number; name: string | null; value: unknown };
  let attrRows = $state<AttrRow[]>([]);
  let nextRowId = 1;

  /** Pending attachments — files the user has picked / dropped but not
   *  yet uploaded. We upload them on submit (the CAS POSTs are out-of-
   *  batch HTTP requests; only `file.create` and `attachment.create` can
   *  ride the dispatcher batch). */
  type PendingAttachment = {
    id: number;
    file: File;
    status: 'queued' | 'uploading' | 'ready' | 'error';
    fileId?: ID;
    error?: string;
  };
  let pendingAttachments = $state<PendingAttachment[]>([]);
  let nextAttId = 1;
  let dragOverActive = $state(false);

  let dialogEl: HTMLDivElement | null = $state(null);
  let titleEl: HTMLInputElement | null = $state(null);
  let lastFocused: HTMLElement | null = null;

  /** Whether to render the assignee combobox at all. */
  const showAssignee = $derived.by(() => {
    if (prefill?.assigneeUserId !== undefined) return true;
    return defaultCardType === 'task' && assigneeOptions.length > 0;
  });

  /** Names already covered by the well-known slots (and thus filtered
   *  out of the "+ Add field" picker so the user can't shadow a field
   *  the dialog already manages). */
  const wellKnownAttrNames = $derived.by((): ReadonlySet<string> => {
    const s = new Set<string>(['title', 'description', 'tags']);
    if (showAssignee) s.add('assignee');
    if (prefill?.laneAttribute !== undefined) s.add(prefill.laneAttribute.name);
    for (const a of prefill?.extraAttributes ?? []) s.add(a.name);
    for (const r of attrRows) if (r.name !== null) s.add(r.name);
    return s;
  });

  /** "+ Add field" options: every palette attribute not already covered. */
  const attrPickerOptions = $derived.by(() =>
    attributePalette
      .filter((a) => !wellKnownAttrNames.has(a.name))
      .map((a) => ({ value: a.name, label: a.label })),
  );

  /** Tag picker visibility: gated on supply by the calling screen. The
   *  picker is meaningful only for card types that can carry tags, and
   *  only when the screen has actually loaded the tag list. */
  const showTags = $derived(tagOptions.length > 0);

  /* ----------------------------------------------- focus + open/close fx --- */

  $effect(() => {
    if (open) {
      lastFocused = (typeof document !== 'undefined'
        ? (document.activeElement as HTMLElement | null)
        : null) ?? null;
      // Seed assignee from prefill when the overlay opens.
      if (prefill?.assigneeUserId !== undefined && assigneeId === null) {
        assigneeId = prefill.assigneeUserId;
      }
      void tick().then(() => titleEl?.focus());
    } else {
      // Restore focus to whoever opened us.
      if (lastFocused) {
        const el = lastFocused;
        lastFocused = null;
        queueMicrotask(() => {
          try {
            el.focus?.();
          } catch {
            /* ignore */
          }
        });
      }
    }
  });

  /* ---------------------------------------------------------- focus trap --- */

  function focusableInside(root: HTMLElement): HTMLElement[] {
    const sel =
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.from(root.querySelectorAll<HTMLElement>(sel)).filter(
      (el) => !el.hasAttribute('inert') && el.offsetParent !== null,
    );
  }

  /** Tab-trap is implemented at the dialog level so Tab from title goes to
   * description (default browser order) — we only intervene at the boundaries. */
  function onDialogKeydown(e: KeyboardEvent) {
    if (!dialogEl) return;
    if (e.key === 'Tab') {
      const fs = focusableInside(dialogEl);
      if (fs.length === 0) {
        e.preventDefault();
        return;
      }
      const first = fs[0]!;
      const last = fs[fs.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || (active !== null && !dialogEl.contains(active))) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
  }

  /* -------------------------------------------------------- key handlers --- */

  function isModEnter(e: KeyboardEvent): boolean {
    return e.key === 'Enter' && (e.ctrlKey || e.metaKey);
  }

  function onTitleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      requestClose();
      return;
    }
    if (isModEnter(e)) {
      e.preventDefault();
      e.stopPropagation();
      void submit({ closeAfter: true });
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      void submit({ closeAfter: false });
    }
  }

  function onDescriptionKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      requestClose();
      return;
    }
    if (isModEnter(e)) {
      e.preventDefault();
      e.stopPropagation();
      void submit({ closeAfter: true });
    }
    // Plain Enter inside the textarea is a newline — do NOT submit.
  }

  function onShellKeydown(e: KeyboardEvent) {
    // Catches the case where focus is on the assignee Combobox or footer.
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      requestClose();
      return;
    }
    if (isModEnter(e)) {
      e.preventDefault();
      e.stopPropagation();
      void submit({ closeAfter: true });
    }
  }

  /* ----------------------------------------------- attribute row helpers --- */

  function addAttrRow(): void {
    attrRows = [...attrRows, { id: nextRowId++, name: null, value: undefined }];
  }

  function removeAttrRow(rowId: number): void {
    attrRows = attrRows.filter((r) => r.id !== rowId);
  }

  function setAttrName(rowId: number, name: string | null): void {
    attrRows = attrRows.map((r) => {
      if (r.id !== rowId) return r;
      // Picking a new attribute resets the value — the previous value
      // may not be meaningful under the new attribute's type.
      return { ...r, name, value: undefined };
    });
  }

  function setAttrValue(rowId: number, value: unknown): void {
    attrRows = attrRows.map((r) => (r.id === rowId ? { ...r, value } : r));
  }

  function attributeFor(name: string | null): FilterAttribute | null {
    if (name === null) return null;
    return attributePalette.find((a) => a.name === name) ?? null;
  }

  /* ----------------------------------------------- attachment helpers --- */

  function queueFiles(files: FileList | File[] | null | undefined): void {
    if (!files) return;
    const list = Array.from(files);
    if (list.length === 0) return;
    const additions: PendingAttachment[] = list.map((f) => ({
      id: nextAttId++,
      file: f,
      status: 'queued',
    }));
    pendingAttachments = [...pendingAttachments, ...additions];
  }

  function removeAttachment(rowId: number): void {
    pendingAttachments = pendingAttachments.filter((a) => a.id !== rowId);
  }

  function onAttachmentInput(e: Event): void {
    const input = e.currentTarget as HTMLInputElement;
    queueFiles(input.files);
    // Reset so re-picking the same file fires the change event again.
    input.value = '';
  }

  function onDropZoneDrop(e: DragEvent): void {
    e.preventDefault();
    dragOverActive = false;
    if (e.dataTransfer?.files) queueFiles(e.dataTransfer.files);
  }

  function onDropZoneDragOver(e: DragEvent): void {
    e.preventDefault();
    dragOverActive = true;
  }

  function onDropZoneDragLeave(): void {
    dragOverActive = false;
  }

  function fmtSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /**
   * Upload every queued attachment to CAS + `file.create`. Returns the
   * resolved file ids (in the same order as `pendingAttachments`).
   * Throws if any upload failed — the caller surfaces the error inline.
   */
  async function prepareAttachments(): Promise<ID[]> {
    if (pendingAttachments.length === 0) return [];
    const fileIds: ID[] = [];
    // Sequential upload keeps the failure mode simple — the first failing
    // file aborts the rest, and the dialog has a per-file error chip to
    // show which one tripped. Most submissions carry 1–2 files; parallel
    // upload would only shave milliseconds.
    for (const att of pendingAttachments) {
      if (att.status === 'ready' && att.fileId !== undefined) {
        fileIds.push(att.fileId);
        continue;
      }
      att.status = 'uploading';
      delete att.error;
      try {
        const fileId = await prepareAttachmentFile(
          dispatcher,
          att.file,
          authState ?? null,
        );
        att.fileId = fileId;
        att.status = 'ready';
        fileIds.push(fileId);
      } catch (e) {
        att.status = 'error';
        att.error = e instanceof Error ? e.message : String(e);
        throw e;
      }
    }
    return fileIds;
  }

  /* ---------------------------------------------------------- submission --- */

  function requestClose() {
    if (submitting) return;
    open = false;
    onClose?.();
  }

  function clearInputs() {
    title = '';
    description = '';
    // Keep the assignee selection — the user explicitly chose it (or it came
    // from prefill); blanking it would force them to re-select for every
    // rapid-fire entry.
    // Clear the per-submission inputs so the next rapid-fire entry
    // starts clean. Details stay open so the user doesn't have to
    // re-expand for the next item.
    selectedTagIds = [];
    attrRows = [];
    pendingAttachments = [];
  }

  async function submit(opts: { closeAfter: boolean }) {
    if (submitting) return;
    if (title.trim() === '') return;
    submitting = true;
    errorMessage = null;

    const effectivePrefill: QuickEntryPrefill = { ...(prefill ?? {}) };
    if (assigneeId !== null) {
      effectivePrefill.assigneeUserId = assigneeId;
    }

    // Card-type ↔ parent matrix today: project is top-level (no parent
    // required); everything else (task, milestone, component, tag) is
    // parented under a project. When the caller didn't supply a parent
    // we pick the sidebar's active project scope. Surface a clear inline
    // error rather than letting the wire `requires a parent` reach the
    // user. Logic lives in `resolveParentForInsert` so the unit tests
    // can pin the behaviour without mounting the overlay.
    const resolution = resolveParentForInsert(
      defaultCardType,
      parentCardId,
      projectScope.projectId,
    );
    if (resolution.error !== null) {
      submitting = false;
      errorMessage = resolution.error;
      return;
    }

    // Gate 6: resolve the default-create-status chain when we're
    // inserting a task. Other card types either don't have a required
    // status edge (project / milestone / etc.) or don't surface through
    // QuickEntry, so the chain is skipped. If the caller didn't thread
    // the inputs through, we also skip the chain — the server's
    // required-edge check will surface the missing status with a
    // friendly enough error.
    let defaultStatusCardId: ID | undefined;
    if (defaultCardType === 'task' && candidateStatuses !== undefined) {
      // Skip the chain when the prefill already pins `status` (kanban
      // column "+"); submission.ts also short-circuits but resolving
      // here would be wasted work and could surface a misleading error
      // when the project has no triage / active statuses but the user
      // explicitly chose one.
      const pinsStatus =
        effectivePrefill.laneAttribute?.name === 'status' ||
        (effectivePrefill.extraAttributes ?? []).some(
          (a) => a.name === 'status',
        ) ||
        attrRows.some((r) => r.name === 'status' && r.value !== undefined);
      if (!pinsStatus) {
        const r = resolveDefaultCreateStatus({
          screenCard: screenCard ?? null,
          flow: flow ?? null,
          candidateStatuses,
        });
        if ('error' in r) {
          submitting = false;
          errorMessage = r.message;
          notify({ type: 'error', message: r.message });
          return;
        }
        defaultStatusCardId = r.statusCardId;
      }
    }

    // Run attachment uploads BEFORE building the batch — the CAS POSTs
    // are out-of-band, but once we have file_ids the attachment.create
    // sub-requests can ride the same batched transaction as the insert.
    let attachmentFileIds: ID[];
    try {
      attachmentFileIds = await prepareAttachments();
    } catch (e) {
      submitting = false;
      errorMessage = `Attachment upload failed: ${e instanceof Error ? e.message : String(e)}`;
      return;
    }

    const additionalAttributes = attrRows
      .filter((r) => r.name !== null && r.value !== undefined && r.value !== '')
      .map((r) => ({ name: r.name as string, value: r.value }));

    const args: QuickEntrySubmitInput = {
      cardTypeName: defaultCardType,
      title,
      description,
      prefill: effectivePrefill,
    };
    if (resolution.parentCardId !== null) args.parentCardId = resolution.parentCardId;
    if (defaultStatusCardId !== undefined) args.defaultStatusCardId = defaultStatusCardId;
    if (additionalAttributes.length > 0) args.additionalAttributes = additionalAttributes;
    if (selectedTagIds.length > 0) args.tagIds = selectedTagIds.slice();
    if (attachmentFileIds.length > 0) args.attachmentFileIds = attachmentFileIds;

    try {
      const newCardId = await submitQuickEntry(dispatcher, args);
      onCreated?.(newCardId);
      notify({
        type: 'success',
        message: 'Created',
        undo: () => {
          void dispatcher.request<CardDeleteInput, CardDeleteOutput>({
            endpoint: 'card',
            action: 'delete',
            data: { cardId: newCardId },
          });
        },
      });
      clearInputs();
      if (opts.closeAfter) {
        open = false;
        onClose?.();
      } else {
        // Re-enable inputs BEFORE focusing — focus() on a disabled input is a
        // browser no-op, so leaving submitting=true here would silently drop
        // focus and the user couldn't immediately type the next title.
        submitting = false;
        await tick();
        titleEl?.focus();
        return;
      }
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : String(e);
    } finally {
      submitting = false;
    }
  }

  /* --------------------------------------------------------- backdrop fx --- */

  function onBackdropClick() {
    if (submitting) return;
    requestClose();
  }

  /* ----------------------------- portal action: re-parent to <body> --- */

  function portal(node: HTMLElement) {
    const body = typeof document !== 'undefined' ? document.body : null;
    if (body) body.appendChild(node);
    return {
      destroy() {
        if (node.parentNode) node.parentNode.removeChild(node);
      },
    };
  }

  const assigneeComboOptions = $derived.by(() =>
    assigneeOptions.map((o) => ({ value: o.value, label: o.label })),
  );

  const tagComboOptions = $derived.by(() =>
    tagOptions.map((o) => ({ value: o.value, label: o.label })),
  );
</script>

{#if open}
  <div
    use:portal
    class="fixed inset-0 z-50 flex items-center justify-center p-4"
    onkeydown={onShellKeydown}
    role="presentation"
  >
    <button
      type="button"
      class="absolute inset-0 bg-black/40"
      aria-label="Close"
      tabindex="-1"
      onclick={onBackdropClick}
    ></button>
    <div
      bind:this={dialogEl}
      role="dialog"
      aria-modal="true"
      aria-label="Quick entry"
      tabindex="-1"
      onkeydown={onDialogKeydown}
      class={cx(
        'relative z-10 flex max-h-[90vh] w-full flex-col rounded-lg border',
        'border-border bg-bg text-fg shadow-2xl',
        detailsOpen ? 'max-w-2xl' : 'max-w-lg',
      )}
    >
      <header class="border-b border-border px-5 py-3">
        <h2 class="text-base font-semibold">New {defaultCardType}</h2>
      </header>

      <div class="flex-1 overflow-auto px-5 py-4">
        {#if errorMessage}
          <div
            role="alert"
            class="mb-3 rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
          >
            {errorMessage}
          </div>
        {/if}

        <label class="mb-2 block text-xs font-medium text-muted" for="qe-title">
          Title
        </label>
        <input
          id="qe-title"
          bind:this={titleEl}
          bind:value={title}
          type="text"
          autocomplete="off"
          placeholder="Title"
          disabled={submitting}
          class={cx(
            'mb-3 w-full rounded-md border border-border bg-bg px-2 py-1.5 text-sm',
            'text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          )}
          onkeydown={onTitleKeydown}
        />

        <label class="mb-2 block text-xs font-medium text-muted" for="qe-description">
          Description
        </label>
        <textarea
          id="qe-description"
          bind:value={description}
          rows="4"
          placeholder="Description (optional)"
          disabled={submitting}
          class={cx(
            'mb-3 w-full resize-y rounded-md border border-border bg-bg px-2 py-1.5 text-sm',
            'text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          )}
          onkeydown={onDescriptionKeydown}
        ></textarea>

        {#if !detailsOpen}
          <button
            type="button"
            class="text-xs text-accent hover:underline focus:outline-none focus-visible:underline"
            onclick={() => (detailsOpen = true)}
            data-testid="qe-more-toggle"
          >
            + More details
          </button>
        {:else}
          <button
            type="button"
            class="mb-3 text-xs text-muted hover:underline focus:outline-none focus-visible:underline"
            onclick={() => (detailsOpen = false)}
            data-testid="qe-more-toggle"
          >
            − Hide details
          </button>

          {#if showAssignee}
            <label class="mb-2 block text-xs font-medium text-muted" for="qe-assignee">
              Assignee
            </label>
            <div class="mb-3">
              <Combobox
                id="qe-assignee"
                bind:value={assigneeId}
                options={assigneeComboOptions}
                placeholder="Select assignee…"
                disabled={submitting}
                aria-label="Assignee"
              />
            </div>
          {/if}

          {#if showTags}
            <label class="mb-2 block text-xs font-medium text-muted" for="qe-tags">
              Tags
            </label>
            <div class="mb-3" data-testid="qe-tags-picker">
              <Combobox
                id="qe-tags"
                bind:value={selectedTagIds}
                options={tagComboOptions}
                multiple
                placeholder="Pick tags…"
                disabled={submitting}
                aria-label="Tags"
              />
            </div>
          {/if}

          <!-- Attributes ----------------------------------------------- -->
          <div class="mb-3" data-testid="qe-attributes">
            <div class="mb-1 flex items-center justify-between">
              <span class="text-xs font-medium text-muted">Attributes</span>
              <button
                type="button"
                class="text-xs text-accent hover:underline focus:outline-none focus-visible:underline disabled:opacity-50"
                disabled={submitting || attrPickerOptions.length === 0}
                onclick={addAttrRow}
                data-testid="qe-add-attribute"
              >
                + Add field
              </button>
            </div>
            {#if attrRows.length === 0}
              <p class="text-[11px] italic text-muted">
                {attrPickerOptions.length === 0
                  ? 'No extra attributes available.'
                  : 'Click + Add field to set an attribute.'}
              </p>
            {/if}
            {#each attrRows as row (row.id)}
              {@const fa = attributeFor(row.name)}
              <div class="mb-1.5 flex items-start gap-1.5" data-testid="qe-attr-row">
                <div class="w-40 shrink-0">
                  <Combobox
                    aria-label="Attribute"
                    options={attributePalette
                      .filter(
                        (a) => a.name === row.name || !wellKnownAttrNames.has(a.name),
                      )
                      .map((a) => ({ value: a.name, label: a.label }))}
                    value={row.name}
                    placeholder="Field…"
                    disabled={submitting}
                    onchange={(v) =>
                      setAttrName(row.id, typeof v === 'string' ? v : null)}
                  />
                </div>
                <div class="min-w-0 flex-1">
                  {#if fa !== null}
                    <ValueInput
                      attribute={fa}
                      value={row.value}
                      multiple={fa.valueType.endsWith('[]') ||
                        fa.valueType === 'card_ref[]'}
                      onchange={(v) => setAttrValue(row.id, v)}
                    />
                  {:else}
                    <span class="text-xs italic text-muted">Pick a field first.</span>
                  {/if}
                </div>
                <IconButton
                  aria-label="Remove field"
                  size="sm"
                  variant="ghost"
                  onclick={() => removeAttrRow(row.id)}
                >
                  {#snippet children()}×{/snippet}
                </IconButton>
              </div>
            {/each}
          </div>

          <!-- Attachments ---------------------------------------------- -->
          <div class="mb-3" data-testid="qe-attachments">
            <span class="mb-1 block text-xs font-medium text-muted">Attachments</span>
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              role="button"
              tabindex="0"
              class={cx(
                'flex flex-col items-center gap-1 rounded-md border border-dashed px-3 py-3 text-xs',
                dragOverActive
                  ? 'border-accent bg-accent/5 text-accent'
                  : 'border-border text-muted hover:border-accent/40',
              )}
              ondragover={onDropZoneDragOver}
              ondragleave={onDropZoneDragLeave}
              ondrop={onDropZoneDrop}
              onkeydown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  (document.getElementById('qe-file-input') as HTMLInputElement | null)?.click();
                }
              }}
            >
              <span>Drop files or</span>
              <label
                for="qe-file-input"
                class="cursor-pointer text-accent hover:underline"
              >
                browse to attach
              </label>
              <input
                id="qe-file-input"
                type="file"
                multiple
                class="hidden"
                onchange={onAttachmentInput}
                data-testid="qe-file-input"
              />
            </div>
            {#each pendingAttachments as att (att.id)}
              <div
                class="mt-1.5 flex items-center gap-2 rounded border border-border bg-surface/40 px-2 py-1 text-xs"
                data-testid="qe-attachment-row"
              >
                <span class="flex-1 truncate">{att.file.name}</span>
                <span class="text-muted">{fmtSize(att.file.size)}</span>
                {#if att.status === 'uploading'}
                  <span class="text-accent">uploading…</span>
                {:else if att.status === 'error'}
                  <span class="text-danger" title={att.error}>error</span>
                {:else if att.status === 'ready'}
                  <span class="text-success">ready</span>
                {/if}
                <IconButton
                  aria-label="Remove attachment"
                  size="sm"
                  variant="ghost"
                  onclick={() => removeAttachment(att.id)}
                >
                  {#snippet children()}×{/snippet}
                </IconButton>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <footer
        class="flex flex-col gap-2 border-t border-border px-5 py-3 text-xs text-muted"
      >
        <div class="flex items-center justify-between gap-2">
          <span>Press Enter to add another · Ctrl+Enter to add and close · Esc to cancel</span>
          {#if submitting}
            <span class="text-accent">Saving…</span>
          {/if}
        </div>
        <div class="flex items-center justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={submitting || title.trim() === ''}
            onclick={() => void submit({ closeAfter: false })}
          >
            {#snippet children()}Add &amp; Another{/snippet}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={submitting || title.trim() === ''}
            onclick={() => void submit({ closeAfter: true })}
          >
            {#snippet children()}Add &amp; Close{/snippet}
          </Button>
        </div>
      </footer>
    </div>
  </div>
{/if}
