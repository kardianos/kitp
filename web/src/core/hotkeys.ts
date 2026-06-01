/**
 * Declarative hierarchical hotkeys — DERIVED from the live control tree.
 *
 * Hotkeys are declared in control config (`hotkeys: HotkeyBinding[]`) and
 * scoped HIERARCHICALLY by the mounted control tree: global -> screen ->
 * region -> control. Child scopes layer over (shadow) parents on the same
 * key.
 *
 * The active binding set is DERIVED by walking the chain from the active
 * control up to the root and overlaying each control's bindings (deepest
 * wins). There is NO imperative register/unregister-on-mount/unmount — that
 * imperative pattern is exactly what caused the Svelte client's chord
 * cascade (a347f38). Deriving from the tree is the fix: nothing writes the
 * binding table on mount; the table is recomputed (lazily, memoized via a
 * signal that depends on the active-control signal) when the active control
 * changes.
 *
 * A single document-level keydown listener resolves each event against the
 * derived set. Chords (e.g. "g p") are a small state machine over it.
 */

import { Signal, computed, type ReadonlySignal } from './signal.js';
import { controlTreeVersion, type Control } from './control.js';

/** One declared binding. `binding` is canonical: "r", "Mod+Enter", "g p". */
export interface HotkeyBinding {
  /** Canonical key/chord string, or an array of aliases sharing one handler. */
  binding: string | readonly string[];
  /** Invoked when the binding fires (already past the input-field guard). */
  run: () => void;
  /** Human label for a help overlay. */
  label?: string;
  /** Fire even when focus is in an input/textarea/contenteditable. */
  fireInInputs?: boolean;
}

/** A binding resolved against its owning control (for shadowing + scope). */
export interface ResolvedBinding {
  run: () => void;
  fireInInputs: boolean;
  /** Depth in the chain (root=0). Deeper shadows shallower for the same key. */
  depth: number;
  /** Human label for a help overlay (carried from the declared binding). */
  label?: string;
  /**
   * Scope name for grouping in the help overlay. Tier 0 (the root scope) is
   * 'global'; deeper tiers use the owning control's `type` (e.g. 'Kanban').
   * Derived — not authoritative; purely for the help overlay's group headings.
   */
  scope: string;
}

/**
 * Mac detection. `navigator.platform` is deprecated; prefer the modern
 * `navigator.userAgentData.platform` (User-Agent Client Hints) and fall back
 * to the legacy field only when UA-CH is unavailable (Safari/Firefox).
 */
function detectMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const modern = nav.userAgentData?.platform;
  if (typeof modern === 'string' && modern.length > 0) {
    return /mac/i.test(modern);
  }
  // Legacy fallback: navigator.platform is deprecated but still the only
  // synchronous signal where UA-CH is absent.
  return /Mac|iPod|iPhone|iPad/.test(nav.platform ?? '');
}

const isMac = detectMac();

/** Normalize a KeyboardEvent into a canonical token, e.g. "Mod+Enter", "g". */
export function eventToToken(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Mod');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey && e.key.length > 1) parts.push('Shift'); // shift on named keys only
  let key = e.key;
  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toLowerCase();
  parts.push(key);
  return parts.join('+');
}

/** Walk a control up to the root, returning [root, ..., active]. */
function chainToRoot(control: Control | null): Control[] {
  const chain: Control[] = [];
  let c = control;
  while (c) {
    chain.push(c);
    c = c.parent;
  }
  chain.reverse(); // root-first so depth index increases toward the active leaf
  return chain;
}

/** Overlay bindings get this added to their tree depth so an open modal/menu
 *  shadows everything below it, no matter how deep the screen subtree goes. */
const OVERLAY_DEPTH_BOOST = 1_000_000;

/** Distance from the root (root = 0). The shadowing key: a deeper control's
 *  binding wins over a shallower one for the same token. */
function depthOf(c: Control): number {
  let d = 0;
  for (let x = c.parent; x; x = x.parent) d++;
  return d;
}

/** Merge one control's declared bindings into `map` at `depth` (deeper / ties
 *  shadow shallower). Tier 0 groups as 'global'; deeper tiers as the owning
 *  control's type (help-overlay grouping). */
function addControlBindings(map: Map<string, ResolvedBinding>, control: Control, depth: number): void {
  const scope = depth === 0 ? 'global' : control.type;
  for (const b of control.hotkeys()) {
    const aliases = typeof b.binding === 'string' ? [b.binding] : b.binding;
    for (const alias of aliases) {
      const token = normalizeToken(alias);
      const existing = map.get(token);
      if (!existing || depth >= existing.depth) {
        map.set(token, {
          run: b.run,
          fireInInputs: b.fireInInputs === true,
          depth,
          ...(b.label !== undefined ? { label: b.label } : {}),
          scope,
        });
      }
    }
  }
}

/** Pre-order DFS over a control's whole subtree. Defensive about
 *  `childControls` (test stubs / control-shaped objects may omit it). */
function walkSubtree(control: Control, visit: (c: Control) => void): void {
  visit(control);
  const kids = typeof control.childControls === 'function' ? control.childControls() : [];
  for (const child of kids) walkSubtree(child, visit);
}

/**
 * Derive the active binding map from the LIVE control tree — not from transient
 * focus. A control's hotkeys are in scope because it is MOUNTED:
 *
 *   - root tier        — the always-on global scope (depth 0);
 *   - focused chain    — the focused control's ancestry, so chrome-specific keys
 *                        are live while chrome holds focus;
 *   - screen subtree   — the ENTIRE current screen body subtree, ALWAYS, so the
 *                        page's hotkeys (/, j/k, Enter, …) stay live regardless
 *                        of where focus sits (sidebar, search box, …). This is
 *                        the fix for "clicking the navbar drops the screen keys";
 *   - overlay          — an open modal/menu, depth-boosted so it shadows all.
 *
 * Shadowing is by true tree depth (deeper wins), so a deep body control beats a
 * shallow chrome control on a shared token. Shared by the live `bindings`
 * computed and the untracked {@link HotkeyController.snapshotFor}.
 */
function deriveBindings(
  rootControl: Control | null,
  activeControl: Control | null,
  overlayControl: Control | null,
  screenControl: Control | null,
): Map<string, ResolvedBinding> {
  const map = new Map<string, ResolvedBinding>();
  if (rootControl) addControlBindings(map, rootControl, 0);
  for (const c of chainToRoot(activeControl)) addControlBindings(map, c, depthOf(c));
  if (screenControl) walkSubtree(screenControl, (c) => addControlBindings(map, c, depthOf(c)));
  for (const c of chainToRoot(overlayControl)) addControlBindings(map, c, depthOf(c) + OVERLAY_DEPTH_BOOST);
  return map;
}

export interface HotkeyControllerOptions {
  /** The root control whose bindings are always in scope (global tier). */
  root: ReadonlySignal<Control | null>;
  /** The currently active/focused control; its chain layers over root. */
  active: ReadonlySignal<Control | null>;
  /**
   * Topmost open overlay control (Dialog / Help / QuickEntry / menu). When
   * present its bindings win above the entire active chain — the `overlay`
   * tier from design/hotkeys.md. Still DERIVED: set the signal when an
   * overlay opens/closes; nothing registers/unregisters bindings.
   */
  overlay?: ReadonlySignal<Control | null>;
  /**
   * The current screen body (the route's mounted control). Its ENTIRE subtree's
   * hotkeys are always in scope, regardless of focus — so the page's keys stay
   * live when focus is on the sidebar / search box / other chrome. Set it when
   * the route body (re)mounts; nothing registers per-binding.
   */
  screen?: ReadonlySignal<Control | null>;
  /** Attach the keydown listener to this target (default: document). */
  target?: EventTarget;
}

export class HotkeyController {
  private readonly active: ReadonlySignal<Control | null>;
  private readonly root: ReadonlySignal<Control | null>;
  private readonly overlay: ReadonlySignal<Control | null> | null;
  private readonly screen: ReadonlySignal<Control | null> | null;
  private readonly target: EventTarget;
  /** Pending chord prefix (e.g. after "g" we wait for the second key). */
  private chordPrefix = '';
  private chordTimer: ReturnType<typeof setTimeout> | null = null;
  private listener: ((e: Event) => void) | null = null;

  /**
   * The DERIVED binding map. Recomputed when active/root change — no
   * imperative writes on mount. Keyed by canonical token; deeper scope wins.
   */
  private readonly bindings: ReadonlySignal<Map<string, ResolvedBinding>>;

  constructor(opts: HotkeyControllerOptions) {
    this.active = opts.active;
    this.root = opts.root;
    this.overlay = opts.overlay ?? null;
    this.screen = opts.screen ?? null;
    this.target = opts.target ?? document;

    this.bindings = computed(() => {
      // Re-derive whenever the control tree changes (mount/unmount) — this is
      // what makes hotkeys "declaratively loaded on control load".
      controlTreeVersion.get();
      return deriveBindings(
        this.root.get(),
        this.active.get(),
        this.overlay?.get() ?? null,
        this.screen?.get() ?? null,
      );
    }, 'hotkeys.binding-map');
  }

  /** Start listening. Returns a disposer. */
  start(): () => void {
    const handler = (ev: Event): void => this.onKeydown(ev as KeyboardEvent);
    this.target.addEventListener('keydown', handler);
    this.listener = handler;
    return () => {
      if (this.listener) this.target.removeEventListener('keydown', this.listener);
      this.listener = null;
      this.clearChord();
    };
  }

  /** For tests/help overlays: snapshot the currently derived bindings. */
  snapshot(): Map<string, ResolvedBinding> {
    return new Map(this.bindings.peek());
  }

  /**
   * Snapshot the bindings for a SPECIFIC control's scope chain (untracked). The
   * help overlay uses this to list the keys active for the current SCREEN even
   * when transient focus — e.g. clicking the topbar help button — has moved the
   * live active control to the shell chrome. Falls back to the root tier (global
   * only) when `control` is null.
   */
  snapshotFor(control: Control | null): Map<string, ResolvedBinding> {
    // Treat `control` as BOTH the focused chain and the screen subtree, so the
    // help overlay lists every key live for that screen (its whole subtree).
    return deriveBindings(this.root.peek(), control, this.overlay?.peek() ?? null, control);
  }

  private onKeydown(e: KeyboardEvent): void {
    if (e.isComposing) return;
    const map = this.bindings.get();
    const token = eventToToken(e);

    // Chord continuation: if a prefix is pending, try "<prefix> <key>".
    if (this.chordPrefix) {
      const chordToken = `${this.chordPrefix} ${token}`;
      this.clearChord();
      const chord = map.get(chordToken);
      if (chord && this.allowed(e, chord)) {
        e.preventDefault();
        chord.run();
        return;
      }
      // fall through: maybe the key is itself a single binding
    }

    // Is this key the prefix of any chord? (e.g. "g" before "g p")
    const isChordPrefix = [...map.keys()].some((k) => k.startsWith(token + ' '));
    const direct = map.get(token);

    // Don't capture a chord prefix while the user is typing in an editable
    // element — otherwise a literal "g" (prefix of `g p`/`g k`/…) gets swallowed
    // mid-word. Global nav chords aren't meant to fire from inside inputs; the
    // single-binding `allowed()` gate below covers the non-chord keys.
    if (isChordPrefix && !direct && !isEditable(e.target)) {
      this.beginChord(token);
      e.preventDefault();
      return;
    }

    if (direct && this.allowed(e, direct)) {
      e.preventDefault();
      direct.run();
    }
  }

  private allowed(e: KeyboardEvent, b: ResolvedBinding): boolean {
    if (b.fireInInputs) return true;
    return !isEditable(e.target);
  }

  private beginChord(prefix: string): void {
    this.clearChord();
    this.chordPrefix = prefix;
    this.chordTimer = setTimeout(() => this.clearChord(), 1200);
  }

  private clearChord(): void {
    this.chordPrefix = '';
    if (this.chordTimer) {
      clearTimeout(this.chordTimer);
      this.chordTimer = null;
    }
  }
}

/** Normalize a declared binding string ("Mod+Enter", "g p") to canonical. */
function normalizeToken(binding: string): string {
  if (binding.includes(' ')) {
    // chord: normalize each segment
    return binding
      .split(/\s+/)
      .map((seg) => normalizeSegment(seg))
      .join(' ');
  }
  return normalizeSegment(binding);
}

function normalizeSegment(seg: string): string {
  const parts = seg.split('+');
  const mods: string[] = [];
  let key = '';
  for (const p of parts) {
    if (p === 'Mod' || p === 'Ctrl' || p === 'Cmd' || p === 'Meta') mods.push('Mod');
    else if (p === 'Alt' || p === 'Option') mods.push('Alt');
    else if (p === 'Shift') mods.push('Shift');
    else key = p.length === 1 ? p.toLowerCase() : p;
  }
  const out: string[] = [];
  if (mods.includes('Mod')) out.push('Mod');
  if (mods.includes('Alt')) out.push('Alt');
  if (mods.includes('Shift')) out.push('Shift');
  out.push(key);
  return out.join('+');
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

/** Format a canonical binding for display ("Mod+/" -> "⌘+/" on Mac). */
export function formatBinding(binding: string): string {
  if (binding.includes(' ')) return binding.split(/\s+/).join(' then ');
  return binding
    .split('+')
    .map((p) => {
      if (p === 'Mod') return isMac ? '⌘' : 'Ctrl';
      if (p === 'Shift') return isMac ? '⇧' : 'Shift';
      if (p === 'Alt') return isMac ? '⌥' : 'Alt';
      return p;
    })
    .join('+');
}

/** A small writable holder for the active-control signal (set on focus). */
export function activeControlSignal(initial: Control | null = null): Signal<Control | null> {
  return new Signal<Control | null>(initial, 'hotkeys.active-control');
}
