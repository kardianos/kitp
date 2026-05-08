<!--
  AggregateGuardEditor.

  Structured editor for a workflow_transition's aggregate_guard JSON.
  Replaces the raw JSON textarea with a form that round-trips to the
  same shape the server's predicate evaluator expects:

    {
      scope: { card_type: string },
      match: 'all' | 'any' | 'none',
      where: { <attr_name>: { <op>: <operand> } }
    }

  Supports operators: eq, neq, in, nin, lt, lte, gt, gte, set, unset.
  Multi-value operators (in / nin) take comma-separated values.

  The component owns its UI state. On every edit it computes the
  guard JSON and emits via on:change so the parent can stash the
  serialised form for the bulk save.
-->
<script lang="ts">
  type GuardOp =
    | 'eq'
    | 'neq'
    | 'in'
    | 'nin'
    | 'lt'
    | 'lte'
    | 'gt'
    | 'gte'
    | 'set'
    | 'unset';

  interface PredicateRow {
    attr: string;
    op: GuardOp;
    value: string;
  }

  interface GuardModel {
    cardType: string;
    match: 'all' | 'any' | 'none';
    where: PredicateRow[];
  }

  let {
    initial,
    onchange,
  }: {
    initial?: unknown;
    onchange?: (json: unknown | undefined) => void;
  } = $props();

  function parseInitial(v: unknown): GuardModel {
    const empty: GuardModel = {
      cardType: '',
      match: 'all',
      where: [],
    };
    if (v === null || v === undefined || typeof v !== 'object') return empty;
    const obj = v as Record<string, unknown>;
    const scope =
      obj['scope'] !== undefined && typeof obj['scope'] === 'object'
        ? (obj['scope'] as Record<string, unknown>)
        : {};
    const ct = typeof scope['card_type'] === 'string' ? scope['card_type'] : '';
    const m = obj['match'];
    const match: 'all' | 'any' | 'none' =
      m === 'any' || m === 'none' ? m : 'all';
    const where: PredicateRow[] = [];
    if (obj['where'] !== undefined && typeof obj['where'] === 'object') {
      const w = obj['where'] as Record<string, unknown>;
      for (const [attrName, perAttr] of Object.entries(w)) {
        if (perAttr === null || typeof perAttr !== 'object') continue;
        const ops = perAttr as Record<string, unknown>;
        for (const [op, val] of Object.entries(ops)) {
          if (!isOp(op)) continue;
          where.push({
            attr: attrName,
            op,
            value: encodeOperand(op, val),
          });
        }
      }
    }
    return { cardType: ct, match, where };
  }

  function isOp(s: string): s is GuardOp {
    return [
      'eq',
      'neq',
      'in',
      'nin',
      'lt',
      'lte',
      'gt',
      'gte',
      'set',
      'unset',
    ].includes(s);
  }

  function encodeOperand(op: GuardOp, v: unknown): string {
    if (op === 'set' || op === 'unset') return '';
    if (op === 'in' || op === 'nin') {
      if (Array.isArray(v)) {
        return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ');
      }
      return '';
    }
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return JSON.stringify(v);
  }

  function decodeOperand(op: GuardOp, raw: string): unknown {
    if (op === 'set' || op === 'unset') return true;
    if (op === 'in' || op === 'nin') {
      return raw
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p !== '');
    }
    // Try parse as number, fall back to string.
    const n = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(n) && String(n) === raw.trim()) {
      return n;
    }
    return raw;
  }

  // svelte-ignore state_referenced_locally
  // Intentional: we capture `initial` ONCE on mount and let the user
  // edit `model` locally; subsequent changes to the parent's `initial`
  // are not pulled in (matches a controlled-uncontrolled handoff).
  let model = $state<GuardModel>(parseInitial(initial));

  function emit(): void {
    if (model.cardType.trim() === '' && model.where.length === 0) {
      onchange?.(undefined);
      return;
    }
    if (model.cardType.trim() === '') {
      // Don't emit a half-built guard — serialiser would reject it server-side.
      onchange?.(undefined);
      return;
    }
    const where: Record<string, Record<string, unknown>> = {};
    for (const r of model.where) {
      if (r.attr.trim() === '') continue;
      const operand = decodeOperand(r.op, r.value);
      where[r.attr] = { ...(where[r.attr] ?? {}), [r.op]: operand };
    }
    const out = {
      scope: { card_type: model.cardType.trim() },
      match: model.match,
      where,
    };
    onchange?.(out);
  }

  $effect(() => {
    void model;
    emit();
  });

  function addRow(): void {
    model = {
      ...model,
      where: [...model.where, { attr: '', op: 'eq', value: '' }],
    };
  }

  function removeRow(idx: number): void {
    model = {
      ...model,
      where: model.where.filter((_, i) => i !== idx),
    };
  }

  function setMatch(m: 'all' | 'any' | 'none'): void {
    model = { ...model, match: m };
  }
</script>

<div class="flex flex-col gap-2 rounded border border-border bg-bg/50 p-2 text-xs"
     data-testid="agg-guard-editor">
  <div class="flex flex-wrap items-end gap-2">
    <label class="flex flex-col gap-1">
      <span class="text-[10px] uppercase tracking-wide text-muted">Scope card_type</span>
      <input
        type="text"
        bind:value={model.cardType}
        placeholder="e.g. test_case"
        data-testid="agg-card-type"
        class="w-32 rounded border border-border bg-bg px-1.5 py-0.5"
      />
    </label>
    <fieldset class="flex flex-col gap-1">
      <span class="text-[10px] uppercase tracking-wide text-muted">Match</span>
      <div class="flex gap-2" data-testid="agg-match-group">
        {#each ['all', 'any', 'none'] as m (m)}
          <label class="flex items-center gap-1">
            <input
              type="radio"
              name="agg-match"
              value={m}
              checked={model.match === m}
              onchange={() => setMatch(m as 'all' | 'any' | 'none')}
            />
            <span>{m}</span>
          </label>
        {/each}
      </div>
    </fieldset>
  </div>

  <div class="flex flex-col gap-1" data-testid="agg-where-rows">
    {#each model.where as row, i (i)}
      <div class="flex items-center gap-1.5" data-testid="agg-where-row">
        <input
          type="text"
          bind:value={row.attr}
          placeholder="attribute"
          class="w-28 rounded border border-border bg-bg px-1.5 py-0.5"
          data-testid="agg-attr"
        />
        <select
          bind:value={row.op}
          class="rounded border border-border bg-bg px-1 py-0.5"
          data-testid="agg-op"
        >
          <option value="eq">eq</option>
          <option value="neq">neq</option>
          <option value="in">in</option>
          <option value="nin">nin</option>
          <option value="lt">lt</option>
          <option value="lte">lte</option>
          <option value="gt">gt</option>
          <option value="gte">gte</option>
          <option value="set">set</option>
          <option value="unset">unset</option>
        </select>
        {#if row.op !== 'set' && row.op !== 'unset'}
          <input
            type="text"
            bind:value={row.value}
            placeholder={row.op === 'in' || row.op === 'nin' ? 'a, b, c' : 'value'}
            class="w-40 rounded border border-border bg-bg px-1.5 py-0.5 font-mono"
            data-testid="agg-value"
          />
        {/if}
        <button
          type="button"
          class="text-muted hover:text-danger"
          onclick={() => removeRow(i)}
          aria-label="Remove predicate row"
          data-testid="agg-remove-row"
        >
          ×
        </button>
      </div>
    {:else}
      <p class="text-[11px] text-muted">No predicates yet.</p>
    {/each}
    <button
      type="button"
      class="self-start rounded border border-border bg-bg px-2 py-0.5 text-[11px] hover:bg-surface-2"
      onclick={addRow}
      data-testid="agg-add-row"
    >
      + Add predicate
    </button>
  </div>
</div>
