/**
 * Unit coverage for the AdminUsersScreen helpers.
 *
 * The vitest setup is node-only (no jsdom), so we exercise the screen via
 * its extracted .ts helpers — `applyUserFilters`, `assignRolePayload`,
 * `buildRolesCsv` — plus a compile-smoke import of the `.svelte` file
 * (matches the pattern in `quick_entry.test.ts` / `ui.test.ts`).
 */

import { describe, expect, it } from 'vitest';

import type { UserListWithRolesRow } from '../../src/reg/types.js';
import {
  applyUserFilters,
  assignRolePayload,
  buildRolesCsv,
} from '../../src/screens/admin/admin_users_helpers.js';

/* -------------------------------------------------------------------------- */
/* Sample users                                                               */
/* -------------------------------------------------------------------------- */

function makeUsers(): UserListWithRolesRow[] {
  return [
    {
      id: 1n,
      display_name: 'Alice Anderson',
      email: 'alice@example.com',
      roles: [
        { role_name: 'admin' },
        {
          role_name: 'member',
          scope_project_id: 10n,
          scope_project_title: 'Acme Co',
        },
      ],
    },
    {
      id: 2n,
      display_name: 'Bob Brown',
      email: 'bob@example.com',
      roles: [{ role_name: 'member', scope_project_id: 11n, scope_project_title: 'Beta Inc' }],
    },
    {
      id: 3n,
      display_name: 'Carol Carter',
      // no email — exercises the empty-email CSV column
      roles: [],
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* applyUserFilters                                                           */
/* -------------------------------------------------------------------------- */

describe('applyUserFilters', () => {
  it('returns every user when search is empty and roleFilter is null', () => {
    const users = makeUsers();
    const out = applyUserFilters(users, '', null);
    expect(out).toHaveLength(3);
    expect(out.map((u) => u.id)).toEqual([1n, 2n, 3n]);
  });

  it('substring-matches display_name case-insensitively', () => {
    const users = makeUsers();
    expect(applyUserFilters(users, 'alice', null).map((u) => u.id)).toEqual([1n]);
    expect(applyUserFilters(users, 'ALICE', null).map((u) => u.id)).toEqual([1n]);
    expect(applyUserFilters(users, 'an', null).map((u) => u.id)).toEqual([1n]); // "Anderson"
    // Whitespace-only search treated as empty.
    expect(applyUserFilters(users, '   ', null).map((u) => u.id)).toEqual([1n, 2n, 3n]);
  });

  it('roleFilter requires the user to hold at least one assignment with that role', () => {
    const users = makeUsers();
    expect(applyUserFilters(users, '', 'admin').map((u) => u.id)).toEqual([1n]);
    expect(applyUserFilters(users, '', 'member').map((u) => u.id)).toEqual([1n, 2n]);
    expect(applyUserFilters(users, '', 'nonsense')).toHaveLength(0);
    // Carol has zero assignments and is excluded by every role filter.
    expect(applyUserFilters(users, 'carol', 'admin')).toHaveLength(0);
  });

  it('search and roleFilter AND together', () => {
    const users = makeUsers();
    // "b" matches Bob (display) and Carol (email-less, no match on name)…
    expect(applyUserFilters(users, 'b', null).map((u) => u.id)).toEqual([2n]);
    // …filtered down by role=admin yields nobody.
    expect(applyUserFilters(users, 'b', 'admin')).toHaveLength(0);
    // role=member + name=alice still works (Alice has a member-scope role).
    expect(applyUserFilters(users, 'alice', 'member').map((u) => u.id)).toEqual([1n]);
  });

  it('does not mutate the input list', () => {
    const users = makeUsers();
    // Native JSON.stringify throws on bigint; coerce ids to strings.
    const stringify = (v: unknown): string =>
      JSON.stringify(v, (_k, val) =>
        typeof val === 'bigint' ? val.toString() : val,
      );
    const before = stringify(users);
    applyUserFilters(users, 'alice', 'admin');
    expect(stringify(users)).toBe(before);
  });
});

/* -------------------------------------------------------------------------- */
/* assignRolePayload                                                          */
/* -------------------------------------------------------------------------- */

describe('assignRolePayload', () => {
  it('omits scopeProjectId when null (global scope)', () => {
    const payload = assignRolePayload(7n, 'admin', null);
    expect(payload).toEqual({ userId: 7n, roleName: 'admin' });
    // The key MUST be absent — not set to undefined / null — so the
    // handler encoder does not emit `scope_project_id` on the wire.
    expect(Object.prototype.hasOwnProperty.call(payload, 'scopeProjectId')).toBe(false);
  });

  it('includes scopeProjectId when provided', () => {
    const payload = assignRolePayload(7n, 'member', 42n);
    expect(payload).toEqual({ userId: 7n, roleName: 'member', scopeProjectId: 42n });
  });

  it('treats scopeProjectId === 0 as a real id (not omitted)', () => {
    const payload = assignRolePayload(7n, 'member', 0n);
    expect(payload.scopeProjectId).toBe(0n);
  });
});

/* -------------------------------------------------------------------------- */
/* buildRolesCsv                                                              */
/* -------------------------------------------------------------------------- */

describe('buildRolesCsv', () => {
  it('emits a header followed by one body row per (user × assignment) tuple', () => {
    const users = makeUsers();
    const csv = buildRolesCsv(users);
    const lines = csv.split('\n');
    // Trailing newline → empty last element after split.
    expect(lines[lines.length - 1]).toBe('');
    // Header + 3 body rows (Alice has 2 assignments, Bob 1, Carol 0).
    expect(lines.length).toBe(1 /* header */ + 3 /* body */ + 1 /* trailing */);
    expect(lines[0]).toBe('User Id,Display Name,Email,Role,Scope');
    expect(lines[1]).toBe('1,Alice Anderson,alice@example.com,admin,global');
    expect(lines[2]).toBe('1,Alice Anderson,alice@example.com,member,Acme Co');
    expect(lines[3]).toBe('2,Bob Brown,bob@example.com,member,Beta Inc');
  });

  it('emits only the header for an empty user list', () => {
    const csv = buildRolesCsv([]);
    expect(csv).toBe('User Id,Display Name,Email,Role,Scope\n');
  });

  it('quotes fields containing commas', () => {
    const users: UserListWithRolesRow[] = [
      {
        id: 1n,
        display_name: 'Doe, Jane',
        email: 'jane@example.com',
        roles: [{ role_name: 'admin' }],
      },
    ];
    const csv = buildRolesCsv(users);
    const lines = csv.split('\n');
    expect(lines[1]).toBe('1,"Doe, Jane",jane@example.com,admin,global');
  });

  it('quotes fields containing double quotes (escaped by doubling)', () => {
    const users: UserListWithRolesRow[] = [
      {
        id: 1n,
        display_name: 'She said "hi"',
        email: 'q@example.com',
        roles: [{ role_name: 'admin' }],
      },
    ];
    const csv = buildRolesCsv(users);
    const lines = csv.split('\n');
    expect(lines[1]).toBe('1,"She said ""hi""",q@example.com,admin,global');
  });

  it('quotes fields containing newlines', () => {
    const users: UserListWithRolesRow[] = [
      {
        id: 1n,
        display_name: 'Multi\nLine',
        email: 'm@example.com',
        roles: [{ role_name: 'admin' }],
      },
    ];
    const csv = buildRolesCsv(users);
    // Embedded newlines stay inside the quoted field, which means the CSV
    // string itself has more newlines than rows. The first body row spans
    // two physical lines.
    expect(csv).toContain('1,"Multi\nLine",m@example.com,admin,global');
  });

  it('falls back to "project #<id>" when scope_project_title is missing', () => {
    const users: UserListWithRolesRow[] = [
      {
        id: 1n,
        display_name: 'Alice',
        email: 'a@x',
        roles: [{ role_name: 'member', scope_project_id: 99n }],
      },
    ];
    const csv = buildRolesCsv(users);
    expect(csv).toContain('1,Alice,a@x,member,project #99');
  });

  it('renders empty email as an empty CSV field (no quoting required)', () => {
    const users: UserListWithRolesRow[] = [
      {
        id: 4n,
        display_name: 'Eve',
        roles: [{ role_name: 'admin' }],
      },
    ];
    const csv = buildRolesCsv(users);
    const lines = csv.split('\n');
    expect(lines[1]).toBe('4,Eve,,admin,global');
  });
});

/* -------------------------------------------------------------------------- */
/* Component compile-smoke                                                    */
/* -------------------------------------------------------------------------- */

describe('AdminUsersScreen imports', () => {
  it('the .svelte component module loads without throwing', async () => {
    const m = await import('../../src/screens/admin/AdminUsersScreen.svelte');
    expect(m.default).toBeDefined();
  });
});
