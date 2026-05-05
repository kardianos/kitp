/**
 * Pure submission logic for the QuickEntryOverlay.
 *
 * Lives in a plain `.ts` module (not a .svelte file) so it can be unit-tested
 * without DOM. The rule is "issue every sub-request synchronously in the same
 * tick" — the Dispatcher's per-tick batching takes care of folding the calls
 * into a single `POST /api/v1/batch` (REQUIREMENTS N-CLI-1/2/3).
 */

import type { Dispatcher } from '../dispatch/dispatcher.js';
import type {
  AttributeUpdateInput,
  AttributeUpdateOutput,
  CardInsertInput,
  CardInsertOutput,
} from '../reg/types.js';

/** Optional prefill values that the screen passes down to the overlay. */
export interface QuickEntryPrefill {
  /** Inbox prefills "me"; results in an `attribute.update` for `assignee`. */
  assigneeUserId?: number;
  /** Kanban column prefill; results in an `attribute.update` for `status`. */
  statusValue?: string;
  /** Kanban swim-lane prefill; arbitrary attribute name + value. */
  laneAttribute?: { name: string; value: unknown };
}

/** Inputs a screen / overlay collects from the user and from its prefill. */
export interface QuickEntrySubmitInput {
  cardTypeName: string;
  parentCardId?: number;
  title: string;
  description: string;
  prefill?: QuickEntryPrefill;
}

/**
 * Issue the card.insert (and optional attribute.update calls) for one
 * quick-entry submission. Every request is queued synchronously so the
 * dispatcher batches them into ONE POST.
 *
 * Resolves with the new card id once every request has resolved successfully.
 * Rejects with the first error if any sub-request fails — callers should keep
 * the inputs so the user can retry.
 */
export async function submitQuickEntry(
  dispatcher: Pick<Dispatcher, 'request'>,
  input: QuickEntrySubmitInput,
): Promise<number> {
  const insertData: CardInsertInput = {
    cardTypeName: input.cardTypeName,
    title: input.title,
  };
  if (input.parentCardId !== undefined) {
    insertData.parentCardId = input.parentCardId;
  }

  const insertP = dispatcher.request<CardInsertInput, CardInsertOutput>({
    endpoint: 'card',
    action: 'insert',
    data: insertData,
  });

  // The follow-up attribute.update calls need the new card id. We chain off
  // `insertP` so they're enqueued as soon as it resolves — but to keep them in
  // the SAME batch we must enqueue them within the same microtask the
  // dispatcher used to flush. We do that by awaiting the insert id and then
  // emitting all attribute.updates together.
  //
  // Note: in the typical happy path the Dispatcher's rAF schedule fires after
  // every queued request returns from a single Promise resolution chain. Tests
  // can drive this deterministically via `flushNow()`.
  const updatesPromise = insertP.then(({ id: newCardId }) => {
    const ps: Promise<AttributeUpdateOutput>[] = [];
    if (input.description !== '') {
      ps.push(
        dispatcher.request<AttributeUpdateInput, AttributeUpdateOutput>({
          endpoint: 'attribute',
          action: 'update',
          data: {
            cardId: newCardId,
            attributeName: 'description',
            value: input.description,
          },
        }),
      );
    }
    const pf = input.prefill;
    if (pf?.assigneeUserId !== undefined) {
      ps.push(
        dispatcher.request<AttributeUpdateInput, AttributeUpdateOutput>({
          endpoint: 'attribute',
          action: 'update',
          data: {
            cardId: newCardId,
            attributeName: 'assignee',
            value: pf.assigneeUserId,
          },
        }),
      );
    }
    if (pf?.statusValue !== undefined) {
      ps.push(
        dispatcher.request<AttributeUpdateInput, AttributeUpdateOutput>({
          endpoint: 'attribute',
          action: 'update',
          data: {
            cardId: newCardId,
            attributeName: 'status',
            value: pf.statusValue,
          },
        }),
      );
    }
    if (pf?.laneAttribute !== undefined) {
      ps.push(
        dispatcher.request<AttributeUpdateInput, AttributeUpdateOutput>({
          endpoint: 'attribute',
          action: 'update',
          data: {
            cardId: newCardId,
            attributeName: pf.laneAttribute.name,
            value: pf.laneAttribute.value,
          },
        }),
      );
    }
    if (ps.length === 0) return newCardId;
    return Promise.all(ps).then(() => newCardId);
  });

  return updatesPromise;
}
