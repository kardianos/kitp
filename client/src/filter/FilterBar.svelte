<script lang="ts">
  /**
   * Chip-row filter UI for a flat AND of leaves, plus an optional
   * Quick filters row above. Mirrors the Dart `FilterBar` widget but
   * renders real DOM (no canvas).
   *
   * The component owns three pieces of UI state:
   *   - The chip row of leaves derived from the bound `predicate`.
   *   - An inline editor popover for adding / editing a single leaf.
   *   - A Modal-hosted `<FilterTreeEditor>` for advanced edits (when
   *     the predicate is no longer flat-AND, this is the only way back).
   *
   * `predicate` is two-way bound; every mutation also fires `onchange`
   * so screens that prefer callbacks (e.g. URL persistence) don't have
   * to re-derive state from the bound value.
   */

  import { tick } from 'svelte';
  import {
    autoUpdate,
    computePosition,
    flip,
    offset,
  } from '@floating-ui/dom';
  import Button from '../ui/Button.svelte';
  import Chip from '../ui/Chip.svelte';
  import Combobox from '../ui/Combobox.svelte';
  import IconButton from '../ui/IconButton.svelte';
  import { cx } from '../util/class_names.js';
  import type { FilterAttribute } from './attribute_schema.svelte.js';
  import FilterPresets from './FilterPresets.svelte';
  import FilterTreeEditor from './FilterTreeEditor.svelte';
  import {
    flattenLeaves,
    isFlatAndOfLeaves,
    opArity,
    predicateFromLeaves,
    toText,
    type Op,
    type Predicate,
    type PredicateLeaf,
  } from './predicate.js';
  import { quickChipIsActive, replaceLeafForAttr, type QuickChip } from './quick_chips.js';
  import ValueInput from './ValueInput.svelte';

  interface Props {
    attributes: FilterAttribute[];
    predicate: Predicate | null;
    scope: string;
    onchange?: (p: Predicate | null) => void;
    quickChips?: QuickChip[];
  }

  let {
    attributes,
    predicate = $bindable(),
    scope,
    onchange,
    quickChips = [],
  }: Props = $props();

  /* ---- Derived ----------------------------------------------------------- */

  /** Whether the chip row can render — requires a flat AND. */
  const isFlat = $derived.by(() => {
    if (predicate === null) return true;
    return isFlatAndOfLeaves(predicate);
  });

  /** Flat list of leaves for the chip row. Empty when predicate is null. */
  const leaves = $derived.by((): PredicateLeaf[] => {
    if (predicate === null) return [];
    if (!isFlatAndOfLeaves(predicate)) return [];
    return flattenLeaves(predicate);
  });

  /* ---- Mutation helpers -------------------------------------------------- */

  function emit(next: Predicate | null) {
    predicate = next;
    onchange?.(next);
  }

  function setLeaves(next: PredicateLeaf[]) {
    if (next.length === 0) {
      emit(null);
      return;
    }
    emit(predicateFromLeaves(next));
  }

  function removeLeafAt(idx: number) {
    const cur = leaves.slice();
    cur.splice(idx, 1);
    setLeaves(cur);
  }

  function applyQuickChip(chip: QuickChip) {
    // Only replace existing leaf when the predicate is flat-AND. If the
    // user has built an advanced tree the chip-row is hidden anyway and
    // this code path is unreachable.
    if (!isFlat) return;
    emit(replaceLeafForAttr(predicate, chip.predicate));
  }

  /* ---- Inline editor popover -------------------------------------------- */

  type EditorState = {
    /** -1 means "appending a new leaf"; otherwise replaces leaves[idx]. */
    idx: number;
    attr: string;
    op: Op;
    values: unknown[];
  };

  let editor = $state<EditorState | null>(null);
  let editorAnchor: HTMLElement | null = null;
  let popupEl: HTMLDivElement | null = $state(null);
  let cleanupFloat: (() => void) | null = null;

  async function openEditorForLeaf(idx: number, anchor: HTMLElement) {
    const leaf = leaves[idx];
    if (leaf === undefined) return;
    editor = {
      idx,
      attr: leaf.attr,
      op: leaf.op,
      values: leaf.values ? leaf.values.slice() : [],
    };
    editorAnchor = anchor;
    await tick();
    setupFloating();
  }

  async function openEditorForAdd(anchor: HTMLElement) {
    const first = attributes[0];
    if (first === undefined) return;
    editor = {
      idx: -1,
      attr: first.name,
      op: first.ops[0] ?? 'eq',
      values: [],
    };
    editorAnchor = anchor;
    await tick();
    setupFloating();
  }

  function closeEditor() {
    editor = null;
    editorAnchor = null;
    cleanupFloat?.();
    cleanupFloat = null;
  }

  function setupFloating() {
    const a = editorAnchor;
    if (!a || !popupEl) return;
    cleanupFloat?.();
    cleanupFloat = autoUpdate(a, popupEl, () => {
      if (!a || !popupEl) return;
      void computePosition(a, popupEl, {
        placement: 'bottom-start',
        middleware: [offset(4), flip()],
      }).then(({ x, y }) => {
        if (!popupEl) return;
        Object.assign(popupEl.style, { left: `${x}px`, top: `${y}px` });
      });
    });
  }

  function commitEditor() {
    if (editor === null) return;
    const leaf: PredicateLeaf = {
      kind: 'leaf',
      attr: editor.attr,
      op: editor.op,
    };
    if (opArity(editor.op) !== 'none' && editor.values.length > 0) {
      leaf.values = editor.values.slice();
    }
    const cur = leaves.slice();
    if (editor.idx === -1) {
      cur.push(leaf);
    } else {
      cur[editor.idx] = leaf;
    }
    setLeaves(cur);
    closeEditor();
  }

  function onEditorAttrChange(name: string) {
    if (editor === null) return;
    const attr = attributes.find((a) => a.name === name);
    editor.attr = name;
    editor.op = attr?.ops[0] ?? 'eq';
    editor.values = [];
  }

  function onEditorOpChange(op: Op) {
    if (editor === null) return;
    const prevArity = opArity(editor.op);
    editor.op = op;
    const newArity = opArity(op);
    if (newArity === 'none') {
      editor.values = [];
    } else if (newArity === 'multi' && prevArity !== 'multi') {
      const v = editor.values[0];
      editor.values = v === undefined ? [] : [v];
    } else if (newArity === 'single' && prevArity === 'multi') {
      const v = editor.values[0];
      editor.values = v === undefined ? [] : [v];
    }
  }

  function onEditorValueChange(v: unknown) {
    if (editor === null) return;
    const arity = opArity(editor.op);
    if (arity === 'multi') {
      editor.values = Array.isArray(v) ? v.slice() : [];
    } else if (v === null || v === undefined) {
      editor.values = [];
    } else {
      editor.values = [v];
    }
  }

  function onEditorKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      // Don't fire when the focus is inside an input that wants Enter
      // for its own purposes (combobox search). We special-case <input>
      // type="text" / number / date as "fine to commit on Enter".
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName.toLowerCase();
      if (tag === 'input' || tag === 'button') {
        e.preventDefault();
        commitEditor();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeEditor();
    }
  }

  function onDocPointerDown(e: PointerEvent) {
    if (editor === null) return;
    const t = e.target as Node | null;
    if (!t) return;
    if (popupEl?.contains(t)) return;
    if (editorAnchor?.contains(t)) return;
    closeEditor();
  }

  $effect(() => {
    if (editor !== null) {
      document.addEventListener('pointerdown', onDocPointerDown, true);
      return () => {
        document.removeEventListener('pointerdown', onDocPointerDown, true);
      };
    }
    return undefined;
  });

  $effect(() => {
    return () => {
      cleanupFloat?.();
    };
  });

  /* ---- Advanced editor (Modal) ------------------------------------------ */

  let advancedOpen = $state(false);

  function openAdvanced() {
    advancedOpen = true;
  }

  function onAdvancedSave(next: Predicate | null) {
    emit(next);
  }

  /* ---- Render helpers --------------------------------------------------- */

  /** Look up an attribute by name (returns undefined if unloaded). */
  function attrFor(name: string): FilterAttribute | undefined {
    return attributes.find((a) => a.name === name);
  }

  /**
   * Per-leaf chip text. Uses `toText` on a synthetic leaf so the wire
   * op string is consistent across the bar and the read-only preview.
   */
  function chipText(leaf: PredicateLeaf): string {
    const a = attrFor(leaf.attr);
    if (a === undefined) return toText(leaf);
    // Replace the attribute name with its label for nicer chips.
    const txt = toText(leaf);
    if (txt.startsWith(`${leaf.attr} `)) {
      return `${a.label}${txt.slice(leaf.attr.length)}`;
    }
    return txt;
  }
</script>

<div class="flex w-full flex-col gap-2">
  {#if quickChips.length > 0}
    <div class="flex items-center gap-2 overflow-x-auto" aria-label="Quick filters">
      <span class="shrink-0 text-xs uppercase tracking-wide text-muted">
        Quick filters
      </span>
      {#each quickChips as chip (chip.id)}
        {@const active = quickChipIsActive(predicate, chip)}
        <button
          type="button"
          class={cx(
            'inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-xs font-medium',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            active
              ? 'border-transparent bg-accent text-accent-fg'
              : 'border-border bg-surface text-fg hover:bg-border/40',
          )}
          onclick={() => applyQuickChip(chip)}
        >
          {chip.label}
        </button>
      {/each}
    </div>
  {/if}

  <div class="flex flex-wrap items-center gap-2">
    {#if isFlat}
      {#each leaves as leaf, i (i + ':' + leaf.attr + ':' + leaf.op)}
        <span class="inline-flex">
          <button
            type="button"
            class="inline-flex items-center"
            onclick={(e) => openEditorForLeaf(i, e.currentTarget as HTMLElement)}
            aria-label="Edit filter {chipText(leaf)}"
          >
            <Chip
              label={chipText(leaf)}
              size="md"
              variant="default"
              removable
              onRemove={() => removeLeafAt(i)}
            />
          </button>
        </span>
      {/each}

      <Button
        size="sm"
        variant="secondary"
        onclick={(e) => openEditorForAdd(e.currentTarget as HTMLElement)}
      >
        + Add filter
      </Button>
    {:else}
      <span class="text-sm text-muted">
        Advanced filter: {predicate ? toText(predicate) : ''}
      </span>
    {/if}

    <Button
      size="sm"
      variant="ghost"
      disabled={!isFlat && predicate !== null ? false : false}
      title={isFlat
        ? 'Open advanced filter editor'
        : 'Predicate has nested groups; use the advanced editor to edit it.'}
      onclick={openAdvanced}
    >
      Advanced
    </Button>

    <FilterPresets
      {scope}
      {predicate}
      onLoad={(p) => emit(p)}
    />

    {#if predicate !== null}
      <Button size="sm" variant="ghost" onclick={() => emit(null)}>
        Clear
      </Button>
    {/if}
  </div>
</div>

{#if editor !== null}
  {@const editorAttr = attrFor(editor.attr)}
  {@const editorArity = opArity(editor.op)}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    bind:this={popupEl}
    class="z-50 flex w-80 flex-col gap-2 rounded-md border border-border bg-bg p-3 shadow-lg"
    role="dialog"
    aria-label="Edit filter"
    tabindex="-1"
    style="position: fixed; left: 0; top: 0;"
    onkeydown={onEditorKeydown}
  >
    <label class="flex flex-col gap-1 text-xs text-muted">
      Attribute
      <Combobox
        aria-label="Attribute"
        options={attributes.map((a) => ({ value: a.name, label: a.label }))}
        value={editor.attr}
        onchange={(v) => {
          if (typeof v === 'string') onEditorAttrChange(v);
        }}
      />
    </label>

    <label class="flex flex-col gap-1 text-xs text-muted">
      Operator
      <Combobox
        aria-label="Operator"
        options={(editorAttr?.ops ?? (['eq', 'ne'] as Op[])).map((o) => ({
          value: o,
          label: o,
        }))}
        value={editor.op}
        searchable={false}
        onchange={(v) => {
          if (typeof v === 'string') onEditorOpChange(v as Op);
        }}
      />
    </label>

    {#if editorAttr && editorArity !== 'none'}
      <label class="flex flex-col gap-1 text-xs text-muted">
        Value
        <ValueInput
          attribute={editorAttr}
          value={editorArity === 'multi' ? editor.values : editor.values[0]}
          multiple={editorArity === 'multi'}
          onchange={onEditorValueChange}
        />
      </label>
    {/if}

    <div class="mt-1 flex justify-end gap-2">
      <Button size="sm" variant="ghost" onclick={closeEditor}>Cancel</Button>
      <Button size="sm" variant="primary" onclick={commitEditor}>
        {editor.idx === -1 ? 'Add' : 'Save'}
      </Button>
    </div>
  </div>
{/if}

<FilterTreeEditor
  {attributes}
  {predicate}
  bind:open={advancedOpen}
  onSave={onAdvancedSave}
/>
