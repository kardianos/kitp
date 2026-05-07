<script lang="ts">
  /**
   * Sidebar dropdown that pins the active project scope. "(All projects)"
   * picks the unscoped view; selecting a project sets the scope for every
   * list screen (Inbox / Grid / Kanban) until the user changes it.
   *
   * We fetch the project list lazily on mount via
   * `card.select_with_attributes` and cache it in component state — the
   * list shouldn't churn enough during a session to need a watcher. If a
   * stale label flashes after a rename, picking the project a second time
   * forces a refetch.
   */
  import { onMount } from 'svelte';
  import { getDispatcher } from '../dispatch/context';
  import { cardSelectWithAttributes } from '../reg/handlers';
  import type {
    CardSelectWithAttributesInput,
    CardSelectWithAttributesOutput,
    CardWithAttrs,
  } from '../reg/types';
  import Combobox from '../ui/Combobox.svelte';
  import { projectScope } from './project_scope.svelte';

  const dispatcher = getDispatcher();
  let projects = $state<CardWithAttrs[]>([]);
  let loaded = $state(false);

  async function load(): Promise<void> {
    try {
      const out = await dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data: { cardTypeName: 'project', limit: 200 },
      });
      projects = out.rows;
    } catch {
      projects = [];
    } finally {
      loaded = true;
    }
  }

  onMount(() => {
    void load();
  });

  const options = $derived.by(() => {
    const opts: { value: number | string; label: string }[] = [
      { value: '__all__', label: '(All projects)' },
    ];
    for (const p of projects) {
      const t = p.attributes['title'];
      const label = typeof t === 'string' && t.length > 0 ? t : `#${p.id}`;
      opts.push({ value: p.id, label });
    }
    return opts;
  });

  const selectedValue = $derived<number | string | null>(
    projectScope.projectId ?? '__all__',
  );

  function onPick(v: number | string | (number | string)[] | null): void {
    if (Array.isArray(v)) return;
    if (v === '__all__' || v === null) {
      projectScope.setProject(null);
      return;
    }
    if (typeof v === 'number') {
      projectScope.setProject(v);
    }
  }
</script>

<!--
  Use <div>, not <label>: clicking a Combobox option bubbles to the
  label, which forwards a synthetic click to the trigger button and
  re-opens the menu we just closed.
-->
<div class="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-muted">
  <span>Project</span>
  <Combobox
    aria-label="Active project scope"
    options={options}
    value={selectedValue}
    searchable={projects.length > 8}
    placeholder={loaded ? 'Pick…' : 'Loading…'}
    onchange={onPick}
  />
</div>
