/**
 * Activity card_ref label resolution — shared by the task-detail activity feed
 * (#35/#2) and the standalone Activity page (#1).
 *
 * Activity rows carry RAW card ids in their old/new attribute values (e.g.
 * `attr_update milestone: #234 → #456`, `tag_apply: [#12,#13]`). To render
 * "from bob to sally" instead of "#234 to #456", we resolve those ids to titles.
 *
 * Data-driven: we map an attribute NAME → its target card_type from the
 * attribute schema (`attribute_def`), gather every referenced id grouped by
 * target type, and fire one `card.search { cardTypeName, ids }` per type. No
 * card_type names are hard-coded — a new `card_ref` attribute resolves the
 * moment its def carries a `target_card_type`.
 */

import type { Api } from '../core/api.js';
import type { CallOptions } from '../core/api.js';
import type { AttrSchema } from '../filter/attribute-schema.js';
import { CARD_SEARCH_SPEC } from '../ui/specs.js';
import type { ActivityRow } from './comment-specs.js';
import type { IdMap } from './activity-text.js';

/** The two resolved maps `formatActivityText` consumes. */
export interface ActivityLabelMaps {
  /** id→title for card_ref value-cards (status/milestone/component/person/…). */
  cardTitles: IdMap;
  /** id→title for tag cards (the `tags` card_ref[] + tag_apply/remove rows). */
  tagPaths: IdMap;
}

/** Build attribute-name → target card_type map from the schema (card_ref attrs only). */
export function attrNameToTargetType(schema: readonly AttrSchema[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of schema) {
    if ((a.valueType === 'card_ref' || a.valueType === 'card_ref[]') && a.targetCardType !== undefined) {
      m.set(a.name, a.targetCardType);
    }
  }
  return m;
}

/** Coerce a candidate id to a digit string: bigint, integer number, or a digit
 *  string (activity jsonb stores card_ref ids as JSON strings). */
function idKey(v: unknown): string | null {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number' && Number.isInteger(v)) return v.toString();
  if (typeof v === 'string' && /^\d+$/.test(v)) return v;
  return null;
}

function collectInto(set: Set<string>, v: unknown): void {
  if (Array.isArray(v)) {
    for (const e of v) {
      const k = idKey(e);
      if (k !== null) set.add(k);
    }
    return;
  }
  const k = idKey(v);
  if (k !== null) set.add(k);
}

/**
 * Group every card-id referenced by `rows` by its target card_type, using the
 * attribute schema for the name→type mapping. `tag_apply`/`tag_remove` rows
 * (which carry no attribute name) map to the `tags` attribute's target type
 * (falling back to the conventional `tag` card_type).
 */
export function collectRefIdsByType(
  rows: readonly ActivityRow[],
  nameToType: Map<string, string>,
): Map<string, Set<string>> {
  const byType = new Map<string, Set<string>>();
  const add = (type: string, v: unknown): void => {
    let set = byType.get(type);
    if (set === undefined) {
      set = new Set<string>();
      byType.set(type, set);
    }
    collectInto(set, v);
  };
  const tagType = nameToType.get('tags') ?? 'tag';
  for (const row of rows) {
    if (row.kind === 'attr_update') {
      const name = row.attributeName;
      if (name === undefined) continue;
      const type = nameToType.get(name);
      if (type === undefined) continue;
      add(type, row.valueOld);
      add(type, row.valueNew);
    } else if (row.kind === 'tag_apply' || row.kind === 'tag_remove') {
      add(tagType, row.valueOld);
      add(tagType, row.valueNew);
    }
  }
  // Drop empty buckets so we don't fire a no-op card.search.
  for (const [type, set] of byType) {
    if (set.size === 0) byType.delete(type);
  }
  return byType;
}

/**
 * Resolve every referenced card_ref id in `rows` to a title and invoke `onMaps`
 * once all per-type `card.search` lookups have landed (or immediately, with
 * empty maps, when nothing needs resolving). Each lookup is gated by `opts.alive`.
 * Titles for the tags type land in `tagPaths`; all other types in `cardTitles`.
 */
export function loadActivityLabels(
  api: Api,
  rows: readonly ActivityRow[],
  nameToType: Map<string, string>,
  onMaps: (maps: ActivityLabelMaps) => void,
  opts: CallOptions = {},
): void {
  const byType = collectRefIdsByType(rows, nameToType);
  const cardTitles: IdMap = {};
  const tagPaths: IdMap = {};
  if (byType.size === 0) {
    onMaps({ cardTitles, tagPaths });
    return;
  }
  const tagType = nameToType.get('tags') ?? 'tag';
  let pending = byType.size;
  const done = (): void => {
    pending -= 1;
    if (pending === 0) onMaps({ cardTitles, tagPaths });
  };
  for (const [type, ids] of byType) {
    const target = type === tagType ? tagPaths : cardTitles;
    api.callByName(
      CARD_SEARCH_SPEC,
      { cardTypeName: type, ids: [...ids].map((s) => BigInt(s)) },
      (out) => {
        const found = ((out ?? {}) as { rows?: Array<{ id: bigint; title: string }> }).rows ?? [];
        for (const r of found) target[String(r.id)] = r.title;
        done();
      },
      { ...opts, onErr: () => done() },
    );
  }
}
