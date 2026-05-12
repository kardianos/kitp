<script lang="ts">
  /**
   * Split button that closes / cancels / otherwise terminalises a card
   * by setting a ref attribute to one of its terminal-flagged value
   * cards.
   *
   * Primary click sends the card to the first terminal option (the
   * obvious "Close" affordance). The chevron opens a popover listing
   * every terminal option so the user can pick a specific one ("Cancel"
   * vs "Done", say). Hidden entirely when the attribute has no terminal
   * options or the card is already pointing at one of them.
   *
   * Used both on the task detail header and on row hover. Visual size
   * is configurable via the `compact` prop so the row variant fits in
   * the inline action strip.
   */
  import { tick } from 'svelte';
  import {
    autoUpdate,
    computePosition,
    flip,
    offset,
  } from '@floating-ui/dom';
  import { getDispatcher } from '../../dispatch/context';
  import { attributeUpdate } from '../../reg/handlers';
  import type {
    AttributeUpdateInput,
    AttributeUpdateOutput,
    ID,
  } from '../../reg/types';
  import { notify } from '../toast.svelte';
  import { cx } from '../../util/class_names';

  interface Option {
    id: ID;
    label: string;
  }

  interface Props {
    cardId: ID;
    attributeName: string;
    terminalOptions: Option[];
    /** Current value of the ref attr; used to decide if we should hide. */
    currentValue?: ID | null;
    onChanged?: () => void;
    compact?: boolean;
    /** Override the primary label (defaults to "Close"). */
    primaryLabel?: string;
  }

  let {
    cardId,
    attributeName,
    terminalOptions,
    currentValue,
    onChanged,
    compact = false,
    primaryLabel = 'Close',
  }: Props = $props();

  const dispatcher = getDispatcher();

  const alreadyTerminal = $derived.by((): boolean => {
    if (currentValue === undefined || currentValue === null) return false;
    return terminalOptions.some((o) => o.id === currentValue);
  });

  const visible = $derived(terminalOptions.length > 0 && !alreadyTerminal);

  const primaryOption = $derived(terminalOptions[0]);

  let menuOpen = $state(false);
  let trigger: HTMLDivElement | null = $state(null);
  let popup: HTMLDivElement | null = $state(null);
  let cleanupFloat: (() => void) | null = null;
  let busy = $state(false);

  async function setStatus(optId: ID, label: string): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await dispatcher.request<AttributeUpdateInput, AttributeUpdateOutput>({
        endpoint: attributeUpdate.endpoint,
        action: attributeUpdate.action,
        data: { cardId, attributeName, value: optId },
      });
      onChanged?.();
    } catch (e) {
      notify({
        type: 'error',
        message: `Failed to set ${attributeName}: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      busy = false;
    }
  }

  async function openMenu(): Promise<void> {
    menuOpen = true;
    await tick();
    if (!trigger || !popup) return;
    cleanupFloat?.();
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

  function closeMenu(): void {
    menuOpen = false;
    cleanupFloat?.();
    cleanupFloat = null;
  }

  function onDocPointerDown(e: PointerEvent): void {
    if (!menuOpen) return;
    const t = e.target as Node | null;
    if (!t) return;
    if (popup?.contains(t)) return;
    if (trigger?.contains(t)) return;
    closeMenu();
  }

  $effect(() => {
    if (menuOpen) {
      document.addEventListener('pointerdown', onDocPointerDown, true);
      return () => document.removeEventListener('pointerdown', onDocPointerDown, true);
    }
    return undefined;
  });

  $effect(() => () => cleanupFloat?.());

  async function pickPrimary(e: MouseEvent): Promise<void> {
    e.stopPropagation();
    if (primaryOption === undefined) return;
    await setStatus(primaryOption.id, primaryOption.label);
  }

  function toggleMenu(e: MouseEvent): void {
    e.stopPropagation();
    if (menuOpen) closeMenu();
    else void openMenu();
  }
</script>

{#if visible && primaryOption !== undefined}
  <div bind:this={trigger} class="relative inline-flex">
    <div
      class={cx(
        'inline-flex items-stretch overflow-hidden rounded-md border border-border bg-bg text-sm',
        compact ? 'h-7' : 'h-8',
      )}
    >
      <button
        type="button"
        class={cx(
          'inline-flex items-center gap-1 px-2 hover:bg-surface focus:outline-none focus-visible:bg-surface',
          busy && 'cursor-wait opacity-60',
          compact ? 'text-xs' : 'text-sm',
        )}
        disabled={busy}
        title="{primaryLabel} ({primaryOption.label})"
        data-testid="terminal-action-primary"
        onclick={pickPrimary}
      >
        <span>{primaryLabel}</span>
      </button>
      {#if terminalOptions.length > 1}
        <button
          type="button"
          class={cx(
            'inline-flex items-center border-l border-border px-1.5 text-muted hover:bg-surface focus:outline-none focus-visible:bg-surface',
            busy && 'cursor-wait opacity-60',
          )}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="Pick a terminal state"
          title="Pick a terminal state"
          data-testid="terminal-action-toggle"
          disabled={busy}
          onclick={toggleMenu}
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

    {#if menuOpen}
      <div
        bind:this={popup}
        role="menu"
        class="z-50 flex w-48 flex-col overflow-hidden rounded-md border border-border bg-bg py-1 text-sm shadow-lg"
        style="position: fixed; left: 0; top: 0; opacity: 0; pointer-events: none;"
      >
        {#each terminalOptions as opt (String(opt.id))}
          <button
            type="button"
            role="menuitem"
            class="px-3 py-1.5 text-left hover:bg-surface focus:outline-none focus-visible:bg-surface"
            onclick={(e) => {
              e.stopPropagation();
              closeMenu();
              void setStatus(opt.id, opt.label);
            }}
          >
            {opt.label}
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/if}
