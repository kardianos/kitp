<script lang="ts">
  /**
   * QuickEntryOverlay — `n` shortcut from any list screen lands here.
   *
   * Layout: title input (auto-focused), description textarea (Tab from title
   * focuses here), optional assignee Combobox. Footer: "Enter to add another,
   * Ctrl+Enter to add and close, Esc to cancel."
   *
   * Submission flow:
   *  - Plain Enter inside the title input  -> submit, KEEP overlay open, clear
   *    inputs, refocus title for the next entry.
   *  - Ctrl/Cmd+Enter (anywhere)           -> submit, CLOSE overlay.
   *  - Esc                                  -> close without submission.
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
  import { tick } from 'svelte';
  import { getDispatcher } from '../dispatch/context.js';
  import { projectScope } from '../shell/project_scope.svelte';
  import Combobox from '../ui/Combobox.svelte';
  import { notify } from '../ui/toast.svelte.js';
  import { cx } from '../util/class_names.js';
  import {
    resolveParentForInsert,
    submitQuickEntry,
    type QuickEntryPrefill,
    type QuickEntrySubmitInput,
  } from './submission.js';
  import { projectTypeSelect } from '../reg/handlers_admin.js';
  import type {
    CardDeleteInput,
    CardDeleteOutput,
    ProjectTypeRow,
    ProjectTypeSelectInput,
    ProjectTypeSelectOutput,
  } from '../reg/types.js';

  interface AssigneeOption {
    value: number;
    label: string;
  }

  interface Props {
    open: boolean;
    defaultCardType: string;
    parentCardId?: number;
    prefill?: QuickEntryPrefill;
    /**
     * List of assignee options the Combobox renders. Empty array hides the
     * picker (only relevant when defaultCardType === 'task' or prefill set
     * an assignee). Screens fetch this via `user.select` and pass it through.
     */
    assigneeOptions?: AssigneeOption[];
    onCreated?: (newCardId: number) => void;
    onClose?: () => void;
  }

  let {
    open = $bindable(),
    defaultCardType,
    parentCardId,
    prefill,
    assigneeOptions = [],
    onCreated,
    onClose,
  }: Props = $props();

  const dispatcher = getDispatcher();

  /* ------------------------------------------------------------------ state */

  let title = $state('');
  let description = $state('');
  let assigneeId = $state<number | null>(null);
  let projectTypeId = $state<number | null>(null);
  let projectTypes = $state<ProjectTypeRow[]>([]);
  let submitting = $state(false);
  let errorMessage = $state<string | null>(null);

  let dialogEl: HTMLDivElement | null = $state(null);
  let titleEl: HTMLInputElement | null = $state(null);
  let lastFocused: HTMLElement | null = null;

  /** Whether to render the assignee combobox at all. */
  const showAssignee = $derived.by(() => {
    if (prefill?.assigneeUserId !== undefined) return true;
    return defaultCardType === 'task' && assigneeOptions.length > 0;
  });

  /** Render the project_type combobox only for project create flows. */
  const showProjectType = $derived(defaultCardType === 'project');

  const projectTypeOptions = $derived(
    projectTypes.map((p) => ({
      value: p.id,
      label: p.is_default ? `${p.name} (default)` : p.name,
    })),
  );

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
      // Lazy-load project_types when opening for a project create. Pick
      // the prefill or the default row as the initial selection.
      if (showProjectType && projectTypes.length === 0) {
        void (async () => {
          try {
            const out = await dispatcher.request<
              ProjectTypeSelectInput,
              ProjectTypeSelectOutput
            >({
              endpoint: projectTypeSelect.endpoint,
              action: projectTypeSelect.action,
              data: {},
            });
            projectTypes = out.rows;
            if (projectTypeId === null) {
              if (prefill?.projectTypeId !== undefined) {
                projectTypeId = prefill.projectTypeId;
              } else {
                const def = out.rows.find((r) => r.is_default);
                projectTypeId = def?.id ?? out.rows[0]?.id ?? null;
              }
            }
          } catch {
            // If the load fails the combobox stays empty; the server
            // falls back to the default row anyway.
          }
        })();
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
    if (showProjectType && projectTypeId !== null) {
      effectivePrefill.projectTypeId = projectTypeId;
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

    const args: QuickEntrySubmitInput = {
      cardTypeName: defaultCardType,
      title,
      description,
      prefill: effectivePrefill,
    };
    if (resolution.parentCardId !== null) args.parentCardId = resolution.parentCardId;

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
        'relative z-10 flex max-h-[90vh] w-full max-w-lg flex-col rounded-lg border',
        'border-border bg-bg text-fg shadow-2xl',
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

        {#if showProjectType}
          <label class="mb-2 block text-xs font-medium text-muted" for="qe-project-type">
            Project type
          </label>
          <div class="mb-3" data-testid="qe-project-type">
            <Combobox
              id="qe-project-type"
              bind:value={projectTypeId}
              options={projectTypeOptions}
              placeholder="Select type…"
              disabled={submitting || projectTypes.length === 0}
              aria-label="Project type"
            />
          </div>
        {/if}
      </div>

      <footer
        class="flex items-center justify-between gap-2 border-t border-border px-5 py-3 text-xs text-muted"
      >
        <span>Press Enter to add another · Ctrl+Enter to add and close · Esc to cancel</span>
        {#if submitting}
          <span class="text-accent">Saving…</span>
        {/if}
      </footer>
    </div>
  </div>
{/if}
