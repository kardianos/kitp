/**
 * QuickEntry submission — the pure attribute-merge builders + the coalesced
 * "one tick, one batch, one transaction" submit.
 *
 * Port of `client/src/quick_entry/submission.ts` (NOT imported), re-expressed
 * against the `web/` ZERO-PROMISE `api.callByName(spec, data, onOk)` surface
 * rather than the Svelte dispatcher's awaited `request`. The rule is unchanged:
 * issue every sub-request synchronously in the SAME tick so the dispatcher's
 * per-tick batching folds them into one `POST /api/v1/batch` and the server
 * runs that batch in one transaction (N-SRV-1).
 *
 * Sequence (after attachments are pre-uploaded to CAS + materialised via
 * file.create — that happens OUTSIDE this module, in the overlay's upload pass):
 *   1. card.insert        — title + parent + the merged attributes map
 *   2. tag.apply (×N)     — one per chosen tag, fired from card.insert's onOk
 *   3. attachment.create (×M) — one per pre-uploaded file id, same onOk
 *
 * The {@link buildInsertAttributes} merge order (low → high precedence) is
 * default-status → assignee → prefill lane/extra axes → additionalAttributes,
 * so a user's explicit "+ Add field" edit beats a screen prefill (matching
 * "screen override beats flow override" one level up). Exported separately so
 * `node --test` can pin the merge contract without the overlay.
 */

import type { Api } from '../core/api.js';
import type { ApiFault } from '../core/dispatch.js';

/** A pre-resolved attribute the overlay rides on the insert (e.g. lane axis). */
export interface NamedAttribute {
  name: string;
  value: unknown;
}

/** Prefill the calling screen passes down (kanban column `+`, inbox "me", …). */
export interface QuickEntryPrefill {
  /** Inbox prefills "me"; stamped as `assignee` on the card.insert. */
  assigneeUserId?: bigint;
  /** Column-axis attribute prefill (kanban "+ in this column"). */
  laneAttribute?: NamedAttribute;
  /** Arbitrary additional attribute presets (a column needing two axes). */
  extraAttributes?: NamedAttribute[];
}

/** Inputs the overlay collects from the user + its prefill. */
export interface QuickEntrySubmitInput {
  cardTypeName: string;
  /** Omitted for top-level cards; the overlay scopes tasks to the project. */
  parentCardId?: bigint;
  title: string;
  description: string;
  prefill?: QuickEntryPrefill;
  /**
   * Resolved default-create-status id. Stamped as `attributes.status` so the
   * server's required-edge check accepts the new (task, status) pair on the
   * same insert. Skipped when the card_type isn't `task` or when the prefill
   * already pins `status` (the kanban column `+` path).
   */
  defaultStatusCardId?: bigint;
  /** User-entered "+ Add field" rows. Empty values are dropped. */
  additionalAttributes?: NamedAttribute[];
  /** Tag cards to apply after the insert resolves (one tag.apply each). */
  tagIds?: bigint[];
  /** Pre-uploaded file ids to bind (one attachment.create each). */
  attachmentFileIds?: bigint[];
}

/** Card types the schema makes top-level (no parent_card_id required). */
const PARENT_OPTIONAL_CARD_TYPES = new Set<string>(['project']);

/** Result of {@link resolveParentForInsert}. */
export interface ParentResolution {
  /** A usable parent id, or null when the card_type needs no parent. */
  parentCardId: bigint | null;
  /** A user-facing message when the inputs can't satisfy the parent rule. */
  error: string | null;
}

/**
 * Decide the `parent_card_id` for a fresh `card.insert`. Every card type whose
 * `card_type.parent_card_type_id` is non-null needs a parent at insert time —
 * in practice everything except `project`. The overlay fills it from the
 * current project scope when the caller didn't pass an explicit parent.
 */
export function resolveParentForInsert(
  cardTypeName: string,
  explicitParent: bigint | undefined,
  scopeProjectId: bigint | null,
): ParentResolution {
  if (explicitParent !== undefined) return { parentCardId: explicitParent, error: null };
  if (PARENT_OPTIONAL_CARD_TYPES.has(cardTypeName)) return { parentCardId: null, error: null };
  if (scopeProjectId !== null) return { parentCardId: scopeProjectId, error: null };
  return {
    parentCardId: null,
    error: `Pick a project in the sidebar before adding a ${cardTypeName}.`,
  };
}

/**
 * Assemble the `attributes` map for the `card.insert`. Precedence low → high:
 * default-status → assignee → prefill lane → prefill extras →
 * additionalAttributes. The user's explicit edits win over a screen prefill.
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
    attrs['status'] = input.defaultStatusCardId;
  }
  if (input.description !== '') attrs['description'] = input.description;
  if (pf?.assigneeUserId !== undefined) attrs['assignee'] = pf.assigneeUserId;
  if (pf?.laneAttribute !== undefined) attrs[pf.laneAttribute.name] = pf.laneAttribute.value;
  if (pf?.extraAttributes !== undefined) {
    for (const a of pf.extraAttributes) attrs[a.name] = a.value;
  }
  if (input.additionalAttributes !== undefined) {
    for (const a of input.additionalAttributes) {
      // Drop empties so a half-filled row doesn't clobber an inherited value.
      if (a.value === undefined || a.value === null || a.value === '') continue;
      attrs[a.name] = a.value;
    }
  }
  return attrs;
}

/** Build the `card.insert` input object (the camelCase surface the spec encodes). */
export function buildInsertInput(input: QuickEntrySubmitInput): {
  cardTypeName: string;
  title: string;
  parentCardId?: bigint;
  attributes?: Record<string, unknown>;
} {
  const insert: {
    cardTypeName: string;
    title: string;
    parentCardId?: bigint;
    attributes?: Record<string, unknown>;
  } = { cardTypeName: input.cardTypeName, title: input.title };
  if (input.parentCardId !== undefined) insert.parentCardId = input.parentCardId;
  const attrs = buildInsertAttributes(input);
  if (Object.keys(attrs).length > 0) insert.attributes = attrs;
  return insert;
}

/* -------------------------------------------------------------------------- */
/* Spec keys (all registered elsewhere at boot — reused, not re-defined).      */
/* -------------------------------------------------------------------------- */

export const QE_CARD_INSERT_SPEC = 'card.insert';
export const QE_TAG_APPLY_SPEC = 'tag.apply';
export const QE_ATTACHMENT_CREATE_SPEC = 'attachment.create';
export const QE_CARD_DELETE_SPEC = 'card.delete';

/** Callbacks the {@link submitQuickEntry} pipeline reports through. */
export interface SubmitCallbacks {
  /** Success: the new card's bigint id, once the insert resolved. */
  onCreated: (newCardId: bigint) => void;
  /** Failure: the first sub-request fault (insert / tag / attachment). */
  onError?: (fault: ApiFault) => void;
  /** Liveness gate so a torn-down overlay drops late deliveries. */
  alive?: () => boolean;
}

/**
 * Issue the New-Task batch through the ZERO-PROMISE callback surface. The
 * `card.insert` fires first; from its `onOk` (synchronously, the same tick) we
 * fire one `tag.apply` per chosen tag + one `attachment.create` per pre-uploaded
 * file id. The dispatcher coalesces the same-tick follow-ups into the SAME
 * `POST /api/v1/batch` as the insert, so the whole submission is one round-trip
 * and one transaction. `onCreated` fires as soon as the insert resolves (the
 * tags/attachments are fire-and-forget against the central fault funnel + the
 * per-call onError). NO promise crosses this surface.
 */
export function submitQuickEntry(
  api: Api,
  input: QuickEntrySubmitInput,
  cb: SubmitCallbacks,
): void {
  const alive = cb.alive ?? ((): boolean => true);
  api.callByName(
    QE_CARD_INSERT_SPEC,
    buildInsertInput(input),
    (out) => {
      if (!alive()) return;
      const newCardId = ((out ?? {}) as { id?: bigint }).id ?? 0n;
      if (newCardId === 0n) return;

      // Tags + attachments need the new id; fire them in this same tick so the
      // dispatcher folds them into the insert's batch (one transaction).
      for (const tagCardId of input.tagIds ?? []) {
        api.callByName(
          QE_TAG_APPLY_SPEC,
          { targetCardId: newCardId, tagCardId },
          () => {},
          { alive, ...(cb.onError ? { onErr: cb.onError } : {}) },
        );
      }
      for (const fileId of input.attachmentFileIds ?? []) {
        api.callByName(
          QE_ATTACHMENT_CREATE_SPEC,
          { cardId: newCardId, fileId },
          () => {},
          { alive, ...(cb.onError ? { onErr: cb.onError } : {}) },
        );
      }

      cb.onCreated(newCardId);
    },
    { alive, ...(cb.onError ? { onErr: cb.onError } : {}) },
  );
}

/**
 * Fire the Undo: delete the just-created task. Used by the success toast's Undo
 * button. Fire-and-forget against the central fault funnel.
 */
export function undoQuickEntry(api: Api, newCardId: bigint, alive?: () => boolean): void {
  api.callByName(QE_CARD_DELETE_SPEC, { cardId: newCardId }, () => {}, alive ? { alive } : {});
}
