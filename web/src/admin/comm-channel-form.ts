/**
 * Comm Channels screen config for the generic RecordForm — the whole editable
 * mail account expressed as DATA: a field table + the mapping functions
 * (row→draft, draft→saveInput). The generic RecordForm owns the rendering,
 * draft, save and list refresh.
 *
 * A mail account is its ways in plus one way out
 * (docs/MAIL_INTAKE_AND_CALENDARS.md, "Sending"), so the form says whether it
 * is complete, then has two sections: Sending (an SMTP server, Mailgun,
 * Postmark, or your own endpoint — that method's fields indented under the
 * picker) and Receiving (polling a mailbox beside the POST and SMTP routes —
 * the CommRoutes control, mounted in place — then what new mail becomes).
 * Technical details at the foot show the requests on the wire. "Send a test
 * message" mails you through the account's way out.
 */

import type { RecordFormField, RecordFormScreenConfig } from './record-form.js';
import type { CommChannel } from './specs.js';
import {
  type CommChannelDraft,
  emptyChannelDraft,
  channelRowToDraft,
  channelDraftToSet,
  validateChannelDraft,
  CHANNEL_STATUS_OPTIONS,
  SIGNATURE_MODE_OPTIONS,
  INTAKE_MODE_OPTIONS,
  REPLY_QUOTE_OPTIONS,
  RELAY_REPLIES_OPTIONS,
  EMAIL_ATTACHMENTS_OPTIONS,
  SEND_METHOD_OPTIONS,
  MAILGUN_REGION_OPTIONS,
} from './nested-editor.js';

/** The status order shared with the template / demo Comms screens. */
const STATUS_ORDER = [{ field: 'attributes.title', direction: 'ASC' }];

/** Shown for one send method. */
const forMethod = (m: string): RecordFormField['showWhen'] => ({ field: 'sendMethod', in: [m] });
/** Shown while the account sends at all. */
const sends: RecordFormField['showWhen'] = { field: 'sendMethod', notIn: ['none'] };
/** Shown while it polls a mailbox. */
const polls: RecordFormField['showWhen'] = { field: 'imapOn', in: ['true'] };

/** What each send method does, under the picker. */
const SEND_METHOD_HINTS: Record<string, string> = {
  smtp: 'kitp signs in to your mail server (port 587 with STARTTLS, or 465) and hands each message over.',
  mailgun: 'kitp hands each message, as it built it, to Mailgun’s API — threading headers go out unchanged.',
  postmark: 'kitp sends each message through Postmark’s API, its threading headers (Message-ID, In-Reply-To, References) included.',
  webhook: 'kitp POSTs each message, signed, to an https endpoint you run — a Cloudflare Worker, a Lambda with Amazon SES, a script — and it sends it. See Technical details below.',
  none: 'Receive only: replies, notifications and account emails can’t go out through this account.',
};

/** The Sending section: how replies, notifications and codes leave kitp.
 *  The picker is the section's main control; its method's fields sit
 *  indented under it. */
const SENDING_FIELDS: RecordFormField[] = [
  {
    name: 'sendingHeading',
    label: 'Sending',
    kind: 'heading',
    hint: 'How replies, notifications and account emails leave kitp. One way out per account.',
  },
  {
    name: 'sendMethod',
    label: 'Send with',
    kind: 'select',
    prominent: true,
    options: [...SEND_METHOD_OPTIONS],
    hintByValue: SEND_METHOD_HINTS,
  },
  { name: 'smtpHost', label: 'SMTP host', kind: 'text', placeholder: 'smtp.example.com', indent: true, showWhen: forMethod('smtp') },
  { name: 'smtpPort', label: 'SMTP port', kind: 'text', placeholder: '587', indent: true, showWhen: forMethod('smtp') },
  { name: 'smtpUsername', label: 'SMTP username', kind: 'text', indent: true, showWhen: forMethod('smtp') },
  { name: 'smtpPassword', label: 'SMTP password', kind: 'secret', configuredFlag: 'hasSmtpPassword', indent: true, showWhen: forMethod('smtp') },
  {
    name: 'sendDomain',
    label: 'Mailgun domain',
    kind: 'text',
    placeholder: 'mg.example.com',
    hint: 'The sending domain set up in Mailgun; the From address below must be on it.',
    indent: true,
    showWhen: forMethod('mailgun'),
  },
  { name: 'sendRegion', label: 'Mailgun region', kind: 'select', options: [...MAILGUN_REGION_OPTIONS], indent: true, showWhen: forMethod('mailgun') },
  {
    name: 'sendSecret',
    label: 'API key',
    kind: 'secret',
    configuredFlag: 'hasSendSecret',
    hint: 'A sending API key for that domain (Mailgun: Sending → Domain settings → Sending API keys).',
    indent: true,
    showWhen: forMethod('mailgun'),
  },
  {
    name: 'sendSecret',
    label: 'Server API token',
    kind: 'secret',
    configuredFlag: 'hasSendSecret',
    hint: 'A Postmark server’s token (Servers → your server → API Tokens). The From address must be a confirmed sender signature or on a verified domain.',
    indent: true,
    showWhen: forMethod('postmark'),
  },
  { name: 'sendStream', label: 'Message stream', kind: 'text', placeholder: 'outbound', indent: true, showWhen: forMethod('postmark') },
  {
    name: 'sendUrl',
    label: 'Endpoint URL',
    kind: 'text',
    placeholder: 'https://mail-out.example.workers.dev/',
    hint: 'A 2xx answer means sent; another 4xx refuses the message; a 5xx is tried again.',
    indent: true,
    showWhen: forMethod('webhook'),
  },
  {
    name: 'sendSecret',
    label: 'Signing secret',
    kind: 'secret',
    configuredFlag: 'hasSendSecret',
    hint: 'kitp signs each POST with it (X-Kitp-Signature); your endpoint checks it. Use a long random string.',
    indent: true,
    showWhen: forMethod('webhook'),
  },
  {
    name: 'fromAddress',
    label: 'From address',
    kind: 'text',
    placeholder: 'support@example.com',
    hint: 'The account’s own address; mail goes out from it, named with the account’s name.',
    showWhen: sends,
  },
  { name: 'signatureMode', label: 'Reply signature', kind: 'select', options: [...SIGNATURE_MODE_OPTIONS], showWhen: sends },
  { name: 'replyQuote', label: 'Quoting in replies', kind: 'select', options: [...REPLY_QUOTE_OPTIONS], showWhen: sends },
  // docs/MAIL_INTAKE_AND_CALENDARS.md: a reply someone sent to this address
  // alone.
  {
    name: 'relayReplies',
    label: 'Emailed replies',
    kind: 'select',
    options: [...RELAY_REPLIES_OPTIONS],
    hint: 'When someone replies to this address only, kitp emails a copy to the thread’s other people — not to kitp users (they see it here), not to anyone already on the reply. Auto-replies and bounces are never sent on.',
    showWhen: sends,
  },
];

/** The Receiving section: the ways in side by side — polling a mailbox, and
 *  delivery to a route — then what new mail becomes, whichever way it came. */
const RECEIVING_FIELDS: RecordFormField[] = [
  {
    name: 'receivingHeading',
    label: 'Receiving',
    kind: 'heading',
    hint: 'Mail comes in one way or more: kitp polls a mailbox, or a provider or your mail server delivers it. Either way, it is filed as set below.',
  },
  {
    name: 'imapOn',
    label: 'Poll a mailbox (IMAP)',
    kind: 'checkbox',
    hint: 'kitp signs in and fetches new mail every minute.',
    column: 1,
  },
  { name: 'imapHost', label: 'IMAP host', kind: 'text', placeholder: 'imap.example.com', column: 1, indent: true, showWhen: polls },
  { name: 'imapPort', label: 'IMAP port', kind: 'text', placeholder: '993', column: 1, indent: true, showWhen: polls },
  { name: 'imapUsername', label: 'IMAP username', kind: 'text', column: 1, indent: true, showWhen: polls },
  {
    name: 'imapPassword',
    label: 'IMAP password',
    kind: 'secret',
    configuredFlag: 'hasImapPassword',
    column: 1,
    indent: true,
    showWhen: polls,
  },
  {
    name: 'routes',
    label: 'Delivered to kitp',
    kind: 'control',
    column: 2,
    control: {
      type: 'CommRoutes',
      config: {
        heading: 'Have mail delivered (POST or SMTP)',
        intro:
          'A provider or your mail server delivers each message to a route: a POST URL, or an address on kitp’s SMTP listener (forward a mailbox to it). Each route has its own secret — one per sender. Copies that arrive twice are filed once.',
      },
      newText: 'Save the account, then add POST or SMTP routes here.',
    },
  },
  // docs/CONVERSATIONS.md: what new mail becomes.
  { name: 'intakeMode', label: 'New mail', kind: 'select', options: [...INTAKE_MODE_OPTIONS] },
  {
    name: 'intakeStatusId',
    label: 'New task status',
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
    indent: true,
    showWhen: { field: 'intakeMode', in: ['task'] },
  },
  {
    name: 'emailAttachments',
    label: 'Attachments from email',
    kind: 'select',
    options: [...EMAIL_ATTACHMENTS_OPTIONS],
    hint: 'Kept files stay on the thread; Add to task, next to a file in the conversation, moves it onto the task.',
  },
];

/** Technical details at the foot of the form: the requests on the wire. */
const TECHNICAL_DETAILS: RecordFormField = {
  name: 'technical',
  label: 'Technical details — what goes over the wire',
  kind: 'details',
  standalone: true,
  details: [
    {
      title: 'Receiving: a raw POST route',
      text: 'The message is the request body. For a Cloudflare Email Worker, Amazon SES (S3 + a Lambda), or your own script.',
      code: `POST https://kitp.example.com/api/v1/comm/inbound/<route token>
Content-Type: message/rfc822

From: Pat Customer <pat@customer.example>
To: support@example.com
Subject: The export drops the last row
Message-ID: <abc123@customer.example>

When I export the Q3 report the final row is missing.

→ 200 {"status":"task"}     also "reply", "thread", "duplicate", "ignored"
→ 503 {"status":"retry"}    try again (Retry-After)

curl -X POST -H 'Content-Type: message/rfc822' --data-binary @message.eml \\
  https://kitp.example.com/api/v1/comm/inbound/<route token>`,
    },
    {
      title: 'Receiving: a Mailgun route',
      text: 'The route forwards to the URL ending in /mime: Mailgun posts form data with the raw message in body-mime, signed with the webhook signing key.',
      code: `POST https://kitp.example.com/api/v1/comm/inbound/<route token>/mime
Content-Type: multipart/form-data; boundary=…

timestamp  1793980800
token      6f1c0d…            (used once)
signature  hex(HMAC-SHA256(signing key, timestamp + token))
body-mime  From: Pat Customer <pat@customer.example> …   (the whole message)`,
    },
    {
      title: 'Receiving: a Postmark route',
      text: 'The inbound webhook’s JSON; kitp files RawEmail, so turn on “Include raw email content in JSON payload”.',
      code: `POST https://kitp.example.com/api/v1/comm/inbound/<route token>
Content-Type: application/json

{ "From": "pat@customer.example", "Subject": "The export drops the last row", …,
  "RawEmail": "From: Pat Customer <pat@customer.example>\\r\\nTo: support@example.com\\r\\n…" }`,
    },
    {
      title: 'Sending: your own endpoint',
      text: 'What kitp POSTs for each message. Send it to the envelope recipients as it is (a provider’s raw-message API: Amazon SES SendRawEmail, Cloudflare Email Service, …).',
      code: `POST https://mail-out.example.com/kitp
Content-Type: message/rfc822
X-Kitp-Timestamp: 1793980800
X-Kitp-Envelope-From: support@example.com
X-Kitp-Envelope-To: pat@customer.example, bob@customer.example
X-Kitp-Signature: v1=5d2c9e…

From: "Support" <support@example.com>
To: pat@customer.example, bob@customer.example
Subject: Re: The export drops the last row [#l4m0o6XxlV]
Message-ID: <…@example.com>
In-Reply-To: <abc123@customer.example>
References: <abc123@customer.example>

…

← 2xx sent · another 4xx refused for good · 408, 429, 5xx tried again`,
    },
    {
      title: 'Checking the signature',
      text: 'Recompute it with the signing secret, compare in constant time, and refuse a timestamp more than five minutes off.',
      code: `signature = "v1=" + hex(HMAC-SHA256(secret,
    timestamp + "\\n" + envelope_from + "\\n" + envelope_to + "\\n" + body))`,
    },
    {
      title: 'Sending: Mailgun and Postmark',
      text: 'What kitp calls for you.',
      code: `Mailgun   POST https://api.mailgun.net/v3/<domain>/messages.mime   (EU: api.eu.mailgun.net)
          basic auth api:<API key>; form: to (each recipient), message (the whole message)

Postmark  POST https://api.postmarkapp.com/email
          X-Postmark-Server-Token: <token>
          JSON: From, To, Subject, TextBody, Attachments, MessageStream,
                Headers [Message-ID, In-Reply-To, References, …]`,
    },
  ],
};

export const COMM_CHANNEL_FORM: RecordFormScreenConfig = {
  title: 'Mail account',
  projectScopePath: 'scope.projectId',
  saveSpec: 'comm_channel.set',
  listSpec: 'comm_channel.list',
  newButtonLabel: '+ New mail account',
  saveButtonLabel: 'Save',
  // The data-mapping functions (the only per-screen code besides the field
  // table). row is the decoded camelCase CommChannel; draft is the form
  // shape; the converters apply the write-only-secret + omit-on-blank rules.
  rowToDraft: (row) => channelRowToDraft(row as unknown as CommChannel) as unknown as Record<string, unknown>,
  draftToInput: (draft, projectId) => channelDraftToSet(draft as unknown as CommChannelDraft, projectId),
  emptyDraft: () => emptyChannelDraft() as unknown as Record<string, unknown>,
  validate: (draft) => validateChannelDraft(draft as unknown as CommChannelDraft),
  fields: [
    {
      name: 'setup',
      label: 'Setup',
      kind: 'readonly',
      toneField: 'setupTone',
      hint: 'Complete once mail comes in at least one way and the account has a way out.',
    },
    { name: 'name', label: 'Name', kind: 'text' },
    {
      name: 'channelStatus',
      label: 'Status',
      kind: 'select',
      options: [...CHANNEL_STATUS_OPTIONS],
      hint: 'Disabled (admin) sends and fetches nothing. kitp sets Disabled (fault) after repeated failures; the Comm log says why.',
    },
    ...SENDING_FIELDS,
    ...RECEIVING_FIELDS,
    TECHNICAL_DETAILS,
  ],
  recordActions: [
    {
      label: 'Send a test message',
      spec: 'comm_channel.test_send',
      toInput: (draft) => ({ channelId: draft['id'] }),
      doneText: (out) => `Sent a test message to ${String((out as { to?: string }).to ?? 'you')}. If it doesn’t arrive, the Comm log says why.`,
    },
  ],
};
