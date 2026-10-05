/**
 * Activity Sinks screen config for the generic RecordForm — the whole editable
 * sink expressed as DATA (field table + row→draft / draft→input mappers), the
 * same shape as COMM_CHANNEL_FORM. Replaces the bespoke `activitySinkConfig`
 * NestedEditor branch.
 *
 * Two sink kinds share the form; `showWhen` on the kind select picks the
 * kind-specific fields:
 *   - msgraph_teams — a BROADCAST sink: posts the project's (filtered) activity
 *     to one Teams channel, optionally rolled up every N minutes.
 *   - email — a PERSONAL-subscription sink: an admin opts one of the project's
 *     comm channels in for notification mail; members then subscribe from their
 *     Account page (each subscription carries its own filters + rollup). The
 *     sink's filters act as an admin ceiling ANDed into every subscription.
 *
 * Both kinds carry the event filter (ActivityFilterEditor) and the card filter
 * (PredicateFilter over task attributes, evaluated on the event's task).
 */

import type { RecordFormScreenConfig } from './record-form.js';
import type { ActivitySinkRow } from './specs.js';
import { CHANNEL_STATUS_OPTIONS } from './nested-editor.js';

export const SINK_KIND_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'msgraph_teams', label: 'Microsoft Teams channel' },
  { value: 'email', label: 'Email (personal subscriptions)' },
];

/** The rollup window bound (minutes) the server enforces. */
export const MAX_ROLLUP_MINUTES = 1440;

const TEAMS = ['msgraph_teams'] as const;
const EMAIL = ['email'] as const;

export interface ActivitySinkDraft {
  id: string;
  name: string;
  sinkKind: string;
  msgraphTenantId: string;
  msgraphClientId: string;
  /** Blank on load; a non-empty value is the ONLY thing that writes the secret. */
  msgraphClientSecret: string;
  msgraphTeamId: string;
  msgraphChannelId: string;
  /** email: the comm_channel card the notification mail is sent through. */
  channelId: string;
  /** msgraph_teams: rollup window in minutes ('' / '0' = every tick). */
  rollupMinutes: string;
  channelStatus: string;
  /** The activity_filter predicate JSON string ('' = match every row). */
  activityFilter: string;
  /** The card_filter predicate-tree JSON string ('' = every card). */
  cardFilter: string;
}

export function emptySinkDraft(): ActivitySinkDraft {
  return {
    id: '0', name: '', sinkKind: 'msgraph_teams',
    msgraphTenantId: '', msgraphClientId: '', msgraphClientSecret: '',
    msgraphTeamId: '', msgraphChannelId: '', channelId: '', rollupMinutes: '0',
    channelStatus: 'enabled', activityFilter: '', cardFilter: '',
  };
}

/** Hydrate a sink draft from a decoded (camelCase) row. The client SECRET
 *  always starts blank (never echoed). */
export function sinkRowToDraft(row: ActivitySinkRow): ActivitySinkDraft {
  const channelId = row.channelId ?? '';
  return {
    id: row.id,
    name: row.name,
    sinkKind: row.sinkKind === '' ? 'msgraph_teams' : row.sinkKind,
    msgraphTenantId: row.msgraphTenantId ?? '',
    msgraphClientId: row.msgraphClientId ?? '',
    msgraphClientSecret: '',
    msgraphTeamId: row.msgraphTeamId ?? '',
    msgraphChannelId: row.msgraphChannelId ?? '',
    channelId: channelId === '0' ? '' : channelId,
    rollupMinutes: String(row.rollupMinutes ?? 0),
    channelStatus: row.channelStatus === '' ? 'enabled' : row.channelStatus,
    activityFilter: row.activityFilter ?? '',
    cardFilter: row.cardFilter ?? '',
  };
}

/** Parse a rollup-minutes draft value; null when not an integer in range. */
export function parseRollupMinutes(raw: string): number | null {
  const t = raw.trim();
  if (t === '') return 0;
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 && n <= MAX_ROLLUP_MINUTES ? n : null;
}

/** Per-field error messages; empty record = valid. Mirrors the server gate. */
export function validateSinkDraft(d: ActivitySinkDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (d.name.trim() === '') errors['name'] = 'Sink name is required.';
  if (d.sinkKind.trim() === '') errors['sinkKind'] = 'Sink kind is required.';
  else if (!SINK_KIND_OPTIONS.some((o) => o.value === d.sinkKind)) {
    errors['sinkKind'] = `Unknown sink kind '${d.sinkKind}'.`;
  }
  if (d.sinkKind === 'email' && (d.channelId === '' || d.channelId === '0')) {
    errors['channelId'] = 'Pick the comm channel notification mail is sent through.';
  }
  if (d.sinkKind === 'msgraph_teams' && parseRollupMinutes(d.rollupMinutes) === null) {
    errors['rollupMinutes'] = `Rollup must be a whole number of minutes from 0 to ${MAX_ROLLUP_MINUTES}.`;
  }
  return errors;
}

/** Convert a sink draft to the activity_sink.set input (camelCase; the codec
 *  snake-cases it). The client secret is sent ONLY when non-empty; both filters
 *  are always sent (so clearing writes '' = match everything). Kind-specific
 *  fields go only with their kind. */
export function sinkDraftToSet(d: ActivitySinkDraft, projectId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    projectId,
    name: d.name.trim(),
    sinkKind: d.sinkKind.trim(),
  };
  if (d.id !== '' && d.id !== '0') out['id'] = d.id;
  if (d.sinkKind === 'email') {
    if (d.channelId !== '' && d.channelId !== '0') out['channelId'] = d.channelId;
  } else {
    if (d.msgraphTenantId.trim() !== '') out['msgraphTenantId'] = d.msgraphTenantId.trim();
    if (d.msgraphClientId.trim() !== '') out['msgraphClientId'] = d.msgraphClientId.trim();
    if (d.msgraphClientSecret !== '') out['msgraphClientSecret'] = d.msgraphClientSecret;
    if (d.msgraphTeamId.trim() !== '') out['msgraphTeamId'] = d.msgraphTeamId.trim();
    if (d.msgraphChannelId.trim() !== '') out['msgraphChannelId'] = d.msgraphChannelId.trim();
    out['rollupMinutes'] = parseRollupMinutes(d.rollupMinutes) ?? 0;
  }
  out['activityFilter'] = d.activityFilter;
  out['cardFilter'] = d.cardFilter;
  if (d.channelStatus !== '') out['channelStatus'] = d.channelStatus;
  return out;
}

export const ACTIVITY_SINK_FORM: RecordFormScreenConfig = {
  title: 'Sink configuration',
  projectScopePath: 'scope.projectId',
  saveSpec: 'activity_sink.set',
  listSpec: 'activity_sink.list',
  newButtonLabel: '+ New sink',
  saveButtonLabel: 'Save sink',
  rowToDraft: (row) => sinkRowToDraft(row as unknown as ActivitySinkRow) as unknown as Record<string, unknown>,
  draftToInput: (draft, projectId) => sinkDraftToSet(draft as unknown as ActivitySinkDraft, projectId),
  emptyDraft: () => emptySinkDraft() as unknown as Record<string, unknown>,
  validate: (draft) => validateSinkDraft(draft as unknown as ActivitySinkDraft),
  fields: [
    { name: 'name', label: 'Name', kind: 'text' },
    { name: 'sinkKind', label: 'Kind', kind: 'select', options: [...SINK_KIND_OPTIONS] },
    {
      name: 'channelId',
      label: 'Send through comm channel',
      kind: 'selectFromQuery',
      showWhen: { field: 'sinkKind', in: EMAIL },
      hint: "Mail goes out from this channel's From address. Members subscribe from their Account page.",
      optionsFrom: {
        spec: 'comm_channel.list',
        input: { projectId: { fromProject: true } },
        valueField: 'id',
        labelField: 'name',
        placeholderLabel: 'Pick a comm channel',
      },
    },
    { name: 'msgraphTenantId', label: 'MS Graph tenant', kind: 'text', showWhen: { field: 'sinkKind', in: TEAMS } },
    { name: 'msgraphClientId', label: 'MS Graph client id', kind: 'text', showWhen: { field: 'sinkKind', in: TEAMS } },
    {
      name: 'msgraphClientSecret',
      label: 'MS Graph client secret',
      kind: 'secret',
      configuredFlag: 'hasClientSecret',
      showWhen: { field: 'sinkKind', in: TEAMS },
    },
    { name: 'msgraphTeamId', label: 'MS Graph team', kind: 'text', showWhen: { field: 'sinkKind', in: TEAMS } },
    { name: 'msgraphChannelId', label: 'MS Graph channel', kind: 'text', showWhen: { field: 'sinkKind', in: TEAMS } },
    {
      name: 'rollupMinutes',
      label: 'Rollup (minutes)',
      kind: 'number',
      min: 0,
      max: MAX_ROLLUP_MINUTES,
      hint: '0 posts on the next tick; N batches everything into one post at most every N minutes.',
      showWhen: { field: 'sinkKind', in: TEAMS },
    },
    { name: 'channelStatus', label: 'Status', kind: 'select', options: [...CHANNEL_STATUS_OPTIONS] },
    {
      name: 'activityFilter',
      label: 'Event filter',
      kind: 'activityFilter',
      placeholder: 'No filter — every event.',
    },
    {
      name: 'cardFilter',
      label: 'Card filter',
      kind: 'cardFilter',
      cardType: 'task',
      hint: "Only events on matching tasks. For email sinks it also limits every member's subscription.",
    },
    { name: 'subscriptionCount', label: 'Subscriptions', kind: 'readonly', showWhen: { field: 'sinkKind', in: EMAIL } },
    { name: 'lastPushedAt', label: 'Last delivered', kind: 'readonly', showWhen: { field: 'sinkKind', in: TEAMS } },
    { name: 'lastError', label: 'Last error', kind: 'readonly' },
  ],
};
