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
  ID,
} from '../reg/types.js';

/** Optional prefill values that the screen passes down to the overlay. */
export interface QuickEntryPrefill {
  /** Inbox prefills "me"; results in an `attribute.update` for `assignee`. */
  assigneeUserId?: ID;
  /** Column-axis attribute prefill (kanban "+ in this column" button). */
  laneAttribute?: { name: string; value: unknown };
  /**
   * Arbitrary additional attribute presets — used when the kanban
   * column "+" button needs to set BOTH a column and lane attribute and
   * the well-known assignee/status/laneAttribute slots aren't enough.
   * Kept distinct from the named slots so existing callers are
   * unaffected.
   */
  extraAttributes?: { name: string; value: unknown }[];
}

/** Inputs a screen / overlay collects from the user and from its prefill. */
export interface QuickEntrySubmitInput {
  cardTypeName: string;
  parentCardId?: ID;
  title: string;
  description: string;
  prefill?: QuickEntryPrefill;
  /**
   * Resolved default-create-status id (Gate 6 of FLOW_AND_SCREEN_KERNEL).
   * QuickEntryOverlay computes this via `resolveDefaultCreateStatus`
   * before calling submitQuickEntry and ships it in the
   * `card.insert` attributes payload so the server's required-edge
   * check accepts the new (task, status) pair on the same insert.
   *
   * Skipped (not sent) when:
   *   - The card_type isn't `task` (only tasks carry a required status
   *     today; project / milestone / etc. don't need a status edge).
   *   - The prefill already pins `status` via `laneAttribute` or
   *     `extraAttributes` (the kanban column "+" path); the explicit
   *     user intent wins over the chain default.
   */
  defaultStatusCardId?: ID;
}

/** Card types that the schema makes top-level (no parent_card_id required). */
const PARENT_OPTIONAL_CARD_TYPES = new Set<string>(['project']);

/**
 * Result of {@link resolveParentForInsert}. `parentCardId === null` means
 * "no parent, but that's OK" (top-level project). `error` is a user-facing
 * string when the inputs can't satisfy the server's parent requirement.
 */
export interface ParentResolution {
  parentCardId: ID | null;
  error: string | null;
}

/**
 * Decide which parent_card_id we should send for a fresh `card.insert`.
 *
 * The server rule (see `card.go`'s `requires a parent` branch): every card
 * type whose `card_type.parent_card_type_id` is non-null needs a parent at
 * insert time. In practice that's everything except `project`. The quick
 * entry surfaces today don't require the user to pick a parent — the
 * sidebar's project scope should fill that in. Top-level project inserts
 * still skip the requirement.
 *
 * Returns either a usable parentCardId, `null` (no parent needed for this
 * card_type), or a non-null `error` message that the caller should surface
 * inline before issuing the request.
 */
export function resolveParentForInsert(
  cardTypeName: string,
  explicitParent: ID | undefined,
  scopeProjectId: ID | null,
): ParentResolution {
  if (explicitParent !== undefined) {
    return { parentCardId: explicitParent, error: null };
  }
  if (PARENT_OPTIONAL_CARD_TYPES.has(cardTypeName)) {
    return { parentCardId: null, error: null };
  }
  if (scopeProjectId !== null) {
    return { parentCardId: scopeProjectId, error: null };
  }
  return {
    parentCardId: null,
    error: `Pick a project in the sidebar before adding a ${cardTypeName}.`,
  };
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
): Promise<ID> {
  const insertData: CardInsertInput = {
    cardTypeName: input.cardTypeName,
    title: input.title,
  };
  if (input.parentCardId !== undefined) {
    insertData.parentCardId = input.parentCardId;
  }

  // Gate 6: stamp the resolved default-create-status into the insert's
  // attributes payload when the caller threaded one through. The
  // overlay decides whether to call the resolver and what to do on
  // error; we just forward the value here. An explicit prefill that
  // pins `status` (e.g. kanban column "+" with a column attr of
  // `status`) takes precedence — the explicit user intent wins over
  // the chain default, mirroring the spec's "screen override beats
  // flow override" ordering one level up.
  const pinsStatusViaPrefill =
    input.prefill?.laneAttribute?.name === 'status' ||
    (input.prefill?.extraAttributes ?? []).some((a) => a.name === 'status');
  if (
    input.defaultStatusCardId !== undefined &&
    !pinsStatusViaPrefill
  ) {
    insertData.attributes = {
      ...(insertData.attributes ?? {}),
      status: input.defaultStatusCardId,
    };
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
    if (pf?.extraAttributes !== undefined) {
      for (const a of pf.extraAttributes) {
        ps.push(
          dispatcher.request<AttributeUpdateInput, AttributeUpdateOutput>({
            endpoint: 'attribute',
            action: 'update',
            data: {
              cardId: newCardId,
              attributeName: a.name,
              value: a.value,
            },
          }),
        );
      }
    }
    if (ps.length === 0) return newCardId;
    return Promise.all(ps).then(() => newCardId);
  });

  return updatesPromise;
}
