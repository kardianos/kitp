/**
 * Detail profiles — the per-card-type configuration of the shared detail view
 * (TaskDetail), kept one level up so the control never branches on card_type.
 *
 * A profile names, for one card type:
 *   - the noun the view uses ("Task", "Page") in its loading / not-found text;
 *   - the flow-bound status attribute the header badge reads and the
 *     TransitionBar drives (`status`, `publish_status`);
 *   - which sections mount (a page has no email threads, links, approvals,
 *     tags or related tasks — it has its PUBLISHED ON section instead);
 *   - attribute-panel tweaks: extra attrs to hide (the status attr — it moves
 *     through the TransitionBar, never a free picker) and default-hidden attrs
 *     to show (a page's sort_order IS its site order, so it's editable);
 *   - whether an id that misses resolves a comm card to its parent task.
 *
 * Adding a detail-able card type is an entry here plus a route.
 */

export type DetailSection =
  | 'comments'
  | 'comms'
  | 'links'
  | 'approvals'
  | 'attachments'
  | 'tags'
  | 'related'
  | 'publications';

export interface DetailProfile {
  noun: string;
  statusAttr: string;
  sections: readonly DetailSection[];
  /** Attributes hidden from the panel on top of the shared skip-list. */
  skipAttrs: readonly string[];
  /** Shared-skip-list attributes this card type DOES edit in the panel. */
  showAttrs: readonly string[];
  /** On a miss, try the id as a comm card and open its parent task. */
  commRedirect: boolean;
}

const TASK_PROFILE: DetailProfile = {
  noun: 'Task',
  statusAttr: 'status',
  sections: ['comments', 'comms', 'links', 'approvals', 'attachments', 'tags', 'related'],
  skipAttrs: [],
  showAttrs: [],
  commRedirect: true,
};

export const DETAIL_PROFILES: Readonly<Record<string, DetailProfile>> = {
  task: TASK_PROFILE,
  page: {
    noun: 'Page',
    statusAttr: 'publish_status',
    sections: ['comments', 'attachments', 'publications'],
    skipAttrs: ['publish_status'],
    showAttrs: ['sort_order'],
    commRedirect: false,
  },
};

/** The profile for a card type (a card type with none uses the task one). */
export function detailProfile(cardTypeName: string): DetailProfile {
  return DETAIL_PROFILES[cardTypeName] ?? TASK_PROFILE;
}

/**
 * The project a card sits in, walking `parent_card_id` through `byId` (the
 * loaded cards of the card's own type): a page's parent may be another page,
 * so its project is the first ancestor that ISN'T one of them. Capped at 16
 * hops (the tree-walk rule). Undefined when the card has no parent.
 */
export function enclosingProjectId(
  card: { id: bigint; parent_card_id?: bigint },
  byId: ReadonlyMap<bigint, { parent_card_id?: bigint }>,
): bigint | undefined {
  let parent = card.parent_card_id;
  for (let hops = 0; parent !== undefined && hops < 16; hops++) {
    const up = byId.get(parent);
    if (up === undefined) return parent;
    parent = up.parent_card_id;
  }
  return undefined;
}
