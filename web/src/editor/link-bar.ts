/**
 * The editor's link bar — what the Link command opens instead of a browser
 * prompt. A strip at the top of the edit area with one text box: type or
 * paste a URL and press Enter, or, when the host supplies link targets
 * (the page detail offers its project's pages as `ref:<id>` links), pick
 * one from the list below the box. Escape or Cancel closes it.
 *
 * DOM-only and engine-agnostic: the engine says where to put the bar and
 * what to do with the chosen href; {@link filterLinkTargets} is the pure
 * matching rule (exported for tests).
 */

import type { LinkTarget } from './engine.js';

/**
 * Most suggestions the bar renders at once. The list scrolls (about eight
 * rows show); past this many a footer says how many more match, so typing
 * narrows rather than the DOM growing with the project.
 */
const MAX_SHOWN = 50;

/** Text that is plainly a URL (or a ref:) rather than a page search. */
const URLISH = /^(?:[a-z][a-z0-9+.-]*:|\/|#|\.)/i;

/** The last segment of a "Home › Guide › Install" label: the page's own title. */
const ownTitle = (label: string): string => label.slice(label.lastIndexOf('›') + 1);

/**
 * The targets matching what's typed, best first: all of them for an empty
 * box, none once the text looks like a URL, else those whose label or hint
 * contains every typed word, case-insensitively, in any order. Targets whose
 * own title (the label's last segment) holds every word come before those
 * matched only through a parent's title or the hint; otherwise the input
 * order (alphabetical by path) holds.
 */
export function filterLinkTargets(targets: readonly LinkTarget[], query: string): LinkTarget[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...targets];
  if (URLISH.test(q)) return [];
  const words = q.split(/\s+/);
  const own: LinkTarget[] = [];
  const rest: LinkTarget[] = [];
  for (const t of targets) {
    const hay = `${t.label} ${t.hint ?? ''}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue;
    const title = ownTitle(t.label).toLowerCase();
    (words.every((w) => title.includes(w)) ? own : rest).push(t);
  }
  return [...own, ...rest];
}

export interface LinkBarOptions {
  /** Element the bar is inserted into, before `before`. */
  host: HTMLElement;
  before: Node | null;
  /** Pickable targets ([] for a URL-only bar). */
  targets: readonly LinkTarget[];
  /** A target or typed URL was chosen. */
  onApply: (href: string) => void;
  /** The bar closed (after apply, Cancel or Escape). */
  onClose: () => void;
}

export interface LinkBar {
  el: HTMLElement;
  focus(): void;
  close(): void;
}

/** Build, insert and focus a link bar. */
export function openLinkBar(opts: LinkBarOptions): LinkBar {
  const bar = document.createElement('div');
  bar.className = 'rich-editor__link-bar';
  bar.dataset.linkBar = '';

  const row = document.createElement('div');
  row.className = 'rich-editor__link-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rich-editor__link-input';
  input.dataset.linkInput = '';
  input.placeholder = opts.targets.length > 0 ? 'Paste a URL, or search pages' : 'Paste a URL';
  input.setAttribute('aria-label', 'Link target');
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'btn btn-primary rich-editor__link-apply';
  apply.dataset.linkApply = '';
  apply.textContent = 'Link';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn rich-editor__link-cancel';
  cancel.dataset.linkCancel = '';
  cancel.textContent = 'Cancel';
  row.append(input, apply, cancel);

  const list = document.createElement('ul');
  list.className = 'rich-editor__link-list';
  list.dataset.linkList = '';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Pages');
  const more = document.createElement('div');
  more.className = 'muted rich-editor__link-more';
  more.dataset.linkMore = '';
  bar.append(row, list, more);

  let shown: LinkTarget[] = [];
  let active = -1;
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    bar.remove();
    opts.onClose();
  };
  const choose = (href: string): void => {
    if (href.trim() === '') return;
    opts.onApply(href.trim());
    close();
  };

  const paint = (): void => {
    const hits = filterLinkTargets(opts.targets, input.value);
    shown = hits.slice(0, MAX_SHOWN);
    if (active >= shown.length) active = shown.length - 1;
    list.replaceChildren();
    list.style.display = shown.length === 0 ? 'none' : '';
    const hidden = hits.length - shown.length;
    more.style.display = hidden > 0 ? '' : 'none';
    more.textContent = hidden > 0 ? `${String(hidden)} more ${hidden === 1 ? 'page matches' : 'pages match'}. Keep typing to narrow the list.` : '';
    shown.forEach((t, i) => {
      const li = document.createElement('li');
      li.className = 'rich-editor__link-option' + (i === active ? ' is-active' : '');
      li.dataset.linkOption = t.href;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', i === active ? 'true' : 'false');
      const label = document.createElement('span');
      label.textContent = t.label;
      li.append(label);
      if (t.hint !== undefined && t.hint !== '') {
        const hint = document.createElement('span');
        hint.className = 'muted rich-editor__link-hint';
        hint.textContent = t.hint;
        li.append(hint);
      }
      // mousedown, not click: keep focus in the box until the choice lands.
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        choose(t.href);
      });
      list.append(li);
    });
    // Keep the highlighted row in view as the arrow keys walk a long list.
    // (Optional call: jsdom has no scrollIntoView.)
    if (active >= 0) list.children[active]?.scrollIntoView?.({ block: 'nearest' });
  };

  input.addEventListener('input', () => {
    active = -1;
    paint();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (shown.length === 0) return;
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      active = (active + step + shown.length) % shown.length;
      paint();
    } else if (e.key === 'Enter') {
      // Keep Enter / Mod+Enter from reaching the host (it would commit the
      // whole description).
      e.preventDefault();
      e.stopPropagation();
      const pick = active >= 0 ? shown[active] : undefined;
      choose(pick !== undefined ? pick.href : input.value);
    } else if (e.key === 'Escape') {
      // Close the bar only; the host's Escape cancels the whole edit.
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  apply.addEventListener('click', () => {
    const pick = active >= 0 ? shown[active] : undefined;
    choose(pick !== undefined ? pick.href : input.value);
  });
  cancel.addEventListener('click', close);

  opts.host.insertBefore(bar, opts.before);
  paint();
  input.focus();
  return { el: bar, focus: () => input.focus(), close };
}
