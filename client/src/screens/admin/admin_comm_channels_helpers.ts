/**
 * Pure helpers for `AdminCommChannelsScreen`. Extracted as a TypeScript
 * module so form validation + payload composition can be unit-tested
 * without a Svelte mount runtime (vitest is node-only).
 *
 * Spec: email_comm_spec.md §"Storage and security notes" (L211) +
 * §"Server-side handlers" (L122) — comm_channel.set / .list.
 *
 *   - `ChannelDraft` is the in-form shape (everything is a string so
 *     `<input>` bind:value works uniformly). `draftToSetInput` converts
 *     it to the `ChannelSetInput` payload, applying the omit-on-blank
 *     rule so an unchanged password field doesn't clobber the stored
 *     value (spec L94 + L130).
 *   - `channelRowToDraft` round-trips a server row back into the draft
 *     for the edit flow; password fields are always blank (never
 *     revealed once stored — spec L94).
 *   - `validateChannelDraft` rejects empty name / channel_type and
 *     emits per-field error messages.
 */

import type {
  ChannelRow,
  ChannelSetInput,
  ID,
} from '../../reg/types.js';

/* -------------------------------------------------------------------------- */
/* Channel draft shape                                                        */
/* -------------------------------------------------------------------------- */

/**
 * In-form representation of a channel. Every numeric / id field is a
 * string so the form binds uniformly to text inputs; conversion happens
 * inside `draftToSetInput`.
 */
export interface ChannelDraft {
  /** 0n / '0' for new channels. */
  id: string;
  name: string;
  /** `email` in v1. The form locks this. */
  channelType: string;
  imapHost: string;
  imapPort: string;
  imapUsername: string;
  /** Always blank on load — passwords are never revealed. */
  imapPassword: string;
  smtpHost: string;
  smtpPort: string;
  smtpUsername: string;
  /** Always blank on load — passwords are never revealed. */
  smtpPassword: string;
  fromAddress: string;
  /** '0' / '' for "no intake status set". */
  intakeStatusId: string;
}

/**
 * Build an empty draft. `email` is the v1 default channel type.
 */
export function emptyChannelDraft(): ChannelDraft {
  return {
    id: '0',
    name: '',
    channelType: 'email',
    imapHost: '',
    imapPort: '',
    imapUsername: '',
    imapPassword: '',
    smtpHost: '',
    smtpPort: '',
    smtpUsername: '',
    smtpPassword: '',
    fromAddress: '',
    intakeStatusId: '0',
  };
}

/**
 * Hydrate a draft from a server row for the edit flow. Password fields
 * always start blank (the GUI shows "configured" via has_*_password
 * flags); a non-empty input after edit is what triggers a password
 * write. Per the spec the server preserves the stored value when the
 * field is omitted.
 */
export function channelRowToDraft(row: ChannelRow): ChannelDraft {
  return {
    id: row.id.toString(),
    name: row.name,
    channelType: row.channel_type === '' ? 'email' : row.channel_type,
    imapHost: row.imap_host,
    imapPort: row.imap_port === 0 ? '' : row.imap_port.toString(),
    imapUsername: row.imap_username,
    imapPassword: '',
    smtpHost: row.smtp_host,
    smtpPort: row.smtp_port === 0 ? '' : row.smtp_port.toString(),
    smtpUsername: row.smtp_username,
    smtpPassword: '',
    fromAddress: row.from_address,
    intakeStatusId:
      row.intake_status_id === 0n ? '0' : row.intake_status_id.toString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Validate a draft. Returns a record of per-field error messages; an
 * empty record means the draft is valid. Mirrors the server's
 * `validateChannelSet` so the operator sees the same rejection without
 * a round-trip.
 */
export function validateChannelDraft(draft: ChannelDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (draft.name.trim() === '') {
    errors.name = 'Channel name is required.';
  }
  if (draft.channelType.trim() === '') {
    errors.channelType = 'Channel type is required.';
  } else if (draft.channelType !== 'email') {
    errors.channelType = "Channel type 'email' is the only supported value in v1.";
  }
  // Ports must be numeric if supplied.
  if (draft.imapPort !== '' && !isPositiveInt(draft.imapPort)) {
    errors.imapPort = 'IMAP port must be a positive integer.';
  }
  if (draft.smtpPort !== '' && !isPositiveInt(draft.smtpPort)) {
    errors.smtpPort = 'SMTP port must be a positive integer.';
  }
  return errors;
}

function isPositiveInt(s: string): boolean {
  if (!/^\d+$/.test(s.trim())) return false;
  const n = Number(s);
  return Number.isInteger(n) && n > 0;
}

/* -------------------------------------------------------------------------- */
/* Draft → set payload                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Convert a (validated) draft into the `ChannelSetInput` wire payload.
 *
 * Field-by-field rules (mirroring the server's omit-on-update):
 *   - id == '' / '0' → omit (insert path)
 *   - name / channel_type → always present (validation guarantees
 *     non-empty)
 *   - text fields blank → omit (leave stored)
 *   - port fields blank → omit
 *   - password fields blank → omit (server preserves stored value)
 *   - intakeStatusId == '' / '0' → omit
 */
export function draftToSetInput(
  draft: ChannelDraft,
  projectId: ID,
): ChannelSetInput {
  const out: ChannelSetInput = {
    projectId,
    name: draft.name.trim(),
    channelType: draft.channelType.trim(),
  };
  const id = parseIdOrZero(draft.id);
  if (id !== 0n) out.id = id;
  if (draft.imapHost.trim() !== '') out.imapHost = draft.imapHost.trim();
  const imapPort = parsePortOrZero(draft.imapPort);
  if (imapPort !== 0) out.imapPort = imapPort;
  if (draft.imapUsername.trim() !== '') out.imapUsername = draft.imapUsername.trim();
  if (draft.imapPassword !== '') out.imapPassword = draft.imapPassword;
  if (draft.smtpHost.trim() !== '') out.smtpHost = draft.smtpHost.trim();
  const smtpPort = parsePortOrZero(draft.smtpPort);
  if (smtpPort !== 0) out.smtpPort = smtpPort;
  if (draft.smtpUsername.trim() !== '') out.smtpUsername = draft.smtpUsername.trim();
  if (draft.smtpPassword !== '') out.smtpPassword = draft.smtpPassword;
  if (draft.fromAddress.trim() !== '') out.fromAddress = draft.fromAddress.trim();
  const intake = parseIdOrZero(draft.intakeStatusId);
  if (intake !== 0n) out.intakeStatusId = intake;
  return out;
}

function parseIdOrZero(s: string): ID {
  const trimmed = s.trim();
  if (trimmed === '' || trimmed === '0') return 0n;
  try {
    const n = BigInt(trimmed);
    return n < 0n ? 0n : n;
  } catch {
    return 0n;
  }
}

function parsePortOrZero(s: string): number {
  const trimmed = s.trim();
  if (trimmed === '') return 0;
  const n = Number(trimmed);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/* -------------------------------------------------------------------------- */
/* Misc render helpers                                                        */
/* -------------------------------------------------------------------------- */

/**
 * "Host:Port" display string. Empty host => empty string (so the GUI
 * can render `—` rather than `:0`).
 */
export function hostPortLabel(host: string, port: number): string {
  if (host === '') return '';
  if (port === 0) return host;
  return `${host}:${port}`;
}

/** Coerce a thrown value to a string for toast messages. */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
