/**
 * PagePublications — the PUBLISHED ON section of a page's detail view: where
 * the page is live, and whether that copy is current.
 *
 * One row per portal holding a snapshot of the page (`page.publications`):
 * the portal's name, whether it is public or preview-only (a QA portal), when
 * and by whom it was published, a badge saying whether that copy matches the
 * page as it is now ("Current") or the page has edits the portal doesn't show
 * yet ("Unpublished edits"), and a Preview link that opens the portal's
 * signed-in preview at this page in a new tab.
 *
 * A page reaches a portal by ENTERING a status whose publishes_to names it
 * (the TransitionBar above), so the detail calls {@link reload} after a move
 * and after an edit (which can turn a copy stale).
 *
 * (A page's place in the site — its parent, child pages, "+ Child page" — is
 * the PLACE IN SITE section, PageStructure.)
 *
 * Zero-promise: reads/writes go through `api.callByName(..., { alive })`.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { localTimeEl } from '../util/datetime.js';
import {
  PORTAL_SPEC,
  previewUrl,
  type PagePublication,
  type PagePublicationsOutput,
} from '../bundles/specs.js';

export interface PagePublicationsConfig extends BaseControlConfig {
  type: 'PagePublications';
  /** The focal page id (string from the route). */
  pageId?: string;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    PagePublications: PagePublicationsConfig;
  }
}

export class PagePublications extends Control<PagePublicationsConfig> {
  private pageId: bigint | null = null;
  private rows: PagePublication[] = [];
  private loaded = false;
  private listEl!: HTMLElement;

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'page-pubs';
    el.dataset.control = 'PagePublications';
    el.dataset.region = 'detail.publications';
    return el;
  }

  protected render(): void {
    this.pageId = parseId(this.config.pageId);

    const head = document.createElement('div');
    head.className = 'page-pubs__head';
    const heading = document.createElement('h2');
    heading.className = 'task-detail__section-label muted';
    heading.textContent = 'PUBLISHED ON';
    head.append(heading);

    const list = document.createElement('ul');
    list.className = 'page-pubs__list';
    list.dataset.pagePubs = '';
    this.listEl = list;

    this.el.append(head, list);
    this.paint();
    this.load();
  }

  /** Public refresh hook (after a status move / an edit / header Refresh). */
  reload(): void {
    this.load();
  }

  private load(): void {
    if (this.pageId === null) return;
    this.ctx.api.callByName(
      PORTAL_SPEC.publications,
      { pageId: this.pageId },
      (out) => {
        if (!this.isAlive()) return;
        this.rows = (out as PagePublicationsOutput).rows ?? [];
        this.loaded = true;
        this.paint();
      },
      { alive: () => this.isAlive() },
    );
  }

  private paint(): void {
    this.listEl.replaceChildren();
    if (this.rows.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'page-pubs__empty muted';
      empty.dataset.pagePubsEmpty = '';
      empty.textContent = this.loaded
        ? 'Not published. Moving the page into a status that publishes to a portal puts it there.'
        : 'Loading…';
      this.listEl.append(empty);
      return;
    }
    for (const r of this.rows) this.listEl.append(this.renderRow(r));
  }

  private renderRow(r: PagePublication): HTMLElement {
    const li = document.createElement('li');
    li.className = 'page-pubs__item';
    li.dataset.pagePub = r.portalId.toString();

    const top = document.createElement('div');
    top.className = 'page-pubs__top';
    const name = document.createElement('span');
    name.className = 'page-pubs__portal';
    name.textContent = r.portalTitle !== '' ? r.portalTitle : `Portal #${r.portalId.toString()}`;
    const reach = document.createElement('span');
    reach.className = 'page-pubs__reach muted';
    reach.textContent = r.public ? (r.host !== '' ? r.host : 'Public') : 'Preview only';
    const state = document.createElement('span');
    state.className = `page-pubs__state page-pubs__state--${r.current ? 'current' : 'stale'}`;
    state.dataset.pagePubState = r.current ? 'current' : 'stale';
    state.textContent = r.current ? 'Current' : 'Unpublished edits';
    state.title = r.current
      ? 'This portal shows the page as it is now.'
      : 'The page has edits this portal doesn’t show yet. Publish again (e.g. “Publish changes”) to send them.';
    top.append(name, reach, state);

    const meta = document.createElement('div');
    meta.className = 'page-pubs__meta muted';
    const text = (t: string): Text => document.createTextNode(t);
    meta.append(text('Published '));
    if (r.publishedAt !== '') meta.append(localTimeEl(r.publishedAt, 'page-pubs__time'));
    if (r.publishedBy !== '') meta.append(text(` by ${r.publishedBy}`));
    meta.append(text(' · '));
    const preview = document.createElement('a');
    preview.className = 'page-pubs__preview';
    preview.dataset.pagePubPreview = '';
    preview.href = previewUrl(r.portalId, r.path);
    preview.target = '_blank';
    preview.rel = 'noopener';
    preview.textContent = r.path !== '' ? 'Preview' : 'Preview (building…)';
    meta.append(preview);

    li.append(top, meta);
    return li;
  }
}

function parseId(raw: string | undefined): bigint | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const n = BigInt(raw);
  return n > 0n ? n : null;
}

export function registerPagePublications(): void {
  Control.register('PagePublications', PagePublications);
}
