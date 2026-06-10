/**
 * Control framework — the centerpiece. Direct DOM, no virtual DOM.
 *
 * Lifecycle:  construct (build el) -> mount(parent) (render once, append)
 *   -> update (effects registered in render() patch specific DOM nodes as
 *   signals change; NO re-render) -> destroy() (depth-first children, then
 *   this control's disposers — signal-effect disposers, event-listener
 *   removers, onDestroy cleanups — then remove DOM). PARENT OWNS CHILDREN:
 *   one root.destroy() tears down the whole subtree.
 *
 * Registry + factory:
 *   Control.register('Type', ctor)   — throws on duplicate.
 *   Control.New('Type', config, ctx) — UNKNOWN TYPE RETURNS A VISIBLE
 *     NotFound PLACEHOLDER (never throws). Wired into the factory so every
 *     call site (declarative child, imperative spawn) degrades gracefully.
 *
 * Type safety despite the dynamic string key: ControlConfigMap is augmented
 * per control via TS declaration merging, giving the typed Control.New<K>
 * overload below. Configs form a discriminated union validated at the
 * server-JSON trust boundary.
 */

import { effect, signal, type Signal } from './signal.js';
import type { HotkeyBinding } from './hotkeys.js';
import { SIBLING_ABORT_REASON, type ApiFault } from './dispatch.js';
import {
  DataController,
  type ActionBinding,
  type QueryBinding,
  type DataHost,
} from './data.js';

/* -------------------------------------------------------------------------- */
/* Typed registry surface (augmented per control via declaration merging).    */
/* -------------------------------------------------------------------------- */

/**
 * Each control file augments this interface:
 *   declare module '../core/control.js' {
 *     interface ControlConfigMap { Kanban: KanbanConfig }
 *   }
 * The key is the runtime type string; the value is that control's config
 * type. This is the single source of truth that makes the dynamic factory
 * statically typed.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface ControlConfigMap {}

/** The discriminated union of every registered config (server JSON target). */
export type AnyControlConfig = ControlConfigMap[keyof ControlConfigMap];

/** Shared config shape every control config extends. */
export interface BaseControlConfig {
  type: string;
  /** Declarative children instantiated recursively (slot-routed via target). */
  children?: ChildConfig[];
  /** Hotkeys scoped to this control's node in the live tree (hierarchical). */
  hotkeys?: HotkeyBinding[];
  /** Optional slot name the parent uses to route this child into a region. */
  target?: string;
  /**
   * Per-instance READ binding table (server-screen JSON can extend the
   * control's class-static `queries`). Merged at mount by the DataController.
   */
  queries?: QueryBinding[];
  /** Per-instance WRITE binding table, merged with the class-static `actions`. */
  actions?: ActionBinding[];
}

/** A child config is any control config (loosely typed at JSON boundary). */
export type ChildConfig = BaseControlConfig & Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* Context — boot-time services handed to every control.                      */
/* -------------------------------------------------------------------------- */

export interface ControlContext {
  api: import('./api.js').Api;
  tree: import('./tree.js').TreeNode;
  /** Optional shared event bus for cross-control signals (quick-entry, etc.). */
  bus?: { emit(type: string, detail?: unknown): void };
  /**
   * Optional shared scope object (e.g. the AppShell's project scope). Resolved
   * by `{ from: 'scope.<path>' }` inputs in a control's data table; the
   * DataController peeks it at fire time. Reactive triggers still watch a TREE
   * path (`{ signal: 'scope.projectId' }`) — mirror the scope into the tree if
   * a query should refetch on its change.
   */
  scope?: Record<string, unknown>;
}

/**
 * The loose ctor type the registry STORES internally. The runtime factory
 * path is `Map.get(string)` (the dynamic trust boundary), so the stored value
 * is type-erased to this. Type safety at REGISTRATION is provided by the
 * generic `Control.register<C>` below (which accepts a ctor narrowing its
 * config to any `C extends BaseControlConfig` without a call-site cast), and
 * at CONSTRUCTION by the typed `Control.New<K>` overload.
 */
interface ControlCtor {
  new (type: string, config: BaseControlConfig, ctx: ControlContext): Control;
}

/* -------------------------------------------------------------------------- */
/* Element → owning Control registry (for focus-driven active-scope tracking). */
/* -------------------------------------------------------------------------- */

/** Each mounted control's root el → the control. Used by `controlForNode` so
 *  the HotkeyController can resolve "which control owns the focused element"
 *  and make its (and its ancestors') scoped hotkeys live. */
const controlOwners = new WeakMap<HTMLElement, Control>();

/**
 * Bumped on EVERY control mount + destroy. The HotkeyController's binding map is
 * a `computed` that reads this, so the active hotkey set is re-derived from the
 * live control tree whenever the tree changes — i.e. a control's hotkeys become
 * live because it MOUNTED, not because it's focused. This is the framework-level
 * "hotkeys are declaratively loaded on control load" signal. Lazy: the computed
 * just marks dirty here and recomputes on the next keydown read — no eager work.
 */
export const controlTreeVersion = signal(0, 'control.tree-version');
function bumpControlTree(): void {
  controlTreeVersion.set(controlTreeVersion.peek() + 1);
}

/**
 * The DEEPEST mounted control whose root element is `node` or an ancestor of it
 * — i.e. the control that "owns" the focused/clicked node. Walks up the DOM and
 * returns the first registered root. null when the node is outside every
 * control (or there's no DOM).
 */
export function controlForNode(node: Node | null): Control | null {
  let el: HTMLElement | null =
    node instanceof HTMLElement ? node : ((node?.parentElement ?? null) as HTMLElement | null);
  while (el) {
    const owner = controlOwners.get(el);
    if (owner) return owner;
    el = el.parentElement;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Control base class.                                                        */
/* -------------------------------------------------------------------------- */

export abstract class Control<Cfg extends BaseControlConfig = BaseControlConfig> {
  /** This control's root DOM node. */
  readonly el: HTMLElement;
  /** Children this control owns (cleaned up depth-first on destroy). */
  protected readonly children = new Set<Control>();
  /** Set by Control.New / spawn so hotkeys can walk the live tree upward. */
  parent: Control | null = null;
  private readonly disposers: Array<() => void> = [];
  private mounted = false;
  private destroyed = false;

  /** Named handlers registered via `handler(name, fn)` (result/error sinks). */
  private readonly handlers = new Map<string, (arg: unknown) => void>();
  /** Intent listeners registered by the DataController (one name -> many fns). */
  private readonly intentListeners = new Map<string, Array<(payload: unknown) => void>>();
  /** This control's data layer; created + wired in mount(), disposed in destroy(). */
  private data: DataController | null = null;

  /**
   * Inline fault signal so a control can SELF-REPRESENT an error in its own
   * render (the `onError: 'self'` route). Read it reactively in render() to
   * show an inline banner; `clearFault()` to dismiss.
   */
  protected readonly fault: Signal<ApiFault | null> = signal<ApiFault | null>(
    null,
    'control.fault',
  );

  constructor(
    readonly type: string,
    readonly config: Cfg,
    protected readonly ctx: ControlContext,
  ) {
    this.el = this.createRoot();
  }

  /** Override to choose the root element/tag. Default: <div data-control=type>. */
  protected createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.dataset.control = this.type;
    return el;
  }

  /** One-time DOM construction + signal effects. Children built here. */
  protected abstract render(): void;

  /** Attach to parent DOM, run render once, wire the data layer, mark mounted. */
  mount(parent: HTMLElement | DocumentFragment): void {
    if (this.mounted || this.destroyed) return;
    this.render();
    parent.appendChild(this.el);
    this.mounted = true;
    controlOwners.set(this.el, this); // focus → active-scope resolution
    // Own + wire the declarative data layer AFTER render so render() has
    // registered any named handlers / inline-fault effect the bindings target.
    this.data = new DataController(this.dataHost(), this.ctx.tree);
    this.data.wire();
    bumpControlTree(); // a newly-mounted control's hotkeys join the live set
  }

  /** True between mount() and destroy(). Used by the dispatcher's alive gate. */
  isAlive(): boolean {
    return !this.destroyed;
  }

  /* ---- declarative data: handlers, intents, faults, merged tables ---- */

  /**
   * Class-static READ binding table. Override in a subclass as
   * `static override queries = [...]` — "registering a control registers the
   * API calls it can make." Merged with `config.queries` by the DataController.
   */
  static queries: readonly QueryBinding[] = [];
  /** Class-static WRITE binding table; merged with `config.actions`. */
  static actions: readonly ActionBinding[] = [];

  /**
   * Register a named handler usable as a `{ method }` result sink or error
   * route in a binding. Call from render() (or the ctor) before mount wires
   * the data layer.
   */
  protected handler(name: string, fn: (arg: unknown) => void): void {
    this.handlers.set(name, fn);
  }

  /**
   * Fire an action/query intent. The DataController listens; this is the
   * control's imperative trigger (a button click, a hotkey) for a DECLARED
   * action — the control still declares WHAT happens, this just says WHEN.
   */
  intent(name: string, payload?: unknown): void {
    const bucket = this.intentListeners.get(name);
    if (!bucket) return;
    for (const fn of [...bucket]) fn(payload);
  }

  /**
   * Register a control-owned intent handler. The DataController registers
   * action/query intents the same way (via the DataHost); this is the
   * surface a control uses for its own UI-only intents (open a dialog, move a
   * selection) raised by `this.intent(name)` from a hotkey or a button. The
   * registration is dropped on destroy along with the listener table.
   */
  protected registerIntent(name: string, fn: (payload: unknown) => void): void {
    let bucket = this.intentListeners.get(name);
    if (!bucket) {
      bucket = [];
      this.intentListeners.set(name, bucket);
    }
    bucket.push(fn);
  }

  /** Deliver a fault to this control's inline representation (the 'self' route). */
  setFault(fault: ApiFault): void {
    // Drop the sibling-abort noise the backend stamps on every non-offending
    // sub-request when a batch sibling fails: it's not THIS control's load
    // error, and surfacing it (e.g. "Failed to load grid: aborted…") masks the
    // real cause, which rides a separate `sub_error` fault on the offender
    // (delivered to its own onError route — `top` toasts it via the funnel).
    // Mirrors the central funnel's handling in `main.ts`.
    if (fault.kind === 'aborted' && fault.reason === SIBLING_ABORT_REASON) return;
    this.fault.set(fault);
  }

  /** Dismiss the inline fault. */
  clearFault(): void {
    this.fault.set(null);
  }

  /** Merged READ table: class-static declarations + per-instance config. */
  protected mergedQueries(): readonly QueryBinding[] {
    const ctor = this.constructor as typeof Control;
    return [...(ctor.queries ?? []), ...(this.config.queries ?? [])];
  }

  /** Merged WRITE table: class-static declarations + per-instance config. */
  protected mergedActions(): readonly ActionBinding[] {
    const ctor = this.constructor as typeof Control;
    return [...(ctor.actions ?? []), ...(this.config.actions ?? [])];
  }

  /** Build the structural DataHost view the DataController drives. */
  private dataHost(): DataHost {
    const self = this;
    return {
      ctx: { api: self.ctx.api, tree: self.ctx.tree },
      config: self.config as unknown as Record<string, unknown>,
      ...(self.ctx.scope ? { scope: self.ctx.scope } : {}),
      dataQueries: () => self.mergedQueries(),
      dataActions: () => self.mergedActions(),
      findHandler: (name) => self.handlers.get(name),
      setFault: (f) => self.setFault(f),
      isAlive: () => self.isAlive(),
      addDisposer: (fn) => self.onDestroy(fn),
      onIntent: (name, fn) => {
        let bucket = self.intentListeners.get(name);
        if (!bucket) {
          bucket = [];
          self.intentListeners.set(name, bucket);
        }
        bucket.push(fn);
      },
    };
  }

  /** Hotkeys declared in this control's config (consumed by HotkeyController). */
  hotkeys(): readonly HotkeyBinding[] {
    return this.config.hotkeys ?? [];
  }

  /** Register a reactive effect owned by this control; auto-disposed. */
  protected effect(fn: () => (() => void) | void, name?: string): void {
    this.disposers.push(effect(fn, name ?? `${this.type}.effect`));
  }

  /* ---- signal-binding helpers ---------------------------------------------
   *
   * One-liners that register a reactive effect mapping a signal (or a thunk
   * reading signals) onto a DOM property. Auto-disposed via `effect()`. The
   * goal is to push the
   *
   *   this.effect(() => { el.textContent = sig.get(); });
   *
   * pattern into a single self-documenting call. Each helper accepts either a
   * `Signal<T>` (read with `.get()`) or a `() => T` thunk (any signal reads
   * INSIDE the thunk are tracked automatically). The thunk form is the more
   * common one — it lets you mix multiple sources without a `computed()`.
   *
   * NB: these do NOT diff. They write the value on every effect run; the
   * signal layer already drops no-op writes via Object.is, so when the source
   * value is unchanged the helper's underlying effect never runs at all.
   * ----------------------------------------------------------------------- */

  /** Bind `el.textContent` to `source`. Coerces null/undefined to ''. */
  protected bindText(el: Node, source: Signal<unknown> | (() => unknown), name?: string): void {
    this.effect(() => {
      const v = readSource(source);
      el.textContent = v === null || v === undefined ? '' : String(v);
    }, name ?? `${this.type}.bindText`);
  }

  /**
   * Bind an HTML attribute. `null`, `undefined`, `false`, or `''` REMOVE the
   * attribute; `true` sets it to a flag (`attr=""`); anything else stringifies.
   * Matches the conventional "presence is truthy" attribute semantics.
   */
  protected bindAttr(
    el: Element,
    attr: string,
    source: Signal<unknown> | (() => unknown),
    name?: string,
  ): void {
    this.effect(() => {
      const v = readSource(source);
      if (v === null || v === undefined || v === false || v === '') {
        el.removeAttribute(attr);
      } else if (v === true) {
        el.setAttribute(attr, '');
      } else {
        el.setAttribute(attr, String(v));
      }
    }, name ?? `${this.type}.bindAttr(${attr})`);
  }

  /** Toggle a class based on a boolean source. */
  protected bindClass(
    el: Element,
    cls: string,
    source: Signal<unknown> | (() => unknown),
    name?: string,
  ): void {
    this.effect(() => {
      el.classList.toggle(cls, !!readSource(source));
    }, name ?? `${this.type}.bindClass(${cls})`);
  }

  /** Show / hide an element via `style.display` (no class toggle). `true`
   *  reveals, `false` sets `display: none`. */
  protected bindShow(
    el: HTMLElement,
    source: Signal<unknown> | (() => unknown),
    name?: string,
  ): void {
    this.effect(() => {
      el.style.display = readSource(source) ? '' : 'none';
    }, name ?? `${this.type}.bindShow`);
  }

  /**
   * Bind a DOM property (e.g. `value`, `checked`, `disabled`, `hidden`).
   * Useful for inputs whose state mirrors a signal — though for `value` /
   * `checked` you usually ALSO listen on `'input'` / `'change'` to push the
   * other way.
   */
  protected bindProp<E extends Element>(
    el: E,
    key: keyof E & string,
    source: Signal<unknown> | (() => unknown),
    name?: string,
  ): void {
    this.effect(() => {
      (el as unknown as Record<string, unknown>)[key] = readSource(source);
    }, name ?? `${this.type}.bindProp(${key})`);
  }

  /** Bind a single CSS property on `el.style`. The value is coerced via
   *  `String(v)`; `null` / `undefined` clears the property. */
  protected bindStyle(
    el: HTMLElement,
    prop: string,
    source: Signal<unknown> | (() => unknown),
    name?: string,
  ): void {
    this.effect(() => {
      const v = readSource(source);
      // Cast: CSSStyleDeclaration indexer is keyed by camelCased property name.
      const styleObj = el.style as unknown as Record<string, string>;
      styleObj[prop] = v === null || v === undefined ? '' : String(v);
    }, name ?? `${this.type}.bindStyle(${prop})`);
  }

  /** Register any disposer (listener removal, floating-ui cleanup, etc.). */
  protected onDestroy(fn: () => void): void {
    this.disposers.push(fn);
  }

  /** Add an event listener and register its removal on destroy. */
  protected listen<K extends keyof HTMLElementEventMap>(
    el: EventTarget,
    type: K | string,
    handler: (ev: Event) => void,
    opts?: AddEventListenerOptions,
  ): void {
    el.addEventListener(type as string, handler, opts);
    this.onDestroy(() => el.removeEventListener(type as string, handler, opts));
  }

  /** Imperatively create + own a child control, mounted into `host`. */
  protected spawn(type: string, config: unknown, host: HTMLElement): Control {
    const c = Control.New(type as keyof ControlConfigMap, config as never, this.ctx);
    c.parent = this;
    this.children.add(c);
    c.mount(host);
    return c;
  }

  /**
   * Instantiate declarative children from config (or an explicit list),
   * mounting each into `host` (default: this.el). Returns them so a
   * slot-routing parent can place them itself. Equivalent to hand-writing
   * nested Control.New calls.
   */
  protected mountChildren(host: HTMLElement = this.el, configs?: ChildConfig[]): Control[] {
    const list = configs ?? this.config.children ?? [];
    const out: Control[] = [];
    for (const childCfg of list) {
      out.push(this.spawn(childCfg.type, childCfg, host));
    }
    return out;
  }

  /** Remove + dispose a specific owned child. */
  protected destroyChild(child: Control): void {
    if (this.children.delete(child)) child.destroy();
  }

  /** Tear down: children first (depth-first), then disposers, then DOM. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const c of this.children) c.destroy();
    this.children.clear();
    for (const d of this.disposers.splice(0)) {
      try {
        d();
      } catch {
        // a failing disposer must not strand sibling disposers
      }
    }
    // The DataController's effects/intents were registered as disposers above;
    // drop the references so a late intent() / fault is a no-op after destroy.
    this.data = null;
    this.intentListeners.clear();
    this.handlers.clear();
    controlOwners.delete(this.el);
    this.el.remove();
    this.mounted = false;
    this.parent = null;
    bumpControlTree(); // its hotkeys leave the live set
  }

  /** Walk owned children (one level). Used by the hotkey tree derivation. */
  childControls(): readonly Control[] {
    return [...this.children];
  }

  /* ---- registry (static) ---- */

  private static registry = new Map<string, ControlCtor>();
  /** Set by not-found.ts wiring to avoid an import cycle at module-eval time. */
  private static notFoundCtor: ControlCtor | null = null;

  /**
   * Register a control type. Generic over the ctor's own (possibly narrowed)
   * config type `C` so `Control.register('Screen', Screen)` — where `Screen`'s
   * ctor takes `ScreenConfig` — type-checks with NO `any` and NO cast at the
   * call site. `C extends BaseControlConfig` guarantees the narrowing is a real
   * subtype; the value is stored against the loose `ControlCtor` since the
   * runtime factory path is `Map.get(string)` and validated at the JSON
   * boundary. This is the fix for the previous `ControlCtor` variance error.
   */
  static register<C extends BaseControlConfig>(
    type: string,
    ctor: new (type: string, config: C, ctx: ControlContext) => Control,
  ): void {
    if (Control.registry.has(type)) throw new Error(`control "${type}" already registered`);
    Control.registry.set(type, ctor as unknown as ControlCtor);
  }

  static isRegistered(type: string): boolean {
    return Control.registry.has(type);
  }

  /** Internal: install the NotFound ctor (breaks the import cycle). */
  static _setNotFound(ctor: ControlCtor): void {
    Control.notFoundCtor = ctor;
  }

  /**
   * Factory. Typed via the ControlConfigMap overload; the runtime path is a
   * Map.get(string). An UNREGISTERED type returns a visible NotFound
   * placeholder — never throws.
   */
  static New<K extends keyof ControlConfigMap>(
    type: K,
    config: ControlConfigMap[K] extends BaseControlConfig ? ControlConfigMap[K] : never,
    ctx: ControlContext,
  ): Control;
  static New(type: string, config: unknown, ctx: ControlContext): Control;
  static New(type: string, config: unknown, ctx: ControlContext): Control {
    const ctor = Control.registry.get(type);
    // Untyped server JSON crosses the trust boundary here; the ctor validates
    // its own slice (configs form a discriminated union). Cast at this single
    // internal boundary, never at call sites.
    if (ctor) return new ctor(type, config as BaseControlConfig, ctx);
    // Graceful degradation: stash the requested type for the placeholder.
    const ph = (config && typeof config === 'object' ? { ...(config as object) } : {}) as Record<
      string,
      unknown
    >;
    ph.__missingType = type;
    ph.type = type;
    if (Control.notFoundCtor) return new Control.notFoundCtor(type, ph as unknown as BaseControlConfig, ctx);
    // Should never happen once not-found.ts is imported, but stay safe.
    const fallback = new (class extends Control {
      protected render(): void {
        this.el.textContent = `Unknown control: ${type}`;
      }
    })(type, ph as unknown as BaseControlConfig, ctx);
    return fallback;
  }
}

/* -------------------------------------------------------------------------- */
/* Internal: resolve a binding source (Signal | thunk) to its current value.   */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a binding source. A thunk (`() => T`) runs inline so any signal
 * reads inside it are tracked by the surrounding effect. A `Signal<T>` is
 * read via `.get()` (tracked the same way). Used by every `bindX` helper.
 */
function readSource<T>(src: Signal<T> | (() => T)): T {
  return typeof src === 'function' ? (src as () => T)() : src.get();
}
