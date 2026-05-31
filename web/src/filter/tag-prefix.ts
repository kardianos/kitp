/**
 * Tag-prefix grouping seam — the shared logic for grouping a board / grid by a
 * MUTUALLY-EXCLUSIVE tag prefix instead of the raw `tags` (card_ref[]) value.
 *
 * Tags carry a slash-delimited `path` ('priority/high') and a `root_exclusive_at`
 * segment naming the prefix under which only ONE tag may apply per card
 * ('priority'). A card can hold many tags overall, but at most one per exclusive
 * root — which is exactly what makes a clean single-column grouping possible:
 *
 *   - GROUPABLE prefixes = the distinct non-empty `root_exclusive_at` values
 *     among the project's tags. `priority` (exclusive) is offered; `platform` /
 *     `area` (no exclusive root) are not — grouping by them would scatter a card
 *     across several columns.
 *   - For prefix P the columns/lanes are the tags whose root is P; a card's
 *     bucket is the single tag it carries under P (or unset).
 *
 * Membership keys off `root_exclusive_at` directly (NOT a path-prefix guess), so
 * a tag is in prefix P's set iff its root is P. `path` is used only for the
 * column's display leaf ('priority/high' → 'high').
 *
 * Both the Kanban (columns + swim lanes) and the Grid (row grouping) consume
 * these helpers, so they live in `filter/` beside the {@link GroupAttr} seam.
 */

/** Option-value prefix marking a group/lane `<select>` entry as a tag prefix
 *  (vs. a plain attribute name like 'status'). The suffix is the exclusive
 *  root, e.g. `tagpfx:priority`. */
export const TAG_PREFIX_OPTION = 'tagpfx:';

/** Build the group/lane `<select>` option value for an exclusive tag root. */
export function tagPrefixOptionValue(root: string): string {
  return TAG_PREFIX_OPTION + root;
}

/** The exclusive root encoded in an option value, or null when it isn't a tag
 *  prefix option. */
export function tagPrefixFromOptionValue(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || !value.startsWith(TAG_PREFIX_OPTION)) return null;
  const root = value.slice(TAG_PREFIX_OPTION.length);
  return root === '' ? null : root;
}

/** Leaf segment of a slash-delimited tag path: 'priority/high' → 'high',
 *  'high' → 'high', '' → ''. */
export function tagLeaf(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length === 0 ? path : (parts[parts.length - 1] ?? path);
}

/** Human label for an exclusive root segment: 'priority' → 'Priority'. */
export function tagRootLabel(root: string): string {
  if (root === '') return root;
  return root.charAt(0).toUpperCase() + root.slice(1);
}

/** The distinct non-empty `rootExclusiveAt` values across [rows], in first-seen
 *  order — the set of prefixes a card / board may be grouped by. */
export function exclusiveRoots(rows: ReadonlyArray<{ rootExclusiveAt?: string }>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const root = r.rootExclusiveAt ?? '';
    if (root === '' || seen.has(root)) continue;
    seen.add(root);
    out.push(root);
  }
  return out;
}

/**
 * The id (as a stringified key) of the card's tag under exclusive root [prefix],
 * or null when the card carries none. [cardTags] is the raw `tags` attribute
 * value (an array of ids in any wire form — bigint / number / digit-string);
 * [rootById] maps an id-key (`id.toString()`) to that tag's `rootExclusiveAt`.
 *
 * Exclusivity guarantees at most one match, so the first is canonical.
 */
export function tagIdUnderRoot(
  cardTags: unknown,
  rootById: ReadonlyMap<string, string>,
  prefix: string,
): string | null {
  if (!Array.isArray(cardTags)) return null;
  for (const el of cardTags) {
    const key = typeof el === 'bigint' ? el.toString() : String(el);
    if (rootById.get(key) === prefix) return key;
  }
  return null;
}
