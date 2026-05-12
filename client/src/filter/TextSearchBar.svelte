<script lang="ts">
  /**
   * Quick text search bar.
   *
   * Owns a single "contains" search across one or more scopes
   * (title / description / comments). The state round-trips through
   * the predicate AST as `contains` leaves so the same search can be
   * inspected / edited in Add filter / Advanced, and so multi-tab
   * mirroring (and saved Views) work without a parallel storage path.
   *
   * Wire shape:
   *   - one scope  → a single `<attr> contains <text>` leaf merged
   *                  into the user's existing flat-AND predicate.
   *   - N scopes   → an OR group of N contains-leaves; the rest of
   *                  the predicate ANDs with that group. This makes
   *                  the chip-row fall back to "Advanced filter:"
   *                  rendering — acceptable for the multi-scope case.
   */
  import { tick } from 'svelte';
  import {
    autoUpdate,
    computePosition,
    flip,
    offset,
  } from '@floating-ui/dom';
  import { cx } from '../util/class_names';
  import {
    type Predicate,
    type PredicateLeaf,
  } from './predicate';

  interface Props {
    predicate: Predicate | null;
    onchange: (next: Predicate | null) => void;
  }

  let { predicate, onchange }: Props = $props();

  /* ---------------------------------------------------- scope catalogue */

  const SCOPES: { value: string; label: string }[] = [
    { value: 'title', label: 'Title' },
    { value: 'description', label: 'Description' },
    { value: 'comments', label: 'Comments' },
  ];
  const SCOPE_NAMES = new Set(SCOPES.map((s) => s.value));

  /* ----------------------------------------- read search from predicate */

  function walkLeaves(p: Predicate | null, out: PredicateLeaf[]): void {
    if (p === null) return;
    if (p.kind === 'leaf') {
      out.push(p);
      return;
    }
    for (const c of p.children) walkLeaves(c, out);
  }

  /**
   * Extract the search-state (text + scopes) from the predicate. If
   * there are 0 search leaves we return blank. If there are N leaves
   * but their values disagree, we also return blank — the user has
   * mixed `contains` chips in via Add filter, so the search bar can't
   * faithfully represent them and should yield to the chip row.
   */
  const derivedState = $derived.by((): { text: string; scopes: string[] } => {
    const leaves: PredicateLeaf[] = [];
    walkLeaves(predicate, leaves);
    const matches = leaves.filter(
      (l) => l.op === 'contains' && SCOPE_NAMES.has(l.attr),
    );
    if (matches.length === 0) return { text: '', scopes: ['title'] };
    const text = matches[0]!.values?.[0];
    if (typeof text !== 'string') return { text: '', scopes: ['title'] };
    for (const m of matches) {
      const v = m.values?.[0];
      if (typeof v !== 'string' || v !== text) {
        return { text: '', scopes: ['title'] };
      }
    }
    const scopes = matches.map((m) => m.attr);
    return { text, scopes };
  });

  /* ---------------------------------------- local input state mirroring */

  let inputText = $state<string>('');
  let selectedScopes = $state<string[]>(['title']);
  /** Most-recently-committed predicate state (so the sync effect can */
  /** ignore round-trips driven by our own emit). */
  let lastEmittedText = $state<string>('');
  let lastEmittedScopes = $state<string[]>(['title']);

  /** Sync local state from the predicate when it changes externally. */
  $effect(() => {
    const ds = derivedState;
    // Skip if the predicate change came from our own emit.
    if (
      ds.text === lastEmittedText &&
      sameScopes(ds.scopes, lastEmittedScopes)
    ) {
      return;
    }
    inputText = ds.text;
    selectedScopes = ds.scopes.length > 0 ? ds.scopes.slice() : ['title'];
  });

  function sameScopes(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const sa = [...a].sort();
    const sb = [...b].sort();
    for (let i = 0; i < sa.length; i++) {
      if (sa[i] !== sb[i]) return false;
    }
    return true;
  }

  /* ----------------------------------------------------- predicate emit */

  /**
   * Strip every `contains` leaf for scope attrs out of `p`. Preserves
   * everything else (other-leaf chips, nested groups). Returns null
   * when stripping empties the predicate.
   */
  function stripSearchLeaves(p: Predicate | null): Predicate | null {
    if (p === null) return null;
    if (p.kind === 'leaf') {
      if (p.op === 'contains' && SCOPE_NAMES.has(p.attr)) return null;
      return p;
    }
    const kept: Predicate[] = [];
    for (const c of p.children) {
      const stripped = stripSearchLeaves(c);
      if (stripped !== null) kept.push(stripped);
    }
    if (kept.length === 0) return null;
    if (kept.length === 1 && p.connective !== 'not') return kept[0] as Predicate;
    return { kind: 'group', connective: p.connective, children: kept };
  }

  function buildSearchPredicate(
    text: string,
    scopes: string[],
  ): Predicate | null {
    if (text.length === 0 || scopes.length === 0) return null;
    const leaves: PredicateLeaf[] = scopes.map((s) => ({
      kind: 'leaf',
      attr: s,
      op: 'contains',
      values: [text],
    }));
    if (leaves.length === 1) return leaves[0] as PredicateLeaf;
    return { kind: 'group', connective: 'or', children: leaves };
  }

  function andOf(a: Predicate | null, b: Predicate | null): Predicate | null {
    if (a === null) return b;
    if (b === null) return a;
    if (a.kind === 'group' && a.connective === 'and') {
      return {
        kind: 'group',
        connective: 'and',
        children: [...a.children, b],
      };
    }
    return { kind: 'group', connective: 'and', children: [a, b] };
  }

  function emit(text: string, scopes: string[]): void {
    const stripped = stripSearchLeaves(predicate);
    const searchPart = buildSearchPredicate(text, scopes);
    const next = andOf(stripped, searchPart);
    lastEmittedText = text;
    lastEmittedScopes = scopes.slice();
    onchange(next);
  }

  /* --------------------------------------------- debounce text changes */

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const DEBOUNCE_MS = 220;

  function onInput(e: Event): void {
    const v = (e.target as HTMLInputElement).value;
    inputText = v;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      emit(inputText, selectedScopes);
    }, DEBOUNCE_MS);
  }

  function flushNow(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    emit(inputText, selectedScopes);
  }

  function clearSearch(): void {
    inputText = '';
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    emit('', selectedScopes);
  }

  function toggleScope(name: string): void {
    const next = selectedScopes.includes(name)
      ? selectedScopes.filter((s) => s !== name)
      : [...selectedScopes, name];
    if (next.length === 0) {
      // Always keep at least one scope; default back to title so the
      // input stays meaningful.
      selectedScopes = ['title'];
    } else {
      selectedScopes = next;
    }
    if (inputText.length > 0) emit(inputText, selectedScopes);
  }

  /* ------------------------------------------------ scope popover plumbing */

  let scopeOpen = $state(false);
  let scopeTrigger: HTMLButtonElement | null = $state(null);
  let scopePopup: HTMLDivElement | null = $state(null);
  let scopeCleanup: (() => void) | null = null;

  async function openScope(): Promise<void> {
    scopeOpen = true;
    await tick();
    if (!scopeTrigger || !scopePopup) return;
    scopeCleanup?.();
    scopeCleanup = autoUpdate(scopeTrigger, scopePopup, () => {
      if (!scopeTrigger || !scopePopup) return;
      void computePosition(scopeTrigger, scopePopup, {
        placement: 'bottom-end',
        middleware: [offset(4), flip()],
      }).then(({ x, y }) => {
        if (!scopePopup) return;
        Object.assign(scopePopup.style, {
          left: `${x}px`,
          top: `${y}px`,
          opacity: '1',
          pointerEvents: 'auto',
        });
      });
    });
  }

  function closeScope(): void {
    scopeOpen = false;
    scopeCleanup?.();
    scopeCleanup = null;
  }

  function onScopeDocPointerDown(e: PointerEvent): void {
    if (!scopeOpen) return;
    const t = e.target as Node | null;
    if (!t) return;
    if (scopePopup?.contains(t)) return;
    if (scopeTrigger?.contains(t)) return;
    closeScope();
  }

  $effect(() => {
    if (scopeOpen) {
      document.addEventListener('pointerdown', onScopeDocPointerDown, true);
      return () => {
        document.removeEventListener(
          'pointerdown',
          onScopeDocPointerDown,
          true,
        );
      };
    }
    return undefined;
  });

  $effect(() => {
    return () => {
      scopeCleanup?.();
      if (debounceTimer !== null) clearTimeout(debounceTimer);
    };
  });

  const scopeButtonLabel = $derived.by((): string => {
    if (selectedScopes.length === SCOPES.length) return 'All';
    if (selectedScopes.length === 1) {
      const s = SCOPES.find((x) => x.value === selectedScopes[0]);
      return s?.label ?? 'Title';
    }
    return `${selectedScopes.length} scopes`;
  });
</script>

<div class="flex w-full items-center gap-2">
  <div class="relative flex h-8 flex-1 items-center rounded-md border border-border bg-bg focus-within:ring-2 focus-within:ring-accent">
    <svg viewBox="0 0 16 16" class="ml-2 h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.5" fill="none" />
      <path
        d="M10.5 10.5 L13 13"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
      />
    </svg>
    <input
      type="search"
      value={inputText}
      oninput={onInput}
      onkeydown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          flushNow();
        }
      }}
      placeholder="Search tasks…"
      aria-label="Search tasks"
      data-testid="text-search-input"
      class="h-full flex-1 bg-transparent px-2 text-sm text-fg placeholder:text-muted focus:outline-none"
    />
    {#if inputText.length > 0}
      <button
        type="button"
        class="mr-1 rounded p-1 text-muted hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        aria-label="Clear search"
        onclick={clearSearch}
      >
        <svg viewBox="0 0 12 12" class="h-3 w-3" aria-hidden="true">
          <path
            d="M2 2 L10 10 M10 2 L2 10"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
      </button>
    {/if}
  </div>

  <div class="relative inline-block">
    <button
      bind:this={scopeTrigger}
      type="button"
      class={cx(
        'inline-flex h-8 items-center gap-1 rounded-md border border-border bg-bg px-2 text-xs text-fg',
        'hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
      )}
      aria-haspopup="menu"
      aria-expanded={scopeOpen}
      aria-label="Search scope"
      title="Search scope"
      data-testid="text-search-scope"
      onclick={() => (scopeOpen ? closeScope() : void openScope())}
    >
      <span class="text-muted">in:</span>
      <span class="font-medium">{scopeButtonLabel}</span>
      <svg viewBox="0 0 12 12" class="h-3 w-3 text-muted" aria-hidden="true">
        <path
          d="M2 4 L6 8 L10 4"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          fill="none"
        />
      </svg>
    </button>

    {#if scopeOpen}
      <div
        bind:this={scopePopup}
        role="menu"
        class="z-50 flex w-48 flex-col gap-1 rounded-md border border-border bg-bg p-2 text-sm shadow-lg"
        style="position: fixed; left: 0; top: 0; opacity: 0; pointer-events: none;"
      >
        <div class="px-1 pb-1 text-xs uppercase tracking-wide text-muted">
          Search in
        </div>
        {#each SCOPES as s (s.value)}
          {@const checked = selectedScopes.includes(s.value)}
          <label class="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-surface">
            <input
              type="checkbox"
              class="h-3.5 w-3.5 accent-current text-accent"
              checked={checked}
              onchange={() => toggleScope(s.value)}
            />
            <span>{s.label}</span>
          </label>
        {/each}
      </div>
    {/if}
  </div>
</div>
