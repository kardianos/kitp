/**
 * QuickEntryOverlay unit tests.
 *
 * The vitest setup is node-only (no jsdom). We therefore cover the overlay's
 * behaviour through:
 *   - `submitQuickEntry()` (pure batch-shaping logic, no DOM).
 *   - A scripted "submission controller" simulating Enter / Ctrl+Enter / Esc
 *     via the same keydown handlers the .svelte component installs. The
 *     handlers are pure functions if you give them mutable state to mutate;
 *     we replicate that state shape here and assert side-effects.
 *   - A compile/import smoke for the .svelte file (matches `ui.test.ts`).
 *
 * The dispatcher is mocked: `{ request: vi.fn().mockImplementation(...) }`.
 * Tests assert that ONE batch's worth of sub-requests were issued on submit
 * (one `card.insert`, optional `attribute.update`s) and that follow-up effects
 * (toast, clear inputs, close, error message) match the spec from §5.7 of the
 * migration plan and the QuickEntryOverlay task description.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resolveParentForInsert,
  submitQuickEntry,
  type QuickEntrySubmitInput,
} from '../../src/quick_entry/submission.js';
import { notify, toasts } from '../../src/ui/toast.svelte.js';

/* -------------------------------------------------------------------------- */
/* Dispatcher mock                                                            */
/* -------------------------------------------------------------------------- */

interface RequestArgs {
  endpoint: string;
  action: string;
  data?: unknown;
  type?: string;
  ref?: Record<string, unknown>;
  key?: Record<string, unknown>;
}

interface MockDispatcher {
  request: ReturnType<typeof vi.fn>;
  calls: RequestArgs[];
}

/**
 * Build a dispatcher mock whose `request()`:
 *   - resolves `card.insert` synchronously with `{ id: insertedId }`
 *   - resolves `attribute.update` synchronously with `{ ok: true, activity_id: 1 }`
 *   - resolves `card.delete` synchronously with `{ ok: true, activity_id: 2 }`
 *   - returns a rejected promise for any endpoint listed in `failOn`.
 */
function makeDispatcher(opts: {
  insertedId?: bigint;
  failOn?: ReadonlyArray<{ endpoint: string; action: string }>;
} = {}): MockDispatcher {
  const insertedId = opts.insertedId ?? 42n;
  const failOn = opts.failOn ?? [];
  const calls: RequestArgs[] = [];

  const request = vi.fn(async (args: RequestArgs) => {
    calls.push(args);
    const fail = failOn.find(
      (f) => f.endpoint === args.endpoint && f.action === args.action,
    );
    if (fail) {
      throw new Error(`mock-fail:${args.endpoint}.${args.action}`);
    }
    if (args.endpoint === 'card' && args.action === 'insert') {
      return { id: insertedId };
    }
    if (args.endpoint === 'attribute' && args.action === 'update') {
      return { ok: true, activity_id: 1 };
    }
    if (args.endpoint === 'card' && args.action === 'delete') {
      return { ok: true, activity_id: 2 };
    }
    throw new Error(`unexpected mock route: ${args.endpoint}.${args.action}`);
  });

  return { request, calls };
}

/* -------------------------------------------------------------------------- */
/* Simulated component state + handlers (mirror of QuickEntryOverlay.svelte)  */
/* -------------------------------------------------------------------------- */

interface SimState {
  open: boolean;
  title: string;
  description: string;
  submitting: boolean;
  errorMessage: string | null;
  closed: boolean;
  refocused: boolean;
  createdIds: bigint[];
}

/**
 * Replays the QuickEntryOverlay's submit() flow over the simulated state. The
 * arguments mirror what the .svelte component's `submit(opts)` does, with the
 * notable simplification that "refocus title input" is observed as a flag
 * rather than a real DOM call.
 */
async function runSubmit(
  state: SimState,
  dispatcher: MockDispatcher,
  args: {
    closeAfter: boolean;
    cardTypeName: string;
    parentCardId?: bigint;
    prefill?: QuickEntrySubmitInput['prefill'];
  },
): Promise<void> {
  if (state.submitting) return;
  if (state.title.trim() === '') return;
  state.submitting = true;
  state.errorMessage = null;
  try {
    const submit: QuickEntrySubmitInput = {
      cardTypeName: args.cardTypeName,
      title: state.title,
      description: state.description,
    };
    if (args.parentCardId !== undefined) submit.parentCardId = args.parentCardId;
    if (args.prefill !== undefined) submit.prefill = args.prefill;

    const newId = await submitQuickEntry(dispatcher, submit);
    state.createdIds.push(newId);
    notify({
      type: 'success',
      message: 'Created',
      undo: () => {
        void dispatcher.request({
          endpoint: 'card',
          action: 'delete',
          data: { cardId: newId },
        });
      },
    });
    state.title = '';
    state.description = '';
    if (args.closeAfter) {
      state.open = false;
      state.closed = true;
    } else {
      state.refocused = true;
    }
  } catch (e) {
    state.errorMessage = e instanceof Error ? e.message : String(e);
  } finally {
    state.submitting = false;
  }
}

function freshState(overrides: Partial<SimState> = {}): SimState {
  return {
    open: true,
    title: '',
    description: '',
    submitting: false,
    errorMessage: null,
    closed: false,
    refocused: false,
    createdIds: [],
    ...overrides,
  };
}

afterEach(() => {
  toasts.clear();
});

/* -------------------------------------------------------------------------- */
/* 1. Submit on plain Enter (title-only)                                     */
/* -------------------------------------------------------------------------- */

describe('QuickEntryOverlay: submit on Enter (title only)', () => {
  it('issues card.insert + attribute.update for description; resolves; clears; stays open', async () => {
    const dispatcher = makeDispatcher({ insertedId: 101n });
    const state = freshState({
      title: 'Wire up logs',
      description: 'Plumb structured logger through workers',
    });

    await runSubmit(state, dispatcher, { closeAfter: false, cardTypeName: 'task' });

    // The dispatcher saw exactly two sub-requests in this submit.
    expect(dispatcher.calls).toHaveLength(2);
    expect(dispatcher.calls[0]).toMatchObject({
      endpoint: 'card',
      action: 'insert',
      data: { cardTypeName: 'task', title: 'Wire up logs' },
    });
    expect(dispatcher.calls[1]).toMatchObject({
      endpoint: 'attribute',
      action: 'update',
      data: {
        cardId: 101n,
        attributeName: 'description',
        value: 'Plumb structured logger through workers',
      },
    });

    expect(state.createdIds).toEqual([101n]);
    expect(state.title).toBe('');
    expect(state.description).toBe('');
    expect(state.errorMessage).toBeNull();
    expect(state.open).toBe(true); // overlay stays open for next entry
    expect(state.closed).toBe(false);
    expect(state.refocused).toBe(true);
  });

  it('with no description, only one card.insert is issued', async () => {
    const dispatcher = makeDispatcher({ insertedId: 7n });
    const state = freshState({ title: 'Fast path' });

    await runSubmit(state, dispatcher, { closeAfter: false, cardTypeName: 'task' });

    expect(dispatcher.calls).toHaveLength(1);
    expect(dispatcher.calls[0]).toMatchObject({
      endpoint: 'card',
      action: 'insert',
    });
  });

  it('with prefill.assigneeUserId, also issues attribute.update for assignee', async () => {
    const dispatcher = makeDispatcher({ insertedId: 11n });
    const state = freshState({ title: 'Assigned task', description: '' });

    await runSubmit(state, dispatcher, {
      closeAfter: false,
      cardTypeName: 'task',
      prefill: { assigneeUserId: 5n },
    });

    expect(dispatcher.calls).toHaveLength(2);
    expect(dispatcher.calls[1]).toMatchObject({
      endpoint: 'attribute',
      action: 'update',
      data: { cardId: 11n, attributeName: 'assignee', value: 5n },
    });
  });

  it('with laneAttribute + extraAttributes the kanban column + lane prefills both fire', async () => {
    const dispatcher = makeDispatcher({ insertedId: 50n });
    const state = freshState({ title: 'Kanban entry' });

    await runSubmit(state, dispatcher, {
      closeAfter: false,
      cardTypeName: 'task',
      prefill: {
        laneAttribute: { name: 'status', value: 11n },
        extraAttributes: [{ name: 'milestone_ref', value: 22n }],
      },
    });

    expect(dispatcher.calls).toHaveLength(3);
    const attrUpdates = dispatcher.calls
      .filter((c) => c.endpoint === 'attribute' && c.action === 'update')
      .map((c) => (c.data as { attributeName: string }).attributeName);
    expect(attrUpdates).toContain('status');
    expect(attrUpdates).toContain('milestone_ref');
  });

  it('passes parentCardId on the card.insert sub-request when provided', async () => {
    const dispatcher = makeDispatcher();
    const state = freshState({ title: 'Child' });

    await runSubmit(state, dispatcher, {
      closeAfter: false,
      cardTypeName: 'task',
      parentCardId: 99n,
    });

    expect(dispatcher.calls[0]).toMatchObject({
      endpoint: 'card',
      action: 'insert',
      data: { cardTypeName: 'task', title: 'Child', parentCardId: 99n },
    });
  });

  it('fires a "Created" success toast with an Undo callback', async () => {
    const dispatcher = makeDispatcher({ insertedId: 77n });
    const state = freshState({ title: 'Toasted' });

    await runSubmit(state, dispatcher, { closeAfter: false, cardTypeName: 'task' });

    // The most-recent toast should be our success.
    const last = toasts.items[toasts.items.length - 1];
    expect(last).toBeDefined();
    expect(last!.type).toBe('success');
    expect(last!.message).toBe('Created');
    expect(typeof last!.undo).toBe('function');

    // Invoking Undo dispatches a card.delete for the new card.
    last!.undo!();
    const del = dispatcher.calls[dispatcher.calls.length - 1];
    expect(del).toMatchObject({
      endpoint: 'card',
      action: 'delete',
      data: { cardId: 77n },
    });
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Submit on Ctrl+Enter — closes after success                            */
/* -------------------------------------------------------------------------- */

describe('QuickEntryOverlay: submit on Ctrl+Enter', () => {
  it('runs the same submission and then closes the overlay (calls onClose)', async () => {
    const dispatcher = makeDispatcher({ insertedId: 9n });
    const state = freshState({ title: 'Close me', description: 'desc' });

    await runSubmit(state, dispatcher, { closeAfter: true, cardTypeName: 'task' });

    expect(dispatcher.calls).toHaveLength(2);
    expect(state.open).toBe(false);
    expect(state.closed).toBe(true);
    expect(state.refocused).toBe(false); // not relevant when closing
    expect(state.title).toBe('');
    expect(state.description).toBe('');
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Esc cancels — no batch dispatched                                       */
/* -------------------------------------------------------------------------- */

describe('QuickEntryOverlay: Esc cancels', () => {
  it('Esc closes the overlay without making any sub-requests', () => {
    const dispatcher = makeDispatcher();
    const state = freshState({ title: 'Should not submit' });

    // Replicate the .svelte handler: Esc => requestClose() (no submit).
    const onEsc = () => {
      if (state.submitting) return;
      state.open = false;
      state.closed = true;
    };
    onEsc();

    expect(state.open).toBe(false);
    expect(state.closed).toBe(true);
    expect(dispatcher.calls).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Description Tab works — keyboard handler does not consume Tab         */
/* -------------------------------------------------------------------------- */

describe('QuickEntryOverlay: keyboard handler is Tab-friendly', () => {
  /**
   * The .svelte component's per-input keydown handlers handle Esc and Enter
   * variants only. Verify (via a structural assertion on a stubbed event)
   * that Tab is NOT preventDefault-ed — the browser default move-focus
   * behaviour must run so Tab from title moves to the description textarea.
   */
  it('onTitleKeydown leaves Tab alone', () => {
    let prevented = false;
    let stopped = false;
    const e = {
      key: 'Tab',
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault: () => {
        prevented = true;
      },
      stopPropagation: () => {
        stopped = true;
      },
    } as unknown as KeyboardEvent;

    // Inline the handler logic the .svelte file uses for the title input.
    function onTitleKeydown(ev: KeyboardEvent) {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      const isModEnter = ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey);
      if (isModEnter) {
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      if (ev.key === 'Enter') {
        ev.preventDefault();
        ev.stopPropagation();
      }
    }
    onTitleKeydown(e);
    expect(prevented).toBe(false);
    expect(stopped).toBe(false);
  });

  it('onDescriptionKeydown leaves plain Enter alone (newline) and Tab alone', () => {
    function onDescriptionKeydown(ev: KeyboardEvent): {
      prevented: boolean;
      stopped: boolean;
    } {
      let prevented = false;
      let stopped = false;
      const w = {
        preventDefault: () => {
          prevented = true;
        },
        stopPropagation: () => {
          stopped = true;
        },
      };
      if (ev.key === 'Escape') {
        w.preventDefault();
        w.stopPropagation();
      } else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
        w.preventDefault();
        w.stopPropagation();
      }
      return { prevented, stopped };
    }
    const tab = { key: 'Tab', ctrlKey: false, metaKey: false } as KeyboardEvent;
    const plainEnter = { key: 'Enter', ctrlKey: false, metaKey: false } as KeyboardEvent;
    const ctrlEnter = { key: 'Enter', ctrlKey: true, metaKey: false } as KeyboardEvent;

    expect(onDescriptionKeydown(tab)).toEqual({ prevented: false, stopped: false });
    expect(onDescriptionKeydown(plainEnter)).toEqual({ prevented: false, stopped: false });
    expect(onDescriptionKeydown(ctrlEnter)).toEqual({ prevented: true, stopped: true });
  });
});

/* -------------------------------------------------------------------------- */
/* 4b. resolveParentForInsert — the parent-fallback contract                 */
/* -------------------------------------------------------------------------- */

describe('resolveParentForInsert', () => {
  // These tests were added after a regression where the kanban / grid
  // "+ New task" buttons issued card.insert without parentCardId, hitting
  // the server's `card_type "task" requires a parent` validation. The
  // helper centralises the fallback so screens can't forget again.

  it('passes through an explicit parent unchanged for any card type', () => {
    expect(resolveParentForInsert('task', 7n, null)).toEqual({
      parentCardId: 7n,
      error: null,
    });
    expect(resolveParentForInsert('project', 7n, 99n)).toEqual({
      parentCardId: 7n,
      error: null,
    });
  });

  it('lets project inserts go through with no parent + no scope', () => {
    expect(resolveParentForInsert('project', undefined, null)).toEqual({
      parentCardId: null,
      error: null,
    });
  });

  it('falls back to the active project scope for non-project card types', () => {
    expect(resolveParentForInsert('task', undefined, 42n)).toEqual({
      parentCardId: 42n,
      error: null,
    });
    expect(resolveParentForInsert('milestone', undefined, 42n)).toEqual({
      parentCardId: 42n,
      error: null,
    });
    expect(resolveParentForInsert('component', undefined, 42n)).toEqual({
      parentCardId: 42n,
      error: null,
    });
  });

  it("returns a user-facing error when no parent and no scope are available", () => {
    const r = resolveParentForInsert('task', undefined, null);
    expect(r.parentCardId).toBeNull();
    expect(r.error).toMatch(/project/i);
    expect(r.error).toMatch(/task/);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Error path — dispatcher rejects                                         */
/* -------------------------------------------------------------------------- */

describe('QuickEntryOverlay: error path', () => {
  it('shows the error inline and preserves inputs; overlay stays open', async () => {
    const dispatcher = makeDispatcher({
      failOn: [{ endpoint: 'card', action: 'insert' }],
    });
    const state = freshState({ title: 'will-fail', description: 'still here' });

    await runSubmit(state, dispatcher, { closeAfter: true, cardTypeName: 'task' });

    expect(state.errorMessage).toContain('mock-fail:card.insert');
    expect(state.title).toBe('will-fail');
    expect(state.description).toBe('still here');
    expect(state.open).toBe(true);
    expect(state.closed).toBe(false);
    expect(state.createdIds).toHaveLength(0);
  });

  it('rejects on a failing attribute.update too (and surfaces the error)', async () => {
    const dispatcher = makeDispatcher({
      failOn: [{ endpoint: 'attribute', action: 'update' }],
    });
    const state = freshState({ title: 'good title', description: 'desc-fails' });

    await runSubmit(state, dispatcher, { closeAfter: false, cardTypeName: 'task' });

    expect(state.errorMessage).toContain('mock-fail:attribute.update');
    // Inputs preserved, overlay still open.
    expect(state.title).toBe('good title');
    expect(state.description).toBe('desc-fails');
    expect(state.open).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 6. Compile smoke for the .svelte component + the rune controller         */
/* -------------------------------------------------------------------------- */

describe('QuickEntryOverlay imports', () => {
  it('the .svelte component module loads without throwing', async () => {
    const m = await import('../../src/quick_entry/QuickEntryOverlay.svelte');
    expect(m.default).toBeDefined();
  });
  it('the use_quick_entry rune controller loads without throwing', async () => {
    const m = await import('../../src/quick_entry/use_quick_entry.svelte');
    expect(typeof m.useQuickEntry).toBe('function');
  });
});
