/**
 * TagChip — the reusable tag-path → chip control. LIFTED from the Svelte
 * client's `client/src/ui/widgets/TagChip.svelte` (which wraps the lower-level
 * `Chip`): it renders a single tag, showing the LEAF segment of the tag path
 * as the chip label and carrying the full path as a tooltip so a hierarchical
 * tag (`area/frontend/ui`) reads compactly as `ui` while staying discoverable.
 *
 * This is the reusable tag control going forward — the Grid's Tags column
 * renders one TagChip per tag, and future screens (task detail, inbox row
 * summaries) mount the same control. It is purely presentational: NO data
 * bindings, NO promises, NO API calls — config in, DOM out. An optional
 * `onRemove` renders an `×` affordance (parity with the Svelte `removable`
 * prop) for editable tag lists; the Grid mounts it read-only.
 *
 * Structural hooks for tests + the later styling pass (NO visual CSS this
 * pass): root `data-tag-chip`, `data-tag-path` (the full path), and a
 * `.tag-chip` / `.tag-chip__label` / `.tag-chip__remove` class per part.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { tagPathLeaf } from './grid-helpers.js';

import { icon } from '../ui/icons.js';
export interface TagChipConfig extends BaseControlConfig {
  type: 'TagChip';
  /** The full tag path (e.g. `area/frontend/ui`). The chip shows the leaf. */
  path: string;
  /** Render an `×` remove affordance. Default false (read-only chip). */
  removable?: boolean;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    TagChip: TagChipConfig;
  }
}

export class TagChip extends Control<TagChipConfig> {
  /** Set by the host (e.g. the Grid) when the chip should be removable. */
  private onRemove: (() => void) | null = null;

  /** Register a remove callback before mount; renders the `×` affordance. */
  setOnRemove(fn: () => void): void {
    this.onRemove = fn;
  }

  protected override createRoot(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'tag-chip';
    el.dataset.control = 'TagChip';
    el.dataset.tagChip = '';
    return el;
  }

  protected render(): void {
    const path = typeof this.config.path === 'string' ? this.config.path : '';
    this.el.dataset.tagPath = path;
    // Full path as a tooltip so the compacted leaf label stays discoverable.
    if (path.length > 0) this.el.title = path;

    const label = document.createElement('span');
    label.className = 'tag-chip__label';
    label.textContent = tagPathLeaf(path);
    this.el.append(label);

    const removable = this.config.removable === true || this.onRemove !== null;
    if (removable) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'tag-chip__remove';
      remove.dataset.tagRemove = '';
      remove.append(icon('x', 12));
      remove.setAttribute('aria-label', `Remove tag ${path}`);
      this.el.append(remove);
      this.listen(remove, 'click', (ev) => {
        ev.stopPropagation();
        this.onRemove?.();
      });
    }
  }
}

export function registerTagChip(): void {
  Control.register('TagChip', TagChip);
}
