/**
 * AccountPage — the signed-in user's own settings (#21), reached from the
 * rail user-menu's "Account". One scrolling page of sections, with a menu on
 * the left that jumps to each (ACCOUNT_SECTIONS):
 *
 *   - Profile: the identity leaf (`auth.user`, landed by the boot /auth/me
 *     probe) — display name, roles, admin/agent — and Log out;
 *   - Email addresses (AccountEmails; docs/EMAIL_ADDRESSES.md);
 *   - Notifications: the caller's email subscriptions (per project), managed
 *     by the config-only MY_SUBSCRIPTIONS_SCREEN MasterDetail;
 *   - Calendars (AccountCalendars).
 *
 * Under them the menu links (🔗) to the account's own pages that live
 * elsewhere (ACCOUNT_LINKS): Watch lists, My screens, My Agents. The page
 * ends with room enough that the last section can be scrolled to the top.
 * Zero-promise throughout.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { AUTH_USER_PATH, type AuthUser } from '../auth/auth-state.js';
import { masterDetailScreen } from '../admin/master-detail.js';
import { MY_SUBSCRIPTIONS_SCREEN } from '../notifications/subscription-screen.js';
import { MY_SCREENS_PATH } from '../myscreens/specs.js';
import { icon } from '../ui/icons.js';
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

/** The page's sections, in order: the menu's jump links. */
export const ACCOUNT_SECTIONS = [
  { key: 'profile', label: 'Profile' },
  { key: 'emails', label: 'Email addresses' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'calendars', label: 'Calendars' },
] as const;

type AccountSectionKey = (typeof ACCOUNT_SECTIONS)[number]['key'];

/** The account's own pages elsewhere: the menu's links (with a link icon). */
export const ACCOUNT_LINKS: readonly { key: string; label: string; href: string }[] = [
  { key: 'watch-lists', label: 'Watch lists', href: '/watch-lists' },
  { key: 'my-screens', label: 'My screens', href: MY_SCREENS_PATH },
  { key: 'agents', label: 'My Agents', href: '/agents' },
];

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

    const profile = this.section('profile', 'Profile');
    this.buildProfile(profile.host);
    const emails = this.section('emails', 'Email addresses');
    const notifications = this.section(
      'notifications',
      'Notifications',
      'Get email about activity in your projects. Each subscription picks which events and tasks to include and how often to send a roll-up.',
    );
    notifications.host.classList.add('account-page__notifications');
    // The calendars control carries its own instructions
    // (docs/MAIL_INTAKE_AND_CALENDARS.md §8).
    const calendars = this.section('calendars', 'Calendars');
    const sections: Record<AccountSectionKey, HTMLElement> = {
      profile: profile.section,
      emails: emails.section,
      notifications: notifications.section,
      calendars: calendars.section,
    };

    const content = document.createElement('div');
    content.className = 'account-page__content';
    content.append(...ACCOUNT_SECTIONS.map((s) => sections[s.key]));

    const layout = document.createElement('div');
    layout.className = 'account-page__layout';
    layout.append(this.buildNav(sections), content);
    this.el.append(h1, layout);
    // Spawn once the host is in the page (the list's virtual window measures it).
    this.spawn('AccountEmails', { type: 'AccountEmails' }, emails.host);
    this.spawn('MasterDetail', masterDetailScreen(MY_SUBSCRIPTIONS_SCREEN), notifications.host);
    this.spawn('AccountCalendars', { type: 'AccountCalendars' }, calendars.host);
  }

  /** The left menu: a jump link per section, then the links elsewhere. */
  private buildNav(sections: Record<AccountSectionKey, HTMLElement>): HTMLElement {
    const nav = document.createElement('nav');
    nav.className = 'account-page__nav';
    nav.setAttribute('aria-label', 'Account');
    const jumps = ACCOUNT_SECTIONS.map((s) => {
      const a = document.createElement('a');
      a.className = 'account-page__nav-link';
      a.dataset.accountNav = s.key;
      a.href = `#account-${s.key}`;
      a.textContent = s.label;
      this.listen(
        a,
        'click',
        plainClick(() => {
          for (const j of jumps) j.removeAttribute('aria-current');
          a.setAttribute('aria-current', 'true');
          sections[s.key].scrollIntoView?.({ block: 'start', behavior: 'smooth' });
        }),
      );
      return a;
    });
    const rule = document.createElement('div');
    rule.className = 'account-page__nav-rule';
    rule.setAttribute('role', 'separator');
    const links = ACCOUNT_LINKS.map((l) => {
      const a = document.createElement('a');
      a.className = 'account-page__nav-link account-page__nav-link--away';
      a.dataset.accountLink = l.key;
      a.href = l.href;
      const label = document.createElement('span');
      label.textContent = l.label;
      a.append(icon('link', 14), label);
      this.listen(a, 'click', plainClick(() => navigate(l.href)));
      return a;
    });
    nav.append(...jumps, rule, ...links);
    return nav;
  }

  /** The Profile section's body: who you are, and Log out. */
  private buildProfile(host: HTMLElement): void {
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
    host.append(card, logoutBtn);
  }

  /** A section: its anchor (the menu jumps to it), heading, optional intro
   *  and the host its body mounts in. */
  private section(key: AccountSectionKey, title: string, intro?: string): { section: HTMLElement; host: HTMLElement } {
    const section = document.createElement('section');
    section.className = 'account-page__section';
    section.id = `account-${key}`;
    section.dataset.accountSection = key;
    const h2 = document.createElement('h2');
    h2.className = 'account-page__subtitle';
    h2.textContent = title;
    section.append(h2);
    if (intro !== undefined) {
      const p = document.createElement('p');
      p.className = 'account-page__intro muted';
      p.textContent = intro;
      section.append(p);
    }
    const host = document.createElement('div');
    host.className = 'account-page__host';
    section.append(host);
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
