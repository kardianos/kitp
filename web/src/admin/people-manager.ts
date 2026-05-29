/**
 * PeopleManager — the unified "People" admin screen (#11). One screen for every
 * person, with segment toggles (All / Users / Assignees / Contacts) and easy
 * promote/demote between those tiers. Replaces the separate Contacts + Users
 * admin screens.
 *
 * Tiers are derived, not stored as one field:
 *   - contact  = person_kind 'contact', no user_account
 *   - assignee = person_kind 'member', no user_account
 *   - user     = person_kind 'member' + a linked user_account
 *
 * Promote/demote composes the existing handlers:
 *   - kind change           → attribute.update(person_kind)
 *   - grant a login         → person.grant_account (mint + link a user_account)
 *   - revoke a login        → user.unlink_person
 *
 * "+ New" opens a modal dialog (Name / Email / Type) — no `prompt`. Type
 * defaults to the active segment's tier; Email is required when Type='User'.
 * Each row carries a Remove affordance that opens a confirm dialog and composes
 * the removal: revoke the login first when the person is a user
 * (user.unlink_person), then soft-delete the person card (card.delete).
 * Zero-promise; reloads after each write.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import type { ApiFault } from '../core/dispatch.js';
import { ADMIN_SPEC, type UserListOutput, type UserRow, type UserRoleAssignment } from './specs.js';
import { SPEC, type SelectWithAttributesOutput } from '../kanban/specs.js';
import type { CardWithAttrs } from '../kanban/kanban-helpers.js';
import { trapFocus, captureFocus } from '../util/focus-trap.js';

/** A human-readable message for a merge fault — surfaces the server's
 *  'merge_login_conflict' (and other sub_error) text in the merge dialog. */
function mergeFaultMessage(f: ApiFault): string {
  if (f.kind === 'sub_error') return f.message !== '' ? f.message : `Merge failed (${f.code}).`;
  if (f.kind === 'http') return `Merge failed (http ${f.status}).`;
  if (f.kind === 'network') return `Merge failed: ${f.message}`;
  return 'Merge failed.';
}

export interface PeopleManagerConfig extends BaseControlConfig {
  type: 'PeopleManager';
  /** Breadcrumb title (the AppShell reads it for the admin crumb). */
  title?: string;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    PeopleManager: PeopleManagerConfig;
  }
}

type Tier = 'contact' | 'assignee' | 'user';
type Segment = 'all' | Tier;

const SEGMENTS: ReadonlyArray<{ value: Segment; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'user', label: 'Users' },
  { value: 'assignee', label: 'Assignees' },
  { value: 'contact', label: 'Contacts' },
];
const TIER_LABEL: Record<Tier, string> = { contact: 'Contact', assignee: 'Assignee', user: 'User' };

/** A person row joined with its account (when any) + its derived tier. */
interface PersonRow {
  id: bigint;
  title: string;
  email: string;
  tier: Tier;
  /** The linked user_account id (string), when this person is a user. */
  accountId: string | null;
  /** The user's role assignments (users only; from user.list_with_roles). */
  roles: UserRoleAssignment[];
}

export class PeopleManager extends Control<PeopleManagerConfig> {
  private persons: CardWithAttrs[] = [];
  private accountByPerson: Map<string, UserRow> = new Map();
  private segment: Segment = 'all';
  /** Assignable roles (role.list) for the per-user role picker (#19). */
  private roleOptions: Array<{ id: string; name: string }> = [];

  private segHost!: HTMLElement;
  private listHost!: HTMLElement;
  /** The open modal (create / remove), with its focus trap + opener-restore. */
  private modal: { overlay: HTMLElement; release: () => void; restore: () => void } | null = null;

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'people-manager';
    el.dataset.control = 'PeopleManager';
    return el;
  }

  protected render(): void {
    const head = document.createElement('header');
    head.className = 'people-manager__head';
    const title = document.createElement('h1');
    title.className = 'people-manager__title';
    title.textContent = 'People';

    const seg = document.createElement('div');
    seg.className = 'people-manager__segments';
    seg.dataset.peopleSegments = '';
    this.segHost = seg;

    const newBtn = document.createElement('button');
    newBtn.type = 'button';
    newBtn.className = 'btn people-manager__new';
    newBtn.dataset.peopleNew = '';
    newBtn.textContent = '+ New';
    this.listen(newBtn, 'click', () => this.openCreateDialog());

    head.append(title, seg, newBtn);

    const list = document.createElement('div');
    list.className = 'people-manager__list';
    list.dataset.peopleList = '';
    this.listHost = list;

    this.el.append(head, list);

    this.onDestroy(() => this.closeModal());

    this.paintSegments();
    this.load();
  }

  private load(): void {
    this.ctx.api.callByName(
      SPEC.selectWithAttributes,
      { cardTypeName: 'person' },
      (out) => {
        if (!this.isAlive()) return;
        this.persons = (out as SelectWithAttributesOutput).rows ?? [];
        this.paint();
      },
      { alive: () => this.isAlive() },
    );
    this.ctx.api.callByName(
      ADMIN_SPEC.userListWithRoles,
      {},
      (out) => {
        if (!this.isAlive()) return;
        const map = new Map<string, UserRow>();
        for (const u of (out as UserListOutput).rows ?? []) {
          if (u.person_card_id !== undefined && u.person_card_id !== '') map.set(u.person_card_id, u);
        }
        this.accountByPerson = map;
        this.paint();
      },
      { alive: () => this.isAlive() },
    );
    // Assignable roles for the per-user role picker (#19).
    this.ctx.api.callByName(
      ADMIN_SPEC.roleList,
      {},
      (out) => {
        if (!this.isAlive()) return;
        const rows = ((out ?? {}) as { rows?: Array<{ id?: unknown; name?: unknown }> }).rows ?? [];
        this.roleOptions = rows.map((r) => ({ id: String(r.id ?? ''), name: String(r.name ?? '') }));
        this.paint();
      },
      { alive: () => this.isAlive() },
    );
  }

  private attr(card: CardWithAttrs, name: string): string {
    const v = card.attributes[name];
    return typeof v === 'string' ? v : '';
  }

  private rows(): PersonRow[] {
    const out: PersonRow[] = [];
    for (const p of this.persons) {
      const account = this.accountByPerson.get(p.id.toString()) ?? null;
      const kind = this.attr(p, 'person_kind');
      const tier: Tier = account !== null ? 'user' : kind === 'contact' ? 'contact' : 'assignee';
      out.push({
        id: p.id,
        title: this.attr(p, 'title'),
        email: account?.email ?? this.attr(p, 'email'),
        tier,
        accountId: account?.id ?? null,
        roles: account?.roles ?? [],
      });
    }
    out.sort((a, b) => a.title.localeCompare(b.title));
    return out;
  }

  private paintSegments(): void {
    this.segHost.replaceChildren();
    for (const s of SEGMENTS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'people-manager__segment';
      btn.dataset.peopleSegment = s.value;
      btn.textContent = s.label;
      btn.classList.toggle('people-manager__segment--active', s.value === this.segment);
      btn.setAttribute('aria-pressed', s.value === this.segment ? 'true' : 'false');
      this.listen(btn, 'click', () => {
        this.segment = s.value;
        this.paintSegments();
        this.paint();
      });
      this.segHost.append(btn);
    }
  }

  private paint(): void {
    const host = this.listHost;
    host.replaceChildren();
    const rows = this.rows().filter((r) => this.segment === 'all' || r.tier === this.segment);
    if (rows.length === 0) {
      const p = document.createElement('p');
      p.className = 'people-manager__empty muted';
      p.textContent = 'No people in this view.';
      host.append(p);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const r of rows) frag.append(this.renderRow(r));
    host.append(frag);
  }

  private renderRow(r: PersonRow): HTMLElement {
    const row = document.createElement('div');
    row.className = 'people-manager__row';
    row.dataset.peopleRow = r.id.toString();
    row.dataset.tier = r.tier;

    const name = document.createElement('span');
    name.className = 'people-manager__name';
    name.dataset.peopleName = '';
    name.textContent = r.title || `#${r.id.toString()}`;

    const email = document.createElement('span');
    email.className = 'people-manager__email muted';
    email.textContent = r.email;

    // Tier select — the promote/demote control.
    const tierSel = document.createElement('select');
    tierSel.className = 'people-manager__tier';
    tierSel.dataset.peopleTier = '';
    tierSel.setAttribute('aria-label', 'Tier');
    for (const t of ['contact', 'assignee', 'user'] as Tier[]) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = TIER_LABEL[t];
      if (t === r.tier) opt.selected = true;
      tierSel.append(opt);
    }
    this.listen(tierSel, 'change', () => this.changeTier(r, tierSel.value as Tier));

    // Remove: opens a confirm dialog → revoke login (if a user) + soft-delete.
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'people-manager__remove';
    remove.dataset.peopleRemove = '';
    remove.title = 'Remove';
    remove.setAttribute('aria-label', `Remove ${r.title || `#${r.id.toString()}`}`);
    remove.textContent = '✕';
    this.listen(remove, 'click', () => this.openRemoveDialog(r));

    // Merge: fold this (duplicate) person into another, repointing every
    // assignee / originator / comm-recipient reference to the survivor.
    const merge = document.createElement('button');
    merge.type = 'button';
    merge.className = 'people-manager__merge';
    merge.dataset.peopleMerge = r.id.toString();
    merge.title = 'Merge this duplicate into another person';
    merge.setAttribute('aria-label', `Merge ${r.title || `#${r.id.toString()}`} into another person`);
    merge.textContent = 'Merge';
    this.listen(merge, 'click', () => this.openMergeDialog(r));

    row.append(name, email, tierSel, merge, remove);
    // Inline role assignment for users (#19): their roles as removable chips +
    // an "add role" picker. Reuses the user_role.set / user_role.revoke specs.
    if (r.tier === 'user' && r.accountId !== null) {
      row.append(this.renderRolesEditor(r));
    }
    return row;
  }

  /** The per-user roles editor: current roles as ✕-chips + an "add role" select.
   *  Global-scope assignment (the common case); scoped roles still show + revoke. */
  private renderRolesEditor(r: PersonRow): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'people-manager__roles';
    wrap.dataset.peopleRoles = '';

    for (const role of r.roles) {
      const chip = document.createElement('span');
      chip.className = 'people-manager__role-chip';
      chip.dataset.peopleRole = role.role_name;
      const label = document.createElement('span');
      label.textContent = role.scope_project_title
        ? `${role.role_name} · ${role.scope_project_title}`
        : role.role_name;
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'people-manager__role-remove';
      rm.dataset.peopleRoleRemove = role.role_name;
      rm.setAttribute('aria-label', `Revoke ${role.role_name}`);
      rm.textContent = '✕';
      this.listen(rm, 'click', () => this.revokeRole(r, role));
      chip.append(label, rm);
      wrap.append(chip);
    }

    // Add-role select: roles not already held GLOBALLY (a global grant is the
    // one this picker mints; scoped grants of the same role still list).
    const haveGlobal = new Set(
      r.roles.filter((x) => x.scope_project_id === undefined).map((x) => x.role_name),
    );
    const add = document.createElement('select');
    add.className = 'people-manager__role-add';
    add.dataset.peopleRoleAdd = '';
    add.setAttribute('aria-label', 'Add role');
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '+ Add role…';
    add.append(blank);
    for (const ro of this.roleOptions) {
      if (haveGlobal.has(ro.name)) continue;
      const opt = document.createElement('option');
      opt.value = ro.name;
      opt.textContent = ro.name;
      add.append(opt);
    }
    this.listen(add, 'change', () => {
      if (add.value !== '') this.assignRole(r, add.value);
    });
    wrap.append(add);
    return wrap;
  }

  private assignRole(r: PersonRow, roleName: string): void {
    if (r.accountId === null) return;
    this.ctx.api.callByName(
      ADMIN_SPEC.userRoleSet,
      { userId: r.accountId, roleName },
      () => {
        if (this.isAlive()) this.load();
      },
      { alive: () => this.isAlive() },
    );
  }

  private revokeRole(r: PersonRow, role: UserRoleAssignment): void {
    if (r.accountId === null) return;
    const input: Record<string, unknown> = { userId: r.accountId, roleName: role.role_name };
    if (role.scope_project_id !== undefined) input['scopeProjectId'] = role.scope_project_id;
    this.ctx.api.callByName(
      ADMIN_SPEC.userRoleRevoke,
      input,
      () => {
        if (this.isAlive()) this.load();
      },
      { alive: () => this.isAlive() },
    );
  }

  /** Promote / demote a person to a target tier by composing the needed writes. */
  private changeTier(r: PersonRow, target: Tier): void {
    if (target === r.tier) return;
    const fired: string[] = [];
    const done = (): void => {
      // Reload once all fired writes have settled (each onOk calls this; a
      // couple of extra reloads are harmless + idempotent).
      if (this.isAlive()) this.load();
    };

    // 1. person_kind: 'contact' for the contact tier, 'member' otherwise.
    const wantKind = target === 'contact' ? 'contact' : 'member';
    fired.push('kind');
    this.ctx.api.callByName(
      SPEC.attributeUpdate,
      { cardId: r.id, attributeName: 'person_kind', value: wantKind },
      () => done(),
      { alive: () => this.isAlive() },
    );

    // 2. account: grant when becoming a user; revoke when leaving 'user'.
    if (target === 'user' && r.accountId === null) {
      this.ctx.api.callByName(
        ADMIN_SPEC.personGrantAccount,
        { personCardId: r.id },
        () => done(),
        {
          alive: () => this.isAlive(),
          // A missing email is the common failure — surface it (the central
          // funnel toasts) and leave the kind change in place.
          onErr: () => done(),
        },
      );
    } else if (target !== 'user' && r.accountId !== null) {
      this.ctx.api.callByName(
        ADMIN_SPEC.userUnlinkPerson,
        { userAccountId: r.accountId },
        () => done(),
        { alive: () => this.isAlive() },
      );
    }
  }

  /* ------------------------------- modal ---------------------------------- */

  /** Mount `panel` as a centered modal over a scrim, trapping Tab focus and
   *  restoring focus to the opener on close. Backdrop click + Esc close it. */
  private openModal(panel: HTMLElement, label: string): void {
    this.closeModal();
    const restore = captureFocus();

    const overlay = document.createElement('div');
    overlay.className = 'pm-modal';
    overlay.dataset.pmModal = '';

    const backdrop = document.createElement('div');
    backdrop.className = 'pm-modal__backdrop';
    this.listen(backdrop, 'click', () => this.closeModal());

    panel.classList.add('pm-modal__panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', label);
    this.listen(panel, 'keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Escape') {
        ev.preventDefault();
        this.closeModal();
      }
    });

    overlay.append(backdrop, panel);
    this.el.append(overlay);
    const release = trapFocus(panel);
    this.modal = { overlay, release, restore };
  }

  private closeModal(): void {
    if (this.modal === null) return;
    const { overlay, release, restore } = this.modal;
    this.modal = null;
    release();
    overlay.remove();
    restore();
  }

  /** Build one labelled field (label + control) for the modal forms. */
  private field(labelText: string, control: HTMLElement): HTMLElement {
    const field = document.createElement('label');
    field.className = 'pm-modal__field';
    const span = document.createElement('span');
    span.className = 'pm-modal__label';
    span.textContent = labelText;
    control.classList.add('pm-modal__input');
    field.append(span, control);
    return field;
  }

  /* ------------------------------- create --------------------------------- */

  /** "+ New": a modal with Name / Email / Type. Type defaults to the active
   *  segment's tier; Email is required when Type='User' (the login key). */
  private openCreateDialog(): void {
    const panel = document.createElement('div');

    const title = document.createElement('h2');
    title.className = 'pm-modal__title';
    title.textContent = 'Add person';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.dataset.peopleNewName = '';
    nameInput.placeholder = 'Full name';

    const emailInput = document.createElement('input');
    emailInput.type = 'email';
    emailInput.dataset.peopleNewEmail = '';
    emailInput.placeholder = 'name@example.com';

    const typeSel = document.createElement('select');
    typeSel.dataset.peopleNewType = '';
    for (const t of ['contact', 'assignee', 'user'] as Tier[]) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = TIER_LABEL[t];
      typeSel.append(opt);
    }
    typeSel.value = this.segment === 'all' ? 'assignee' : this.segment;

    const hint = document.createElement('p');
    hint.className = 'pm-modal__hint muted';
    hint.dataset.peopleNewHint = '';

    const emailField = this.field('Email', emailInput);

    const actions = document.createElement('div');
    actions.className = 'pm-modal__actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.dataset.peopleNewCancel = '';
    cancel.textContent = 'Cancel';
    this.listen(cancel, 'click', () => this.closeModal());
    const create = document.createElement('button');
    create.type = 'button';
    create.className = 'btn btn-primary';
    create.dataset.peopleNewSubmit = '';
    create.textContent = 'Create';
    actions.append(cancel, create);

    const validate = (): void => {
      const tier = typeSel.value as Tier;
      const userTier = tier === 'user';
      hint.textContent = userTier ? 'A user needs an email — it’s the sign-in key.' : '';
      emailField.classList.toggle('pm-modal__field--required', userTier);
      const nameOk = nameInput.value.trim() !== '';
      const emailOk = !userTier || emailInput.value.trim() !== '';
      create.disabled = !(nameOk && emailOk);
    };
    this.listen(nameInput, 'input', validate);
    this.listen(emailInput, 'input', validate);
    this.listen(typeSel, 'change', validate);

    this.listen(create, 'click', () => {
      const tier = typeSel.value as Tier;
      const name = nameInput.value.trim();
      const email = emailInput.value.trim();
      if (name === '' || (tier === 'user' && email === '')) return;
      const input: Record<string, unknown> = { title: name, tier };
      if (email !== '') input['email'] = email;
      this.ctx.api.callByName(
        ADMIN_SPEC.personCreate,
        input,
        () => {
          if (!this.isAlive()) return;
          this.closeModal();
          this.load();
        },
        { alive: () => this.isAlive() },
      );
    });

    panel.append(title, this.field('Name', nameInput), emailField, this.field('Type', typeSel), hint, actions);
    this.openModal(panel, 'Add person');
    validate();
    nameInput.focus?.();
  }

  /* -------------------------------- merge --------------------------------- */

  /** "Merge": fold this (duplicate) person into a chosen survivor. Every
   *  assignee / originator / comm-recipient reference repoints to the survivor,
   *  a sole login moves over, and the duplicate is soft-deleted (person.merge).
   *  Mirrors the server's login-conflict guard up front: two people that BOTH
   *  have a login can't be merged here. */
  private openMergeDialog(loser: PersonRow): void {
    const others = this.rows().filter((r) => r.id !== loser.id);

    const panel = document.createElement('div');
    const title = document.createElement('h2');
    title.className = 'pm-modal__title';
    title.textContent = 'Merge duplicate';

    const intro = document.createElement('p');
    intro.className = 'pm-modal__hint muted';
    intro.textContent =
      `Fold “${loser.title || `#${loser.id.toString()}`}” into another person. Every task assignee, ` +
      `originator, and comm recipient pointing at it moves to the survivor, and this duplicate is removed.`;

    const sel = document.createElement('select');
    sel.dataset.peopleMergeSurvivor = '';
    if (others.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No other people to merge into';
      sel.append(opt);
      sel.disabled = true;
    } else {
      for (const o of others) {
        const opt = document.createElement('option');
        opt.value = o.id.toString();
        opt.textContent = o.email ? `${o.title || `#${o.id.toString()}`} · ${o.email}` : o.title || `#${o.id.toString()}`;
        sel.append(opt);
      }
    }

    const warn = document.createElement('p');
    warn.className = 'pm-modal__hint';
    warn.dataset.peopleMergeWarn = '';
    warn.style.display = 'none';

    const actions = document.createElement('div');
    actions.className = 'pm-modal__actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.dataset.peopleMergeCancel = '';
    cancel.textContent = 'Cancel';
    this.listen(cancel, 'click', () => this.closeModal());
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'btn btn-primary';
    submit.dataset.peopleMergeSubmit = '';
    submit.textContent = 'Merge';
    actions.append(cancel, submit);

    const survivorOf = (id: string): PersonRow | undefined => others.find((o) => o.id.toString() === id);
    const validate = (): void => {
      const sv = survivorOf(sel.value);
      const bothLogins = loser.accountId !== null && sv != null && sv.accountId !== null;
      if (bothLogins) {
        warn.textContent =
          'Both people have a login. Resolve the duplicate logins first — merging user accounts (sessions, tokens, agents, roles) isn’t supported here.';
        warn.style.display = '';
      } else {
        warn.style.display = 'none';
      }
      submit.disabled = others.length === 0 || sel.value === '' || bothLogins;
    };
    this.listen(sel, 'change', validate);

    this.listen(submit, 'click', () => {
      if (sel.value === '') return;
      this.ctx.api.callByName(
        ADMIN_SPEC.personMerge,
        { survivorId: sel.value, loserIds: [loser.id] },
        () => {
          if (!this.isAlive()) return;
          this.closeModal();
          this.load();
        },
        {
          alive: () => this.isAlive(),
          onErr: (f) => {
            warn.textContent = mergeFaultMessage(f);
            warn.style.display = '';
          },
        },
      );
    });

    panel.append(title, intro, this.field('Survivor', sel), warn, actions);
    this.openModal(panel, 'Merge duplicate');
    validate();
  }

  /* ------------------------------- remove --------------------------------- */

  /** Per-row Remove: a confirm dialog explaining what happens (a user also
   *  loses their login), then composes the removal on confirm. */
  private openRemoveDialog(r: PersonRow): void {
    const panel = document.createElement('div');

    const title = document.createElement('h2');
    title.className = 'pm-modal__title';
    title.textContent = 'Remove person';

    const name = r.title || `#${r.id.toString()}`;
    const msg = document.createElement('p');
    msg.className = 'pm-modal__msg';
    msg.textContent =
      r.tier === 'user'
        ? `Remove ${name}? Their login is revoked and the person archived.`
        : `Remove ${name}? The ${TIER_LABEL[r.tier].toLowerCase()} is archived.`;

    const actions = document.createElement('div');
    actions.className = 'pm-modal__actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.dataset.peopleRemoveCancel = '';
    cancel.textContent = 'Cancel';
    this.listen(cancel, 'click', () => this.closeModal());
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn btn-danger';
    confirm.dataset.peopleRemoveConfirm = '';
    confirm.textContent = 'Remove';
    this.listen(confirm, 'click', () => this.removePerson(r));
    actions.append(cancel, confirm);

    panel.append(title, msg, actions);
    this.openModal(panel, 'Remove person');
    confirm.focus?.();
  }

  /** Compose a removal: revoke the login first when the person is a user, then
   *  soft-delete the person card. Both ride one coalesced batch; the reload
   *  fires when the card.delete settles. */
  private removePerson(r: PersonRow): void {
    if (r.tier === 'user' && r.accountId !== null) {
      this.ctx.api.callByName(
        ADMIN_SPEC.userUnlinkPerson,
        { userAccountId: r.accountId },
        () => {},
        { alive: () => this.isAlive() },
      );
    }
    this.ctx.api.callByName(
      'card.delete',
      { cardId: r.id },
      () => {
        if (!this.isAlive()) return;
        this.closeModal();
        this.load();
      },
      { alive: () => this.isAlive() },
    );
  }
}

export function registerPeopleManager(): void {
  Control.register('PeopleManager', PeopleManager);
}
