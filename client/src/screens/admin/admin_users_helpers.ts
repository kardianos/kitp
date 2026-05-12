/**
 * Pure helpers for `AdminUsersScreen`.
 *
 * Extracted as a TypeScript module so they can be unit-tested without a
 * Svelte component-mount runtime (vitest is node-only here). Three helpers:
 *
 *   - `applyUserFilters`: substring-search by `display_name` (case-insensitive)
 *     plus an optional role-membership filter. Pure.
 *   - `assignRolePayload`: builds a `UserRoleSetInput` for the `user_role.set`
 *     mutation; the `scopeProjectId` field is OMITTED (not set to null) when
 *     no scope is chosen, matching the encoder convention in `handlers_admin.ts`.
 *   - `buildRolesCsv` + `downloadCsv`: client-side CSV export of the
 *     `(user × role × scope)` tuples surfaced in the detail pane.
 *
 * Note on naming: the migration plan §5.10 informally refers to
 * `scope_card_id`, but the actual wire shape (`RoleAssignmentRow`,
 * `UserRoleSetInput`) uses the historical `scope_project_id` /
 * `scopeProjectId`. We keep the existing field names so the helpers line
 * up with the registered handler specs.
 */

import type {
  ID,
  RoleAssignmentRow,
  UserListWithRolesRow,
  UserRoleSetInput,
} from '../../reg/types.js';

// ----------------------------------------------------------------------------
// Filtering
// ----------------------------------------------------------------------------

/**
 * Apply the master-pane search and role filter.
 *
 *   - `search` matches case-insensitive substrings against `display_name`.
 *     An empty / whitespace-only search matches everything.
 *   - `roleFilter`, if non-null, requires the user to hold at least one
 *     role assignment with `role_name === roleFilter` (any scope).
 *
 * Both predicates AND together (substring AND role membership). Returns a
 * fresh array; never mutates `users`.
 */
export function applyUserFilters(
  users: readonly UserListWithRolesRow[],
  search: string,
  roleFilter: string | null,
): UserListWithRolesRow[] {
  const needle = search.trim().toLowerCase();
  const out: UserListWithRolesRow[] = [];
  for (const u of users) {
    if (needle.length > 0) {
      if (!u.display_name.toLowerCase().includes(needle)) continue;
    }
    if (roleFilter !== null) {
      const hit = u.roles.some((r) => r.role_name === roleFilter);
      if (!hit) continue;
    }
    out.push(u);
  }
  return out;
}

// ----------------------------------------------------------------------------
// Mutation payload shaping
// ----------------------------------------------------------------------------

/**
 * Build the input record for `user_role.set`. Mirrors the encoder convention
 * in `handlers_admin.ts`: when `scopeProjectId` is `null`, the field is
 * OMITTED (not present) so the server treats it as "global scope".
 */
export function assignRolePayload(
  userId: ID,
  roleName: string,
  scopeProjectId: ID | null,
): UserRoleSetInput {
  const out: UserRoleSetInput = { userId, roleName };
  if (scopeProjectId !== null) {
    out.scopeProjectId = scopeProjectId;
  }
  return out;
}

// ----------------------------------------------------------------------------
// CSV export
// ----------------------------------------------------------------------------

/**
 * RFC 4180-ish CSV field quoting.
 *
 *   - Returns the raw value if it contains no special characters.
 *   - Otherwise wraps in `"…"` and escapes inner `"` by doubling.
 *
 * Special characters: `,` `"` `\n` `\r`.
 */
function csvField(value: string): string {
  if (value === '') return '';
  const needsQuote = /[",\n\r]/.test(value);
  if (!needsQuote) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/** One CSV row: fields joined by comma. Already-quoted fields pass through. */
function csvRow(fields: readonly string[]): string {
  return fields.map(csvField).join(',');
}

/**
 * Build a CSV string for the role assignments table.
 *
 * Header: `User Id,Display Name,Email,Role,Scope`. One body row per
 * `(user × role assignment)` tuple. Users with no role assignments
 * contribute nothing to the body. Rows end with `\n` (final row included).
 *
 * Scope column:
 *   - `'global'` when `scope_project_id` is undefined.
 *   - The `scope_project_title` if present.
 *   - Otherwise `'project #<id>'` as a stable fallback.
 */
export function buildRolesCsv(users: readonly UserListWithRolesRow[]): string {
  const header = csvRow(['User Id', 'Display Name', 'Email', 'Role', 'Scope']);
  const lines: string[] = [header];
  for (const u of users) {
    for (const ra of u.roles) {
      lines.push(
        csvRow([
          String(u.id),
          u.display_name,
          u.email ?? '',
          ra.role_name,
          scopeLabel(ra),
        ]),
      );
    }
  }
  // Trailing newline so consumers (Excel, `tail`, `csvkit`) treat the file as
  // line-terminated. Each row already lacks a newline; join with '\n'.
  return lines.join('\n') + '\n';
}

/** Human-readable scope label for a single role assignment row. */
export function scopeLabel(ra: RoleAssignmentRow): string {
  if (ra.scope_project_id === undefined) return 'global';
  if (ra.scope_project_title !== undefined && ra.scope_project_title !== '') {
    return ra.scope_project_title;
  }
  return `project #${ra.scope_project_id}`;
}

/**
 * Trigger a browser download of `csv` named `filename`.
 *
 * Pure DOM/Blob; no third-party dependency. Safe in tests because the
 * helper only runs when invoked — calling code is gated on a button click.
 * If `document` is undefined (node test runner with no jsdom), the helper
 * is a no-op so importers don't blow up at module load.
 */
export function downloadCsv(filename: string, csv: string): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // Firefox needs the anchor in the DOM for `.click()` to dispatch.
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer URL revocation a tick so the browser has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
