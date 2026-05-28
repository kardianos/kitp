/**
 * AccountPage — a minimal read-only profile for the signed-in user (#21),
 * reached from the rail user-menu's "Account". Reads the identity leaf
 * (`auth.user`, landed by the boot /auth/me probe) and shows the display name,
 * roles, and admin/agent flags. A Logout button posts to the auth endpoint.
 * Read-only for now (no profile edits); zero-promise — logout is a one-way fetch.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { AUTH_USER_PATH, type AuthUser } from '../auth/auth-state.js';
import { logout } from './logout.js';

export interface AccountPageConfig extends BaseControlConfig {
  type: 'AccountPage';
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    AccountPage: AccountPageConfig;
  }
}

export class AccountPage extends Control<AccountPageConfig> {
  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'account-page';
    el.dataset.control = 'AccountPage';
    return el;
  }

  protected render(): void {
    const h1 = document.createElement('h1');
    h1.className = 'account-page__title';
    h1.textContent = 'Account';

    const card = document.createElement('div');
    card.className = 'account-page__card';

    const nameRow = this.field('Name', '');
    const rolesRow = this.field('Roles', '');
    const kindRow = this.field('Type', '');
    card.append(nameRow.row, rolesRow.row, kindRow.row);

    // Reactive: fill from the identity leaf when /auth/me lands (+ on change).
    this.effect(() => {
      const u = this.ctx.tree.at([...AUTH_USER_PATH]).get<AuthUser | undefined>();
      nameRow.value.textContent = u?.displayName && u.displayName.length > 0 ? u.displayName : '—';
      const roles = u?.roles ?? [];
      rolesRow.value.textContent = roles.length > 0 ? roles.join(', ') : 'none';
      kindRow.value.textContent = u?.isAdmin ? 'Admin' : u?.isAgent ? 'Agent' : 'Member';
    }, 'account.identity');

    const logoutBtn = document.createElement('button');
    logoutBtn.type = 'button';
    logoutBtn.className = 'btn account-page__logout';
    logoutBtn.dataset.accountLogout = '';
    logoutBtn.textContent = 'Log out';
    this.listen(logoutBtn, 'click', () => logout());

    this.el.append(h1, card, logoutBtn);
  }

  private field(label: string, initial: string): { row: HTMLElement; value: HTMLElement } {
    const row = document.createElement('div');
    row.className = 'account-page__row';
    const l = document.createElement('span');
    l.className = 'account-page__label muted';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'account-page__value';
    v.textContent = initial;
    row.append(l, v);
    return { row, value: v };
  }
}

export function registerAccountPage(): void {
  Control.register('AccountPage', AccountPage);
}
