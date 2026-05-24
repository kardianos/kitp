<script lang="ts">
  /**
   * Recipient chip picker for the comm comm_recipients field.
   *
   * Renders the selected participants as removable chips with an input
   * underneath. The input searches the supplied `persons` list by title
   * + email substring; typed text that looks like an email and doesn't
   * match an existing person triggers an inline "Add as new contact"
   * suggestion that calls `person.upsert_by_email` (kind='contact').
   *
   * Designed for two call sites: the Start-comm form on the Task
   * detail screen and the inline Edit-recipients affordance on the
   * Comms screen. Both pass the same `persons` array they already
   * load for the assignee dropdown, so this component never refetches.
   */
  import { tick } from 'svelte';
  import { getDispatcher } from '../dispatch/context.js';
  import { personUpsertByEmail } from '../reg/handlers.js';
  import type {
    CardWithAttrs,
    ID,
    PersonUpsertByEmailInput,
    PersonUpsertByEmailOutput,
  } from '../reg/types.js';
  import { cx } from '../util/class_names.js';
  import Chip from './Chip.svelte';

  interface Props {
    value: ID[];
    persons: CardWithAttrs[];
    onchange?: (v: ID[]) => void;
    /** Disables the input + chip removal. */
    disabled?: boolean;
    placeholder?: string;
    /** Forwarded to the input id for label `for` association. */
    id?: string;
    'aria-label'?: string;
    class?: string;
  }

  let {
    value = $bindable(),
    persons,
    onchange,
    disabled = false,
    placeholder = 'Add by name or email…',
    id,
    'aria-label': ariaLabel,
    class: klass = '',
  }: Props = $props();

  const dispatcher = getDispatcher();

  let query = $state('');
  let inputEl: HTMLInputElement | null = $state(null);
  let focused = $state(false);
  let highlight = $state(0);
  let busy = $state(false);
  /** Error from the last upsert, surfaced beneath the input. */
  let errMsg = $state('');
  /**
   * Local cache of contacts created via `+ Add as new contact` this
   * session. The parent's `persons` list is fetched once on screen
   * mount and doesn't include the just-upserted row, so without this
   * fallback the chip would render as `#123` until the user navigates
   * away and back. Keyed by stringified ID so it slots into the same
   * lookup path as `personById`.
   */
  let createdLocal = $state<Map<string, { email: string }>>(new Map());

  const personById = $derived.by((): Map<string, CardWithAttrs> => {
    const m = new Map<string, CardWithAttrs>();
    for (const p of persons) m.set(p.id.toString(), p);
    return m;
  });

  function titleOf(p: CardWithAttrs): string {
    const t = p.attributes['title'];
    if (typeof t === 'string' && t.length > 0) return t;
    const e = p.attributes['email'];
    if (typeof e === 'string' && e.length > 0) return e;
    return `#${p.id}`;
  }

  function emailOf(p: CardWithAttrs): string {
    const e = p.attributes['email'];
    return typeof e === 'string' ? e : '';
  }

  function isContact(p: CardWithAttrs): boolean {
    return p.attributes['person_kind'] === 'contact';
  }

  /**
   * Best-effort email shape check. The server is the actual source of
   * truth — it accepts whatever a user types and stores it verbatim —
   * but the picker uses this to decide when to surface the "Add as new
   * contact" suggestion versus showing only existing matches.
   */
  function looksLikeEmail(s: string): boolean {
    const t = s.trim();
    if (t.length < 3) return false;
    if (t.includes(' ')) return false;
    const at = t.indexOf('@');
    return at > 0 && at < t.length - 1 && t.indexOf('.', at) > at;
  }

  const selectedIds = $derived(new Set(value.map((id) => id.toString())));

  const filtered = $derived.by((): CardWithAttrs[] => {
    const q = query.trim().toLowerCase();
    const pool = persons.filter((p) => !selectedIds.has(p.id.toString()));
    if (q === '') return pool.slice(0, 8);
    return pool
      .filter((p) => {
        const t = titleOf(p).toLowerCase();
        const e = emailOf(p).toLowerCase();
        return t.includes(q) || e.includes(q);
      })
      .slice(0, 8);
  });

  /**
   * True when the typed query is a not-already-listed email that
   * doesn't exactly match the email attribute of any existing person —
   * surfaces the inline "+ Add" suggestion.
   */
  const canCreateFromEmail = $derived.by((): boolean => {
    const q = query.trim();
    if (!looksLikeEmail(q)) return false;
    const ql = q.toLowerCase();
    for (const p of persons) {
      if (emailOf(p).toLowerCase() === ql) return false;
    }
    return true;
  });

  // Highlight wraps across suggestions + the optional create row.
  const optionCount = $derived(filtered.length + (canCreateFromEmail ? 1 : 0));
  const listboxId = $derived(id !== undefined ? `${id}-listbox` : undefined);

  $effect(() => {
    if (highlight >= optionCount) highlight = 0;
  });

  function emit(next: ID[]) {
    value = next;
    onchange?.(next);
  }

  function addPerson(p: CardWithAttrs) {
    if (selectedIds.has(p.id.toString())) return;
    emit([...value, p.id]);
    query = '';
    errMsg = '';
    void tick().then(() => inputEl?.focus());
  }

  function removeAt(idx: number) {
    const next = value.slice();
    next.splice(idx, 1);
    emit(next);
  }

  async function createAndAdd() {
    const email = query.trim();
    if (!looksLikeEmail(email) || busy) return;
    busy = true;
    errMsg = '';
    try {
      const out = await dispatcher.request<
        PersonUpsertByEmailInput,
        PersonUpsertByEmailOutput
      >({
        endpoint: personUpsertByEmail.endpoint,
        action: personUpsertByEmail.action,
        data: { email, kind: 'contact' },
      });
      const idKey = out.person_id.toString();
      if (!persons.some((p) => p.id.toString() === idKey)) {
        createdLocal.set(idKey, { email });
      }
      if (!selectedIds.has(idKey)) {
        emit([...value, out.person_id]);
      }
      query = '';
      void tick().then(() => inputEl?.focus());
    } catch (e) {
      errMsg = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function onKeydown(ev: KeyboardEvent) {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (optionCount > 0) highlight = (highlight + 1) % optionCount;
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (optionCount > 0) highlight = (highlight - 1 + optionCount) % optionCount;
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      if (highlight < filtered.length) {
        const p = filtered[highlight];
        if (p !== undefined) addPerson(p);
      } else if (canCreateFromEmail) {
        void createAndAdd();
      }
    } else if (ev.key === 'Backspace' && query === '' && value.length > 0) {
      removeAt(value.length - 1);
    } else if (ev.key === 'Escape') {
      query = '';
      focused = false;
      inputEl?.blur();
    }
  }
</script>

<div
  class={cx(
    'flex min-h-[2.25rem] flex-wrap items-center gap-1 rounded-md border bg-surface px-1.5 py-1',
    focused ? 'border-accent ring-1 ring-accent' : 'border-border',
    disabled ? 'opacity-60 pointer-events-none' : '',
    klass,
  )}
>
  {#each value as personId, idx}
    {@const idKey = personId.toString()}
    {@const p = personById.get(idKey)}
    {@const local = p === undefined ? createdLocal.get(idKey) : undefined}
    {#if p !== undefined}
      <Chip
        label={isContact(p) ? `${titleOf(p)} · contact` : titleOf(p)}
        variant={isContact(p) ? 'default' : 'accent'}
        removable
        onRemove={() => removeAt(idx)}
      />
    {:else if local !== undefined}
      <Chip
        label={`${local.email} · contact`}
        variant="default"
        removable
        onRemove={() => removeAt(idx)}
      />
    {:else}
      <Chip label={`#${personId}`} removable onRemove={() => removeAt(idx)} />
    {/if}
  {/each}
  <input
    bind:this={inputEl}
    bind:value={query}
    onfocus={() => (focused = true)}
    onblur={() => setTimeout(() => (focused = false), 150)}
    onkeydown={onKeydown}
    {placeholder}
    {disabled}
    {id}
    role="combobox"
    aria-expanded={focused && optionCount > 0}
    aria-controls={listboxId}
    aria-autocomplete="list"
    class="min-w-[10ch] flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
    aria-label={ariaLabel ?? placeholder}
    autocomplete="off"
  />
</div>

{#if focused && optionCount > 0 && !disabled}
  <ul
    role="listbox"
    id={listboxId}
    class="mt-1 max-h-60 overflow-auto rounded-md border border-border bg-surface text-sm shadow-md"
  >
    {#each filtered as p, i}
      <li
        role="option"
        aria-selected={highlight === i}
        class={cx(
          'flex cursor-pointer items-center justify-between px-2 py-1.5',
          highlight === i ? 'bg-accent text-accent-fg' : 'hover:bg-surface-hover',
        )}
        onmousedown={(e) => {
          e.preventDefault();
          addPerson(p);
        }}
      >
        <span class="truncate">
          {titleOf(p)}
          {#if emailOf(p) !== '' && emailOf(p) !== titleOf(p)}
            <span class={cx('ml-1 text-xs', highlight === i ? 'opacity-80' : 'text-muted')}>
              {emailOf(p)}
            </span>
          {/if}
        </span>
        {#if isContact(p)}
          <span class={cx('text-xs', highlight === i ? 'opacity-80' : 'text-muted')}>
            contact
          </span>
        {/if}
      </li>
    {/each}
    {#if canCreateFromEmail}
      {@const createIdx = filtered.length}
      <li
        role="option"
        aria-selected={highlight === createIdx}
        class={cx(
          'flex cursor-pointer items-center gap-1 border-t border-border px-2 py-1.5',
          highlight === createIdx ? 'bg-accent text-accent-fg' : 'hover:bg-surface-hover',
        )}
        onmousedown={(e) => {
          e.preventDefault();
          void createAndAdd();
        }}
      >
        <span aria-hidden="true">+</span>
        <span class="truncate">Add <strong>{query.trim()}</strong> as new contact</span>
        {#if busy}
          <span class="ml-auto text-xs">…</span>
        {/if}
      </li>
    {/if}
  </ul>
{/if}

{#if errMsg !== ''}
  <p class="mt-1 text-xs text-danger" role="alert">{errMsg}</p>
{/if}
