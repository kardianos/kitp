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

import type { FilterAttribute } from '../filter/attribute_schema.svelte.js';
import { useShortcut } from '../keys/shortcut.js';
import type { ShortcutScope } from '../keys/scopes.js';
import type { CardWithAttrs, ID } from '../reg/types.js';
import type { FlowRow } from './default_status.svelte.js';
import type { QuickEntryPrefill } from './submission.js';

export interface UseQuickEntryOptions {
  scope: ShortcutScope;
  defaultCardType: string;
  parentCardId?: ID;
  prefill?: QuickEntryPrefill;
  /** Optional list of assignee options for the inline picker. */
  assigneeOptions?: { value: ID; label: string }[];
  /**
   * Gate 6: inputs for the default-create-status chain. Screens that
   * have these values in memory thread them through so QuickEntry can
   * stamp the resolved status on the new task in the same
   * `card.insert`. These are provided as getters (not eager values)
   * so a screen that calls `useQuickEntry` once at mount and refreshes
   * `statuses` async still has the latest data when the user submits.
   * The plain-value forms remain accepted for non-reactive callers and
   * tests; both shapes round-trip through the overlay unchanged.
   */
  screenCard?: CardWithAttrs | null | (() => CardWithAttrs | null);
  flow?: FlowRow | null | (() => FlowRow | null);
  candidateStatuses?: CardWithAttrs[] | (() => CardWithAttrs[]);
  /**
   * Attribute palette feeding the "+ Add field" picker in the
   * expanded dialog. Same FilterAttribute shape the FilterBar / Advanced
   * editor consume, so screens that already build a palette can pass it
   * straight through. Provided as a getter so async-loaded palette
   * entries become visible mid-session without rebuilding the rune.
   */
  attributePalette?: FilterAttribute[] | (() => FilterAttribute[]);
  /**
   * Available tag cards, surfaced as a multi-select in the dialog's
   * "More details" section. Each option is `{value: tagCardId, label: path}`.
   * Getter form keeps the list reactive to the screen's per-project
   * tag fetch.
   */
  tagOptions?: { value: ID; label: string }[] | (() => { value: ID; label: string }[]);
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
  /** Resolved (not a getter) — the rune unwraps any function form. */
  screenCard?: CardWithAttrs | null;
  /** Resolved (not a getter) — the rune unwraps any function form. */
  flow?: FlowRow | null;
  /** Resolved (not a getter) — the rune unwraps any function form. */
  candidateStatuses?: CardWithAttrs[];
  /** Resolved (not a getter) — the rune unwraps any function form. */
  attributePalette?: FilterAttribute[];
  /** Resolved (not a getter) — the rune unwraps any function form. */
  tagOptions?: { value: ID; label: string }[];
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
      if (opts.screenCard !== undefined) {
        p.screenCard = typeof opts.screenCard === 'function'
          ? (opts.screenCard as () => CardWithAttrs | null)()
          : opts.screenCard;
      }
      if (opts.flow !== undefined) {
        p.flow = typeof opts.flow === 'function'
          ? (opts.flow as () => FlowRow | null)()
          : opts.flow;
      }
      if (opts.candidateStatuses !== undefined) {
        p.candidateStatuses = typeof opts.candidateStatuses === 'function'
          ? (opts.candidateStatuses as () => CardWithAttrs[])()
          : opts.candidateStatuses;
      }
      if (opts.attributePalette !== undefined) {
        p.attributePalette = typeof opts.attributePalette === 'function'
          ? (opts.attributePalette as () => FilterAttribute[])()
          : opts.attributePalette;
      }
      if (opts.tagOptions !== undefined) {
        p.tagOptions = typeof opts.tagOptions === 'function'
          ? (opts.tagOptions as () => { value: ID; label: string }[])()
          : opts.tagOptions;
      }
      if (opts.onCreated !== undefined) p.onCreated = opts.onCreated;
      return p;
    },
  } as UseQuickEntry;
}
