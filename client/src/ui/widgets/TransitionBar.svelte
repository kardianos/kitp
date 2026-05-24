<script lang="ts">
  /**
   * Renders the available state transitions for one card. Replaces
   * {@link TerminalActionButton} (which only handled the
   * active→terminal "Close ▾" bucket); TransitionBar handles every
   * `(from_phase, to_phase)` pair via the 9-bucket table in
   * §"<TransitionBar> replaces TerminalActionButton" of
   * FLOW_AND_SCREEN_KERNEL.md.
   *
   * Bucket → default renderer:
   *   - accept    (triage→active)    : primary positive button per transition (inline).
   *   - reject    (triage→terminal)  : secondary destructive button per transition (inline).
   *   - close     (active→terminal)  : split button — first transition is primary, rest in dropdown.
   *   - reopen    (terminal→active)  : primary positive button per transition.
   *   - progress  (active→active)    : single `Status ▾` dropdown with all `to` options.
   *   - defer     (active→triage)    : inline secondary button.
   *   - retriage  (terminal→triage)  : item under Reopen dropdown.
   *   - recategorize (terminal→terminal): item under Reopen dropdown.
   *   - progress_triage (triage→triage): item under a Triage group on Status ▾.
   *
   * The `variant` prop is the only difference between the row (compact,
   * short labels) and detail (spacious, full labels) renderings — the
   * bucket logic is shared.
   *
   * Data comes from `flow_step.list_for_card`. The caller fetches the
   * transitions and passes the row list in via `transitions`. On click
   * the component dispatches `attribute.update` with the picked `to`
   * card_id, then calls `onChanged` so the parent can refresh.
   *
   * Role-gated transitions render as disabled buttons / dimmed dropdown
   * items with a "Needs <role>" hint label.
   *
   * On a V13 `flow_disallowed` / `flow_role_required` reject from
   * `attribute.update`, the component renders a sticky banner near the
   * action with each `available[]` entry as a live button (one click
   * fires the right transition); role-locked rows render disabled with
   * the required role surfaced.
   */
  import { tick } from 'svelte';
  import {
    autoUpdate,
    computePosition,
    flip,
    offset,
  } from '@floating-ui/dom';
  import { getDispatcher } from '../../dispatch/context';
  import { SubRequestError } from '../../dispatch/errors';
  import { attributeUpdate } from '../../reg/handlers';
  import type {
    AttributeUpdateInput,
    AttributeUpdateOutput,
    ID,
    TransitionPhase,
    TransitionRow,
  } from '../../reg/types';
  import { notify } from '../toast.svelte';
  import { cx } from '../../util/class_names';
  import {
    bucketOf,
    groupByBucket,
    type TransitionBucket,
  } from './transition_bar_buckets.js';

  /** One row of the V13 `available[]` rejection payload. */
  interface FlowAvailableTo {
    step_id: string;
    to: { id: string; label: string; phase: TransitionPhase };
    label: string;
    your_role_allows: boolean;
    requires_role: string | null;
  }

  interface FlowRejectionDetail {
    from: { id: string; label: string; phase: TransitionPhase };
    attempted_to: { id: string; label: string; phase: TransitionPhase };
    available: FlowAvailableTo[];
  }

  interface Props {
    cardId: ID;
    transitions: TransitionRow[];
    /** Called after a successful attribute.update so the parent can refresh. */
    onChanged?: () => void;
    /**
     * `'row'` = compact inline strip suitable for TaskRow hover affordance.
     * `'detail'` = spacious header variant used by TaskDetailScreen.
     */
    variant?: 'row' | 'detail';
  }

  let {
    cardId,
    transitions,
    onChanged,
    variant = 'detail',
  }: Props = $props();

  const dispatcher = getDispatcher();

  const buckets = $derived(groupByBucket(transitions));

  const compact = $derived(variant === 'row');

  let busy = $state(false);

  /** Active V13 rejection banner. Cleared by next successful fire or `dismissBanner()`. */
  let banner = $state<FlowRejectionDetail | null>(null);

  /** Per-bucket popover open state. Only one popover may be open at a time. */
  type OpenPopover =
    | { kind: 'close' }
    | { kind: 'progress' }
    | { kind: 'reopen' }
    | null;
  let openPopover = $state<OpenPopover>(null);

  /** Refs the popovers anchor against. */
  let closeTrigger: HTMLElement | null = $state(null);
  let closePopup: HTMLElement | null = $state(null);
  let progressTrigger: HTMLElement | null = $state(null);
  let progressPopup: HTMLElement | null = $state(null);
  let reopenTrigger: HTMLElement | null = $state(null);
  let reopenPopup: HTMLElement | null = $state(null);

  let cleanupFloat: (() => void) | null = null;

  /**
   * Fire the transition. Sends `attribute.update {cardId, attributeName,
   * value: to_card_id}` through the dispatcher. On error pin the V13
   * envelope into `banner` if present; on success clear the banner and
   * notify the parent.
   */
  export async function fireTransition(t: TransitionRow): Promise<void> {
    if (busy) return;
    if (!t.allowed) {
      notify({
        type: 'error',
        message: t.requires_role_name.length > 0
          ? `Needs role ${t.requires_role_name}`
          : 'This transition is not available.',
      });
      return;
    }
    busy = true;
    try {
      await dispatcher.request<AttributeUpdateInput, AttributeUpdateOutput>({
        endpoint: attributeUpdate.endpoint,
        action: attributeUpdate.action,
        data: {
          cardId,
          attributeName: t.attribute_def_name,
          value: t.to_card_id,
        },
      });
      banner = null;
      onChanged?.();
    } catch (e) {
      if (e instanceof SubRequestError) {
        const detail = parseRejectionDetail(e.detail);
        if (detail !== null) {
          banner = detail;
        } else {
          notify({ type: 'error', message: e.message });
        }
      } else {
        notify({
          type: 'error',
          message: `Failed to change ${t.attribute_def_name}: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    } finally {
      busy = false;
    }
  }

  function dismissBanner(): void {
    banner = null;
  }

  /**
   * Parse a `SubRequestError.detail` payload as the V13 envelope. Returns
   * null if the shape doesn't match — non-flow rejections come through
   * the same code path and we don't want to mask them.
   */
  function parseRejectionDetail(raw: unknown): FlowRejectionDetail | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    const from = parseEndpoint(o.from);
    const attempted_to = parseEndpoint(o.attempted_to);
    const available = parseAvailableArray(o.available);
    if (from === null || attempted_to === null) return null;
    return { from, attempted_to, available };
  }

  function parseEndpoint(raw: unknown):
    | { id: string; label: string; phase: TransitionPhase }
    | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    const id =
      typeof o.id === 'string'
        ? o.id
        : typeof o.id === 'bigint'
          ? o.id.toString()
          : typeof o.id === 'number'
            ? String(o.id)
            : '';
    const label = typeof o.label === 'string' ? o.label : '';
    const phase: TransitionPhase =
      o.phase === 'triage' || o.phase === 'terminal' ? o.phase : 'active';
    if (id === '') return null;
    return { id, label, phase };
  }

  function parseAvailableArray(raw: unknown): FlowAvailableTo[] {
    if (!Array.isArray(raw)) return [];
    const out: FlowAvailableTo[] = [];
    for (const r of raw) {
      if (!r || typeof r !== 'object') continue;
      const o = r as Record<string, unknown>;
      const to = parseEndpoint(o.to);
      if (to === null) continue;
      const stepId =
        typeof o.step_id === 'string'
          ? o.step_id
          : typeof o.step_id === 'bigint'
            ? o.step_id.toString()
            : typeof o.step_id === 'number'
              ? String(o.step_id)
              : '';
      out.push({
        step_id: stepId,
        to,
        label: typeof o.label === 'string' ? o.label : to.label,
        your_role_allows: o.your_role_allows === true,
        requires_role:
          typeof o.requires_role === 'string' && o.requires_role.length > 0
            ? o.requires_role
            : null,
      });
    }
    return out;
  }

  /**
   * Map a V13 `available[]` entry back to the TransitionRow we already
   * have in `transitions[]` so clicking a banner button reuses the same
   * fire path. Match by `step_id` first, then fall back to `to_card_id`.
   */
  function transitionFromAvailable(a: FlowAvailableTo): TransitionRow | null {
    for (const t of transitions) {
      if (t.id.toString() === a.step_id) return t;
    }
    for (const t of transitions) {
      if (t.to_card_id.toString() === a.to.id) return t;
    }
    return null;
  }

  /** Click handler for a banner button — fire the matching transition. */
  async function fireFromBanner(a: FlowAvailableTo): Promise<void> {
    const t = transitionFromAvailable(a);
    if (t === null) {
      notify({
        type: 'error',
        message: 'Transition not currently available; try refreshing.',
      });
      return;
    }
    await fireTransition(t);
  }

  // Popover plumbing — same shape as TerminalActionButton.

  async function openCloseMenu(): Promise<void> {
    openPopover = { kind: 'close' };
    await tick();
    rebindFloat(closeTrigger, closePopup);
  }
  async function openProgressMenu(): Promise<void> {
    openPopover = { kind: 'progress' };
    await tick();
    rebindFloat(progressTrigger, progressPopup);
  }
  async function openReopenMenu(): Promise<void> {
    openPopover = { kind: 'reopen' };
    await tick();
    rebindFloat(reopenTrigger, reopenPopup);
  }
  function closeMenu(): void {
    openPopover = null;
    cleanupFloat?.();
    cleanupFloat = null;
  }

  function rebindFloat(trigger: HTMLElement | null, popup: HTMLElement | null): void {
    cleanupFloat?.();
    if (!trigger || !popup) return;
    cleanupFloat = autoUpdate(trigger, popup, () => {
      if (!trigger || !popup) return;
      void computePosition(trigger, popup, {
        placement: 'bottom-end',
        middleware: [offset(4), flip()],
      }).then(({ x, y }) => {
        if (!popup) return;
        Object.assign(popup.style, {
          left: `${x}px`,
          top: `${y}px`,
          opacity: '1',
          pointerEvents: 'auto',
        });
      });
    });
  }

  function onDocPointerDown(e: PointerEvent): void {
    if (openPopover === null) return;
    const t = e.target as Node | null;
    if (!t) return;
    // Don't close if click was inside the open popover or its trigger.
    const trigger =
      openPopover.kind === 'close'
        ? closeTrigger
        : openPopover.kind === 'progress'
          ? progressTrigger
          : reopenTrigger;
    const popup =
      openPopover.kind === 'close'
        ? closePopup
        : openPopover.kind === 'progress'
          ? progressPopup
          : reopenPopup;
    if (popup?.contains(t)) return;
    if (trigger?.contains(t)) return;
    closeMenu();
  }

  $effect(() => {
    if (openPopover !== null) {
      document.addEventListener('pointerdown', onDocPointerDown, true);
      return () => document.removeEventListener('pointerdown', onDocPointerDown, true);
    }
    return undefined;
  });

  $effect(() => () => cleanupFloat?.());

  /** Public entry point for the `c` keyboard shortcut — fires first close transition. */
  export function fireFirstClose(): void {
    const first = buckets.close[0];
    if (first === undefined) return;
    void fireTransition(first);
  }

  // ---- Derived helpers used by the template ----

  /**
   * Friendly labels per bucket; the row variant uses the shortest form,
   * the detail variant uses the spec wording. Both fall back to the
   * transition's own `label` for per-row text.
   */
  const closePrimary = $derived(buckets.close[0]);
  const closeRest = $derived(buckets.close.slice(1));
  const reopenPrimary = $derived(buckets.reopen[0]);
  const reopenRest = $derived(buckets.reopen.slice(1));
  const retriageOptions = $derived(buckets.retriage);
  const recategorizeOptions = $derived(buckets.recategorize);

  const showCloseSplit = $derived(buckets.close.length > 0);
  const showReopenSplit = $derived(
    buckets.reopen.length > 0 || retriageOptions.length > 0 || recategorizeOptions.length > 0,
  );
  const showProgressDropdown = $derived(
    buckets.progress.length > 0 || buckets.progress_triage.length > 0,
  );

  /** Build the unified Status ▾ dropdown contents. */
  interface DropItem {
    transition: TransitionRow;
    group?: string;
  }
  const progressItems = $derived.by((): DropItem[] => {
    const out: DropItem[] = [];
    if (buckets.progress_triage.length > 0) {
      for (const t of buckets.progress_triage) out.push({ transition: t, group: 'Triage' });
    }
    for (const t of buckets.progress) out.push({ transition: t });
    return out;
  });

  const reopenDropdownItems = $derived.by((): DropItem[] => {
    const out: DropItem[] = [];
    for (const t of reopenRest) out.push({ transition: t });
    if (retriageOptions.length > 0) {
      for (const t of retriageOptions) out.push({ transition: t, group: 'Re-triage' });
    }
    if (recategorizeOptions.length > 0) {
      for (const t of recategorizeOptions) out.push({ transition: t, group: 'Recategorize' });
    }
    return out;
  });

  /** Short label for the row variant — falls back to the to_label. */
  function shortLabel(t: TransitionRow): string {
    return t.label.length > 0 ? t.label : t.to_label;
  }

  /** Full hint label "Needs <role>" rendered next to disabled buttons. */
  function roleHint(t: TransitionRow): string {
    return t.requires_role_name.length > 0 ? `Needs ${t.requires_role_name}` : '';
  }
</script>

<div
  class={cx(
    'transition-bar relative inline-flex flex-wrap items-stretch gap-1',
    variant === 'detail' ? 'text-sm' : 'text-xs',
  )}
  data-testid="transition-bar"
  data-variant={variant}
>
  <!-- accept bucket: triage → active. Primary positive button per transition. -->
  {#each buckets.accept as t (`accept-${t.id}`)}
    <button
      type="button"
      class={cx(
        'inline-flex items-center gap-1 rounded-md bg-accent px-2 font-medium text-accent-fg shadow-sm',
        'hover:opacity-90 active:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        'disabled:cursor-not-allowed disabled:opacity-50',
        compact ? 'h-7 text-xs' : 'h-8',
      )}
      disabled={busy || !t.allowed}
      title={t.allowed ? shortLabel(t) : roleHint(t)}
      data-testid="transition-accept"
      data-bucket="accept"
      data-step-id={t.id.toString()}
      onclick={() => void fireTransition(t)}
    >
      <span>{shortLabel(t)}</span>
      {#if !t.allowed && t.requires_role_name.length > 0}
        <span class="rounded bg-bg/20 px-1 text-[10px]" data-testid="role-hint"
          >{roleHint(t)}</span
        >
      {/if}
    </button>
  {/each}

  <!-- reject bucket: triage → terminal. Secondary destructive button per transition. -->
  {#each buckets.reject as t (`reject-${t.id}`)}
    <button
      type="button"
      class={cx(
        'inline-flex items-center gap-1 rounded-md border border-danger/40 bg-bg px-2 font-medium text-danger',
        'hover:bg-danger/10 active:bg-danger/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-danger',
        'disabled:cursor-not-allowed disabled:opacity-50',
        compact ? 'h-7 text-xs' : 'h-8',
      )}
      disabled={busy || !t.allowed}
      title={t.allowed ? shortLabel(t) : roleHint(t)}
      data-testid="transition-reject"
      data-bucket="reject"
      data-step-id={t.id.toString()}
      onclick={() => void fireTransition(t)}
    >
      <span>{shortLabel(t)}</span>
      {#if !t.allowed && t.requires_role_name.length > 0}
        <span class="rounded bg-surface px-1 text-[10px]" data-testid="role-hint"
          >{roleHint(t)}</span
        >
      {/if}
    </button>
  {/each}

  <!-- defer bucket: active → triage. Inline secondary button. -->
  {#each buckets.defer as t (`defer-${t.id}`)}
    <button
      type="button"
      class={cx(
        'inline-flex items-center gap-1 rounded-md border border-border bg-bg px-2 text-muted',
        'hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        'disabled:cursor-not-allowed disabled:opacity-50',
        compact ? 'h-7 text-xs' : 'h-8',
      )}
      disabled={busy || !t.allowed}
      title={t.allowed ? shortLabel(t) : roleHint(t)}
      data-testid="transition-defer"
      data-bucket="defer"
      data-step-id={t.id.toString()}
      onclick={() => void fireTransition(t)}
    >
      <span>{shortLabel(t)}</span>
      {#if !t.allowed && t.requires_role_name.length > 0}
        <span class="rounded bg-surface px-1 text-[10px]" data-testid="role-hint"
          >{roleHint(t)}</span
        >
      {/if}
    </button>
  {/each}

  <!-- close bucket: active → terminal. Split button: first = primary, rest in dropdown. -->
  {#if closePrimary !== undefined}
    <div
      bind:this={closeTrigger}
      class={cx(
        'relative inline-flex items-stretch overflow-hidden rounded-md border border-border bg-bg',
        compact ? 'h-7' : 'h-8',
      )}
      data-testid="transition-close-split"
    >
      <button
        type="button"
        class={cx(
          'inline-flex items-center gap-1 px-2 hover:bg-surface focus:outline-none focus-visible:bg-surface',
          'disabled:cursor-not-allowed disabled:opacity-50',
          compact ? 'text-xs' : 'text-sm',
        )}
        disabled={busy || !closePrimary.allowed}
        title={closePrimary.allowed ? shortLabel(closePrimary) : roleHint(closePrimary)}
        data-testid="transition-close-primary"
        data-bucket="close"
        data-step-id={closePrimary.id.toString()}
        onclick={() => closePrimary !== undefined && void fireTransition(closePrimary)}
      >
        <span>{compact ? 'Close' : shortLabel(closePrimary)}</span>
        {#if !closePrimary.allowed && closePrimary.requires_role_name.length > 0}
          <span class="rounded bg-surface px-1 text-[10px]" data-testid="role-hint"
            >{roleHint(closePrimary)}</span
          >
        {/if}
      </button>
      {#if closeRest.length > 0}
        <button
          type="button"
          class="inline-flex items-center border-l border-border px-1.5 text-muted hover:bg-surface focus:outline-none focus-visible:bg-surface"
          aria-haspopup="menu"
          aria-expanded={openPopover?.kind === 'close'}
          aria-label="Pick a closing state"
          title="Pick a closing state"
          data-testid="transition-close-toggle"
          disabled={busy}
          onclick={(e) => {
            e.stopPropagation();
            if (openPopover?.kind === 'close') closeMenu();
            else void openCloseMenu();
          }}
        >
          <svg viewBox="0 0 12 12" class="h-3 w-3" aria-hidden="true">
            <path
              d="M2 4 L6 8 L10 4"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              fill="none"
            />
          </svg>
        </button>
      {/if}
    </div>
    {#if openPopover?.kind === 'close'}
      <div
        bind:this={closePopup}
        role="menu"
        class="kf-float-anchor-fade z-50 flex w-48 flex-col overflow-hidden rounded-md border border-border bg-bg py-1 text-sm shadow-lg"
        data-testid="transition-close-menu"
      >
        {#each closeRest as t (`close-item-${t.id}`)}
          <button
            type="button"
            role="menuitem"
            class={cx(
              'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-surface',
              'focus:outline-none focus-visible:bg-surface',
              'disabled:cursor-not-allowed disabled:opacity-50',
            )}
            disabled={busy || !t.allowed}
            data-testid="transition-close-item"
            data-step-id={t.id.toString()}
            onclick={(e) => {
              e.stopPropagation();
              closeMenu();
              void fireTransition(t);
            }}
          >
            <span>{t.label.length > 0 ? t.label : t.to_label}</span>
            {#if !t.allowed && t.requires_role_name.length > 0}
              <span class="text-[10px] text-muted" data-testid="role-hint"
                >{roleHint(t)}</span
              >
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  {/if}

  <!-- progress bucket: active → active (+ progress_triage as Triage subgroup). Single Status ▾ dropdown. -->
  {#if showProgressDropdown}
    <div
      bind:this={progressTrigger}
      class={cx(
        'relative inline-flex items-stretch overflow-hidden rounded-md border border-border bg-bg',
        compact ? 'h-7' : 'h-8',
      )}
      data-testid="transition-progress-trigger"
    >
      <button
        type="button"
        class={cx(
          'inline-flex items-center gap-1 px-2 hover:bg-surface focus:outline-none focus-visible:bg-surface',
          'disabled:cursor-not-allowed disabled:opacity-50',
          compact ? 'text-xs' : 'text-sm',
        )}
        aria-haspopup="menu"
        aria-expanded={openPopover?.kind === 'progress'}
        aria-label="Change status"
        title="Change status"
        disabled={busy}
        data-bucket="progress"
        onclick={(e) => {
          e.stopPropagation();
          if (openPopover?.kind === 'progress') closeMenu();
          else void openProgressMenu();
        }}
      >
        <span>Status</span>
        <svg viewBox="0 0 12 12" class="h-3 w-3" aria-hidden="true">
          <path
            d="M2 4 L6 8 L10 4"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            fill="none"
          />
        </svg>
      </button>
    </div>
    {#if openPopover?.kind === 'progress'}
      <div
        bind:this={progressPopup}
        role="menu"
        class="kf-float-anchor-fade z-50 flex w-56 flex-col overflow-hidden rounded-md border border-border bg-bg py-1 text-sm shadow-lg"
        data-testid="transition-progress-menu"
      >
        {#each progressItems as item, i (`progress-item-${item.transition.id}`)}
          {#if item.group !== undefined && (i === 0 || progressItems[i - 1]?.group !== item.group)}
            <div
              class="px-3 pt-1 text-[10px] uppercase tracking-wider text-muted"
              data-testid="transition-progress-group"
            >
              {item.group}
            </div>
          {/if}
          <button
            type="button"
            role="menuitem"
            class={cx(
              'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-surface',
              'focus:outline-none focus-visible:bg-surface',
              'disabled:cursor-not-allowed disabled:opacity-50',
            )}
            disabled={busy || !item.transition.allowed}
            data-testid="transition-progress-item"
            data-step-id={item.transition.id.toString()}
            data-bucket={bucketOf(item.transition)}
            onclick={(e) => {
              e.stopPropagation();
              closeMenu();
              void fireTransition(item.transition);
            }}
          >
            <span>{item.transition.label.length > 0 ? item.transition.label : item.transition.to_label}</span>
            {#if !item.transition.allowed && item.transition.requires_role_name.length > 0}
              <span class="text-[10px] text-muted" data-testid="role-hint"
                >{roleHint(item.transition)}</span
              >
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  {/if}

  <!-- reopen bucket: terminal → active. Primary positive button + dropdown for retriage / recategorize. -->
  {#if showReopenSplit}
    {@const primary = reopenPrimary}
    <div
      bind:this={reopenTrigger}
      class={cx(
        'relative inline-flex items-stretch overflow-hidden rounded-md border border-border bg-bg',
        compact ? 'h-7' : 'h-8',
      )}
      data-testid="transition-reopen-split"
    >
      {#if primary !== undefined}
        <button
          type="button"
          class={cx(
            'inline-flex items-center gap-1 bg-accent px-2 font-medium text-accent-fg',
            'hover:opacity-90 active:opacity-80 focus:outline-none focus-visible:bg-accent',
            'disabled:cursor-not-allowed disabled:opacity-50',
            compact ? 'text-xs' : 'text-sm',
          )}
          disabled={busy || !primary.allowed}
          title={primary.allowed ? shortLabel(primary) : roleHint(primary)}
          data-testid="transition-reopen-primary"
          data-bucket="reopen"
          data-step-id={primary.id.toString()}
          onclick={() => void fireTransition(primary)}
        >
          <span>{compact ? 'Reopen' : shortLabel(primary)}</span>
          {#if !primary.allowed && primary.requires_role_name.length > 0}
            <span class="rounded bg-bg/20 px-1 text-[10px]" data-testid="role-hint"
              >{roleHint(primary)}</span
            >
          {/if}
        </button>
      {/if}
      {#if reopenDropdownItems.length > 0}
        <button
          type="button"
          class={cx(
            'inline-flex items-center border-l border-border px-1.5 text-muted hover:bg-surface',
            'focus:outline-none focus-visible:bg-surface',
            primary === undefined && 'px-2',
          )}
          aria-haspopup="menu"
          aria-expanded={openPopover?.kind === 'reopen'}
          aria-label={primary === undefined ? 'Reopen options' : 'Pick a reopen state'}
          title={primary === undefined ? 'Reopen options' : 'Pick a reopen state'}
          data-testid="transition-reopen-toggle"
          disabled={busy}
          onclick={(e) => {
            e.stopPropagation();
            if (openPopover?.kind === 'reopen') closeMenu();
            else void openReopenMenu();
          }}
        >
          {#if primary === undefined}
            <span>Reopen</span>
          {/if}
          <svg viewBox="0 0 12 12" class="h-3 w-3" aria-hidden="true">
            <path
              d="M2 4 L6 8 L10 4"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              fill="none"
            />
          </svg>
        </button>
      {/if}
    </div>
    {#if openPopover?.kind === 'reopen'}
      <div
        bind:this={reopenPopup}
        role="menu"
        class="kf-float-anchor-fade z-50 flex w-56 flex-col overflow-hidden rounded-md border border-border bg-bg py-1 text-sm shadow-lg"
        data-testid="transition-reopen-menu"
      >
        {#each reopenDropdownItems as item, i (`reopen-item-${item.transition.id}`)}
          {#if item.group !== undefined && (i === 0 || reopenDropdownItems[i - 1]?.group !== item.group)}
            <div
              class="px-3 pt-1 text-[10px] uppercase tracking-wider text-muted"
              data-testid="transition-reopen-group"
            >
              {item.group}
            </div>
          {/if}
          <button
            type="button"
            role="menuitem"
            class={cx(
              'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-surface',
              'focus:outline-none focus-visible:bg-surface',
              'disabled:cursor-not-allowed disabled:opacity-50',
            )}
            disabled={busy || !item.transition.allowed}
            data-testid="transition-reopen-item"
            data-step-id={item.transition.id.toString()}
            data-bucket={bucketOf(item.transition)}
            onclick={(e) => {
              e.stopPropagation();
              closeMenu();
              void fireTransition(item.transition);
            }}
          >
            <span>{item.transition.label.length > 0 ? item.transition.label : item.transition.to_label}</span>
            {#if !item.transition.allowed && item.transition.requires_role_name.length > 0}
              <span class="text-[10px] text-muted" data-testid="role-hint"
                >{roleHint(item.transition)}</span
              >
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  {/if}

  <!-- V13 flow-disallowed banner. Sticky until the user clicks a recovery option or dismisses. -->
  {#if banner !== null}
    <div
      role="alert"
      data-testid="transition-banner"
      class={cx(
        'order-last flex w-full flex-col gap-2 rounded-md border border-danger/40 bg-danger/5 p-2 text-fg',
        variant === 'detail' ? 'text-sm' : 'text-xs',
      )}
    >
      <div class="flex items-start justify-between gap-2">
        <p class="leading-snug">
          <span class="font-medium">{banner.from.label}</span> →
          <span class="font-medium">{banner.attempted_to.label}</span> isn't a valid move.
        </p>
        <button
          type="button"
          class="rounded p-0.5 text-muted hover:bg-surface"
          aria-label="Dismiss"
          title="Dismiss"
          data-testid="transition-banner-dismiss"
          onclick={dismissBanner}
        >
          <svg viewBox="0 0 12 12" class="h-3 w-3" aria-hidden="true">
            <path
              d="M3 3 L9 9 M9 3 L3 9"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              fill="none"
            />
          </svg>
        </button>
      </div>
      {#if banner.available.length > 0}
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="text-muted">You can:</span>
          {#each banner.available as a (a.step_id)}
            <button
              type="button"
              class={cx(
                'inline-flex items-center gap-1 rounded-md border border-border bg-bg px-2 py-0.5',
                'hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                'disabled:cursor-not-allowed disabled:opacity-60',
              )}
              disabled={busy || !a.your_role_allows}
              data-testid="transition-banner-action"
              data-step-id={a.step_id}
              title={a.your_role_allows ? a.label : a.requires_role !== null ? `Needs ${a.requires_role}` : ''}
              onclick={() => void fireFromBanner(a)}
            >
              <span>{a.label}</span>
              {#if !a.your_role_allows && a.requires_role !== null}
                <span class="text-[10px] text-muted" data-testid="role-hint">Needs {a.requires_role}</span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>
