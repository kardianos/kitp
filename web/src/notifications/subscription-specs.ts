/**
 * Personal notification subscriptions — the `activity_subscription.*` specs.
 *
 * A subscription is a member's own opt-in to an admin-configured EMAIL activity
 * sink (one per project mailbox the admin enabled): its event filter, card
 * filter and rollup window decide which project activity reaches the member's
 * inbox, and how often. The subscriber is ALWAYS the calling user server-side
 * (never on the wire), so these specs are safe for every signed-in user.
 *
 *   - activity_subscription.list   in {projectId?}  → the caller's own rows
 *   - activity_subscription.sinks  in {}            → email sinks the caller can join
 *   - activity_subscription.set    in {id?|sinkId, name?, activityFilter?,
 *                                      cardFilter?, rollupMinutes?, enabled?}
 *   - activity_subscription.delete in {id}
 *
 * Generic codec both ways (camelCase ⇄ snake_case). The list decoders add the
 * few DISPLAY fields the config-driven list + form read (`scopeLabel`,
 * `statusKey`, `statusLabel`, `rollupLabel`, `lastSentLabel`; the sink picker's
 * `label`) — derived once here so the screen config stays pure data.
 */

import type { Api } from '../core/api.js';
import { encodeWire, decodeWire } from '../core/codec.js';

export const SUBSCRIPTION_SPEC = {
  list: 'activity_subscription.list',
  sinks: 'activity_subscription.sinks',
  set: 'activity_subscription.set',
  delete: 'activity_subscription.delete',
} as const;

/** One of the caller's subscriptions (decoded + display fields). */
export interface SubscriptionRow {
  id: string;
  name: string;
  sinkId: string;
  sinkName: string;
  projectId: string;
  projectName: string;
  channelName: string;
  activityFilter: string;
  cardFilter: string;
  rollupMinutes: number;
  /** The subscription's own state: 'enabled' | 'disabled-admin' (paused) |
   *  'disabled-fault' (delivery failed permanently). */
  channelStatus: string;
  channelFaultReason: string;
  /** The parent sink's channel_status (an admin can pause the whole sink). */
  sinkStatus: string;
  lastPushedAt: string;
  lastPushedCount: string;
  lastError: string;
  pendingSince: string;
  createdAt: string;
  // ---- derived display fields ----
  scopeLabel: string;
  statusKey: SubscriptionStatusKey;
  statusLabel: string;
  rollupLabel: string;
  lastSentLabel: string;
}

/** An email sink the caller may subscribe to. */
export interface SubscribableSinkRow {
  sinkId: string;
  sinkName: string;
  projectId: string;
  projectName: string;
  channelName: string;
  sinkStatus: string;
  /** "Project — Sink" picker label. */
  label: string;
}

export type SubscriptionStatusKey = 'active' | 'paused' | 'fault' | 'sink_off';

/** The effective delivery state of a subscription. The sink's own pause wins
 *  (nothing is sent while the admin has the sink off). */
export function subscriptionStatusKey(row: { channelStatus?: string; sinkStatus?: string }): SubscriptionStatusKey {
  const sink = row.sinkStatus ?? 'enabled';
  if (sink !== '' && sink !== 'enabled') return 'sink_off';
  if (row.channelStatus === 'disabled-admin') return 'paused';
  if (row.channelStatus === 'disabled-fault') return 'fault';
  return 'active';
}

const STATUS_TEXT: Readonly<Record<SubscriptionStatusKey, string>> = {
  active: 'Active',
  paused: 'Paused',
  fault: 'Stopped after a delivery failure',
  sink_off: 'Paused by an admin (sink disabled)',
};

/** Detail-pane status line (the fault reason rides along when present). */
export function subscriptionStatusLabel(row: { channelStatus?: string; sinkStatus?: string; channelFaultReason?: string }): string {
  const key = subscriptionStatusKey(row);
  const reason = row.channelFaultReason ?? '';
  return key === 'fault' && reason !== '' ? `${STATUS_TEXT.fault}: ${reason}` : STATUS_TEXT[key];
}

/** "Immediately" / "Every 15 min" / "Every 2 h". */
export function rollupLabel(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'Immediately';
  if (minutes % 60 === 0) return `Every ${minutes / 60} h`;
  return `Every ${minutes} min`;
}

/** An RFC3339 timestamp as "YYYY-MM-DD HH:MM UTC"; '' → 'Never'. */
export function lastSentLabel(iso: string): string {
  if (iso === '') return 'Never';
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]} UTC` : iso;
}

function asObj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function asRows(raw: unknown): Record<string, unknown>[] {
  const rows = asObj(raw)['rows'];
  return Array.isArray(rows) ? rows.map(asObj) : [];
}
function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'bigint' ? v.toString() : String(v);
}
function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(str(v));
  return Number.isFinite(n) ? n : 0;
}

/** Decode one activity_subscription.list row (exported for tests). */
export function decodeSubscriptionRow(wire: Record<string, unknown>): SubscriptionRow {
  const r = asObj(decodeWire(wire));
  const base = {
    id: str(r['id']),
    name: str(r['name']),
    sinkId: str(r['sinkId']),
    sinkName: str(r['sinkName']),
    projectId: str(r['projectId']),
    projectName: str(r['projectName']),
    channelName: str(r['channelName']),
    activityFilter: str(r['activityFilter']),
    cardFilter: str(r['cardFilter']),
    rollupMinutes: num(r['rollupMinutes']),
    channelStatus: str(r['channelStatus']) || 'enabled',
    channelFaultReason: str(r['channelFaultReason']),
    sinkStatus: str(r['sinkStatus']) || 'enabled',
    lastPushedAt: str(r['lastPushedAt']),
    lastPushedCount: str(r['lastPushedCount']),
    lastError: str(r['lastError']),
    pendingSince: str(r['pendingSince']),
    createdAt: str(r['createdAt']),
  };
  return {
    ...base,
    scopeLabel: `${base.projectName || `Project #${base.projectId}`} — ${base.sinkName || `Sink #${base.sinkId}`}`,
    statusKey: subscriptionStatusKey(base),
    statusLabel: subscriptionStatusLabel(base),
    rollupLabel: rollupLabel(base.rollupMinutes),
    lastSentLabel: lastSentLabel(base.lastPushedAt),
  };
}

/** Decode one activity_subscription.sinks row (exported for tests). */
export function decodeSubscribableSinkRow(wire: Record<string, unknown>): SubscribableSinkRow {
  const r = asObj(decodeWire(wire));
  const row = {
    sinkId: str(r['sinkId']),
    sinkName: str(r['sinkName']),
    projectId: str(r['projectId']),
    projectName: str(r['projectName']),
    channelName: str(r['channelName']),
    sinkStatus: str(r['sinkStatus']) || 'enabled',
  };
  const paused = row.sinkStatus !== 'enabled' ? ' (paused)' : '';
  return { ...row, label: `${row.projectName || `Project #${row.projectId}`} — ${row.sinkName || `Sink #${row.sinkId}`}${paused}` };
}

export interface SubscriptionSetInput {
  id?: string;
  sinkId?: string;
  name?: string;
  activityFilter?: string;
  cardFilter?: string;
  rollupMinutes?: number;
  enabled?: boolean;
}

/** Register the four activity_subscription.* specs (idempotent). */
export function registerSubscriptionSpecs(api: Api): void {
  if (!api.registry.has({ endpoint: 'activity_subscription', action: 'list' })) {
    api.define<{ projectId?: string }, { rows: SubscriptionRow[] }>({
      endpoint: 'activity_subscription',
      action: 'list',
      encode: (i) => encodeWire(i ?? {}),
      decode: (raw) => ({ rows: asRows(raw).map(decodeSubscriptionRow) }),
    });
  }
  if (!api.registry.has({ endpoint: 'activity_subscription', action: 'sinks' })) {
    api.define<Record<string, never>, { rows: SubscribableSinkRow[] }>({
      endpoint: 'activity_subscription',
      action: 'sinks',
      encode: () => ({}),
      decode: (raw) => ({ rows: asRows(raw).map(decodeSubscribableSinkRow) }),
    });
  }
  if (!api.registry.has({ endpoint: 'activity_subscription', action: 'set' })) {
    api.define<SubscriptionSetInput, { subscriptionId: string }>({
      endpoint: 'activity_subscription',
      action: 'set',
      encode: (i) => encodeWire(i),
      decode: (raw) => ({ subscriptionId: str(asObj(raw)['subscription_id']) }),
    });
  }
  if (!api.registry.has({ endpoint: 'activity_subscription', action: 'delete' })) {
    api.define<{ id: string }, { deleted: boolean }>({
      endpoint: 'activity_subscription',
      action: 'delete',
      encode: (i) => encodeWire(i),
      decode: (raw) => ({ deleted: asObj(raw)['deleted'] === true }),
    });
  }
}
