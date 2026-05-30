/**
 * CardRefValue — read-only render of a single card_ref id → resolved label.
 *
 * Consumes a {@link LoadState}`<string>` THUNK so the renderer reads the
 * lifecycle of the lookup explicitly: `Unset` (not loaded yet) renders the
 * `#id` placeholder + a "pending" tone; `Value(label)` renders the resolved
 * name + a "resolved" tone the host can fade in via CSS.  No more
 * `map[id] ?? '#id'` reimplementations across screens; no more "is the
 * label undefined because it hasn't loaded, or because the row legitimately
 * has no label?" ambiguity.
 *
 * Contract:
 *
 *   - `id: bigint | null | undefined` — null/undefined → unset placeholder
 *     (the row had no ref at all).
 *   - `label: () => LoadState<string>` — REACTIVE thunk owned by the
 *     parent.  Most commonly `() => model.refLabel(target, id).get()`
 *     against a {@link PanelModel}; can be any signal-reading thunk.
 *   - Chip wears `[data-card-ref-resolved]` (kind === 'value') /
 *     `[data-card-ref-pending]` (kind === 'unset' or 'pending') so a CSS
 *     transition can fade in the resolve.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import {
  Unset,
  isResolved,
  valueOf,
  type LoadState,
} from '../core/load-state.js';

/* -------------------------------------------------------------------------- */
/* Config + declaration-merged registry type.                                  */
/* -------------------------------------------------------------------------- */

export interface CardRefValueConfig extends BaseControlConfig {
  type: 'CardRefValue';
  /** The id to resolve. `null` / `undefined` → unset placeholder. */
  id: bigint | null | undefined;
  /** Informational — the target card_type. Surfaced as `data-target-card-type`
   *  on the root so styling / tests can scope by target. */
  targetCardType?: string;
  /**
   * Reactive thunk yielding the lookup state.  When it returns Unset the
   * chip shows `#id` + the pending tone; when Value, the label + the
   * resolved tone.  The thunk runs inside a reactive effect, so a signal
   * read inside it (e.g. `model.refLabel(...).get()`) repaints automatically.
   */
  label: () => LoadState<string>;
  /** Override for the null/undefined-id render. Default '—'. */
  unsetText?: string;
  /** Optional extra class added to the root (caller styling hook). */
  extraClass?: string;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    CardRefValue: CardRefValueConfig;
  }
}

/* -------------------------------------------------------------------------- */
/* Control.                                                                   */
/* -------------------------------------------------------------------------- */

export class CardRefValue extends Control<CardRefValueConfig> {
  protected override createRoot(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'card-ref-value';
    el.dataset.control = 'CardRefValue';
    if (this.config.extraClass) {
      for (const c of this.config.extraClass.split(/\s+/).filter(Boolean)) {
        el.classList.add(c);
      }
    }
    if (this.config.targetCardType !== undefined) {
      el.dataset.targetCardType = this.config.targetCardType;
    }
    return el;
  }

  protected render(): void {
    const { id, label, unsetText } = this.config;

    // The unset-id case is fixed at construction (the parent re-spawns on
    // an id change), and has no lookup to track.  Render once + bail.
    if (id === null || id === undefined) {
      this.el.textContent = unsetText ?? '—';
      this.el.dataset.cardRefUnset = '';
      this.el.classList.add('card-ref-value--unset');
      return;
    }
    const idStr = id.toString();
    this.el.dataset.cardRefId = idStr;

    // The label thunk drives every reactive surface on the chip.  ONE read
    // of `label()` per render — the underlying signal subscribes us.
    const labelStateFor = (): LoadState<string> => label() ?? Unset;
    this.bindText(this.el, () => {
      const s = labelStateFor();
      return valueOf(s) ?? `#${idStr}`;
    });
    this.bindClass(this.el, 'card-ref-value--resolved', () => isResolved(labelStateFor()));
    this.bindClass(this.el, 'card-ref-value--pending', () => !isResolved(labelStateFor()));
    // bindAttr's contract treats '' as "remove" (HTML attribute presence
    // semantics); pass `true` to mean "the attribute is present" — the
    // helper writes a bare flag (`attr=""`) so the CSS selector
    // `[data-card-ref-resolved]` matches.
    this.bindAttr(this.el, 'data-card-ref-resolved', () =>
      isResolved(labelStateFor()) ? true : null,
    );
    this.bindAttr(this.el, 'data-card-ref-pending', () =>
      !isResolved(labelStateFor()) ? true : null,
    );
    // Surface the lifecycle kind so tests + styles can branch on it without
    // re-reading the thunk.
    this.bindAttr(this.el, 'data-card-ref-state', () => labelStateFor().kind);
  }
}

export function registerCardRefValue(): void {
  Control.register('CardRefValue', CardRefValue);
}
