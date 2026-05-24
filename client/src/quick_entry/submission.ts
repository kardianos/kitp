/**
 * Pure submission logic for the QuickEntryOverlay.
 *
 * Lives in a plain `.ts` module (not a .svelte file) so it can be unit-tested
 * without DOM. The rule is "issue every sub-request synchronously in the same
 * tick" — the Dispatcher's per-tick batching takes care of folding the calls
 * into a single `POST /api/v1/batch`, and the server runs that batch inside
 * one transaction (N-SRV-1), so a New-Task submission is one round-trip and
 * one transaction even with attachments + tags + arbitrary attributes.
 *
 * The wire shape is built around `card.insert`'s `attributes` map: every
 * scalar value the dialog collects (description, assignee, status, milestone
 * etc.) goes inline on the insert so we don't emit redundant attribute.update
 * calls. Tags use `tag.apply` (which enforces root-exclusive semantics that
 * setting `attributes.tags` directly would bypass). Attachments use
 * `attachment.create` against pre-uploaded file ids.
 */
import type { Dispatcher } from '../dispatch/dispatcher.js';
import type {
  AttachmentCreateInput,
  AttachmentCreateOutput,
  CardInsertInput,
  CardInsertOutput,
  ID,
  TagApplyInput,
  TagApplyOutput,
} from '../reg/types.js';

/** Optional prefill values that the screen passes down to the overlay. */
export interface QuickEntryPrefill {
  /** Inbox prefills "me"; stamped as `assignee` on the card.insert. */
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
  /**
   * User-entered attribute rows from the "More details" disclosure.
   * Each row is `{name, value}`; values are JSON-encodable scalars
   * (bigint for card_ref, string for text/date/enum, number for
   * number, boolean for bool, or an array of those for card_ref[]).
   * Forwarded verbatim into the card.insert attributes map after the
   * built-in slots so the user can override e.g. an assignee prefill
   * by setting the same attribute explicitly.
   */
  additionalAttributes?: { name: string; value: unknown }[];
  /**
   * Tag cards to apply after the insert resolves. Each entry triggers
   * one `tag.apply` sub-request chained off the insert's promise so
   * the new card id is known. tag.apply enforces root-exclusive
   * mutual-exclusion across the same tag root, which a direct
   * `attributes.tags = [...]` write would bypass — that's why we
   * route tags through this handler rather than setting them inline.
   */
  tagIds?: ID[];
  /**
   * File ids (already uploaded to CAS + materialised via `file.create`)
   * to attach to the new card. The dialog runs the chunked upload +
   * file.create pass *before* calling submitQuickEntry, so by the time
   * we're here every entry already has a stable file_id. Each entry
   * triggers one `attachment.create` chained off the insert.
   */
  attachmentFileIds?: ID[];
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
 * Assemble the `attributes` payload that rides on the `card.insert`.
 *
 * The precedence order, low to high: default-status → prefill axes →
 * additionalAttributes. The user's explicit edits in the More-details
 * disclosure win over a screen prefill, mirroring "screen override
 * beats flow override" one level up.
 *
 * Exported so the unit tests can pin the merging contract without
 * mounting the overlay.
 */
export function buildInsertAttributes(
  input: QuickEntrySubmitInput,
): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  const pf = input.prefill;
  const pinsStatusViaPrefill =
    pf?.laneAttribute?.name === 'status' ||
    (pf?.extraAttributes ?? []).some((a) => a.name === 'status');

  if (input.defaultStatusCardId !== undefined && !pinsStatusViaPrefill) {
    attrs.status = input.defaultStatusCardId;
  }
  if (input.description !== '') {
    attrs.description = input.description;
  }
  if (pf?.assigneeUserId !== undefined) {
    attrs.assignee = pf.assigneeUserId;
  }
  if (pf?.laneAttribute !== undefined) {
    attrs[pf.laneAttribute.name] = pf.laneAttribute.value;
  }
  if (pf?.extraAttributes !== undefined) {
    for (const a of pf.extraAttributes) {
      attrs[a.name] = a.value;
    }
  }
  if (input.additionalAttributes !== undefined) {
    for (const a of input.additionalAttributes) {
      // Drop empties so a half-filled row doesn't clobber an inherited
      // prefill value. The dialog already filters these out before
      // calling us, but the guard keeps the contract clean for tests
      // and direct callers.
      if (a.value === undefined || a.value === '') continue;
      attrs[a.name] = a.value;
    }
  }
  return attrs;
}

/**
 * Issue every sub-request a New-Task submission needs in one dispatcher tick.
 *
 * Sequence (one batch, one transaction):
 *   1. card.insert           — title + parent + the merged attributes map
 *   2. tag.apply (×N)        — one per chosen tag, chained off card.insert
 *   3. attachment.create (×M) — one per pre-uploaded file_id
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
  const attrs = buildInsertAttributes(input);
  if (Object.keys(attrs).length > 0) {
    insertData.attributes = attrs;
  }

  const insertP = dispatcher.request<CardInsertInput, CardInsertOutput>({
    endpoint: 'card',
    action: 'insert',
    data: insertData,
  });

  // Tags + attachments need the new card id, so we chain off insertP.
  // The dispatcher's per-tick batching keeps these in the same POST as
  // the insert as long as they're enqueued from the same microtask the
  // dispatcher used to flush — which `insertP.then(...)` is, since the
  // mock + real dispatcher both resolve synchronously enough that the
  // follow-ups land before the rAF tick fires.
  return insertP.then(({ id: newCardId }) => {
    const followUps: Promise<unknown>[] = [];
    if (input.tagIds !== undefined) {
      for (const tagCardId of input.tagIds) {
        followUps.push(
          dispatcher.request<TagApplyInput, TagApplyOutput>({
            endpoint: 'tag',
            action: 'apply',
            data: { targetCardId: newCardId, tagCardId },
          }),
        );
      }
    }
    if (input.attachmentFileIds !== undefined) {
      for (const fileId of input.attachmentFileIds) {
        followUps.push(
          dispatcher.request<AttachmentCreateInput, AttachmentCreateOutput>({
            endpoint: 'attachment',
            action: 'create',
            data: { cardId: newCardId, fileId },
          }),
        );
      }
    }
    if (followUps.length === 0) return newCardId;
    return Promise.all(followUps).then(() => newCardId);
  });
}
