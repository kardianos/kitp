/**
 * AreaSwitches — the switches for a project's areas (Tasks, Conversations,
 * Approvals, Content), in the project's properties, or for the workspace's
 * (Sites), on the Areas admin screen. See docs/AREAS.md.
 *
 * One row per area: what it holds, what it needs, where it started from,
 * its state and the action that changes it.
 *   - On → "Switch off", behind an inline confirm: off hides everything in
 *     the area from everyone, admins included, and pauses its automation.
 *     Managers and admins can switch off.
 *   - Off → "Switch on" (admins only: it reveals what the area holds).
 *   - Not set up → "Set up" with a choice of starting point (admins only).
 * The server has the last word on every rule (area.set); an inline error
 * shows its refusal ("Conversations uses Tasks; switch it off first").
 *
 * After a change the shell's navigation reloads (screens of an area that
 * is off leave the sidebar). Zero promises: area.list / area.set through
 * api.callByName(..., { alive }).
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { peekIsAdmin, peekHasRole } from '../auth/auth-state.js';
import { faultText } from '../admin/record-form.js';
import { AREA_SPEC, type AreaListOutput, type AreaRow } from '../bundles/specs.js';

export interface AreaSwitchesConfig extends BaseControlConfig {
  type: 'AreaSwitches';
  /** 'project' lists one project's areas; 'workspace' the workspace's. */
  scope: 'project' | 'workspace';
  /** The project (scope 'project'), as a string id. */
  projectId?: string;
  /** A heading above the rows (the admin screen); none in the properties
   *  panel, which labels its section itself. */
  title?: string;
  /** Tree path bumped after a change so the shell's navigation reloads.
   *  Default 'shell.navRefresh'. */
  navRefreshPath?: string;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    AreaSwitches: AreaSwitchesConfig;
  }
}

const STATE_LABEL: Record<AreaRow['state'], string> = {
  on: 'On',
  off: 'Off · hidden',
  unused: 'Not set up',
};

/** "Needs Tasks", "Started from Task tracking", "12 items" — the muted
 *  facts under an area's description. */
export function areaFacts(a: AreaRow, all: readonly AreaRow[]): string[] {
  const facts: string[] = [];
  if (a.dependsOn.length > 0) {
    const names = a.dependsOn.map((k) => all.find((x) => x.key === k)?.title ?? k);
    facts.push(`Needs ${names.join(' and ')}`);
  }
  const added = a.starts.filter((s) => a.added.includes(s.key)).map((s) => s.title);
  if (added.length > 0) facts.push(`Started from ${added.join(', ')}`);
  if (a.items !== null) facts.push(`${a.items} item${a.items === 1 ? '' : 's'}`);
  return facts;
}

export class AreaSwitches extends Control<AreaSwitchesConfig> {
  private areas: AreaRow[] = [];
  private loaded = false;
  private confirming: string | null = null;
  private busy: string | null = null;
  private errors: Record<string, string> = {};
  /** The starting point picked per area (Set up / Switch on). */
  private picked: Record<string, string> = {};
  private list!: HTMLElement;

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'area-switches';
    el.dataset.control = 'AreaSwitches';
    return el;
  }

  protected render(): void {
    if (this.config.title !== undefined) {
      const h = document.createElement('h1');
      h.className = 'area-switches__title';
      h.textContent = this.config.title;
      const intro = document.createElement('p');
      intro.className = 'area-switches__intro muted';
      intro.textContent =
        this.config.scope === 'workspace'
          ? 'Areas of the whole workspace. Switching one off hides everything in it from everyone and stops it working until it is switched back on.'
          : 'Switching an area off hides everything in it from everyone and stops it working until it is switched back on.';
      this.el.append(h, intro);
    }
    this.list = document.createElement('div');
    this.list.className = 'area-switches__list';
    this.list.dataset.areaSwitches = this.config.scope;
    this.el.append(this.list);
    this.paint();
    this.load();
  }

  private projectId(): bigint | undefined {
    const raw = this.config.projectId;
    return this.config.scope === 'project' && raw !== undefined && /^\d+$/.test(raw) ? BigInt(raw) : undefined;
  }

  private load(): void {
    const projectId = this.projectId();
    if (this.config.scope === 'project' && projectId === undefined) return;
    this.ctx.api.callByName(
      AREA_SPEC.list,
      projectId !== undefined ? { projectId } : {},
      (out) => {
        if (!this.isAlive()) return;
        this.areas = ((out as AreaListOutput).areas ?? []).filter((a) => a.scope === this.config.scope);
        this.loaded = true;
        this.busy = null;
        this.paint();
      },
      {
        alive: () => this.isAlive(),
        onErr: () => {
          this.loaded = true;
          this.paint();
        },
      },
    );
  }

  private paint(): void {
    if (!this.loaded || this.areas.length === 0) {
      const p = document.createElement('p');
      p.className = 'muted area-switches__empty';
      p.textContent = this.loaded ? 'No areas.' : 'Loading…';
      this.list.replaceChildren(p);
      return;
    }
    const admin = peekIsAdmin(this.ctx.tree);
    const manager = admin || peekHasRole(this.ctx.tree, 'manager');
    this.list.replaceChildren(...this.areas.map((a) => this.row(a, admin, manager)));
  }

  private row(a: AreaRow, admin: boolean, manager: boolean): HTMLElement {
    const row = document.createElement('div');
    row.className = `area-switches__row area-switches__row--${a.state}`;
    row.dataset.area = a.key;
    row.dataset.areaState = a.state;

    const text = document.createElement('div');
    text.className = 'area-switches__text';
    const name = document.createElement('div');
    name.className = 'area-switches__name';
    name.textContent = a.title;
    const doc = document.createElement('div');
    doc.className = 'area-switches__doc muted';
    doc.textContent = a.doc;
    text.append(name, doc);
    const facts = areaFacts(a, this.areas);
    if (facts.length > 0) {
      const f = document.createElement('div');
      f.className = 'area-switches__facts muted';
      f.textContent = facts.join(' · ');
      text.append(f);
    }
    const err = this.errors[a.key];
    if (err !== undefined) {
      const e = document.createElement('div');
      e.className = 'area-switches__error';
      e.dataset.areaError = '';
      e.textContent = err;
      text.append(e);
    }

    const side = document.createElement('div');
    side.className = 'area-switches__side';
    const badge = document.createElement('span');
    badge.className = `badge area-switches__state area-switches__state--${a.state}`;
    badge.dataset.areaBadge = '';
    badge.textContent = STATE_LABEL[a.state];
    side.append(badge);

    const busy = this.busy === a.key;
    if (this.confirming === a.key) {
      const q = document.createElement('div');
      q.className = 'area-switches__confirm';
      q.dataset.areaConfirm = '';
      const ask = document.createElement('span');
      ask.className = 'area-switches__ask';
      ask.textContent = `Hide everything in ${a.title} from everyone, admins included?`;
      q.append(ask);
      const yes = this.button('Switch off', 'confirm-off', () => this.set(a, false), true);
      const no = this.button('Cancel', 'cancel', () => {
        this.confirming = null;
        this.paint();
      });
      q.append(yes, no);
      side.append(q);
    } else if (a.state === 'on') {
      if (manager) side.append(this.button('Switch off', 'off', () => {
        this.confirming = a.key;
        this.paint();
      }));
    } else if (admin) {
      // Off with no starting point used yet, or not set up: offer a choice
      // of starting point when there is more than one.
      const needsStart = a.starts.length > 0 && a.added.length === 0;
      if (needsStart && a.starts.length > 1) {
        const sel = document.createElement('select');
        sel.className = 'area-switches__start';
        sel.dataset.areaStart = '';
        sel.setAttribute('aria-label', `${a.title} starting point`);
        for (const s of a.starts) {
          const o = document.createElement('option');
          o.value = s.key;
          o.textContent = s.title;
          sel.append(o);
        }
        sel.value = this.picked[a.key] ?? a.starts[0]!.key;
        this.listen(sel, 'change', () => {
          this.picked[a.key] = sel.value;
        });
        side.append(sel);
      }
      const label = a.state === 'unused' ? 'Set up' : 'Switch on';
      const btn = this.button(label, 'on', () => this.set(a, true));
      if (needsStart && a.starts.length === 1) btn.title = `Starts from ${a.starts[0]!.title}`;
      side.append(btn);
    }
    for (const b of side.querySelectorAll('button')) b.disabled = busy;
    row.append(text, side);
    return row;
  }

  private button(label: string, key: string, onClick: () => void, primary = false): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn btn--xs${primary ? ' btn-danger' : ''}`;
    b.dataset.areaAction = key;
    b.textContent = label;
    this.listen(b, 'click', onClick);
    return b;
  }

  private set(a: AreaRow, on: boolean): void {
    const projectId = this.projectId();
    this.busy = a.key;
    this.confirming = null;
    delete this.errors[a.key];
    this.paint();
    const input: Record<string, unknown> = { key: a.key, on };
    if (projectId !== undefined) input['projectId'] = projectId;
    if (on && a.added.length === 0 && a.starts.length > 0) input['start'] = this.picked[a.key] ?? a.starts[0]!.key;
    this.ctx.api.callByName(
      AREA_SPEC.set,
      input,
      () => {
        if (!this.isAlive()) return;
        const nav = this.ctx.tree.at((this.config.navRefreshPath ?? 'shell.navRefresh').split('.'));
        nav.set((nav.peek<number>() ?? 0) + 1);
        this.load();
      },
      {
        alive: () => this.isAlive(),
        onErr: (f) => {
          this.busy = null;
          this.errors[a.key] = faultText(f).replace(/^area\.set: /, '');
          this.paint();
        },
      },
    );
  }
}

export function registerAreaSwitches(): void {
  Control.register('AreaSwitches', AreaSwitches);
}
