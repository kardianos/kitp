/**
 * Proof-of-concept controls for the end-to-end demo.
 *
 * These exercise the DECLARATIVE, ZERO-PROMISE data architecture:
 *
 *   - Screen   — declarative `children`, slot-routed into header/body regions;
 *     declares screen-scope hotkeys.
 *   - Toolbar  — buttons + hotkeys fire DECLARED intents via `this.intent(...)`.
 *     It makes no API call itself; it only says WHEN.
 *   - TaskList — declares its data table entirely as DATA:
 *       * a QUERY that fires on mount, builds its input from config, and writes
 *         the decoded rows to a tree path (the list renders reactively from it);
 *       * a QUERY re-fired on the `reload` intent (a `{ intent }` trigger);
 *       * an ACTION (`add`) with an OPTIMISTIC tree patch + `mergePath` result,
 *         routing errors to the TOP-LEVEL handler (`onError: 'top'`);
 *       * an ACTION (`badAdd`) that always faults and routes the error to SELF
 *         (`onError: 'self'`) so the control shows it inline.
 *
 * There are NO promises, no `.then`, no `await` anywhere in this file. Every
 * async outcome is a pre-registered callback the framework drives.
 *
 * The real screen controls (Kanban/Inbox/Grid/...) are built the same way in
 * the next pass; the registry + NotFound mean they slot in incrementally.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import type { ActionBinding, QueryBinding } from '../core/data.js';
import type { ApiFault } from '../core/dispatch.js';

/* -------------------------------------------------------------------------- */
/* Shared demo types.                                                         */
/* -------------------------------------------------------------------------- */

export interface Task {
  id: bigint;
  title: string;
}

export interface TasksReloadInput {
  cardTypeName: string;
}
export interface TasksReloadOutput {
  rows: Task[];
}

/* -------------------------------------------------------------------------- */
/* Configs + declaration-merged registry types.                              */
/* -------------------------------------------------------------------------- */

export interface ScreenConfig extends BaseControlConfig {
  type: 'Screen';
  title: string;
}

export interface ToolbarConfig extends BaseControlConfig {
  type: 'Toolbar';
}

export interface TaskListConfig extends BaseControlConfig {
  type: 'TaskList';
  /** Dotted tree path the rows live at (read by the query input via config). */
  tasksPath: string;
  /** Card type to query for (fed to the query input via `{ config }`). */
  cardTypeName: string;
  emptyText?: string;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    Screen: ScreenConfig;
    Toolbar: ToolbarConfig;
    TaskList: TaskListConfig;
  }
}

/* -------------------------------------------------------------------------- */
/* Screen — slot-routed declarative composition.                             */
/* -------------------------------------------------------------------------- */

export class Screen extends Control<ScreenConfig> {
  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'screen';
    el.tabIndex = -1; // focusable so it can be the active hotkey scope
    return el;
  }

  protected render(): void {
    const titleEl = document.createElement('h1');
    titleEl.className = 'screen__title';
    titleEl.textContent = this.config.title;

    const header = document.createElement('div');
    header.className = 'screen__header';
    const body = document.createElement('div');
    body.className = 'screen__body';

    this.el.append(titleEl, header, body);

    // Slot-route declarative children by their `target`:
    //   target: 'header' -> header region; anything else -> body region.
    for (const child of this.config.children ?? []) {
      const host = child.target === 'header' ? header : body;
      this.spawn(child.type, child, host);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Toolbar — fires DECLARED intents (no API call here).                      */
/* -------------------------------------------------------------------------- */

export class Toolbar extends Control<ToolbarConfig> {
  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'toolbar';
    return el;
  }

  protected render(): void {
    const reload = button('Reload tasks (press r)', 'btn btn-primary');
    const add = button('Add task (press a)', 'btn');
    const bad = button('Add (forced fault → self)', 'btn');

    // The Toolbar only declares WHEN: it fires intents into the bus. The
    // declarative data table on TaskList declares WHAT each intent does.
    this.listen(reload, 'click', () => this.ctx.bus?.emit('reload'));
    this.listen(add, 'click', () =>
      this.ctx.bus?.emit('add', { title: `New task @ ${new Date().toLocaleTimeString()}` }),
    );
    this.listen(bad, 'click', () => this.ctx.bus?.emit('badAdd', { title: 'doomed' }));

    this.el.append(reload, add, bad);
  }
}

/* -------------------------------------------------------------------------- */
/* TaskList — its whole data behavior is DECLARED as a data table.           */
/* -------------------------------------------------------------------------- */

export class TaskList extends Control<TaskListConfig> {
  /**
   * CLASS-STATIC binding table — "registering a control registers the API
   * calls it can make." These are merged with any per-instance `config.queries`
   * / `config.actions` by the DataController at mount.
   */
  static override queries: readonly QueryBinding[] = [
    {
      // Load on mount: build input from config, write decoded rows to the path.
      name: 'load',
      spec: 'card.list_tasks',
      when: 'mount',
      input: { cardTypeName: { config: 'cardTypeName' } },
      result: { method: 'landTasks' },
      onError: 'self', // inline self-represent if the initial load fails
    },
    {
      // Re-fire on the `reload` intent (a { intent } trigger).
      name: 'reload',
      spec: 'card.list_tasks',
      when: { intent: 'reload' },
      input: { cardTypeName: { config: 'cardTypeName' } },
      result: { method: 'landTasks' },
      onError: 'self',
    },
  ];

  static override actions: readonly ActionBinding[] = [
    {
      // Optimistic add: patch the tree immediately, fire the spec, on success
      // mergePath the server echo, on fault auto-rollback + route to TOP.
      intent: 'add',
      spec: 'card.create_task',
      input: { title: { payload: 'title' } },
      optimistic: {
        path: 'screen.tasks',
        patch: (current, payload) => {
          const rows = Array.isArray(current) ? (current as Task[]) : [];
          const p = (payload ?? {}) as { title?: string };
          // Negative temp id so it's visibly optimistic until the server replies.
          const optimisticRow: Task = { id: -BigInt(rows.length + 1), title: p.title ?? '(new)' };
          return [...rows, optimisticRow];
        },
      },
      result: { mergePath: 'screen.tasks' },
      onError: 'top', // central top-level handler shows it
    },
    {
      // Always faults (mock returns an error). Routes the fault to SELF so the
      // control shows it inline. Optimistic patch is rolled back automatically.
      intent: 'badAdd',
      spec: 'card.create_task_broken',
      input: { title: { payload: 'title' } },
      optimistic: {
        path: 'screen.tasks',
        patch: (current, payload) => {
          const rows = Array.isArray(current) ? (current as Task[]) : [];
          const p = (payload ?? {}) as { title?: string };
          return [...rows, { id: -999n, title: `${p.title ?? '(new)'} (will roll back)` }];
        },
      },
      onError: 'self',
    },
  ];

  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'task-list';
    el.tabIndex = 0; // focusable region so it can own a hotkey scope
    return el;
  }

  protected render(): void {
    // Named handler used by the query's `{ method: 'landTasks' }` result sink.
    // (Demonstrates the method-sink route alongside the toPath/mergePath ones.)
    this.handler('landTasks', (out) => {
      const o = (out ?? {}) as { rows?: unknown };
      const rows = Array.isArray(o.rows) ? (o.rows as Task[]) : [];
      this.ctx.tree.at(['screen', 'tasks']).set(rows);
    });

    const faultBanner = document.createElement('div');
    faultBanner.className = 'task-list__fault';
    faultBanner.style.display = 'none';

    const list = document.createElement('ul');
    list.className = 'task-list__items';
    const empty = document.createElement('div');
    empty.className = 'task-list__empty muted';
    this.el.append(faultBanner, empty, list);

    const node = this.ctx.tree.at(['screen', 'tasks']);

    // Inline fault self-representation (the `onError: 'self'` route). Reads the
    // control's `fault` signal reactively; clears on the next successful load.
    this.effect(() => {
      const f = this.fault.get();
      if (!f) {
        faultBanner.style.display = 'none';
        faultBanner.textContent = '';
        return;
      }
      faultBanner.style.display = '';
      faultBanner.textContent = `inline error: ${describeFault(f)} (dismiss: Esc)`;
    }, 'taskList.fault');

    // ONE effect renders the list reactively from the tree path. A successful
    // load also clears any prior inline fault.
    this.effect(() => {
      const tasks = (node.get<Task[]>() ?? []) as Task[];
      if (tasks.length > 0) this.clearFault();
      if (tasks.length === 0) {
        empty.textContent = this.config.emptyText ?? 'No tasks. Press r to load.';
        empty.style.display = '';
        list.replaceChildren();
        return;
      }
      empty.style.display = 'none';
      list.replaceChildren(...tasks.map((t) => taskRow(t)));
    }, 'taskList.render');
  }
}

/* -------------------------------------------------------------------------- */
/* Small DOM helpers (textContent only — no innerHTML).                       */
/* -------------------------------------------------------------------------- */

function button(label: string, className: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = label;
  return b;
}

function taskRow(t: Task): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'task-list__item';
  const id = document.createElement('span');
  id.className = 'task-list__id muted';
  id.textContent = `#${t.id.toString()}`;
  const title = document.createElement('span');
  title.className = 'task-list__title';
  title.textContent = t.title;
  li.append(id, title);
  return li;
}

function describeFault(f: ApiFault): string {
  switch (f.kind) {
    case 'sub_error':
      return `${f.code}: ${f.message}`;
    case 'http':
      return `http ${f.status}`;
    case 'network':
      return `network: ${f.message}`;
    case 'decode':
      return `decode: ${f.message}`;
    case 'aborted':
      return `aborted: ${f.reason}`;
  }
}

/** Marker so the proof's spec-key strings line up with the registered specs. */
export const PROOF_SPEC_KEYS = {
  listTasks: 'card.list_tasks',
  createTask: 'card.create_task',
  createTaskBroken: 'card.create_task_broken',
} as const;

export function registerProofControls(): void {
  Control.register('Screen', Screen);
  Control.register('Toolbar', Toolbar);
  Control.register('TaskList', TaskList);
}
