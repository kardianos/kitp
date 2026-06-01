/**
 * TaskComments (#35) — comments + the activity feed for the Task detail.
 *
 * Fills the TaskDetail's TWO named slots in one control: the control's own root
 * (`el`) mounts into `[data-slot="comments"]`, and it paints the activity feed
 * into the `[data-slot="activity"]` host handed to it at spawn (TaskDetail
 * passes that element through config, mirroring how the TransitionBar takes an
 * `onChanged` callback through config). One activity load feeds both — comments
 * are DERIVED from the same `kind=comment`/`comment_edit` stream.
 *
 * Data (ZERO-PROMISE, like the rest of the web client):
 *   - `activity.select { cardId, limit }` loads the append-only stream. The
 *     server returns card-mode rows ASCENDING (chronological); we sort
 *     newest-first for the feed. "Load more" pages older rows via the
 *     `beforeActivityId` cursor (the smallest loaded id) and APPENDS them.
 *   - `user.select` resolves actor display names for the feed (activity.actor_id
 *     is a user_account id, not a card id).
 *   - `comment.insert { cardId, body }` posts a comment (optimistic append +
 *     activity refresh; rollback on fault).
 *   - `comment.update { activityId, body }` edits a comment, author-gated
 *     (the gate is enforced server-side too; the UI only shows the edit
 *     affordance to the author — `currentUserId` config).
 *
 * Refresh: a `reload()` (called by TaskDetail after a transition / attribute
 * edit) re-queries the stream so the feed reflects the new attr_update /
 * tag / status rows. The TaskDetail bumps a shared `taskDetail.activityVersion`
 * tree leaf on those actions and we also re-query directly via reload().
 *
 * Markdown bodies render ONLY through `setMarkdown` (the single sanitized sink).
 * Declarative + cascade-safe: every load/post routes through
 * `api.callByName(..., onOk, { alive, onErr })`; no `.then`/`await`.
 *
 * Reference (NOT imported): client/src/screens/TaskDetailScreen.svelte comments
 * + activity sections, ActivityRow.svelte, activity_text.ts.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { setMarkdown } from '../util/markdown-control.js';
import { RichEditor } from '../editor/rich-editor.js';
import { AUTH_USER_PATH, peekCurrentUserId, type AuthUser } from '../auth/auth-state.js';
import { ADMIN_SPEC, type UserListOutput, type AttributeDefListOutput } from '../admin/specs.js';
import { schemaForCardType, type AttrSchema } from '../filter/attribute-schema.js';
import { attrNameToTargetType, loadActivityLabels } from './activity-labels.js';
import {
  ACTIVITY_SELECT_SPEC,
  COMMENT_INSERT_SPEC,
  COMMENT_UPDATE_SPEC,
  ACTIVITY_LIMIT,
  type ActivitySelectOutput,
  type CommentInsertOutput,
  type CommentUpdateOutput,
  type ActivityRow,
} from './comment-specs.js';
import {
  deriveComments,
  formatActivityText,
  formatRelativeTime,
  sortActivityDesc,
  type CommentEntry,
  type IdMap,
} from './activity-text.js';

/* -------------------------------------------------------------------------- */
/* Config + declaration-merged registry type.                                  */
/* -------------------------------------------------------------------------- */

export interface TaskCommentsConfig extends BaseControlConfig {
  type: 'TaskComments';
  /** The focal card whose comments + activity are shown (string → bigint). */
  cardId: string;
  /** The card's card_type name — drives the attribute schema used to resolve
   *  card_ref activity values (e.g. "milestone from bob to sally"). Default 'task'. */
  cardTypeName?: string;
  /**
   * The DOM host the activity feed paints into — the TaskDetail's
   * `[data-slot="activity"]` element. Passed through config (not declarative)
   * the same way the TransitionBar takes its `onChanged` callback.
   */
  activityHost?: HTMLElement;
  /**
   * OVERRIDE for the signed-in user's id (string), used to gate the per-comment
   * edit affordance to the author. When absent the id is read from `auth.user`
   * (the boot /auth/me probe). When NEITHER resolves, NO edit pencil shows (the
   * server enforces author-only edits regardless). Tests inject this directly.
   */
  currentUserId?: string;
  /** Optional row cap per activity page. Default ACTIVITY_LIMIT (50). */
  limit?: number;
  /** Called after a successful LOCAL write (the user's own comment insert/edit)
   *  so the parent can advance its background-poll baseline — our own activity
   *  shouldn't trip the "new content" indicator. */
  onLocalWrite?: () => void;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    TaskComments: TaskCommentsConfig;
  }
}

/* -------------------------------------------------------------------------- */
/* Control.                                                                     */
/* -------------------------------------------------------------------------- */

export class TaskComments extends Control<TaskCommentsConfig> {
  private readonly cardId: bigint | null;
  /** Config override for the current-user id; null when absent (then auth.user). */
  private readonly currentUserOverride: string | null;
  private readonly limit: number;
  private readonly activityHost: HTMLElement | null;
  private readonly cardTypeName: string;

  /** The loaded activity rows, newest-first. */
  private rows: ActivityRow[] = [];
  /** Actor display-name lookup (user_account id → name), keyed id-as-string. */
  private userNames: IdMap = {};
  /** Resolved card_ref value-card titles for activity old/new values (id→title). */
  private cardTitles: IdMap = {};
  /** Resolved tag titles for tag_apply/remove + the `tags` attr (id→title). */
  private tagPaths: IdMap = {};
  /** attribute-name → target card_type (from the schema), for label resolution. */
  private nameToType: Map<string, string> = new Map();
  /** True between the first load fire and its response. */
  private loading = false;
  /** True while a "Load more" page is in flight. */
  private loadingMore = false;
  /** False once a page returns fewer than `limit` rows (no older page exists). */
  private hasMore = true;

  /** Comment composer draft (preserved across re-paints). */
  private composerDraft = '';
  /** True while a comment.insert is in flight (disables the composer). */
  private posting = false;
  /** Per-comment edit state, keyed by comment activity-id-as-string. */
  private readonly edits = new Map<string, { draft: string; busy: boolean }>();

  /* DOM regions held so loads / posts repaint without a full re-render. */
  private commentsBody!: HTMLElement;
  private composerHost!: HTMLElement;
  /** The composer's editor (recreated each paint; needs explicit teardown). */
  private composerEditor: RichEditor | null = null;
  /** Live per-comment edit editors, keyed by comment id-as-string. */
  private readonly editEditors = new Map<string, RichEditor>();
  private feedBody!: HTMLElement;

  constructor(...args: ConstructorParameters<typeof Control<TaskCommentsConfig>>) {
    super(...args);
    this.cardId = parseId(this.config.cardId);
    this.currentUserOverride =
      typeof this.config.currentUserId === 'string' && this.config.currentUserId !== ''
        ? this.config.currentUserId
        : null;
    this.limit = typeof this.config.limit === 'number' && this.config.limit > 0
      ? this.config.limit
      : ACTIVITY_LIMIT;
    this.activityHost = this.config.activityHost ?? null;
    this.cardTypeName = this.config.cardTypeName ?? 'task';
  }

  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'task-comments';
    el.dataset.control = 'TaskComments';
    return el;
  }

  protected render(): void {
    /* ----- Comments section (this control's own root) ----- */
    const section = document.createElement('section');
    section.className = 'task-comments__section';
    section.dataset.region = 'detail.comments';
    section.setAttribute('aria-labelledby', 'task-comments-heading');

    const head = document.createElement('h2');
    head.id = 'task-comments-heading';
    head.className = 'task-detail__section-label muted';
    head.dataset.commentsHeading = '';
    head.textContent = 'COMMENTS';
    section.append(head);

    const body = document.createElement('div');
    body.className = 'task-comments__list';
    body.dataset.commentsBody = '';
    this.commentsBody = body;
    section.append(body);

    const composer = document.createElement('div');
    composer.className = 'task-comments__composer';
    composer.dataset.commentsComposer = '';
    this.composerHost = composer;
    section.append(composer);

    this.el.append(section);

    /* ----- Activity feed (paints into the activity slot host) ----- */
    // The host is the TaskDetail's `[data-slot="activity"]` element. If it's
    // absent (e.g. a standalone test), fall back to appending the feed under
    // this control's own root so the feed is still reachable.
    const feedSection = document.createElement('section');
    feedSection.className = 'task-activity__section';
    feedSection.dataset.region = 'detail.activity';
    feedSection.setAttribute('aria-labelledby', 'task-activity-heading');

    const feedHead = document.createElement('h2');
    feedHead.id = 'task-activity-heading';
    feedHead.className = 'task-detail__section-label muted';
    feedHead.dataset.activityHeading = '';
    feedHead.textContent = 'ACTIVITY';
    feedSection.append(feedHead);

    const feedBody = document.createElement('div');
    feedBody.className = 'task-activity__list';
    feedBody.dataset.activityBody = '';
    this.feedBody = feedBody;
    feedSection.append(feedBody);

    if (this.activityHost !== null) {
      // The slot host carries a placeholder label from the shell; clear it.
      this.activityHost.replaceChildren();
      this.activityHost.append(feedSection);
    } else {
      this.el.append(feedSection);
    }

    // Editors hold engine state (a ProseMirror view, later) that needs explicit
    // teardown; this control owns the composer + any open per-comment editors.
    this.onDestroy(() => {
      this.composerEditor?.destroy();
      for (const ed of this.editEditors.values()) ed.destroy();
      this.editEditors.clear();
    });

    this.paintComments();
    this.paintComposer();
    this.paintFeed();
    this.loadUsers();
    this.loadSchema();
    this.loadActivity(/* append */ false);

    // Repaint comments when the signed-in identity lands (so the author's edit
    // pencil appears once the boot /auth/me probe resolves, without a config
    // override). Skipped when an override is set (identity is already fixed). A
    // one-way read of `auth.user`; repaint touches only this control's DOM.
    if (this.currentUserOverride === null) {
      this.effect(() => {
        this.ctx.tree.at([...AUTH_USER_PATH]).get<AuthUser | undefined>(); // subscribe
        if (this.isAlive()) this.paintComments();
      }, 'task-comments.identityWatch');
    }
  }

  /* -------------------------------- loads ------------------------------- */

  /**
   * Re-query the activity stream from the top. Public so the TaskDetail can
   * refresh the feed after a transition / attribute edit (the new attr_update /
   * status row should appear). Resets the cursor + paging state.
   */
  reload(): void {
    this.hasMore = true;
    this.loadActivity(/* append */ false);
  }

  private loadUsers(): void {
    this.ctx.api.callByName(
      ADMIN_SPEC.userSelect,
      {},
      (out) => {
        const rows = (out as UserListOutput).rows ?? [];
        const map: IdMap = {};
        for (const u of rows) map[String(u.id)] = u.display_name;
        this.userNames = map;
        if (this.isAlive()) this.paintFeed();
      },
      { alive: () => this.isAlive() },
    );
  }

  /**
   * Load the card_type's attribute schema once, to map attribute names → their
   * target card_type. That mapping drives card_ref label resolution in the
   * activity feed ("milestone from bob to sally" instead of "#234 to #456").
   * Re-resolves labels for any already-loaded rows when the schema lands.
   */
  private loadSchema(): void {
    this.ctx.api.callByName(
      ADMIN_SPEC.attributeDefSelect,
      {},
      (out) => {
        if (!this.isAlive()) return;
        const defs = (out as AttributeDefListOutput).rows ?? [];
        const full: AttrSchema[] = schemaForCardType(defs, this.cardTypeName);
        this.nameToType = attrNameToTargetType(full);
        this.resolveActivityLabels();
      },
      { alive: () => this.isAlive() },
    );
  }

  /**
   * Resolve the card_ref ids referenced by the loaded activity rows to titles
   * (one `card.search` per target card_type), then repaint the feed. No-op
   * until the schema's name→type map is known. Data-driven — see activity-labels.
   */
  private resolveActivityLabels(): void {
    if (this.nameToType.size === 0 || this.rows.length === 0) return;
    loadActivityLabels(
      this.ctx.api,
      this.rows,
      this.nameToType,
      (maps) => {
        if (!this.isAlive()) return;
        this.cardTitles = maps.cardTitles;
        this.tagPaths = maps.tagPaths;
        this.paintFeed();
      },
      { alive: () => this.isAlive() },
    );
  }

  /**
   * Load a page of activity. `append=false` replaces the stream (initial load /
   * refresh); `append=true` pages older rows via the `beforeActivityId` cursor
   * (the smallest currently-loaded id) and merges them in.
   */
  private loadActivity(append: boolean): void {
    if (this.cardId === null) {
      this.loading = false;
      this.paintFeed();
      this.paintComments();
      return;
    }
    if (append) {
      this.loadingMore = true;
    } else {
      this.loading = true;
    }
    this.paintFeed();

    const input: { cardId: bigint; limit: number; beforeActivityId?: bigint } = {
      cardId: this.cardId,
      limit: this.limit,
    };
    if (append) {
      const cursor = this.oldestId();
      if (cursor !== null) input.beforeActivityId = cursor;
    }

    this.ctx.api.callByName(
      ACTIVITY_SELECT_SPEC,
      input,
      (out) => {
        if (!this.isAlive()) return;
        const page = sortActivityDesc((out as ActivitySelectOutput).rows ?? []);
        if (append) {
          this.loadingMore = false;
          this.mergeOlder(page);
        } else {
          this.loading = false;
          this.rows = page;
        }
        // A page smaller than the cap means there is no older page.
        if (page.length < this.limit) this.hasMore = false;
        this.paintFeed();
        this.paintComments();
        // Resolve the freshly-loaded rows' card_ref values to titles.
        this.resolveActivityLabels();
      },
      {
        alive: () => this.isAlive(),
        onErr: () => {
          // The central funnel already toasted; clear the loading flags so the
          // last-known stream stays visible.
          if (!this.isAlive()) return;
          this.loading = false;
          this.loadingMore = false;
          this.paintFeed();
        },
      },
    );
  }

  /** The smallest loaded activity id (the cursor for the next older page). */
  private oldestId(): bigint | null {
    let min: bigint | null = null;
    for (const r of this.rows) {
      if (min === null || r.id < min) min = r.id;
    }
    return min;
  }

  /** Merge an older page into the stream, de-duping by id, keeping newest-first. */
  private mergeOlder(older: ActivityRow[]): void {
    const seen = new Set(this.rows.map((r) => r.id.toString()));
    for (const r of older) {
      if (!seen.has(r.id.toString())) {
        this.rows.push(r);
        seen.add(r.id.toString());
      }
    }
    this.rows = sortActivityDesc(this.rows);
  }

  /* ------------------------------ comments ------------------------------ */

  private comments(): CommentEntry[] {
    return deriveComments(this.rows);
  }

  private paintComments(): void {
    // Tear down editors from the previous paint before the list is rebuilt;
    // renderEditor re-creates them (seeded from the preserved per-comment draft).
    for (const ed of this.editEditors.values()) ed.destroy();
    this.editEditors.clear();
    this.commentsBody.replaceChildren();
    const list = this.comments();

    if (this.loading && this.rows.length === 0) {
      const wait = document.createElement('p');
      wait.className = 'task-comments__loading muted';
      wait.dataset.commentsLoading = '';
      wait.textContent = 'Loading comments…';
      this.commentsBody.append(wait);
      return;
    }

    if (list.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'task-comments__empty muted';
      empty.dataset.commentsEmpty = '';
      empty.textContent = 'No comments yet.';
      this.commentsBody.append(empty);
      return;
    }

    const ul = document.createElement('ul');
    ul.className = 'task-comments__items';
    ul.dataset.commentsList = '';
    for (const c of list) ul.append(this.renderComment(c));
    this.commentsBody.append(ul);
  }

  private renderComment(c: CommentEntry): HTMLElement {
    const li = document.createElement('li');
    li.className = 'task-comments__item';
    li.dataset.commentRow = c.id.toString();

    const meta = document.createElement('div');
    meta.className = 'task-comments__meta';

    const actor = document.createElement('span');
    actor.className = 'task-comments__actor';
    actor.textContent = this.actorLabel(c.actorId);
    meta.append(actor);

    // Condensed meta: "author · 2h ago (edited)" — a middot separator, time +
    // edited flag muted. The `c<id>` debug tag is dropped (it wasn't in the
    // design and just added noise to the line).
    const sep = document.createElement('span');
    sep.className = 'task-comments__meta-sep muted';
    sep.setAttribute('aria-hidden', 'true');
    sep.textContent = '·';
    meta.append(sep);

    const time = document.createElement('span');
    time.className = 'task-comments__time muted';
    time.dataset.commentTime = '';
    time.textContent = formatRelativeTime(c.createdAt);
    meta.append(time);

    if (c.edited) {
      const edited = document.createElement('span');
      edited.className = 'task-comments__edited muted';
      edited.textContent = '(edited)';
      meta.append(edited);
    }

    const editState = this.edits.get(c.id.toString());
    const me = this.currentUserId();
    const canEdit = me !== null && me === c.actorId.toString();
    if (canEdit && editState === undefined) {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'task-detail__edit-btn';
      editBtn.dataset.commentEdit = '';
      editBtn.title = 'Edit comment';
      editBtn.setAttribute('aria-label', 'Edit comment');
      editBtn.textContent = '✎';
      this.listen(editBtn, 'click', () => this.startEdit(c));
      meta.append(editBtn);
    }

    li.append(meta);

    if (editState !== undefined) {
      li.append(this.renderEditor(c, editState));
    } else {
      const bodyEl = document.createElement('div');
      bodyEl.className = 'task-comments__body';
      bodyEl.dataset.commentBody = '';
      // The single sanctioned Markdown sink (createElement via DOMSerializer).
      setMarkdown(bodyEl, c.body);
      li.append(bodyEl);
    }

    return li;
  }

  private renderEditor(
    c: CommentEntry,
    state: { draft: string; busy: boolean },
  ): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'task-comments__edit';

    const editor = new RichEditor({
      value: state.draft,
      ariaLabel: 'Edit comment',
      disabled: state.busy,
      editableClassName: 'task-comments__edit-input',
      editableAttrs: { 'data-comment-edit-input': '' },
      onInput: (md) => {
        const cur = this.edits.get(c.id.toString());
        if (cur !== undefined) cur.draft = md;
      },
      onCommit: () => this.commitEdit(c),
      onCancel: () => this.cancelEdit(c.id),
    });
    this.editEditors.set(c.id.toString(), editor);
    wrap.append(editor.el);

    const actions = document.createElement('div');
    actions.className = 'task-comments__edit-actions';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn task-comments__btn';
    cancel.dataset.commentEditCancel = '';
    cancel.textContent = 'Cancel';
    cancel.disabled = state.busy;
    this.listen(cancel, 'click', () => this.cancelEdit(c.id));

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-primary task-comments__btn';
    save.dataset.commentEditSave = '';
    save.textContent = state.busy ? 'Saving…' : 'Save';
    save.disabled = state.busy || state.draft.trim() === '';
    this.listen(save, 'click', () => this.commitEdit(c));

    actions.append(cancel, save);
    wrap.append(actions);

    queueMicrotask(() => editor.focus());
    return wrap;
  }

  private startEdit(c: CommentEntry): void {
    this.edits.set(c.id.toString(), { draft: c.body, busy: false });
    this.paintComments();
  }

  private cancelEdit(id: bigint): void {
    this.edits.delete(id.toString());
    this.paintComments();
  }

  /**
   * Commit a comment edit via comment.update, OPTIMISTICALLY: patch the comment
   * body locally (mirror the edit into the stream) and close the editor; a
   * fault re-opens the editor + restores via a refresh. Author-gated client-
   * side (the pencil only shows to the author) AND server-side.
   */
  private commitEdit(c: CommentEntry): void {
    const key = c.id.toString();
    const state = this.edits.get(key);
    if (state === undefined || state.busy) return;
    const next = state.draft.trim();
    if (next === '') return;
    state.busy = true;
    this.paintComments();

    this.ctx.api.callByName(
      COMMENT_UPDATE_SPEC,
      { activityId: c.id, body: next },
      (_out) => {
        void (_out as CommentUpdateOutput);
        if (!this.isAlive()) return;
        this.edits.delete(key);
        // Re-query so the comment_edit audit row + the new body land canonically.
        this.reload();
        this.config.onLocalWrite?.();
      },
      {
        alive: () => this.isAlive(),
        onErr: () => {
          if (!this.isAlive()) return;
          const cur = this.edits.get(key);
          if (cur !== undefined) cur.busy = false;
          this.paintComments();
        },
      },
    );
  }

  /* ------------------------------ composer ------------------------------ */

  private paintComposer(): void {
    this.composerEditor?.destroy();
    this.composerEditor = null;
    this.composerHost.replaceChildren();

    const editor = new RichEditor({
      value: this.composerDraft,
      placeholder: 'Add a comment…',
      ariaLabel: 'Add a comment',
      disabled: this.posting,
      editableClassName: 'task-comments__composer-input',
      editableAttrs: { 'data-comment-input': '' },
      onInput: (md) => {
        this.composerDraft = md;
        // Toggle the Comment button's disabled state without a full repaint.
        const btn = this.composerHost.querySelector<HTMLButtonElement>('[data-comment-submit]');
        if (btn !== null) btn.disabled = this.posting || this.composerDraft.trim() === '';
      },
      onCommit: () => this.postComment(),
    });
    this.composerEditor = editor;
    this.composerHost.append(editor.el);

    const foot = document.createElement('div');
    foot.className = 'task-comments__composer-foot';

    const hint = document.createElement('span');
    hint.className = 'task-comments__composer-hint muted';
    hint.dataset.commentHint = '';
    hint.textContent = 'Markdown supported · Mod+Enter';
    foot.append(hint);

    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'btn btn-primary task-comments__btn';
    submit.dataset.commentSubmit = '';
    submit.textContent = this.posting ? 'Posting…' : 'Comment';
    submit.disabled = this.posting || this.composerDraft.trim() === '';
    this.listen(submit, 'click', () => this.postComment());
    foot.append(submit);

    this.composerHost.append(foot);
  }

  /**
   * Post a comment via comment.insert, OPTIMISTICALLY: synthesise a local
   * comment row + prepend it to the stream so it shows immediately, clear the
   * composer, then refresh from the server so the canonical row (with its real
   * id + comment_body) lands. A fault rolls back the optimistic row + restores
   * the draft.
   */
  private postComment(): void {
    if (this.cardId === null || this.posting) return;
    const body = this.composerDraft.trim();
    if (body === '') return;
    this.posting = true;

    // Optimistic local row — a negative id keeps it distinct from real ids and
    // sorts newest (it has the current timestamp). The refresh replaces it.
    const me = this.currentUserId();
    const optimistic: ActivityRow = {
      id: -1n,
      cardId: this.cardId,
      kind: 'comment',
      actorId: me !== null ? BigInt(me) : 0n,
      createdAt: new Date().toISOString(),
      commentBody: body,
    };
    this.rows = sortActivityDesc([optimistic, ...this.rows]);
    this.composerDraft = '';
    this.paintComposer();
    this.paintComments();
    this.paintFeed();

    this.ctx.api.callByName(
      COMMENT_INSERT_SPEC,
      { cardId: this.cardId, body },
      (_out) => {
        void (_out as CommentInsertOutput);
        if (!this.isAlive()) return;
        this.posting = false;
        // Drop the optimistic placeholder; the refresh re-loads the real row.
        this.rows = this.rows.filter((r) => r.id !== -1n);
        this.reload();
        this.config.onLocalWrite?.();
        this.paintComposer();
      },
      {
        alive: () => this.isAlive(),
        onErr: () => {
          if (!this.isAlive()) return;
          this.posting = false;
          // Roll back: drop the optimistic row + restore the draft so the user
          // can retry. The central funnel already toasted.
          this.rows = this.rows.filter((r) => r.id !== -1n);
          this.composerDraft = body;
          this.paintComposer();
          this.paintComments();
          this.paintFeed();
        },
      },
    );
  }

  /* -------------------------------- feed -------------------------------- */

  private paintFeed(): void {
    this.feedBody.replaceChildren();

    if (this.loading && this.rows.length === 0) {
      const wait = document.createElement('p');
      wait.className = 'task-activity__loading muted';
      wait.dataset.activityLoading = '';
      wait.textContent = 'Loading activity…';
      this.feedBody.append(wait);
      return;
    }

    if (this.rows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'task-activity__empty muted';
      empty.dataset.activityEmpty = '';
      empty.textContent = 'No activity yet.';
      this.feedBody.append(empty);
      return;
    }

    const list = document.createElement('div');
    list.className = 'task-activity__rows';
    list.dataset.activityRows = '';
    for (const row of this.rows) list.append(this.renderActivityRow(row));
    this.feedBody.append(list);

    if (this.hasMore) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'btn task-comments__btn task-activity__more';
      more.dataset.activityMore = '';
      more.textContent = this.loadingMore ? 'Loading…' : 'Load more';
      more.disabled = this.loadingMore;
      this.listen(more, 'click', () => {
        if (!this.loadingMore) this.loadActivity(/* append */ true);
      });
      this.feedBody.append(more);
    }
  }

  private renderActivityRow(row: ActivityRow): HTMLElement {
    const el = document.createElement('div');
    el.className = 'task-activity__row';
    el.dataset.activityRow = row.id.toString();
    el.dataset.activityKind = row.kind;

    const text = document.createElement('span');
    text.className = 'task-activity__text';
    text.dataset.activityText = '';
    // Resolve actors + card_ref values to names: "changed milestone from bob to
    // sally", not "#234 to #456". The maps fill in once the schema + card.search
    // land; until then refs fall back to `#<id>` (the feed never blanks).
    text.textContent = formatActivityText(row, this.userNames, this.cardTitles, this.tagPaths);
    el.append(text);

    const time = document.createElement('span');
    time.className = 'task-activity__time muted';
    time.textContent = formatRelativeTime(row.createdAt);
    el.append(time);

    return el;
  }

  /* -------------------------------- helpers ----------------------------- */

  private actorLabel(actorId: bigint): string {
    return this.userNames[actorId.toString()] ?? `user#${actorId.toString()}`;
  }

  /**
   * The effective signed-in user id (string), or null. The `config.currentUserId`
   * override wins (tests / an explicit host); otherwise the landed `auth.user`
   * identity (peeked — the identity-watch effect repaints when it lands). Null →
   * NO edit pencil shows (server still enforces author-only edits).
   */
  private currentUserId(): string | null {
    if (this.currentUserOverride !== null) return this.currentUserOverride;
    const id = peekCurrentUserId(this.ctx.tree);
    return id === null ? null : id.toString();
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers.                                                                     */
/* -------------------------------------------------------------------------- */

/** Parse a config id string to a positive bigint, or null when malformed. */
function parseId(raw: string | undefined): bigint | null {
  if (raw === undefined || raw === '') return null;
  if (!/^\d+$/.test(raw)) return null;
  try {
    const n = BigInt(raw);
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

export function registerTaskComments(): void {
  Control.register('TaskComments', TaskComments);
}
