/**
 * Toast store + helpers.
 *
 * - `ToastStore` is a rune-backed `$state` array of items.
 * - `notify({ ... })` enqueues a toast and schedules auto-dismissal.
 * - `dismiss(id)` removes a toast by id (cancels its timer).
 *
 * The auto-dismiss timer lives in a side-table so the rune-tracked items array
 * only contains plain serialisable data.
 */

export type ToastType = 'success' | 'error' | 'info';

export interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
  /** If provided, the toast renders an "Undo" button that invokes this. */
  undo?: () => void;
  /** ms until auto-dismiss; 0 means sticky. */
  durationMs: number;
  /** Wall-clock millis at which the toast was pushed (for ordering). */
  createdAt: number;
}

export interface NotifyArgs {
  type?: ToastType;
  message: string;
  undo?: () => void;
  durationMs?: number;
}

const DEFAULT_DURATION_MS = 5000;

let nextId = 1;
function mintId(): string {
  return `t${nextId++}`;
}

export class ToastStore {
  items = $state<ToastItem[]>([]);

  /** Hidden timer table, keyed by toast id. Not reactive. */
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  push(args: NotifyArgs): string {
    const id = mintId();
    const item: ToastItem = {
      id,
      type: args.type ?? 'info',
      message: args.message,
      durationMs: args.durationMs ?? DEFAULT_DURATION_MS,
      createdAt: Date.now(),
      ...(args.undo !== undefined ? { undo: args.undo } : {}),
    };
    this.items = [...this.items, item];
    if (item.durationMs > 0) {
      const t = setTimeout(() => this.dismiss(id), item.durationMs);
      this.timers.set(id, t);
    }
    return id;
  }

  dismiss(id: string): void {
    const t = this.timers.get(id);
    if (t !== undefined) {
      clearTimeout(t);
      this.timers.delete(id);
    }
    this.items = this.items.filter((i) => i.id !== id);
  }

  clear(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.items = [];
  }
}

/** Module-level singleton store, used by the `<Toast>` component + `notify()`. */
export const toasts = new ToastStore();

/** Convenience for screens: `notify({ type: 'success', message: 'Saved' })`. */
export function notify(args: NotifyArgs): string {
  return toasts.push(args);
}

export function dismissToast(id: string): void {
  toasts.dismiss(id);
}
