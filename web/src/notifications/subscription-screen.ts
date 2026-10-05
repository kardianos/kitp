/**
 * "My notifications" — the account page's subscription manager, expressed as
 * DATA: a MasterDetail list of the caller's subscriptions whose detail pane is
 * the generic RecordForm (field table + row→draft / draft→input mappers). No
 * bespoke control code; the same RecordForm field kinds (event filter, card
 * filter, showWhen, alsoSet, inline delete) back the admin Activity Sinks form.
 *
 * Adding a subscription = "+ Add subscription" → pick "Project — Sink" from the
 * email sinks the caller can see (picking also sets the project the card
 * filter's value pickers load for) → name / rollup / filters → Save. The list
 * re-fetches after every write (reload-after-write).
 */

import type { MasterDetailConfig } from '../admin/master-detail.js';
import type { RecordFormScreenConfig } from '../admin/record-form.js';
import { MAX_ROLLUP_MINUTES, parseRollupMinutes } from '../admin/activity-sink-form.js';
import { ACTIVITY_ME_CHOICES } from '../admin/activity-predicate.js';
import type { SubscriptionRow, SubscriptionSetInput } from './subscription-specs.js';

const NEW = ['0'] as const;

export interface SubscriptionDraft {
  /** '0' for a new (unsaved) subscription. */
  id: string;
  /** New only: the email sink to subscribe to. */
  sinkId: string;
  /** The sink's project (set from the picked sink / the row): scopes the card
   *  filter's value pickers. */
  projectId: string;
  /** Read-only "Project — Sink" for an existing subscription. */
  scopeLabel: string;
  name: string;
  rollupMinutes: string;
  enabled: boolean;
  /** The hydrated `enabled`, so an untouched toggle isn't re-sent (re-sending
   *  false would turn a delivery fault into a manual pause). */
  enabledInitial: boolean;
  activityFilter: string;
  cardFilter: string;
}

export function emptySubscriptionDraft(): SubscriptionDraft {
  return {
    id: '0', sinkId: '', projectId: '', scopeLabel: '', name: '',
    rollupMinutes: '0', enabled: true, enabledInitial: true,
    activityFilter: '', cardFilter: '',
  };
}

export function subscriptionRowToDraft(row: SubscriptionRow): SubscriptionDraft {
  const enabled = row.channelStatus === 'enabled';
  return {
    id: row.id,
    sinkId: row.sinkId,
    projectId: row.projectId,
    scopeLabel: row.scopeLabel,
    name: row.name,
    rollupMinutes: String(row.rollupMinutes),
    enabled,
    enabledInitial: enabled,
    activityFilter: row.activityFilter,
    cardFilter: row.cardFilter,
  };
}

function isNew(d: SubscriptionDraft): boolean {
  return d.id === '' || d.id === '0';
}

export function validateSubscriptionDraft(d: SubscriptionDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (isNew(d) && d.sinkId === '') errors['sinkId'] = 'Pick the project and sink to get notifications from.';
  if (d.name.trim() === '') errors['name'] = 'Give the subscription a name.';
  if (parseRollupMinutes(d.rollupMinutes) === null) {
    errors['rollupMinutes'] = `Rollup must be a whole number of minutes from 0 to ${MAX_ROLLUP_MINUTES}.`;
  }
  return errors;
}

/** Draft → activity_subscription.set input. A create carries the sink; an
 *  update carries the id. Filters + rollup always go (so clearing writes '');
 *  `enabled` goes on create and whenever the toggle changed. */
export function subscriptionDraftToSet(d: SubscriptionDraft): SubscriptionSetInput {
  const out: SubscriptionSetInput = {
    name: d.name.trim(),
    activityFilter: d.activityFilter,
    cardFilter: d.cardFilter,
    rollupMinutes: parseRollupMinutes(d.rollupMinutes) ?? 0,
  };
  if (isNew(d)) {
    out.sinkId = d.sinkId;
    out.enabled = d.enabled;
  } else {
    out.id = d.id;
    if (d.enabled !== d.enabledInitial) out.enabled = d.enabled;
  }
  return out;
}

/** Friendly inline text for the server's subscription fault codes. */
export const SUBSCRIPTION_FAULT_MESSAGES: Readonly<Record<string, string>> = {
  no_person: 'Your login has no linked person record yet — ask an admin to link one.',
  no_email: 'Your person record has no email address — ask an admin to add one.',
  sink_not_found: 'That notification sink no longer exists.',
  sink_not_email: 'Only email sinks accept personal subscriptions.',
  subscription_not_found: 'This subscription no longer exists.',
  not_owner: 'You can only change your own subscriptions.',
  unauthorized: "You don't have access to that project.",
};

export const SUBSCRIPTION_FORM: RecordFormScreenConfig = {
  title: 'Subscription',
  projectScoped: false,
  listInput: {},
  saveSpec: 'activity_subscription.set',
  listSpec: 'activity_subscription.list',
  newButtonLabel: '+ Add subscription',
  saveButtonLabel: 'Save subscription',
  rowToDraft: (row) => subscriptionRowToDraft(row as unknown as SubscriptionRow) as unknown as Record<string, unknown>,
  draftToInput: (draft) => subscriptionDraftToSet(draft as unknown as SubscriptionDraft) as unknown as Record<string, unknown>,
  emptyDraft: () => emptySubscriptionDraft() as unknown as Record<string, unknown>,
  validate: (draft) => validateSubscriptionDraft(draft as unknown as SubscriptionDraft),
  delete: {
    spec: 'activity_subscription.delete',
    toInput: (draft) => ({ id: String(draft['id'] ?? '') }),
    buttonLabel: 'Delete',
    confirmText: 'Delete this subscription? You will stop getting these emails.',
  },
  faultMessages: SUBSCRIPTION_FAULT_MESSAGES,
  fields: [
    {
      name: 'sinkId',
      label: 'Project — Sink',
      kind: 'selectFromQuery',
      showWhen: { field: 'id', in: NEW },
      optionsFrom: {
        spec: 'activity_subscription.sinks',
        input: {},
        valueField: 'sinkId',
        labelField: 'label',
        placeholderLabel: 'Pick a project — sink',
        alsoSet: { projectId: 'projectId' },
      },
    },
    { name: 'scopeLabel', label: 'Project — Sink', kind: 'readonly', showWhen: { field: 'id', notIn: NEW } },
    { name: 'name', label: 'Name', kind: 'text', placeholder: 'e.g. Assigned to me' },
    {
      name: 'rollupMinutes',
      label: 'Rollup (minutes)',
      kind: 'number',
      min: 0,
      max: MAX_ROLLUP_MINUTES,
      hint: '0 sends right away; N rolls everything up into one email at most every N minutes.',
    },
    { name: 'enabled', label: 'Enabled', kind: 'checkbox' },
    {
      name: 'activityFilter',
      label: 'Events',
      kind: 'activityFilter',
      placeholder: 'No filter — every event.',
      // Personal filters can say "done / not done by me" (server resolves @me
      // to the subscriber); broadcast sinks have no "me", so they omit this.
      editor: { actorChoices: ACTIVITY_ME_CHOICES },
    },
    {
      name: 'cardFilter',
      label: 'Tasks',
      kind: 'cardFilter',
      cardType: 'task',
      projectField: 'projectId',
      hint: 'Only events on tasks matching this filter (e.g. Assignee is Me). Empty = every task.',
    },
    { name: 'statusLabel', label: 'Status', kind: 'readonly', showWhen: { field: 'id', notIn: NEW } },
    { name: 'lastSentLabel', label: 'Last sent', kind: 'readonly', showWhen: { field: 'id', notIn: NEW } },
    { name: 'lastError', label: 'Last error', kind: 'readonly', showWhen: { field: 'id', notIn: NEW } },
  ],
};

/** List badge per effective status (an active subscription shows none). */
const STATUS_BADGES: Record<string, string> = {
  paused: 'Paused',
  fault: 'Stopped',
  sink_off: 'Sink off',
};

/** The caller's subscriptions — run through `masterDetailScreen()` before
 *  mounting (it builds the declarative list query). */
export const MY_SUBSCRIPTIONS_SCREEN: MasterDetailConfig = {
  type: 'MasterDetail',
  title: 'Subscriptions',
  scopeKey: 'user.subscriptions',
  list: {
    spec: 'activity_subscription.list',
    input: {},
    rowHeight: 56,
    search: { field: 'name', placeholder: 'Search subscriptions…' },
    row: { title: 'name', subtitle: 'scopeLabel', badge: { field: 'statusKey', labels: STATUS_BADGES } },
  },
  detail: {
    titleField: 'name',
    empty: 'Select a subscription, or add one.',
    fields: [],
    form: SUBSCRIPTION_FORM,
  },
};
