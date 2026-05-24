/**
 * NotFound control — the graceful-degradation placeholder.
 *
 * CORE REQUIREMENT: when Control.New is asked for an unregistered type it
 * MUST NOT throw — it returns this visible placeholder showing the unknown
 * type name and a compact dump of the config. This lets a screen assembled
 * from a declarative config render TODAY even when some child control types
 * don't exist yet; we fill them in gradually and the gaps are visible on
 * screen rather than crashing the page.
 *
 * All output is textContent (never innerHTML) so a malicious config can never
 * inject markup through the placeholder.
 */

import { Control, type ControlContext, type BaseControlConfig } from './control.js';

export class NotFound extends Control {
  /** The type the factory was asked for but couldn't resolve. */
  private readonly missingType: string;

  constructor(type: string, config: unknown, ctx: ControlContext) {
    super('NotFound', (config ?? { type: 'NotFound' }) as BaseControlConfig, ctx);
    // The factory stashes the requested type on the config under a private key.
    const c = config as { __missingType?: unknown };
    this.missingType =
      typeof c?.__missingType === 'string' ? c.__missingType : String(type);
  }

  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'control-not-found';
    el.dataset.control = 'NotFound';
    return el;
  }

  protected render(): void {
    const title = document.createElement('div');
    title.className = 'control-not-found__title';
    title.textContent = `Unknown control: "${this.missingType}"`;

    const hint = document.createElement('div');
    hint.className = 'control-not-found__hint';
    hint.textContent = 'This control type is not registered yet.';

    const dump = document.createElement('pre');
    dump.className = 'control-not-found__dump';
    dump.textContent = compactDump(this.config);

    this.el.append(title, hint, dump);
  }
}

/**
 * Compact, bounded JSON-ish dump of a config. Strips the private
 * __missingType marker, caps depth and string length so a huge config can't
 * blow up the placeholder. Pure text — no markup.
 */
function compactDump(config: unknown): string {
  const MAX_DEPTH = 3;
  const MAX_STR = 80;
  const seen = new WeakSet<object>();

  const walk = (v: unknown, depth: number): unknown => {
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'string' && v.length > MAX_STR) return v.slice(0, MAX_STR) + '…';
      if (typeof v === 'bigint') return v.toString() + 'n';
      return v;
    }
    if (seen.has(v)) return '[circular]';
    seen.add(v);
    if (depth >= MAX_DEPTH) return Array.isArray(v) ? '[…]' : '{…}';
    if (Array.isArray(v)) return v.slice(0, 20).map((e) => walk(e, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === '__missingType') continue;
      out[k] = walk(val, depth + 1);
    }
    return out;
  };

  try {
    return JSON.stringify(walk(config, 0), null, 2) ?? String(config);
  } catch {
    return String(config);
  }
}

// Wire NotFound into the factory's graceful-degradation path. Done here
// (rather than in control.ts) to break the import cycle: control.ts must not
// import not-found.ts at module-eval time, but not-found.ts importing
// control.ts is fine, so we install the ctor as a side effect of importing
// this module (main.ts imports it once at boot).
Control._setNotFound(NotFound as unknown as new (
  type: string,
  config: unknown,
  ctx: ControlContext,
) => Control);
