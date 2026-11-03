/**
 * AccountPage — the signed-in user's profile (#21), reached from the rail
 * user-menu's "Account". Reads the identity leaf (`auth.user`, landed by the
 * boot /auth/me probe) and shows the display name, roles, and admin/agent
 * flags. A Logout button posts to the auth endpoint.
 *
 * Below the profile, the NOTIFICATIONS section: the caller's personal email
 * subscriptions (per project), managed by the config-only MY_SUBSCRIPTIONS_SCREEN
 * MasterDetail (list + RecordForm detail). Zero-promise throughout.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { AUTH_USER_PATH, type AuthUser } from '../auth/auth-state.js';
import { masterDetailScreen } from '../admin/master-detail.js';
import { MY_SUBSCRIPTIONS_SCREEN } from '../notifications/subscription-screen.js';
import { logout } from './logout.js';
import { navigate, plainClick } from './router.js';

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

    const notifications = this.buildNotifications();
    const calendars = this.buildCalendars();
    this.el.append(h1, card, logoutBtn, notifications.section, this.buildWatchLists(), calendars.section);
    // Spawn once the host is in the page (the list's virtual window measures it).
    this.spawn('MasterDetail', masterDetailScreen(MY_SUBSCRIPTIONS_SCREEN), notifications.host);
    this.spawn('AccountCalendars', { type: 'AccountCalendars' }, calendars.host);
  }

  /** The Watch lists section: what they are, and the way to their screen
   *  (docs/WATCH_LISTS.md). */
  private buildWatchLists(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'account-page__section';
    section.dataset.accountWatchLists = '';
    const h2 = document.createElement('h2');
    h2.className = 'account-page__subtitle';
    h2.textContent = 'Watch lists';
    const intro = document.createElement('p');
    intro.className = 'account-page__intro muted';
    intro.textContent =
      'Your own bookmark lists of tasks and threads — Stars to begin with. Click a list’s symbol in the corner of a task or thread to put it on the list; filter any screen on “On my watch list”.';
    const link = document.createElement('a');
    link.className = 'btn';
    link.dataset.accountWatchLink = '';
    link.href = '/watch-lists';
    link.textContent = 'Open Watch lists';
    this.listen(link, 'click', plainClick(() => navigate('/watch-lists')));
    section.append(h2, intro, link);
    return section;
  }

  /** The Calendars section: your due dates as calendar feeds
   *  (docs/MAIL_INTAKE_AND_CALENDARS.md §8). The control carries its own
   *  instructions. */
  private buildCalendars(): { section: HTMLElement; host: HTMLElement } {
    const section = document.createElement('section');
    section.className = 'account-page__section';
    section.dataset.accountCalendars = '';
    const h2 = document.createElement('h2');
    h2.className = 'account-page__subtitle';
    h2.textContent = 'Calendars';
    const host = document.createElement('div');
    section.append(h2, host);
    return { section, host };
  }

  /** The Notifications section: heading + intro + the subscriptions-manager host. */
  private buildNotifications(): { section: HTMLElement; host: HTMLElement } {
    const section = document.createElement('section');
    section.className = 'account-page__section';
    section.dataset.accountNotifications = '';
    const h2 = document.createElement('h2');
    h2.className = 'account-page__subtitle';
    h2.textContent = 'Notifications';
    const intro = document.createElement('p');
    intro.className = 'account-page__intro muted';
    intro.textContent =
      'Get email about activity in your projects. Each subscription picks which events and tasks to include and how often to send a roll-up.';
    const host = document.createElement('div');
    host.className = 'account-page__notifications';
    section.append(h2, intro, host);
    return { section, host };
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
