/**
 * End-to-end proof entry point.
 *
 * Assembles a minimal screen entirely from a DECLARATIVE config via
 * Control.New and drives it through the DECLARATIVE, ZERO-PROMISE data layer:
 *
 *   1. A Screen control with declarative children slot-routed into regions,
 *      INCLUDING an unknown child type ('SparkleChart') that renders the
 *      visible NotFound placeholder (graceful degradation).
 *   2. TaskList declares its whole data behavior as a DATA TABLE (see
 *      controls/proof.ts): a QUERY fires on mount and on the `reload` intent
 *      (writes rows to a tree path -> the list renders reactively); an ACTION
 *      `add` applies an OPTIMISTIC tree patch, fires the spec, mergePaths the
 *      echo, and routes errors to the TOP-LEVEL handler; an ACTION `badAdd`
 *      always faults and routes the error to SELF (inline banner) with the
 *      optimistic patch auto-rolled-back.
 *   3. Hierarchical hotkeys derived from the live control tree fire intents.
 *   4. A button triggers the signal cascade-cap throw (guarded, not on load).
 *
 * NO promises, no `.then`, no `await` anywhere in this file. The framework
 * drives the async; everything here is pre-registered callbacks and intents.
 *
 * Flip USE_REAL_BACKEND to hit the real /api/v1/batch instead of the mock.
 */

import { signal } from './core/signal.js';
import { tree } from './core/tree.js';
import {
  Dispatcher,
  fetchTransport,
  type ApiFault,
  type Transport,
  type SubResponse,
} from './core/dispatch.js';
import { Api } from './core/api.js';
import { Control, type ControlContext } from './core/control.js';
import './core/not-found.js'; // side effect: installs the NotFound factory path
import { HotkeyController, activeControlSignal } from './core/hotkeys.js';
import {
  registerProofControls,
  PROOF_SPEC_KEYS,
  type ScreenConfig,
  type Task,
  type TasksReloadInput,
  type TasksReloadOutput,
} from './controls/proof.js';
import { demonstrateCascadeThrow } from './cascade-demo.js';

const USE_REAL_BACKEND = false;

/**
 * SSO-ONLY auth: the SPA renders NO login screen. On an auth failure the only
 * public surface is a full-page bounce to this start endpoint. Single constant.
 * See ARCHITECTURE.md §11 for the server contract this client assumes.
 */
const SSO_START_PATH = '/auth/oidc/start';

/* -------------------------------------------------------------------------- */
/* Mock transport: canned tasks. Speaks the exact wire shape so the encode/   */
/* decode path is the real thing — only the network sink is faked.            */
/* -------------------------------------------------------------------------- */

function mockTransport(): Transport {
  let generation = 0;
  let nextId = 5000;
  return {
    async send(body: string): Promise<{ status: number; text: string }> {
      const req = JSON.parse(body) as {
        subrequests: Array<{ id: string; endpoint: string; action: string; data?: unknown }>;
      };
      const subresponses: SubResponse[] = req.subrequests.map((sr) => {
        const key = `${sr.endpoint}.${sr.action}`;
        if (key === PROOF_SPEC_KEYS.listTasks) {
          generation += 1;
          const rows = Array.from({ length: 3 + generation }, (_v, i) => ({
            // ids cross the wire as JSON strings (Go json:",string"); the
            // dispatcher revives them to bigint.
            id: String(1000 + generation * 10 + i),
            title: `Task ${i + 1} (load #${generation})`,
          }));
          return { id: sr.id, ok: true, data: { rows } };
        }
        if (key === PROOF_SPEC_KEYS.createTask) {
          // Server echoes the created row; mergePath lands it (replacing the
          // optimistic temp row set is out of scope for the mock — the next
          // reload reconciles). We return the full rows array shape so the
          // mergePath merge replaces the leaf with the authoritative set.
          const data = (sr.data ?? {}) as { title?: string };
          const created = { id: String(nextId++), title: String(data.title ?? '(new)') };
          return { id: sr.id, ok: true, data: { rows: appendCreated(created) } };
        }
        if (key === PROOF_SPEC_KEYS.createTaskBroken) {
          return {
            id: sr.id,
            ok: false,
            error: { code: 'flow_disallowed', message: 'create_task_broken always fails' },
          };
        }
        return {
          id: sr.id,
          ok: false,
          error: { code: 'unknown_handler', message: `mock has no ${key}` },
        };
      });
      return { status: 200, text: JSON.stringify({ subresponses }) };
    },
  };
}

/** Read the current tree rows + append the server-created row (mock authority). */
function appendCreated(created: { id: string; title: string }): Array<{ id: string; title: string }> {
  const cur = tree.at(['screen', 'tasks']).peek<Task[]>() ?? [];
  // Drop optimistic (negative-id) rows; the server set is authoritative.
  const real = cur
    .filter((t) => t.id >= 0n)
    .map((t) => ({ id: t.id.toString(), title: t.title }));
  return [...real, created];
}

/* -------------------------------------------------------------------------- */
/* Boot.                                                                       */
/* -------------------------------------------------------------------------- */

function boot(): void {
  const transport = USE_REAL_BACKEND ? fetchTransport('') : mockTransport();
  const dispatcher = new Dispatcher({ transport });
  const api = new Api(dispatcher);

  // Centralized fault funnel — registered ONCE at boot, not per-call. This is
  // the TOP-LEVEL handler that `onError: 'top'` bindings rely on.
  const faultLog = document.getElementById('fault-log');
  const showFault = (fault: ApiFault): void => {
    const msg = describeFault(fault);
    // eslint-disable-next-line no-console
    console.warn('[fault]', msg);
    if (faultLog) faultLog.textContent = msg;
  };
  dispatcher.onFault('network', showFault);
  dispatcher.onFault('http', showFault);
  dispatcher.onFault('decode', showFault);
  dispatcher.onFault('sub_error', showFault);
  dispatcher.onFault('aborted', showFault);

  // ---- SSO-ONLY auth bounce -------------------------------------------------
  // No login UI. A 401 (or an auth 403) means the session is gone; bounce the
  // whole page to the SSO start endpoint, preserving the deep link. Registered
  // as a central fault listener — never per-call code.
  dispatcher.onFault('http', (f) => {
    if (f.status === 401 || f.status === 403) bounceToSso();
  });

  // Pre-register the API specs the proof uses. Declared UP FRONT; the
  // declarative data table addresses them by their `endpoint.action` key.
  api.define<TasksReloadInput, TasksReloadOutput>({
    endpoint: 'card',
    action: 'list_tasks',
    encode: (input) => ({ card_type_name: input.cardTypeName }),
    decode: (raw): TasksReloadOutput => ({ rows: decodeRows(raw) }),
  });
  api.define<{ title: string }, { rows: Task[] }>({
    endpoint: 'card',
    action: 'create_task',
    encode: (input) => ({ title: input.title }),
    decode: (raw) => ({ rows: decodeRows(raw) }),
  });
  api.define<{ title: string }, unknown>({
    endpoint: 'card',
    action: 'create_task_broken',
    encode: (input) => ({ title: input.title }),
  });

  registerProofControls();

  // A tiny intent bus: the Toolbar emits intents; we route each to the
  // TaskList's declarative data table via its `intent(...)` trigger. (In the
  // real app the bus targets the focused/active control; here one list owns
  // every demo intent.)
  let taskList: Control | null = null;
  const bus = {
    emit(type: string, detail?: unknown): void {
      taskList?.intent(type, detail);
    },
  };
  const ctx: ControlContext = { api, tree, bus };

  // The whole screen as ONE declarative config tree, including an UNKNOWN
  // child type to prove the NotFound fallback.
  const screenConfig: ScreenConfig = {
    type: 'Screen',
    title: 'kitp web — declarative no-promise data proof',
    // Screen-scope hotkeys (derived; layered under any active region). They
    // fire DECLARED intents — they do not call the API directly.
    hotkeys: [
      { binding: 'r', label: 'Reload tasks', run: () => bus.emit('reload') },
      { binding: 'a', label: 'Add task', run: () => bus.emit('add', { title: 'Added via hotkey a' }) },
    ],
    children: [
      { type: 'Toolbar', target: 'header' },
      {
        type: 'TaskList',
        target: 'body',
        tasksPath: 'screen.tasks',
        cardTypeName: 'task',
        emptyText: 'No tasks loaded yet. Loads on mount; press r to reload, a to add.',
        // Region-scope hotkey: Escape clears the inline fault banner.
        hotkeys: [{ binding: 'Escape', label: 'Dismiss inline error', run: () => clearListFault() }],
      },
      // UNKNOWN TYPE — renders the visible NotFound placeholder, never throws.
      { type: 'SparkleChart', target: 'body', seriesPath: 'analytics.sparkline', smoothing: 0.4 },
    ],
  };

  const root = Control.New('Screen', screenConfig, ctx);
  const mountEl = document.getElementById('root');
  if (!mountEl) throw new Error('#root missing');
  root.mount(mountEl);

  // Locate the TaskList control so bus intents reach its data table.
  taskList = findControl(root, (c) => c.el.classList.contains('task-list'));

  // ---- Hierarchical hotkeys: derive from the live control tree ----
  const rootSig = signal<Control | null>(root, 'root-control');
  const activeSig = activeControlSignal(root);
  const hotkeys = new HotkeyController({ root: rootSig, active: activeSig });
  hotkeys.start();

  // Focusing the TaskList region makes it the active scope; its `Escape`
  // binding layers over the screen's bindings.
  const taskListEl = mountEl.querySelector<HTMLElement>('.task-list');
  taskListEl?.addEventListener('focus', () => {
    activeSig.set(findControl(root, (c) => c.el === taskListEl) ?? taskList ?? root);
  });
  taskListEl?.addEventListener('blur', () => activeSig.set(root));

  function clearListFault(): void {
    taskList?.clearFault();
  }

  function bounceToSso(): void {
    const redirect = encodeURIComponent(location.pathname + location.search);
    location.assign(`${SSO_START_PATH}?redirect=${redirect}`);
  }

  // ---- Cascade-cap demo (guarded behind a button; not on load) ----
  const cascadeBtn = document.getElementById('cascade-btn');
  cascadeBtn?.addEventListener('click', () => {
    const out = document.getElementById('cascade-out');
    const result = demonstrateCascadeThrow();
    if (out) out.textContent = result;
    // eslint-disable-next-line no-console
    console.warn('[cascade-demo]', result);
  });

  // eslint-disable-next-line no-console
  console.info(
    'kitp web proof booted (declarative, zero-promise). Tasks load on mount; press r to ' +
      'reload, a to add (optimistic), click "Add (forced fault → self)" for the inline error, ' +
      'and "Trigger cascade cap" for the named SignalCycleError.',
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers (pure; no promises).                                                */
/* -------------------------------------------------------------------------- */

function decodeRows(raw: unknown): Task[] {
  const obj = (raw ?? {}) as { rows?: unknown };
  const rows = Array.isArray(obj.rows) ? obj.rows : [];
  return rows.map((r): Task => {
    const row = r as { id: bigint | string; title: string };
    return { id: BigInt(row.id), title: String(row.title) };
  });
}

function describeFault(f: ApiFault): string {
  switch (f.kind) {
    case 'sub_error':
      return `sub_error[${f.code}]: ${f.message}`;
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

/** Depth-first search of the live control tree for a matching control. */
function findControl(from: Control, pred: (c: Control) => boolean): Control | null {
  if (pred(from)) return from;
  for (const c of from.childControls()) {
    const f = findControl(c, pred);
    if (f) return f;
  }
  return null;
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}
