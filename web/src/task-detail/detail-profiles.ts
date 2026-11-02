/**
 * Detail profiles — the per-card-type configuration of the shared detail view
 * (TaskDetail), kept one level up so the control never branches on card_type.
 *
 * A profile names, for one card type:
 *   - the noun the view uses ("Task", "Page") in its loading / not-found text
 *     and the prev/next nav bubble;
 *   - the detail route its cards open in (prev/next walks stay on it);
 *   - which "…" menu actions it has (task.move / task.purge are task-only;
 *     a type with none hides the menu);
 *   - whether the description's Link bar offers the project's other cards of
 *     the type (pages link to pages with `ref:<id>`, which a portal build
 *     resolves);
 *   - the placeholders the description's Insert menu offers and checks
 *     (pages: the portal placeholders; tasks: none, so no menu or checks);
 *   - the flow-bound status attribute the header badge reads and the
 *     TransitionBar drives (`status`, `publish_status`);
 *   - which sections mount (a page has no email threads, links, approvals,
 *     tags or related tasks — it has PLACE IN SITE and PUBLISHED ON instead);
 *   - attribute-panel tweaks: extra attrs to hide (the status attr — it moves
 *     through the TransitionBar, never a free picker) and default-hidden attrs
 *     to show (a page's sort_order IS its site order, so it's editable);
 *   - whether an id that misses resolves a comm card to its parent task.
 *
 * Adding a detail-able card type is an entry here plus a route.
 */

import type { CardRoute } from '../shell/router.js';
import { PAGE_PLACEHOLDERS, type PlaceholderDef } from '../bundles/placeholders.js';
import type { EditorSnippet } from '../editor/engine.js';
import { viewUrl } from './upload.js';

/** An action in the detail header's "…" menu. */
export type DetailMenuAction = 'move' | 'purge';

export type DetailSection =
  | 'comments'
  | 'comms'
  | 'links'
  | 'approvals'
  | 'attachments'
  | 'tags'
  | 'related'
  | 'structure'
  | 'publications';

export interface DetailProfile {
  noun: string;
  /** The detail route this type's cards open in (prev/next stays on it). */
  route: CardRoute;
  /** "…" menu actions, in order; empty hides the menu. */
  menuActions: readonly DetailMenuAction[];
  /** The description's Link bar lists the project's other cards of this
   *  type as `ref:<id>` links. */
  linkSiblings: boolean;
  /** Placeholders the description's Insert menu offers and the view checks
   *  the body's against; empty → no Insert menu, no checks. */
  placeholders: readonly PlaceholderDef[];
  /** The description's Insert menu offers the card's attached pictures
   *  (a page's are published with it). */
  insertPictures: boolean;
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
  route: 'task',
  menuActions: ['move', 'purge'],
  linkSiblings: false,
  placeholders: [],
  insertPictures: false,
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
    route: 'page',
    // task.move / task.purge refuse pages; a page is archived through its flow.
    menuActions: [],
    linkSiblings: true,
    placeholders: PAGE_PLACEHOLDERS,
    insertPictures: true,
    statusAttr: 'publish_status',
    sections: ['comments', 'attachments', 'structure', 'publications'],
    // publish_status moves through the TransitionBar; the navigation flags
    // live in PLACE IN SITE.
    skipAttrs: ['publish_status', 'nav_hidden', 'nav_hide_children'],
    showAttrs: ['sort_order'],
    commRedirect: false,
  },
};

/**
 * The area each detail section belongs to (docs/AREAS.md): a section of an
 * area that is off isn't shown (its items are hidden by the server anyway).
 * Project areas are read from the card's project; Sites from the workspace.
 */
export const SECTION_AREA: Partial<Record<DetailSection, string>> = {
  comms: 'conversations',
  approvals: 'approvals',
  links: 'tasks',
  publications: 'sites',
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

type TitledCard = { id: bigint; parent_card_id?: bigint; attributes?: Record<string, unknown> };

/**
 * A card's title path through its same-type ancestors in `byId`, e.g.
 * 'Home › Getting started' for a page under Home. Capped at 16 hops.
 */
export function titlePath(card: TitledCard, byId: ReadonlyMap<bigint, TitledCard>): string {
  const titles: string[] = [];
  let cur: TitledCard | undefined = card;
  for (let hops = 0; cur !== undefined && hops < 16; hops++) {
    const t = cur.attributes?.['title'];
    titles.unshift(typeof t === 'string' && t !== '' ? t : `#${cur.id.toString()}`);
    cur = cur.parent_card_id === undefined ? undefined : byId.get(cur.parent_card_id);
  }
  return titles.join(' › ');
}

/**
 * The Link bar targets for a card: the other cards of its type in the same
 * project, labelled by title path, linking as `ref:<id>` (the id survives a
 * rename or move; a portal build turns it into the page's URL).
 */
export function siblingLinkTargets(
  selfId: bigint,
  projectId: bigint,
  rows: readonly TitledCard[],
): { label: string; href: string; hint: string }[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return rows
    .filter((r) => r.id !== selfId && enclosingProjectId(r, byId) === projectId)
    .map((r) => ({ label: titlePath(r, byId), href: `ref:${r.id.toString()}`, hint: `ref:${r.id.toString()}` }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** markdown-escape an image's alt text. */
const altText = (s: string): string => s.replace(/[[\]\\]/g, (c) => `\\${c}`);

/**
 * The Insert menu's "Pictures" entries for a card's attached images: each
 * inserts `![name](/api/v1/attachment/<id>/view)`, which kitp shows inline
 * and a portal build publishes with the page.
 */
export function pictureSnippets(images: ReadonlyArray<{ id: bigint; filename: string }>): EditorSnippet[] {
  return images.map((a) => ({
    group: 'Pictures',
    label: a.filename,
    text: `![${altText(a.filename)}](${viewUrl(a.id)})`,
    hint: '',
    description: 'Attached to this page; published with it',
  }));
}
