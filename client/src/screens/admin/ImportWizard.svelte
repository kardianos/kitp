<script lang="ts">
  /**
   * Four-step import wizard, shown as a Modal:
   *
   *   1. Upload CSV     — file picker; on submit, upload to CAS and
   *                       call `project.import.upload` to get a job.
   *   2. Column mapping — table of CSV headers, each with a dropdown
   *                       that targets a known attribute or `ignore`.
   *                       Auto-fill via snake_case match.
   *   3. Resolution     — per-category radios (match / auto-create /
   *                       skip / leave-blank).
   *   4. Preview        — read-only summary + error log. Commit step
   *                       lives in phase 6 and is stubbed for now.
   *
   * The wizard keeps state locally; the import_job row on the server
   * is the durable record. A future refresh-to-resume hook would read
   * `import_job.status` and skip ahead — out of scope for phase 5.
   */
  import { getContext } from 'svelte';

  import type { AuthState } from '../../auth/auth_state.svelte';
  import { getDispatcher } from '../../dispatch/context';
  import type { ID } from '../../reg/types';
  import ErrorAlert from '../../ui/ErrorAlert.svelte';
  import Modal from '../../ui/Modal.svelte';
  import { notify } from '../../ui/toast.svelte';
  import {
    autoMapping,
    IGNORE_COLUMN,
    TARGET_ATTRS,
    uploadCsvFile,
    type ImportCommitInput,
    type ImportCommitOutput,
    type ImportPreviewInput,
    type ImportPreviewOutput,
    type ImportResolution,
    type ImportSetMappingInput,
    type ImportSetMappingOutput,
    type ImportUploadInput,
    type ImportUploadOutput,
    type ResolutionMode,
  } from './import_wizard';

  interface Props {
    open: boolean;
    projectId: ID | null;
  }
  let { open = $bindable(), projectId }: Props = $props();

  const dispatcher = getDispatcher();
  const authState = getContext<AuthState | undefined>('authState') ?? null;

  type Step = 'upload' | 'mapping' | 'resolution' | 'preview';
  let step = $state<Step>('upload');

  // Upload step
  let file = $state<File | null>(null);
  let uploading = $state(false);
  let jobId = $state<ID | null>(null);
  let headers = $state<string[]>([]);
  let previewRows = $state<string[][]>([]);
  let rowCount = $state(0);
  let errorMsg = $state<string | null>(null);

  // Mapping step
  let mapping = $state<Record<string, string>>({});

  // Resolution step — sensible defaults from the plan: tags/persons
  // auto-create, others match_existing.
  let resPersons = $state<ResolutionMode>('match_existing');
  let resMilestones = $state<ResolutionMode>('match_existing');
  let resComponents = $state<ResolutionMode>('match_existing');
  let resTags = $state<ResolutionMode>('match_existing');
  let resStatuses = $state<'match_existing' | 'skip'>('match_existing');

  // Preview / commit steps
  let previewOut = $state<ImportPreviewOutput | null>(null);
  let commitOut = $state<ImportCommitOutput | null>(null);
  let committing = $state(false);

  function resetState(): void {
    step = 'upload';
    file = null;
    uploading = false;
    jobId = null;
    headers = [];
    previewRows = [];
    rowCount = 0;
    errorMsg = null;
    mapping = {};
    previewOut = null;
    commitOut = null;
    committing = false;
  }

  $effect(() => {
    if (!open) {
      resetState();
    }
  });

  async function onUploadSubmit(): Promise<void> {
    if (file === null || projectId === null || uploading) return;
    uploading = true;
    errorMsg = null;
    try {
      const fileId = await uploadCsvFile(file, dispatcher, authState);
      const out = await dispatcher.request<ImportUploadInput, ImportUploadOutput>({
        endpoint: 'project.import',
        action: 'upload',
        data: { projectId, fileId },
      });
      jobId = out.jobId;
      headers = out.headers;
      previewRows = out.previewRows;
      rowCount = out.rowCount;
      mapping = autoMapping(headers);
      step = 'mapping';
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
    } finally {
      uploading = false;
    }
  }

  async function onMappingSubmit(): Promise<void> {
    if (jobId === null) return;
    errorMsg = null;
    try {
      await dispatcher.request<ImportSetMappingInput, ImportSetMappingOutput>({
        endpoint: 'project.import',
        action: 'set_mapping',
        data: { jobId, mapping },
      });
      step = 'resolution';
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
    }
  }

  async function onResolutionSubmit(): Promise<void> {
    if (jobId === null) return;
    errorMsg = null;
    try {
      const resolution: ImportResolution = {
        persons: resPersons,
        milestones: resMilestones,
        components: resComponents,
        tags: resTags,
        statuses: resStatuses,
      };
      const out = await dispatcher.request<ImportPreviewInput, ImportPreviewOutput>({
        endpoint: 'project.import',
        action: 'preview',
        data: { jobId, resolution },
      });
      previewOut = out;
      step = 'preview';
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
    }
  }

  async function onCommitClick(): Promise<void> {
    if (jobId === null || committing) return;
    committing = true;
    errorMsg = null;
    try {
      const out = await dispatcher.request<ImportCommitInput, ImportCommitOutput>({
        endpoint: 'project.import',
        action: 'commit',
        data: { jobId },
      });
      commitOut = out;
      notify({
        type: 'success',
        message: `Imported ${out.created.tasks} task${out.created.tasks === 1 ? '' : 's'}`,
      });
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
    } finally {
      committing = false;
    }
  }

  function onFileChange(e: Event): void {
    const target = e.currentTarget as HTMLInputElement;
    const picked = target.files && target.files.length > 0 ? target.files.item(0) : null;
    file = picked;
  }
</script>

<Modal bind:open title="Import CSV">
  <div class="flex flex-col gap-4 text-sm text-fg">
    <!-- Step indicator -->
    <ol class="flex gap-2 text-xs uppercase tracking-wide text-muted">
      {#each ['upload', 'mapping', 'resolution', 'preview'] as s, i}
        <li
          class:font-semibold={step === s}
          class:text-fg={step === s}
        >
          {i + 1}. {s}
        </li>
      {/each}
    </ol>

    {#if errorMsg !== null}
      <ErrorAlert message={errorMsg} />
    {/if}

    {#if step === 'upload'}
      <p class="text-muted">
        Choose a CSV exported from this or another kitp project (or a
        file you've prepared yourself).
      </p>
      <input
        type="file"
        accept=".csv,text/csv"
        onchange={onFileChange}
        class="text-sm"
      />
      <button
        type="button"
        disabled={file === null || uploading || projectId === null}
        onclick={() => void onUploadSubmit()}
        class="self-start rounded-md border border-border bg-bg px-3 py-1.5 text-sm hover:bg-bg-soft disabled:opacity-50"
      >
        {uploading ? 'Uploading…' : 'Upload and continue'}
      </button>
    {:else if step === 'mapping'}
      <p class="text-muted">
        Map each CSV column to a target attribute. <strong>{rowCount}</strong> rows detected.
      </p>
      <table class="w-full border-collapse text-left">
        <thead>
          <tr class="border-b border-border">
            <th class="py-1 pr-3 text-xs uppercase tracking-wide text-muted">CSV column</th>
            <th class="py-1 text-xs uppercase tracking-wide text-muted">Target attribute</th>
          </tr>
        </thead>
        <tbody>
          {#each headers as h (h)}
            <tr class="border-b border-border/60">
              <td class="py-1 pr-3 font-mono">{h}</td>
              <td class="py-1">
                <select
                  bind:value={mapping[h]}
                  class="rounded-md border border-border bg-bg px-2 py-1 text-sm"
                >
                  <option value={IGNORE_COLUMN}>(ignore)</option>
                  {#each TARGET_ATTRS as t (t)}
                    <option value={t}>{t}</option>
                  {/each}
                </select>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
      <div class="flex gap-2">
        <button
          type="button"
          onclick={() => void onMappingSubmit()}
          class="rounded-md border border-border bg-bg px-3 py-1.5 hover:bg-bg-soft"
        >
          Continue
        </button>
      </div>
    {:else if step === 'resolution'}
      <p class="text-muted">
        Decide what to do when a referenced value doesn't already exist in this project.
      </p>
      <div class="grid grid-cols-2 gap-3">
        <label class="flex flex-col gap-1">
          <span class="text-xs uppercase tracking-wide text-muted">Persons</span>
          <select bind:value={resPersons} class="rounded-md border border-border bg-bg px-2 py-1">
            <option value="match_existing">Match existing only</option>
            <option value="auto_create">Auto-create new</option>
            <option value="skip">Skip row</option>
            <option value="leave_blank">Leave blank</option>
          </select>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs uppercase tracking-wide text-muted">Milestones</span>
          <select bind:value={resMilestones} class="rounded-md border border-border bg-bg px-2 py-1">
            <option value="match_existing">Match existing only</option>
            <option value="auto_create">Auto-create new</option>
            <option value="skip">Skip row</option>
            <option value="leave_blank">Leave blank</option>
          </select>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs uppercase tracking-wide text-muted">Components</span>
          <select bind:value={resComponents} class="rounded-md border border-border bg-bg px-2 py-1">
            <option value="match_existing">Match existing only</option>
            <option value="auto_create">Auto-create new</option>
            <option value="skip">Skip row</option>
            <option value="leave_blank">Leave blank</option>
          </select>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs uppercase tracking-wide text-muted">Tags</span>
          <select bind:value={resTags} class="rounded-md border border-border bg-bg px-2 py-1">
            <option value="match_existing">Match existing only</option>
            <option value="auto_create">Auto-create new</option>
            <option value="skip">Skip row</option>
            <option value="leave_blank">Leave blank</option>
          </select>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs uppercase tracking-wide text-muted">Statuses</span>
          <select bind:value={resStatuses} class="rounded-md border border-border bg-bg px-2 py-1">
            <option value="match_existing">Match existing only</option>
            <option value="skip">Skip row</option>
          </select>
        </label>
      </div>
      <button
        type="button"
        onclick={() => void onResolutionSubmit()}
        class="self-start rounded-md border border-border bg-bg px-3 py-1.5 hover:bg-bg-soft"
      >
        Run preview
      </button>
    {:else if step === 'preview' && previewOut !== null}
      {@const summary = commitOut !== null
        ? { label: 'Imported', counts: commitOut.created, skipped: commitOut.skippedRows }
        : { label: 'Would create', counts: previewOut.wouldCreate, skipped: previewOut.skippedRows }}
      <div class="grid grid-cols-2 gap-2 rounded-md border border-border bg-bg-soft p-3 text-sm">
        <div>{summary.label} tasks</div>
        <div class="text-right font-semibold">{summary.counts.tasks}</div>
        <div>{summary.label} persons</div>
        <div class="text-right">{summary.counts.persons}</div>
        <div>{summary.label} milestones</div>
        <div class="text-right">{summary.counts.milestones}</div>
        <div>{summary.label} components</div>
        <div class="text-right">{summary.counts.components}</div>
        <div>{summary.label} tags</div>
        <div class="text-right">{summary.counts.tags}</div>
        <div>Skipped rows</div>
        <div class="text-right">{summary.skipped}</div>
      </div>
      {#if commitOut === null && previewOut.errors.length > 0}
        <div class="max-h-48 overflow-y-auto rounded-md border border-danger/40 bg-danger/10 p-2 text-sm">
          <p class="mb-1 font-semibold text-danger">
            {previewOut.errors.length} error{previewOut.errors.length === 1 ? '' : 's'}
          </p>
          <ul class="space-y-0.5 font-mono text-xs">
            {#each previewOut.errors.slice(0, 50) as e}
              <li>
                row {e.row}{e.column ? ` · ${e.column}` : ''}: {e.message}
              </li>
            {/each}
            {#if previewOut.errors.length > 50}
              <li class="text-muted">… {previewOut.errors.length - 50} more</li>
            {/if}
          </ul>
        </div>
      {/if}
      {#if commitOut === null}
        <button
          type="button"
          disabled={committing || previewOut.errors.length > 0}
          onclick={() => void onCommitClick()}
          class="self-start rounded-md border border-border bg-bg px-3 py-1.5 hover:bg-bg-soft disabled:opacity-50"
        >
          {committing ? 'Committing…' : 'Commit import'}
        </button>
      {:else}
        <button
          type="button"
          onclick={() => (open = false)}
          class="self-start rounded-md border border-border bg-bg px-3 py-1.5 hover:bg-bg-soft"
        >
          Done
        </button>
      {/if}
    {/if}
  </div>
</Modal>
