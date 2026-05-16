/**
 * Comm Gate 9 unit coverage for AdminCommChannelsScreen + its helpers.
 *
 * vitest is node-only, so we exercise the screen via:
 *   1. Pure helpers — `emptyChannelDraft`, `channelRowToDraft`,
 *      `validateChannelDraft`, `draftToSetInput`, `hostPortLabel`.
 *   2. Handler codecs — `commChannelSet` / `commChannelList` encode +
 *      decode.
 *   3. A compile-smoke import of the .svelte component.
 *
 * Spec checkpoints exercised:
 *   - Channel save with all fields → correct payload.
 *   - Channel save with password fields blank → payload omits
 *     passwords (server keeps stored).
 *   - Channel edit pre-fills non-password fields.
 *   - Empty channels list renders empty state (via the component's
 *     `data-testid="comm-channels-empty"` marker).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  commChannelList,
  commChannelSet,
} from '../../src/reg/handlers.js';
import type { ChannelRow } from '../../src/reg/types.js';
import {
  channelRowToDraft,
  draftToSetInput,
  emptyChannelDraft,
  hostPortLabel,
  validateChannelDraft,
} from '../../src/screens/admin/admin_comm_channels_helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

/* -------------------------------------------------------------------------- */
/* emptyChannelDraft                                                          */
/* -------------------------------------------------------------------------- */

describe('emptyChannelDraft', () => {
  it('returns a blank draft with channelType=email locked in', () => {
    const d = emptyChannelDraft();
    expect(d.id).toBe('0');
    expect(d.name).toBe('');
    expect(d.channelType).toBe('email');
    expect(d.imapHost).toBe('');
    expect(d.imapPort).toBe('');
    expect(d.imapPassword).toBe('');
    expect(d.smtpPassword).toBe('');
    expect(d.intakeStatusId).toBe('0');
  });
});

/* -------------------------------------------------------------------------- */
/* channelRowToDraft                                                          */
/* -------------------------------------------------------------------------- */

describe('channelRowToDraft', () => {
  function mkRow(overrides: Partial<ChannelRow> = {}): ChannelRow {
    return {
      id: 7n,
      name: 'Support',
      channel_type: 'email',
      imap_host: 'imap.example.com',
      imap_port: 993,
      imap_username: 'support',
      smtp_host: 'smtp.example.com',
      smtp_port: 587,
      smtp_username: 'support',
      from_address: 'support@example.com',
      intake_status_id: 13n,
      channel_status: 'enabled',
      channel_fault_reason: '',
      has_imap_password: true,
      has_smtp_password: false,
      created_at: '2026-05-13T12:00:00Z',
      ...overrides,
    };
  }

  it('hydrates non-password fields verbatim from the row', () => {
    const d = channelRowToDraft(mkRow());
    expect(d.id).toBe('7');
    expect(d.name).toBe('Support');
    expect(d.channelType).toBe('email');
    expect(d.imapHost).toBe('imap.example.com');
    expect(d.imapPort).toBe('993');
    expect(d.imapUsername).toBe('support');
    expect(d.smtpHost).toBe('smtp.example.com');
    expect(d.smtpPort).toBe('587');
    expect(d.smtpUsername).toBe('support');
    expect(d.fromAddress).toBe('support@example.com');
    expect(d.intakeStatusId).toBe('13');
  });

  it('always blanks password fields on load — never reveals stored values', () => {
    // Even if a password is configured (has_imap_password=true), the
    // draft starts with both password inputs empty. The spec calls this
    // out at L94: "the form shows 'configured' and offers re-set, never
    // reveals the plaintext."
    const d = channelRowToDraft(mkRow({ has_imap_password: true, has_smtp_password: true }));
    expect(d.imapPassword).toBe('');
    expect(d.smtpPassword).toBe('');
  });

  it('clears zero-valued numeric / id fields to empty strings', () => {
    const d = channelRowToDraft(
      mkRow({ imap_port: 0, smtp_port: 0, intake_status_id: 0n }),
    );
    expect(d.imapPort).toBe('');
    expect(d.smtpPort).toBe('');
    expect(d.intakeStatusId).toBe('0');
  });

  it('defaults channelType to email when the server returns an empty value', () => {
    const d = channelRowToDraft(mkRow({ channel_type: '' }));
    expect(d.channelType).toBe('email');
  });
});

/* -------------------------------------------------------------------------- */
/* validateChannelDraft                                                       */
/* -------------------------------------------------------------------------- */

describe('validateChannelDraft', () => {
  it('accepts a minimal draft with name + channelType', () => {
    const d = emptyChannelDraft();
    d.name = 'Support';
    expect(validateChannelDraft(d)).toEqual({});
  });

  it('rejects a blank name', () => {
    const d = emptyChannelDraft();
    expect(validateChannelDraft(d).name).toMatch(/required/i);
  });

  it('rejects a non-email channelType in v1', () => {
    const d = emptyChannelDraft();
    d.name = 'X';
    d.channelType = 'slack';
    expect(validateChannelDraft(d).channelType).toMatch(/'email'/);
  });

  it('rejects non-numeric ports', () => {
    const d = emptyChannelDraft();
    d.name = 'X';
    d.imapPort = 'abc';
    d.smtpPort = '-5';
    const errs = validateChannelDraft(d);
    expect(errs.imapPort).toMatch(/positive integer/);
    expect(errs.smtpPort).toMatch(/positive integer/);
  });

  it('tolerates empty ports (server applies the 993 / 587 defaults)', () => {
    const d = emptyChannelDraft();
    d.name = 'X';
    expect(validateChannelDraft(d)).toEqual({});
  });
});

/* -------------------------------------------------------------------------- */
/* draftToSetInput                                                            */
/* -------------------------------------------------------------------------- */

describe('draftToSetInput', () => {
  it('builds the full payload from a fully-populated draft', () => {
    const d = emptyChannelDraft();
    d.name = 'Support';
    d.imapHost = 'imap.example.com';
    d.imapPort = '993';
    d.imapUsername = 'support';
    d.imapPassword = 's3cret-imap';
    d.smtpHost = 'smtp.example.com';
    d.smtpPort = '587';
    d.smtpUsername = 'support';
    d.smtpPassword = 's3cret-smtp';
    d.fromAddress = 'support@example.com';
    d.intakeStatusId = '13';
    const input = draftToSetInput(d, 99n);
    expect(input).toEqual({
      projectId: 99n,
      name: 'Support',
      channelType: 'email',
      imapHost: 'imap.example.com',
      imapPort: 993,
      imapUsername: 'support',
      imapPassword: 's3cret-imap',
      smtpHost: 'smtp.example.com',
      smtpPort: 587,
      smtpUsername: 'support',
      smtpPassword: 's3cret-smtp',
      fromAddress: 'support@example.com',
      intakeStatusId: 13n,
    });
  });

  it('omits id when draft.id is 0 / "0" / ""', () => {
    const d = emptyChannelDraft();
    d.name = 'X';
    expect(draftToSetInput(d, 1n).id).toBeUndefined();
    d.id = '';
    expect(draftToSetInput(d, 1n).id).toBeUndefined();
    d.id = '0';
    expect(draftToSetInput(d, 1n).id).toBeUndefined();
  });

  it('includes id when set to a non-zero value (edit path)', () => {
    const d = emptyChannelDraft();
    d.name = 'X';
    d.id = '42';
    expect(draftToSetInput(d, 1n).id).toBe(42n);
  });

  it('omits password fields when blank — server keeps stored value (spec L94)', () => {
    const d = emptyChannelDraft();
    d.name = 'X';
    d.id = '42'; // simulating edit
    d.imapHost = 'imap.example.com';
    d.imapPassword = ''; // blank — keep stored
    d.smtpPassword = ''; // blank — keep stored
    const input = draftToSetInput(d, 99n);
    expect(input.imapPassword).toBeUndefined();
    expect(input.smtpPassword).toBeUndefined();
    // Non-password fields still flow through.
    expect(input.imapHost).toBe('imap.example.com');
  });

  it('omits blank text fields (PATCH-style — leave stored value unchanged)', () => {
    const d = emptyChannelDraft();
    d.name = 'X';
    d.id = '42';
    // Everything blank except name.
    const input = draftToSetInput(d, 1n);
    expect(input.imapHost).toBeUndefined();
    expect(input.imapPort).toBeUndefined();
    expect(input.imapUsername).toBeUndefined();
    expect(input.smtpHost).toBeUndefined();
    expect(input.smtpUsername).toBeUndefined();
    expect(input.fromAddress).toBeUndefined();
    expect(input.intakeStatusId).toBeUndefined();
  });

  it('trims surrounding whitespace from text fields', () => {
    const d = emptyChannelDraft();
    d.name = '  Support  ';
    d.imapHost = '  imap.example.com  ';
    d.fromAddress = ' s@example.com ';
    const input = draftToSetInput(d, 1n);
    expect(input.name).toBe('Support');
    expect(input.imapHost).toBe('imap.example.com');
    expect(input.fromAddress).toBe('s@example.com');
  });

  it('omits an invalid port input (non-numeric → treated as zero)', () => {
    const d = emptyChannelDraft();
    d.name = 'X';
    d.imapPort = 'abc';
    expect(draftToSetInput(d, 1n).imapPort).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* hostPortLabel                                                              */
/* -------------------------------------------------------------------------- */

describe('hostPortLabel', () => {
  it('formats host:port when both are set', () => {
    expect(hostPortLabel('imap.example.com', 993)).toBe('imap.example.com:993');
  });

  it('returns just the host when port is 0', () => {
    expect(hostPortLabel('imap.example.com', 0)).toBe('imap.example.com');
  });

  it('returns empty when host is blank (regardless of port)', () => {
    expect(hostPortLabel('', 993)).toBe('');
    expect(hostPortLabel('', 0)).toBe('');
  });
});

/* -------------------------------------------------------------------------- */
/* commChannelSet codec                                                       */
/* -------------------------------------------------------------------------- */

describe('commChannelSet codec', () => {
  it('encodes required fields and converts camelCase → snake_case', () => {
    const encoded = commChannelSet.encode({
      projectId: 1n,
      name: 'Support',
      channelType: 'email',
    }) as Record<string, unknown>;
    expect(encoded).toEqual({
      project_id: 1n,
      name: 'Support',
      channel_type: 'email',
    });
  });

  it('emits optional fields only when non-empty / non-zero', () => {
    const encoded = commChannelSet.encode({
      projectId: 1n,
      name: 'Support',
      channelType: 'email',
      id: 42n,
      imapHost: 'imap.example.com',
      imapPort: 993,
      imapUsername: 'support',
      imapPassword: 's3cret-imap',
      smtpHost: 'smtp.example.com',
      smtpPort: 587,
      smtpUsername: 'support',
      smtpPassword: 's3cret-smtp',
      fromAddress: 'support@example.com',
      intakeStatusId: 13n,
    }) as Record<string, unknown>;
    expect(encoded).toEqual({
      id: 42n,
      project_id: 1n,
      name: 'Support',
      channel_type: 'email',
      imap_host: 'imap.example.com',
      imap_port: 993,
      imap_username: 'support',
      imap_password: 's3cret-imap',
      smtp_host: 'smtp.example.com',
      smtp_port: 587,
      smtp_username: 'support',
      smtp_password: 's3cret-smtp',
      from_address: 'support@example.com',
      intake_status_id: 13n,
    });
  });

  it('omits blank passwords from the wire shape (server keeps stored)', () => {
    const encoded = commChannelSet.encode({
      projectId: 1n,
      name: 'Support',
      channelType: 'email',
      id: 42n,
      imapPassword: '', // blank
      smtpPassword: '', // blank
    }) as Record<string, unknown>;
    expect(encoded.imap_password).toBeUndefined();
    expect(encoded.smtp_password).toBeUndefined();
  });

  it('omits zero id (insert path)', () => {
    const encoded = commChannelSet.encode({
      projectId: 1n,
      name: 'Support',
      channelType: 'email',
      id: 0n,
    }) as Record<string, unknown>;
    expect(encoded.id).toBeUndefined();
  });

  it('decodes the channel_id response', () => {
    expect(commChannelSet.decode({ channel_id: 99n })).toEqual({ channel_id: 99n });
  });

  it('exposes the registered endpoint / action pair', () => {
    expect(commChannelSet.endpoint).toBe('comm_channel');
    expect(commChannelSet.action).toBe('set');
  });
});

/* -------------------------------------------------------------------------- */
/* commChannelList codec                                                      */
/* -------------------------------------------------------------------------- */

describe('commChannelList codec', () => {
  it('encodes the project_id', () => {
    expect(commChannelList.encode({ projectId: 1n })).toEqual({ project_id: 1n });
  });

  it('decodes a row envelope', () => {
    const out = commChannelList.decode({
      rows: [
        {
          id: 7n,
          name: 'Support',
          channel_type: 'email',
          imap_host: 'imap.example.com',
          imap_port: 993,
          imap_username: 'support',
          smtp_host: 'smtp.example.com',
          smtp_port: 587,
          smtp_username: 'support',
          from_address: 'support@example.com',
          intake_status_id: 13n,
          has_imap_password: true,
          has_smtp_password: false,
          created_at: '2026-05-13T12:00:00Z',
        },
      ],
    });
    expect(out.rows).toHaveLength(1);
    const r = out.rows[0]!;
    expect(r.id).toBe(7n);
    expect(r.name).toBe('Support');
    expect(r.channel_type).toBe('email');
    expect(r.imap_host).toBe('imap.example.com');
    expect(r.imap_port).toBe(993);
    expect(r.has_imap_password).toBe(true);
    expect(r.has_smtp_password).toBe(false);
    expect(r.intake_status_id).toBe(13n);
  });

  it('defaults missing fields to safe zero values', () => {
    const out = commChannelList.decode({
      rows: [
        {
          id: 1n,
          // Most fields omitted — exercise the decoder's per-field fallback.
        },
      ],
    });
    const r = out.rows[0]!;
    expect(r.name).toBe('');
    expect(r.imap_port).toBe(0);
    expect(r.intake_status_id).toBe(0n);
    expect(r.has_imap_password).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Empty-state assertion (component source grep)                              */
/* -------------------------------------------------------------------------- */

describe('AdminCommChannelsScreen — empty-state contract', () => {
  it('renders a stable empty-state data-testid when no channels exist', () => {
    const src = readFileSync(
      join(ROOT, 'src', 'screens', 'admin', 'AdminCommChannelsScreen.svelte'),
      'utf8',
    );
    expect(src).toContain('data-testid="comm-channels-empty"');
  });

  it('wires the new-channel button to openCreateForm', () => {
    const src = readFileSync(
      join(ROOT, 'src', 'screens', 'admin', 'AdminCommChannelsScreen.svelte'),
      'utf8',
    );
    expect(src).toContain('+ New channel');
    expect(src).toContain('openCreateForm');
  });

  it('disables the password input placeholder on edit (write-only contract)', () => {
    const src = readFileSync(
      join(ROOT, 'src', 'screens', 'admin', 'AdminCommChannelsScreen.svelte'),
      'utf8',
    );
    // The "Leave blank to keep stored value" hint is the user-facing
    // signal for spec L94. Grep its presence so a refactor that drops it
    // fails this test.
    expect(src).toContain('Leave blank to keep stored value');
  });
});

/* -------------------------------------------------------------------------- */
/* Component compile-smoke                                                    */
/* -------------------------------------------------------------------------- */

describe('AdminCommChannelsScreen import', () => {
  it('the .svelte component module loads without throwing', async () => {
    const m = await import(
      '../../src/screens/admin/AdminCommChannelsScreen.svelte'
    );
    expect(m.default).toBeDefined();
  });
});
