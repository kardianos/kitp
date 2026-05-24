<script lang="ts">
  /**
   * Visual builder for the `activity_filter` JSON predicate stored on
   * each activity_sink card. Companion to
   * `client/src/filter/FilterTreeEditor.svelte` — same recursive shape
   * (group / leaf), different DSL.
   *
   * Activity-sink filters work on single activity rows. The leaf
   * operators (kind_in / attr_in / actor_in and their inverses) carry
   * a list of values; the value picker swaps to match: closed kind set,
   * attribute_def name combobox, or user combobox.
   *
   * The editor maintains an isolated edit tree until "Save" is pressed
   * so the caller's `predicate` is not mutated during edits. Saving an
   * empty top-level AND emits `null` so the caller can clear the
   * `activity_filter` attribute outright.
   */

  import Button from '../../ui/Button.svelte';
  import Combobox from '../../ui/Combobox.svelte';
  import IconButton from '../../ui/IconButton.svelte';
  import Modal from '../../ui/Modal.svelte';
  import {
    ACTIVITY_COMPOSITE_OPS,
    ACTIVITY_KIND_OPTIONS,
    ACTIVITY_LEAF_OPS,
    activityLeafValueKind,
    activityOpLabel,
    type ActivityCompositeOp,
    type ActivityLeafOp,
    type ActivityPredicate,
  } from './activity_predicate';

  interface Props {
    /** Predicate to seed on each open. `null` means "match everything". */
    predicate: ActivityPredicate | null;
    open: boolean;
    /** Attribute names eligible for `attr_in` / `attr_not_in` leaves. */
    attributeNames: readonly string[];
    /** Users eligible for `actor_in` / `actor_not_in` leaves. */
    users: readonly { id: bigint; display_name: string }[];
    /** Called with the saved predicate (or null = clear). */
    onSave: (p: ActivityPredicate | null) => void;
    onCancel?: () => void;
  }

  let {
    predicate,
    open = $bindable(),
    attributeNames,
    users,
    onSave,
    onCancel,
  }: Props = $props();

  /* ---- Editable mirror -------------------------------------------------- */

  type EditLeaf = {
    id: string;
    kind: 'leaf';
    op: ActivityLeafOp;
    values: string[];
  };
  type EditGroup = {
    id: string;
    kind: 'composite';
    op: ActivityCompositeOp;
    items: EditNode[];
  };
  type EditNode = EditLeaf | EditGroup;

  let nextId = 1;
  function newId(): string {
    return `n${nextId++}`;
  }

  function fromPredicate(p: ActivityPredicate | null): EditGroup {
    if (p === null) {
      return { id: newId(), kind: 'composite', op: 'and', items: [] };
    }
    if (p.kind === 'leaf') {
      // The UI always shows a top-level group so the connective selector
      // is visible — wrap a bare leaf in an AND group on the way in.
      return {
        id: newId(),
        kind: 'composite',
        op: 'and',
        items: [{ id: newId(), kind: 'leaf', op: p.op, values: p.values.slice() }],
      };
    }
    return {
      id: newId(),
      kind: 'composite',
      op: p.op,
      items: p.items.map(toEditNode),
    };
  }

  function toEditNode(p: ActivityPredicate): EditNode {
    if (p.kind === 'leaf') {
      return { id: newId(), kind: 'leaf', op: p.op, values: p.values.slice() };
    }
    return {
      id: newId(),
      kind: 'composite',
      op: p.op,
      items: p.items.map(toEditNode),
    };
  }

  function toPredicate(n: EditNode): ActivityPredicate {
    if (n.kind === 'leaf') {
      return { kind: 'leaf', op: n.op, values: n.values.slice() };
    }
    return {
      kind: 'composite',
      op: n.op,
      items: n.items.map(toPredicate),
    };
  }

  let root = $state<EditGroup>({
    id: newId(),
    kind: 'composite',
    op: 'and',
    items: [],
  });

  // Re-seed the editable tree on each open. Editing while closed has no
  // effect, so the seed only matters on the false→true flip.
  let lastOpen = false;
  $effect(() => {
    if (open && !lastOpen) {
      root = fromPredicate(predicate);
    }
    lastOpen = open;
  });

  /* ---- Mutators --------------------------------------------------------- */

  function defaultLeaf(): EditLeaf {
    return { id: newId(), kind: 'leaf', op: 'kind_in', values: [] };
  }

  function addLeaf(group: EditGroup) {
    group.items = [...group.items, defaultLeaf()];
  }

  function addGroup(group: EditGroup) {
    group.items = [
      ...group.items,
      { id: newId(), kind: 'composite', op: 'and', items: [] },
    ];
  }

  function removeChild(group: EditGroup, id: string) {
    group.items = group.items.filter((c) => c.id !== id);
  }

  function setLeafOp(leaf: EditLeaf, op: ActivityLeafOp) {
    const prevKind = activityLeafValueKind(leaf.op);
    const nextKind = activityLeafValueKind(op);
    leaf.op = op;
    // Switching value-kind (e.g. kind → actor) invalidates the existing
    // values — clear so the picker shows an empty state rather than
    // emitting nonsense values like a user-id in a `kind_in` leaf.
    if (prevKind !== nextKind) {
      leaf.values = [];
    }
  }

  /**
   * Find the parent of [id] starting from `root` and remove it. Used by
   * the group "Remove" button — the root group itself never exposes a
   * remove affordance (the `isRoot` flag gates it).
   */
  function removeFromParent(id: string) {
    function visit(node: EditGroup): boolean {
      const idx = node.items.findIndex((c) => c.id === id);
      if (idx >= 0) {
        node.items = [
          ...node.items.slice(0, idx),
          ...node.items.slice(idx + 1),
        ];
        return true;
      }
      for (const c of node.items) {
        if (c.kind === 'composite' && visit(c)) return true;
      }
      return false;
    }
    visit(root);
  }

  /* ---- Combobox options ------------------------------------------------- */

  const compositeOptions = ACTIVITY_COMPOSITE_OPS.map((op) => ({
    value: op,
    label: activityOpLabel(op),
  }));

  const leafOpOptions = ACTIVITY_LEAF_OPS.map((op) => ({
    value: op,
    label: activityOpLabel(op),
  }));

  const kindOptions = ACTIVITY_KIND_OPTIONS.map((k) => ({
    value: k.value,
    label: k.label,
  }));

  const attrOptions = $derived(
    attributeNames.map((n) => ({ value: n, label: n })),
  );

  const actorOptions = $derived(
    users.map((u) => ({ value: u.id.toString(), label: u.display_name })),
  );

  /* ---- Save / cancel ---------------------------------------------------- */

  function handleSave() {
    const out = toPredicate(root);
    // An empty top-level AND is "no filter" — emit null so the admin
    // can clear the attribute outright rather than storing `{op:'and'}`.
    if (out.kind === 'composite' && out.op === 'and' && out.items.length === 0) {
      onSave(null);
    } else {
      onSave(out);
    }
    open = false;
  }

  function handleCancel() {
    onCancel?.();
    open = false;
  }
</script>

<Modal bind:open title="Activity filter" size="lg" onClose={handleCancel}>
  <div class="space-y-3">
    <p class="text-xs text-muted">
      Each leaf matches a single activity row by its kind, the attribute
      name it touched, or the actor that performed it. Compose with AND /
      OR. An empty filter pushes every row.
    </p>
    {@render renderGroup(root, true)}
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={handleCancel}>Cancel</Button>
    <Button variant="primary" onclick={handleSave}>Save</Button>
  {/snippet}
</Modal>

{#snippet renderGroup(group: EditGroup, isRoot: boolean)}
  <div class="rounded-md border border-border bg-surface/40 p-3">
    <div class="mb-2 flex items-center gap-2">
      <div class="w-24">
        <Combobox
          aria-label="Connective"
          options={compositeOptions}
          value={group.op}
          searchable={false}
          onchange={(v) => {
            if (v === 'and' || v === 'or') group.op = v;
          }}
        />
      </div>
      <Button size="sm" variant="secondary" onclick={() => addLeaf(group)}>
        {#snippet children()}+ Add leaf{/snippet}
      </Button>
      <Button size="sm" variant="secondary" onclick={() => addGroup(group)}>
        {#snippet children()}+ Add group{/snippet}
      </Button>
      {#if !isRoot}
        <span class="ml-auto">
          <IconButton
            aria-label="Remove group"
            variant="ghost"
            size="sm"
            onclick={() => removeFromParent(group.id)}
          >
            {#snippet children()}×{/snippet}
          </IconButton>
        </span>
      {/if}
    </div>

    {#if group.items.length === 0}
      <p class="px-1 text-xs text-muted">
        Empty group. Add a leaf or nested group above.
      </p>
    {:else}
      <ul class="space-y-2 pl-2">
        {#each group.items as child (child.id)}
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

{#snippet renderLeaf(leaf: EditLeaf, parent: EditGroup)}
  {@const valueKind = activityLeafValueKind(leaf.op)}
  {@const options =
    valueKind === 'kind'
      ? kindOptions
      : valueKind === 'attr'
        ? attrOptions
        : actorOptions}
  <div class="flex flex-wrap items-center gap-2 rounded-md border border-border bg-bg p-2">
    <div class="min-w-[10rem]">
      <Combobox
        aria-label="Operator"
        options={leafOpOptions}
        value={leaf.op}
        searchable={false}
        onchange={(v) => {
          if (typeof v === 'string') setLeafOp(leaf, v as ActivityLeafOp);
        }}
      />
    </div>
    <div class="min-w-[14rem] flex-1">
      <Combobox
        aria-label="Values"
        options={options}
        value={leaf.values}
        multiple
        searchable={options.length > 6}
        placeholder={valueKind === 'kind'
          ? 'pick activity kinds…'
          : valueKind === 'attr'
            ? 'pick attribute names…'
            : 'pick users…'}
        onchange={(v) => {
          if (Array.isArray(v)) {
            leaf.values = v.filter((x): x is string => typeof x === 'string');
          } else if (v === null || v === undefined) {
            leaf.values = [];
          } else if (typeof v === 'string') {
            leaf.values = [v];
          }
        }}
      />
    </div>
    <IconButton
      aria-label="Remove leaf"
      variant="ghost"
      size="sm"
      onclick={() => removeChild(parent, leaf.id)}
    >
      {#snippet children()}×{/snippet}
    </IconButton>
  </div>
{/snippet}
