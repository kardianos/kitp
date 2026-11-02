/**
 * SiteView — a portal's site shown inside kitp (/site/:id): the portal's
 * "Show in kitp" switch lists it in the sidebar's SITES section, and this
 * view frames its active build in the content area.
 *
 * The frame loads `/api/v1/portal/<id>/site/`, which serves the build under
 * a sandboxing CSP: no scripts, forms or top-level navigation, so nothing in
 * it can act as the signed-in user. The page keeps kitp's origin
 * (allow-same-origin) so its own stylesheets, images and links carry the
 * session cookie — an opaque origin makes them cross-site and the
 * SameSite=Lax cookie stays behind (401s: no styles, broken links). The
 * <iframe sandbox> repeats the same flags; new tabs (links to other sites
 * open in one) leave the sandbox. A header names the site and
 * offers it in a new tab. It shows what the portal publishes — the published
 * copies, not drafts.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { PORTAL_SPEC, siteUrl, type PortalListOutput, type PortalRow } from '../bundles/specs.js';

export interface SiteViewConfig extends BaseControlConfig {
  type: 'SiteView';
  /** The portal id (string from the route). */
  portalId?: string;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    SiteView: SiteViewConfig;
  }
}

export class SiteView extends Control<SiteViewConfig> {
  private head!: HTMLElement;
  private body!: HTMLElement;

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'site-view';
    el.dataset.control = 'SiteView';
    return el;
  }

  protected render(): void {
    this.head = document.createElement('header');
    this.head.className = 'site-view__head';
    this.body = document.createElement('div');
    this.body.className = 'site-view__body';
    this.el.append(this.head, this.body);
    const id = this.config.portalId ?? '';
    if (!/^\d+$/.test(id)) {
      this.showMissing();
      return;
    }
    this.message('Loading…');
    this.ctx.api.callByName(
      PORTAL_SPEC.list,
      {},
      (out) => {
        if (!this.isAlive()) return;
        const row = ((out as PortalListOutput).rows ?? []).find((r) => r.id.toString() === id);
        if (row === undefined || !row.internal) this.showMissing();
        else this.showSite(row);
      },
      { alive: () => this.isAlive() },
    );
  }

  private showSite(row: PortalRow): void {
    const title = document.createElement('h1');
    title.className = 'site-view__title';
    title.textContent = row.title;
    const meta = document.createElement('span');
    meta.className = 'site-view__meta muted';
    meta.textContent = row.builtAt === '' ? 'Not built yet' : `${row.pageCount} page${row.pageCount === 1 ? '' : 's'}`;
    const open = document.createElement('a');
    open.className = 'btn btn--xs site-view__open';
    open.dataset.siteOpen = '';
    open.href = siteUrl(row.id);
    open.target = '_blank';
    open.rel = 'noopener';
    open.textContent = 'Open in new tab';
    this.head.replaceChildren(title, meta, open);

    const frame = document.createElement('iframe');
    frame.className = 'site-view__frame';
    frame.dataset.siteFrame = '';
    frame.title = row.title;
    frame.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    frame.src = siteUrl(row.id);
    this.body.replaceChildren(frame);
  }

  private showMissing(): void {
    this.head.replaceChildren();
    this.message('This site isn’t shown in kitp. An admin can turn on “Show in kitp” for it in Admin → Portals.');
  }

  private message(text: string): void {
    const p = document.createElement('p');
    p.className = 'muted site-view__message';
    p.dataset.siteMessage = '';
    p.textContent = text;
    this.body.replaceChildren(p);
  }
}

export function registerSiteView(): void {
  Control.register('SiteView', SiteView);
}
