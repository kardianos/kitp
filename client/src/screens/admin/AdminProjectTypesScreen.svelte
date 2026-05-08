<!--
  AdminProjectTypesScreen.

  Master/detail layout for managing project_type rows. Per
  PROJECT_SCOPED_SCHEMA_PLAN.md and IMPL_PLAN_SCOPED_WORKFLOW Phase 1.

    - Master pane (left, ~280px): list of project_type rows. The
      migration-seeded `default` row is pinned at the top with a badge.
    - Detail pane (right): selected row form (name, doc, is_default
      toggle), Save / Delete actions, plus a "Create new project_type"
      affordance at the top.

  Initial-batch contract — one sub-request:
    1. `project_type.select` — every row, ordered by id.

  Mutations route via `project_type.insert / update / delete`.
-->
<script lang="ts">
  import { onMount } from 'svelte';

  import { getDispatcher } from '../../dispatch/context';
  import { setActiveScope } from '../../keys/shortcut';
  import {
    projectTypeDelete,
    projectTypeInsert,
    projectTypeSelect,
    projectTypeUpdate,
  } from '../../reg/handlers_admin';
  import type {
    ProjectTypeDeleteInput,
    ProjectTypeDeleteOutput,
    ProjectTypeInsertInput,
    ProjectTypeInsertOutput,
    ProjectTypeRow,
    ProjectTypeSelectInput,
    ProjectTypeSelectOutput,
    ProjectTypeUpdateInput,
    ProjectTypeUpdateOutput,
  } from '../../reg/types';
  import Button from '../../ui/Button.svelte';
  import Spinner from '../../ui/Spinner.svelte';
  import { notify } from '../../ui/toast.svelte';
  import { cx } from '../../util/class_names';

  setActiveScope('admin_project_types');

  const dispatcher = getDispatcher();

  let rows = $state<ProjectTypeRow[]>([]);
  let selectedId = $state<number | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Edit-form state (local to selected row).
  let editName = $state('');
  let editDoc = $state('');
  let editIsDefault = $state(false);
  let saving = $state(false);

  // New-row form state.
  let newName = $state('');
  let newDoc = $state('');
  let newIsDefault = $state(false);
  let creatingOpen = $state(false);
  let creating = $state(false);

  $effect(() => {
    const sel = rows.find((r) => r.id === selectedId);
    if (sel === undefined) return;
    editName = sel.name;
    editDoc = sel.doc ?? '';
    editIsDefault = sel.is_default;
  });

  const selectedRow = $derived(rows.find((r) => r.id === selectedId) ?? null);

  async function refresh(): Promise<void> {
    loading = true;
    error = null;
    try {
      const out = await dispatcher.request<
        ProjectTypeSelectInput,
        ProjectTypeSelectOutput
      >({
        endpoint: projectTypeSelect.endpoint,
        action: projectTypeSelect.action,
        data: {},
      });
      rows = out.rows.slice().sort((a, b) => {
        if (a.is_default && !b.is_default) return -1;
        if (!a.is_default && b.is_default) return 1;
        return a.id - b.id;
      });
      if (rows.length > 0 && (selectedId === null || !rows.some((r) => r.id === selectedId))) {
        const firstNonDefault = rows.find((r) => !r.is_built_in);
        selectedId = firstNonDefault?.id ?? rows[0]?.id ?? null;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function save(): Promise<void> {
    if (selectedRow === null) return;
    saving = true;
    try {
      const data: ProjectTypeUpdateInput = {
        id: selectedRow.id,
        doc: editDoc,
        isDefault: editIsDefault,
      };
      if (!selectedRow.is_built_in) data.name = editName;
      const out = await dispatcher.request<
        ProjectTypeUpdateInput,
        ProjectTypeUpdateOutput
      >({
        endpoint: projectTypeUpdate.endpoint,
        action: projectTypeUpdate.action,
        data,
      });
      if (!out.ok) throw new Error('update returned not-ok');
      notify({ type: 'success', message: `Saved ${editName}` });
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Save failed: ${msg}` });
    } finally {
      saving = false;
    }
  }

  async function deleteRow(): Promise<void> {
    if (selectedRow === null) return;
    if (selectedRow.is_built_in) {
      notify({ type: 'error', message: 'Cannot delete a built-in project_type' });
      return;
    }
    if (!confirm(`Delete project_type "${selectedRow.name}"?`)) return;
    try {
      const out = await dispatcher.request<
        ProjectTypeDeleteInput,
        ProjectTypeDeleteOutput
      >({
        endpoint: projectTypeDelete.endpoint,
        action: projectTypeDelete.action,
        data: { id: selectedRow.id },
      });
      if (!out.ok) {
        notify({
          type: 'error',
          message:
            out.usage_count !== undefined && out.usage_count > 0
              ? `Cannot delete: ${out.usage_count} project(s) still use this type`
              : 'Delete refused',
        });
        return;
      }
      notify({ type: 'success', message: `Deleted ${selectedRow.name}` });
      selectedId = null;
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Delete failed: ${msg}` });
    }
  }

  async function createRow(): Promise<void> {
    if (newName.trim() === '') {
      notify({ type: 'error', message: 'Name is required' });
      return;
    }
    creating = true;
    try {
      const data: ProjectTypeInsertInput = { name: newName.trim() };
      if (newDoc.trim() !== '') data.doc = newDoc.trim();
      if (newIsDefault) data.isDefault = true;
      const out = await dispatcher.request<
        ProjectTypeInsertInput,
        ProjectTypeInsertOutput
      >({
        endpoint: projectTypeInsert.endpoint,
        action: projectTypeInsert.action,
        data,
      });
      notify({ type: 'success', message: `Created ${newName}` });
      newName = '';
      newDoc = '';
      newIsDefault = false;
      creatingOpen = false;
      await refresh();
      selectedId = out.id;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Create failed: ${msg}` });
    } finally {
      creating = false;
    }
  }

  onMount(() => {
    void refresh();
  });
</script>

<div class="flex h-full flex-col" data-testid="admin-project-types">
  <header class="flex items-center justify-between border-b border-border px-4 py-3">
    <h1 class="text-xl font-semibold">Admin · Project Types</h1>
    <span data-testid="new-project-type-button-wrap">
      <Button onclick={() => (creatingOpen = !creatingOpen)}>
        {creatingOpen ? 'Cancel' : '+ New project type'}
      </Button>
    </span>
  </header>

  {#if creatingOpen}
    <div
      class="border-b border-border bg-surface-2 px-4 py-3"
      data-testid="new-project-type-form"
    >
      <div class="flex flex-wrap items-end gap-3">
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-xs font-medium text-muted">Name</span>
          <input
            type="text"
            bind:value={newName}
            placeholder="e.g. Bugs, Roadmap"
            data-testid="new-project-type-name"
            class={cx(
              'w-48 rounded-md border border-border bg-bg px-3 py-1.5 text-sm',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            )}
          />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-xs font-medium text-muted">Description</span>
          <input
            type="text"
            bind:value={newDoc}
            placeholder="Optional"
            data-testid="new-project-type-doc"
            class={cx(
              'w-72 rounded-md border border-border bg-bg px-3 py-1.5 text-sm',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            )}
          />
        </label>
        <label class="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            bind:checked={newIsDefault}
            data-testid="new-project-type-default"
          />
          <span>Make default</span>
        </label>
        <span data-testid="new-project-type-save-wrap">
          <Button onclick={() => void createRow()} disabled={creating}>
            {creating ? 'Creating…' : 'Create'}
          </Button>
        </span>
      </div>
    </div>
  {/if}

  {#if loading && rows.length === 0}
    <div class="flex flex-1 items-center justify-center">
      <Spinner size="lg" />
    </div>
  {:else if error !== null}
    <div
      role="alert"
      class="m-4 rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
    >
      Failed to load: {error}
      <button type="button" class="ml-3 underline" onclick={() => void refresh()}>
        Retry
      </button>
    </div>
  {:else}
    <div class="flex flex-1 min-h-0">
      <aside
        class="flex w-[280px] shrink-0 flex-col gap-1 border-r border-border p-3"
        aria-label="Project type list"
      >
        <ul data-testid="project-type-list" class="flex flex-col gap-1">
          {#each rows as row (row.id)}
            <li>
              <button
                type="button"
                class={cx(
                  'flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm',
                  selectedId === row.id
                    ? 'bg-accent/15 font-medium text-accent'
                    : 'hover:bg-surface-2',
                )}
                onclick={() => (selectedId = row.id)}
                data-testid="project-type-row"
                data-row-id={row.id}
              >
                <span>{row.name}</span>
                <span class="flex gap-1">
                  {#if row.is_default}
                    <span class="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-accent">
                      default
                    </span>
                  {/if}
                  {#if row.is_built_in}
                    <span class="rounded bg-muted/30 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                      built-in
                    </span>
                  {/if}
                </span>
              </button>
            </li>
          {/each}
        </ul>
      </aside>

      <section class="flex flex-1 flex-col gap-4 p-4" data-testid="project-type-detail">
        {#if selectedRow === null}
          <p class="text-sm text-muted">Select a project type to edit it.</p>
        {:else}
          <div class="flex flex-col gap-4">
            <label class="flex flex-col gap-1 text-sm">
              <span class="text-xs font-medium text-muted">Name</span>
              <input
                type="text"
                bind:value={editName}
                disabled={selectedRow.is_built_in}
                data-testid="edit-project-type-name"
                class={cx(
                  'w-72 rounded-md border border-border bg-bg px-3 py-1.5 text-sm',
                  'disabled:opacity-50',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                )}
              />
              {#if selectedRow.is_built_in}
                <span class="text-xs text-muted">Built-in rows cannot be renamed.</span>
              {/if}
            </label>
            <label class="flex flex-col gap-1 text-sm">
              <span class="text-xs font-medium text-muted">Description</span>
              <textarea
                bind:value={editDoc}
                rows={3}
                data-testid="edit-project-type-doc"
                class={cx(
                  'w-full rounded-md border border-border bg-bg px-3 py-1.5 text-sm',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                )}
              ></textarea>
            </label>
            <label class="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                bind:checked={editIsDefault}
                data-testid="edit-project-type-default"
              />
              <span>Default for new projects</span>
            </label>
            <div class="flex gap-2">
              <span data-testid="save-project-type-wrap">
                <Button onclick={() => void save()} disabled={saving}>
                  {saving ? 'Saving…' : 'Save'}
                </Button>
              </span>
              <span data-testid="delete-project-type-wrap">
                <Button
                  variant="secondary"
                  onclick={() => void deleteRow()}
                  disabled={selectedRow.is_built_in}
                >
                  Delete
                </Button>
              </span>
            </div>
          </div>
        {/if}
      </section>
    </div>
  {/if}
</div>
