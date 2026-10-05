/**
 * Ref-picker option loader for a {@link PredicateFilter} mounted OUTSIDE a
 * screen (the RecordForm `cardFilter` field: an activity sink's / notification
 * subscription's card filter). Same data-driven vocabulary the ScreenFilterBar
 * derives — the card_type's `card_ref` axes from `attribute_def.select` +
 * `card_type.select` ({@link refAxesForCardType}), then one
 * `card.select_with_attributes` per distinct target card_type (project-scoped
 * value types under `projectId`, global ones like `person` unscoped) — landed
 * as the `Record<targetCardType, {value,label}[]>` map the editor's
 * `optionsPath` reads.
 *
 * Zero-promise: every read is a fire-and-forget `callByName` gated on `alive`;
 * each target's options merge into the map as they land, so open pickers fill
 * in progressively.
 */

import type { ControlContext } from '../core/control.js';
import type { AttributeDefRow } from '../admin/specs.js';
import { refAxesForCardType, type CardTypeRow } from './vocabulary.js';

export interface RefOption {
  value: string;
  label: string;
}

export interface LoadRefOptionsArgs {
  /** The card_type the predicate filters (e.g. 'task'). */
  cardType: string;
  /** The project whose value cards (statuses, tags, …) populate the pickers. */
  projectId: string;
  /** Tree path the option map lands at (the PredicateFilter's optionsPath). */
  optionsPath: string[];
  alive: () => boolean;
}

/** A value card's picker label: title, else name / path, else `#id`. */
export function refOptionLabel(row: { id: unknown; attributes?: Record<string, unknown> }): string {
  const a = row.attributes ?? {};
  const t = a['title'] ?? a['name'] ?? a['path'];
  return typeof t === 'string' && t.length > 0 ? t : `#${String(row.id)}`;
}

/** Load (and progressively land) the ref-picker options for [args.cardType]. */
export function loadRefOptions(ctx: ControlContext, args: LoadRefOptionsArgs): void {
  let defs: AttributeDefRow[] | null = null;
  let types: CardTypeRow[] | null = null;
  const node = ctx.tree.at(args.optionsPath);
  node.set({});

  const loadTargets = (): void => {
    if (defs === null || types === null || !args.alive()) return;
    const projectType = types.find((t) => t.name === 'project');
    const seen = new Set<string>();
    for (const axis of refAxesForCardType(defs, types, args.cardType)) {
      const target = axis.targetCardType;
      if (seen.has(target)) continue;
      seen.add(target);
      const trow = types.find((t) => t.name === target);
      const projectScoped =
        projectType !== undefined && trow !== undefined && trow.parent_card_type_id === projectType.id;
      if (projectScoped && (args.projectId === '' || args.projectId === '0')) continue;
      const input: Record<string, unknown> = { cardTypeName: target };
      if (projectScoped) input['parentCardId'] = args.projectId;
      ctx.api.callByName(
        'card.select_with_attributes',
        input,
        (out) => {
          if (!args.alive()) return;
          const rows = ((out as { rows?: Array<{ id: unknown; attributes?: Record<string, unknown> }> }).rows ?? []);
          const opts: RefOption[] = rows.map((r) => ({ value: String(r.id), label: refOptionLabel(r) }));
          const cur = (node.peek<Record<string, RefOption[]>>() ?? {}) as Record<string, RefOption[]>;
          node.set({ ...cur, [target]: opts });
        },
        { alive: args.alive },
      );
    }
  };

  ctx.api.callByName(
    'attribute_def.select',
    {},
    (out) => {
      defs = ((out as { rows?: AttributeDefRow[] }).rows ?? []) as AttributeDefRow[];
      loadTargets();
    },
    { alive: args.alive },
  );
  ctx.api.callByName(
    'card_type.select',
    {},
    (out) => {
      types = ((out as { rows?: CardTypeRow[] }).rows ?? []) as CardTypeRow[];
      loadTargets();
    },
    { alive: args.alive },
  );
}
