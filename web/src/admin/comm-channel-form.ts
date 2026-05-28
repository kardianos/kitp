/**
 * Comm Channels screen config for the generic RecordForm — the whole editable
 * channel config expressed as DATA: a field table + two mapping functions
 * (row→draft, draft→saveInput). This is the shape the admin-screen refactor is
 * aiming for: ~one screen = a config block + a couple of data functions, with
 * the generic RecordForm control owning all the rendering / draft / save / list
 * refresh. Replaces the bespoke `commChannelConfig` branch of the NestedEditor.
 */

import type { RecordFormScreenConfig } from './record-form.js';
import type { CommChannel } from './specs.js';
import {
  type CommChannelDraft,
  emptyChannelDraft,
  channelRowToDraft,
  channelDraftToSet,
  validateChannelDraft,
  CHANNEL_STATUS_OPTIONS,
} from './nested-editor.js';

/** The status order shared with the template / demo Comms screens. */
const STATUS_ORDER = [{ field: 'attributes.title', direction: 'ASC' }];

export const COMM_CHANNEL_FORM: RecordFormScreenConfig = {
  title: 'Channel configuration',
  projectScopePath: 'scope.projectId',
  saveSpec: 'comm_channel.set',
  listSpec: 'comm_channel.list',
  newButtonLabel: '+ New channel',
  saveButtonLabel: 'Save channel',
  // The two data-mapping functions (the only per-screen code besides the field
  // table). row is the decoded camelCase CommChannel; draft is the all-strings
  // form shape; the converters apply the write-only-secret + omit-on-blank rules.
  rowToDraft: (row) => channelRowToDraft(row as unknown as CommChannel) as unknown as Record<string, unknown>,
  draftToInput: (draft, projectId) => channelDraftToSet(draft as unknown as CommChannelDraft, projectId),
  emptyDraft: () => emptyChannelDraft() as unknown as Record<string, unknown>,
  validate: (draft) => validateChannelDraft(draft as unknown as CommChannelDraft),
  fields: [
    { name: 'name', label: 'Name', kind: 'text' },
    { name: 'imapHost', label: 'IMAP host', kind: 'text' },
    { name: 'imapPort', label: 'IMAP port', kind: 'text' },
    { name: 'imapUsername', label: 'IMAP username', kind: 'text' },
    { name: 'imapPassword', label: 'IMAP password', kind: 'secret', configuredFlag: 'hasImapPassword' },
    { name: 'smtpHost', label: 'SMTP host', kind: 'text' },
    { name: 'smtpPort', label: 'SMTP port', kind: 'text' },
    { name: 'smtpUsername', label: 'SMTP username', kind: 'text' },
    { name: 'smtpPassword', label: 'SMTP password', kind: 'secret', configuredFlag: 'hasSmtpPassword' },
    { name: 'fromAddress', label: 'From address', kind: 'text' },
    {
      name: 'intakeStatusId',
      label: 'Intake status',
      kind: 'selectFromQuery',
      optionsFrom: {
        spec: 'card.select_with_attributes',
        input: {
          cardTypeName: { lit: 'status' },
          parentCardId: { fromProject: true },
          order: { lit: STATUS_ORDER },
        },
        valueField: 'id',
        labelField: 'attributes.title',
        placeholderLabel: 'Use project flow default',
      },
    },
    { name: 'channelStatus', label: 'Status', kind: 'select', options: [...CHANNEL_STATUS_OPTIONS] },
  ],
};
