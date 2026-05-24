<script lang="ts">
  /**
   * Advanced predicate editor — recursive tree of group / leaf nodes,
   * shown inside the existing `<Modal>` primitive.
   *
   * Layout per node:
   *   - Group: a card with a connective `<Combobox>` (and / or / not),
   *            "+ Add leaf", "+ Add group" and "Remove" buttons, and a
   *            recursive list of children.
   *   - Leaf:  an attribute `<Combobox>`, op `<Combobox>`, `<ValueInput>`
   *            and a remove button.
   *
   * The editor maintains its own mutable copy of the predicate so the
   * caller's predicate isn't mutated until "Save" is pressed. On save we
   * `onSave(toPredicate(root))` and close the modal.
   *
   * The tree carries internal `id` markers so {#each} keys are stable
   * across reorders / deletions (Svelte 5 cannot key by reference for
   * primitive children).
   */

  import Button from '../ui/Button.svelte';
  import Combobox from '../ui/Combobox.svelte';
  import IconButton from '../ui/IconButton.svelte';
  import Modal from '../ui/Modal.svelte';
  import type { FilterAttribute } from './attribute_schema.svelte.js';
  import {
    isPhase,
    OP_TO_WIRE,
    opArity,
    PHASES,
    SNIPPET_ATTR,
    type Op,
    type Phase,
    type Predicate,
    type PredicateGroup,
    type PredicateLeaf,
  } from './predicate.js';
  import { readSnippetTitle } from './snippet_store.svelte.js';
  import type { CardWithAttrs, ID } from '../reg/types.js';
  import ValueInput from './ValueInput.svelte';

  interface Props {
    attributes: FilterAttribute[];
    /**
     * Project-scoped predicate snippets. When non-empty, the
     * attribute picker grows a "Named filter" pseudo-entry that lets
     * the user drop a snippet reference into the tree (wrap in NOT,
     * compose with OR, etc.).
     */
    snippets?: CardWithAttrs[];
    predicate: Predicate | null;
    open: boolean;
    onSave: (p: Predicate | null) => void;
    onCancel?: () => void;
  }

  let {
    attributes,
    snippets = [],
    predicate,
    open = $bindable(),
    onSave,
    onCancel,
  }: Props = $props();

  /** Options for the snippet value picker. Empty until [snippets] is
   *  non-empty — the editor hides the "Named filter" attribute entry
   *  in that case so the picker never opens empty. */
  const snippetOptions = $derived(
    snippets.map((s) => ({ value: s.id, label: readSnippetTitle(s) })),
  );

  /** Attribute combobox entries with the "Named filter" pseudo-entry
   *  prepended when there are snippets to pick. */
  const attributeOptions = $derived(
    snippetOptions.length > 0
      ? [
          { value: SNIPPET_ATTR, label: 'Named filter' },
          ...attributes.map((a) => ({ value: a.name, label: a.label })),
        ]
      : attributes.map((a) => ({ value: a.name, label: a.label })),
  );

  /* ---- Editable mirror of the predicate ----------------------------------- */

  type EditNodeLeaf = {
    id: string;
    kind: 'leaf';
    attr: string;
    op: Op;
    values: unknown[];
  };
  type EditNodeGroup = {
    id: string;
    kind: 'group';
    connective: 'and' | 'or' | 'not';
    children: EditNode[];
  };
  type EditNode = EditNodeLeaf | EditNodeGroup;

  let nextId = 1;
  function newId(): string {
    return `n${nextId++}`;
  }

  function fromPredicate(p: Predicate | null): EditNode {
    if (p === null) {
      return {
        id: newId(),
        kind: 'group',
        connective: 'and',
        children: [],
      };
    }
    if (p.kind === 'leaf') {
      return {
        id: newId(),
        kind: 'leaf',
        attr: p.attr,
        op: p.op,
        values: p.values ? p.values.slice() : [],
      };
    }
    return {
      id: newId(),
      kind: 'group',
      connective: p.connective,
      children: p.children.map(fromPredicate),
    };
  }

  /**
   * Convert an editable node back to a real {@link Predicate}. NOT
   * groups must end up with exactly one child; we surface this to the
   * caller as a thrown error so the save button can disable rather than
   * silently emit an invalid tree.
   */
  function toPredicate(n: EditNode): Predicate {
    if (n.kind === 'leaf') {
      const leaf: PredicateLeaf = { kind: 'leaf', attr: n.attr, op: n.op };
      if (opArity(n.op) !== 'none' && n.values.length > 0) {
        leaf.values = n.values.slice();
      }
      return leaf;
    }
    if (n.connective === 'not' && n.children.length !== 1) {
      throw new Error('NOT group must have exactly one child');
    }
    const group: PredicateGroup = {
      kind: 'group',
      connective: n.connective,
      children: n.children.map(toPredicate),
    };
    return group;
  }

  /** Root edit tree — re-seeded whenever the modal opens. */
  let root = $state<EditNodeGroup>({
    id: newId(),
    kind: 'group',
    connective: 'and',
    children: [],
  });

  // Re-seed the editable tree whenever the modal opens. (Editing while
  // closed has no observable effect; reseeding only when `open` flips
  // avoids stomping mid-edit state if the parent mutates `predicate`.)
  let lastOpen = false;
  $effect(() => {
    if (open && !lastOpen) {
      const seed = fromPredicate(predicate);
      // Always normalise the root to a group so the UI has a connective
      // selector at top-level.
      if (seed.kind === 'leaf') {
        root = {
          id: newId(),
          kind: 'group',
          connective: 'and',
          children: [seed],
        };
      } else {
        root = seed;
      }
    }
    lastOpen = open;
  });

  /* ---- Mutators ----------------------------------------------------------- */

  function defaultLeaf(): EditNodeLeaf {
    const first = attributes[0];
    if (first === undefined) {
      // No attributes available — fall back to a placeholder leaf the
      // user can rename once attributes load.
      return { id: newId(), kind: 'leaf', attr: '', op: 'eq', values: [] };
    }
    const op: Op = first.ops[0] ?? 'eq';
    return {
      id: newId(),
      kind: 'leaf',
      attr: first.name,
      op,
      values: [],
    };
  }

  function addLeaf(group: EditNodeGroup) {
    group.children = [...group.children, defaultLeaf()];
  }

  function addGroup(group: EditNodeGroup) {
    group.children = [
      ...group.children,
      {
        id: newId(),
        kind: 'group',
        connective: 'and',
        children: [],
      },
    ];
  }

  function removeChild(group: EditNodeGroup, id: string) {
    group.children = group.children.filter((c) => c.id !== id);
  }

  function setLeafAttr(leaf: EditNodeLeaf, attrName: string) {
    leaf.attr = attrName;
    // The `_snippet` sentinel attribute pins the op to `snippet`:
    // there's no other meaningful operator on a snippet ref, and the
    // value picker swaps to the snippet Combobox.
    if (attrName === SNIPPET_ATTR) {
      leaf.op = 'snippet';
      leaf.values = [];
      return;
    }
    // Reset op + values: the new attribute may not support the previous op,
    // and stale values from another attribute are confusing.
    const attr = attributes.find((a) => a.name === attrName);
    leaf.op = attr?.ops[0] ?? 'eq';
    leaf.values = [];
  }

  function setLeafOp(leaf: EditNodeLeaf, op: Op) {
    const prevArity = opArity(leaf.op);
    const prevOp = leaf.op;
    leaf.op = op;
    const newArity = opArity(op);
    // `hasPhase` / `parentStatusPhase` carry phase strings, not
    // ref-target values, so values from any other op are meaningless.
    // Same when leaving one of those ops for a normal value-picker
    // op. Clear in both directions.
    const isPhaseOp = (o: Op): boolean =>
      o === 'hasPhase' || o === 'parentStatusPhase';
    if (isPhaseOp(op) || isPhaseOp(prevOp)) {
      leaf.values = [];
      return;
    }
    // Adapt the value shape.
    if (newArity === 'none') {
      leaf.values = [];
    } else if (newArity === 'multi' && prevArity !== 'multi') {
      // Promote a single value (if any) into an array.
      const v = leaf.values[0];
      leaf.values = v === undefined ? [] : [v];
    } else if (newArity === 'single' && prevArity === 'multi') {
      const v = leaf.values[0];
      leaf.values = v === undefined ? [] : [v];
    }
  }

  /**
   * Friendly display label for an op in the operator combobox. Every
   * op gets a natural-English phrasing so a built leaf reads as a
   * complete sentence — `status is open`, `milestone is any of (M1,
   * M2)`, `parent_task parent's status is Terminal`. The wire string
   * (`=`, `not in`, `has_phase`, …) is what crosses the network; this
   * is purely the editor's display label.
   */
  const OP_LABELS: Readonly<Record<Op, string>> = {
    eq: 'is',
    ne: 'is not',
    in: 'is any of',
    notIn: 'is none of',
    exists: 'is set',
    notExists: 'is not set',
    contains: 'contains',
    notTerminal: 'is open',
    hasPhase: 'has phase',
    parentStatusPhase: "parent's status is",
    // `snippet` leaves render their own picker (the named-snippet
    // combobox) instead of using the attribute+op pattern, but the
    // op label still surfaces in the operator combobox if a user
    // converts a snippet leaf back into a regular leaf.
    snippet: 'named filter',
    // Relative-date ops on text attributes that store ISO 8601
    // dates. The server resolves "today" at query time.
    beforeToday: 'is before today',
    withinDays: 'within next (days)',
  };
  function opLabel(op: Op): string {
    return OP_LABELS[op];
  }

  /**
   * Capitalise a phase value for the right-side picker labels — `triage`
   * → `Triage`, etc. Kept local so the type narrow lives next to its
   * sole consumer.
   */
  function phaseLabel(p: Phase): string {
    return p.charAt(0).toUpperCase() + p.slice(1);
  }

  /** Toggle membership of `phase` in `leaf.values`. */
  function togglePhase(leaf: EditNodeLeaf, phase: Phase): void {
    const cur = leaf.values.filter(isPhase);
    if (cur.includes(phase)) {
      leaf.values = cur.filter((p) => p !== phase);
    } else {
      leaf.values = [...cur, phase];
    }
  }

  /**
   * Find the parent of [id] starting from `root` and remove it. Used by
   * the group "Remove" button (top-level groups never expose this — the
   * `isRoot` flag in `renderGroup` gates the button).
   */
  function removeFromParent(id: string) {
    function visit(node: EditNodeGroup): boolean {
      const idx = node.children.findIndex((c) => c.id === id);
      if (idx >= 0) {
        node.children = [
          ...node.children.slice(0, idx),
          ...node.children.slice(idx + 1),
        ];
        return true;
      }
      for (const c of node.children) {
        if (c.kind === 'group' && visit(c)) return true;
      }
      return false;
    }
    visit(root);
  }

  /* ---- Connective options ------------------------------------------------- */

  const connectiveOptions = [
    { value: 'and' as const, label: 'AND' },
    { value: 'or' as const, label: 'OR' },
    { value: 'not' as const, label: 'NOT' },
  ];

  /* ---- Save guard --------------------------------------------------------- */

  /**
   * `true` when the editable tree converts cleanly. Disables the Save
   * button when invariants (NOT must have one child) are violated so we
   * never emit a broken predicate.
   */
  const canSave = $derived.by(() => {
    try {
      toPredicate(root);
      return true;
    } catch {
      return false;
    }
  });

  function handleSave() {
    let out: Predicate | null;
    try {
      out = toPredicate(root);
    } catch {
      return; // Save button should already be disabled.
    }
    // An empty top-level AND is "no filter" — emit null so callers can
    // drop the `tree` field.
    if (
      out.kind === 'group' &&
      out.connective === 'and' &&
      out.children.length === 0
    ) {
      out = null;
    }
    onSave(out);
    open = false;
  }

  function handleCancel() {
    onCancel?.();
    open = false;
  }
</script>

<Modal bind:open title="Advanced filter" size="lg" onClose={handleCancel}>
  <div class="space-y-3">
    {@render renderGroup(root, true)}
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={handleCancel}>Cancel</Button>
    <Button variant="primary" disabled={!canSave} onclick={handleSave}>Save</Button>
  {/snippet}
</Modal>

<!-- Recursive renderers -->
{#snippet renderGroup(group: EditNodeGroup, isRoot: boolean)}
  <div class="rounded-md border border-border bg-surface/40 p-3">
    <div class="mb-2 flex items-center gap-2">
      <div class="w-24">
        <Combobox
          aria-label="Connective"
          options={connectiveOptions}
          value={group.connective}
          searchable={false}
          onchange={(v) => {
            if (v === 'and' || v === 'or' || v === 'not') {
              group.connective = v;
            }
          }}
        />
      </div>
      <Button size="sm" variant="secondary" onclick={() => addLeaf(group)}>
        + Add leaf
      </Button>
      <Button size="sm" variant="secondary" onclick={() => addGroup(group)}>
        + Add group
      </Button>
      {#if !isRoot}
        <span class="ml-auto">
          <IconButton
            aria-label="Remove group"
            variant="ghost"
            size="sm"
            onclick={() => removeFromParent(group.id)}
          >
            ×
          </IconButton>
        </span>
      {/if}
    </div>

    {#if group.children.length === 0}
      <p class="px-1 text-xs text-muted">
        Empty group. Add a leaf or nested group above.
      </p>
    {:else}
      <ul class="space-y-2 pl-2">
        {#each group.children as child (child.id)}
          <li>
            {#if child.kind === 'leaf'}
              {@render renderLeaf(child, group)}
            {:else}
              {@render renderGroup(child, false)}
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/snippet}

{#snippet renderLeaf(leaf: EditNodeLeaf, parent: EditNodeGroup)}
  {@const attr = attributes.find((a) => a.name === leaf.attr)}
  {@const arity = opArity(leaf.op)}
  <div class="flex flex-wrap items-center gap-2 rounded-md border border-border bg-bg p-2">
    <div class="min-w-[10rem]">
      <Combobox
        aria-label="Attribute"
        options={attributeOptions}
        value={leaf.attr}
        onchange={(v) => {
          if (typeof v === 'string') setLeafAttr(leaf, v);
        }}
      />
    </div>
    <div class="min-w-[7rem]">
      <Combobox
        aria-label="Operator"
        options={
          leaf.attr === SNIPPET_ATTR
            ? [{ value: 'snippet' as Op, label: opLabel('snippet') }]
            : (attr?.ops ?? (['eq', 'ne'] as Op[])).map((o) => ({
                value: o,
                label: opLabel(o),
              }))
        }
        value={leaf.op}
        searchable={false}
        onchange={(v) => {
          if (typeof v === 'string') setLeafOp(leaf, v as Op);
        }}
      />
    </div>
    <div class="min-w-[10rem] flex-1">
      {#if leaf.op === 'snippet'}
        <!-- Snippet picker: single-select Combobox listing project
             snippet cards. The leaf's value is the snippet card id. -->
        <Combobox
          aria-label="Named filter"
          options={snippetOptions}
          value={(leaf.values[0] as ID | undefined) ?? null}
          searchable={snippetOptions.length > 8}
          placeholder="Pick a named filter"
          onchange={(v) => {
            if (v === null || v === undefined) leaf.values = [];
            else if (typeof v === 'bigint') leaf.values = [v];
          }}
        />
      {:else if leaf.op === 'hasPhase' || leaf.op === 'parentStatusPhase'}
        <!-- Phase picker: closed three-checkbox set. `hasPhase` gates
             on the *ref target's* phase (e.g. status="Done" → terminal);
             `parentStatusPhase` (only valid on `parent_task`) gates on
             the parent task's STATUS card's phase — a 2-hop traversal
             compiled by the server. Both ops share the same value
             shape, so the picker is identical. -->
        <div class="flex flex-wrap items-center gap-3 px-1 py-0.5 text-sm">
          {#each PHASES as phase (phase)}
            {@const checked = leaf.values.filter(isPhase).includes(phase)}
            <label class="inline-flex items-center gap-1 text-fg">
              <input
                type="checkbox"
                aria-label={phaseLabel(phase)}
                {checked}
                onchange={() => togglePhase(leaf, phase)}
              />
              <span>{phaseLabel(phase)}</span>
            </label>
          {/each}
        </div>
      {:else if attr && arity !== 'none'}
        <ValueInput
          attribute={attr}
          op={leaf.op}
          value={arity === 'multi' ? leaf.values : leaf.values[0]}
          multiple={arity === 'multi'}
          onchange={(v) => {
            if (arity === 'multi') {
              leaf.values = Array.isArray(v) ? v.slice() : [];
            } else if (v === null || v === undefined) {
              leaf.values = [];
            } else {
              leaf.values = [v];
            }
          }}
        />
      {:else if arity === 'none'}
        <span class="text-xs text-muted">no value</span>
      {:else}
        <span class="text-xs text-muted">attribute not loaded</span>
      {/if}
    </div>
    <IconButton
      aria-label="Remove leaf"
      variant="ghost"
      size="sm"
      onclick={() => removeChild(parent, leaf.id)}
    >
      ×
    </IconButton>
  </div>
{/snippet}
