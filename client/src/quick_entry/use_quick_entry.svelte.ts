/**
 * `useQuickEntry` — small rune-based controller for QuickEntryOverlay.
 *
 * Wires the `n` shortcut for the given scope and exposes a `props` object
 * the screen can spread directly onto the component:
 *
 * ```svelte
 * <script lang="ts">
 *   const qe = useQuickEntry({
 *     scope: 'inbox',
 *     defaultCardType: 'task',
 *     prefill: { assigneeUserId: me.id },
 *     onCreated: () => refresh(),
 *   });
 * </script>
 *
 * <QuickEntryOverlay {...qe.props} />
 * ```
 */

import { useShortcut } from '../keys/shortcut.js';
import type { ShortcutScope } from '../keys/scopes.js';
import type { ID } from '../reg/types.js';
import type { QuickEntryPrefill } from './submission.js';

export interface UseQuickEntryOptions {
  scope: ShortcutScope;
  defaultCardType: string;
  parentCardId?: ID;
  prefill?: QuickEntryPrefill;
  /** Optional list of assignee options for the inline picker. */
  assigneeOptions?: { value: ID; label: string }[];
  onCreated?: (id: ID) => void;
}

/**
 * Props the rune feeds back into `<QuickEntryOverlay {...qe.props} />`. Note
 * that `open` is bindable on the component side; the rune mirrors its `state`
 * here so toggling the props object is a one-liner.
 */
export interface UseQuickEntryProps {
  open: boolean;
  defaultCardType: string;
  parentCardId?: ID;
  prefill?: QuickEntryPrefill;
  assigneeOptions?: { value: ID; label: string }[];
  onCreated?: (id: ID) => void;
  onClose: () => void;
}

export interface UseQuickEntry {
  /**
   * Open the overlay. Accepts an optional one-shot prefill that overrides
   * the controller-level default — used by Kanban "+ Add" buttons that
   * want a column-specific prefill without rebuilding the controller.
   * The override is cleared on close.
   */
  open: (override?: QuickEntryPrefill) => void;
  close: () => void;
  isOpen: () => boolean;
  /** Spread onto `<QuickEntryOverlay>`. */
  props: UseQuickEntryProps;
}

export function useQuickEntry(opts: UseQuickEntryOptions): UseQuickEntry {
  let isOpen = $state(false);
  let override = $state<QuickEntryPrefill | null>(null);

  function openOverlay(next?: QuickEntryPrefill): void {
    override = next ?? null;
    isOpen = true;
  }

  function closeOverlay(): void {
    isOpen = false;
    override = null;
  }

  // Bind `n` to open the overlay at the given scope.
  useShortcut(opts.scope, 'n', () => openOverlay(), `New ${opts.defaultCardType}`);

  return {
    open: openOverlay,
    close: closeOverlay,
    isOpen: () => isOpen,
    get props(): UseQuickEntryProps {
      const p: UseQuickEntryProps = {
        open: isOpen,
        defaultCardType: opts.defaultCardType,
        onClose: closeOverlay,
      };
      if (opts.parentCardId !== undefined) p.parentCardId = opts.parentCardId;
      const effective = override ?? opts.prefill;
      if (effective !== undefined) p.prefill = effective;
      if (opts.assigneeOptions !== undefined) p.assigneeOptions = opts.assigneeOptions;
      if (opts.onCreated !== undefined) p.onCreated = opts.onCreated;
      return p;
    },
  } as UseQuickEntry;
}
