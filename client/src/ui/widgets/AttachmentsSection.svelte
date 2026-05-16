<script lang="ts">
  /**
   * Attachments list + drag-and-drop uploader for one card.
   *
   * Self-contained: fetches the list on mount, uploads via the dedicated
   * HTTP route, downloads via the dedicated HTTP route, soft-deletes via
   * the JSON dispatcher. The parent only needs to bind `cardId`.
   *
   * Drop the file straight onto the section to upload; or click the
   * "Choose files…" button. Drop a directory and we walk only the top-
   * level files — no recursion in v1.
   */

  import { getContext } from 'svelte';
  import {
    downloadAttachment,
    uploadAttachment,
    UploadError,
  } from '../../attachments/upload';
  import type { AuthState } from '../../auth/auth_state.svelte';
  import { serverConfig } from '../../config/server_config';
  import { getDispatcher } from '../../dispatch/context';
  import { attachmentDelete, attachmentList } from '../../reg/handlers';
  import type {
    AttachmentDeleteInput,
    AttachmentDeleteOutput,
    AttachmentListInput,
    AttachmentListOutput,
    AttachmentRow,
    ID,
  } from '../../reg/types';
  import Button from '../Button.svelte';
  import IconButton from '../IconButton.svelte';
  import Spinner from '../Spinner.svelte';
  import { notify } from '../toast.svelte';
  import { cx } from '../../util/class_names';

  interface Props {
    cardId: ID;
    /** Optional: fired after every upload / delete commit so the parent
     *  screen can refresh siblings (e.g. the activity feed). */
    onChanged?: () => void;
  }

  let { cardId, onChanged }: Props = $props();

  const dispatcher = getDispatcher();
  const authState = getContext<AuthState | null>('authState') ?? null;

  // Per-upload size caps + per-chunk size. Loaded from the server's
  // config.get on first mount and cached process-wide. Until the fetch
  // resolves both stay 0 so the dropzone hides the byte-cap hint and
  // size validation is deferred to handleFiles().
  let maxBytes = $state<number>(0);
  let chunkBytes = $state<number>(0);
  void serverConfig(dispatcher).then((cfg) => {
    if (cfg.attachment_max_bytes > 0) maxBytes = cfg.attachment_max_bytes;
    if (cfg.chunk_max_bytes > 0) chunkBytes = cfg.chunk_max_bytes;
  });

  let rows = $state<AttachmentRow[]>([]);
  let loading = $state(false);
  let errorMsg = $state<string | null>(null);

  /** Currently-uploading files. Keyed by a per-upload synthetic id so
   *  more than one can be in flight at once. */
  let uploads = $state<
    Map<
      number,
      { name: string; loaded: number; total: number; phase: 'hashing' | 'uploading' | 'saving' }
    >
  >(new Map());
  let nextUploadID = 0;

  let dragOver = $state(false);
  let inputEl: HTMLInputElement | null = $state(null);

  async function refresh(): Promise<void> {
    if (cardId === 0n) return;
    loading = true;
    errorMsg = null;
    try {
      const out = await dispatcher.request<AttachmentListInput, AttachmentListOutput>({
        endpoint: attachmentList.endpoint,
        action: attachmentList.action,
        data: { cardId },
      });
      rows = out.rows;
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  // Refetch whenever cardId changes — covers both the initial mount and
  // navigation between cards (Svelte preserves component instances across
  // route transitions when only props change).
  $effect(() => {
    void cardId;
    void refresh();
  });

  async function handleFiles(files: FileList | File[]): Promise<void> {
    const list: File[] = Array.from(files);
    // Resolve maxBytes synchronously here in case the user dropped a file
    // before the initial config.get round-trip completed. The cached
    // promise resolves once for the whole session.
    if (maxBytes === 0 || chunkBytes === 0) {
      try {
        const cfg = await serverConfig(dispatcher);
        if (cfg.attachment_max_bytes > 0) maxBytes = cfg.attachment_max_bytes;
        if (cfg.chunk_max_bytes > 0) chunkBytes = cfg.chunk_max_bytes;
      } catch {
        notify({ type: 'error', message: 'Server config unavailable; try again.' });
        return;
      }
    }
    for (const file of list) {
      if (file.size > maxBytes) {
        notify({
          type: 'error',
          message: `${file.name} is ${formatBytes(file.size)} — over the ${formatBytes(maxBytes)} limit.`,
        });
        continue;
      }
      const uid = ++nextUploadID;
      uploads = new Map(uploads).set(uid, {
        name: file.name,
        loaded: 0,
        total: file.size,
        phase: 'uploading',
      });
      try {
        await uploadAttachment(dispatcher, cardId, file, authState, {
          chunkBytes: chunkBytes > 0 ? chunkBytes : undefined,
          onProgress: (p) => {
            uploads = new Map(uploads).set(uid, {
              name: file.name,
              loaded: p.loaded,
              total: p.total,
              phase: p.phase,
            });
          },
        });
      } catch (e) {
        const msg =
          e instanceof UploadError
            ? `${file.name}: ${e.message}`
            : e instanceof Error
              ? `${file.name}: ${e.message}`
              : `${file.name}: ${String(e)}`;
        notify({ type: 'error', message: msg });
      } finally {
        const next = new Map(uploads);
        next.delete(uid);
        uploads = next;
      }
    }
    await refresh();
    onChanged?.();
  }

  async function onDelete(row: AttachmentRow): Promise<void> {
    if (!confirm(`Remove "${row.filename}"?`)) return;
    try {
      await dispatcher.request<AttachmentDeleteInput, AttachmentDeleteOutput>({
        endpoint: attachmentDelete.endpoint,
        action: attachmentDelete.action,
        data: { id: row.id },
      });
      notify({ type: 'success', message: 'Attachment removed.' });
      await refresh();
      onChanged?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Failed to remove: ${msg}` });
    }
  }

  async function onDownload(row: AttachmentRow): Promise<void> {
    try {
      await downloadAttachment(row.id, row.filename, authState);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Download failed: ${msg}` });
    }
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault();
    dragOver = false;
    if (!e.dataTransfer) return;
    const files = e.dataTransfer.files;
    if (files.length === 0) return;
    void handleFiles(files);
  }

  function onDragOver(e: DragEvent): void {
    e.preventDefault();
    dragOver = true;
  }

  function onDragLeave(): void {
    dragOver = false;
  }

  function onPick(): void {
    inputEl?.click();
  }

  function onPicked(e: Event): void {
    const input = e.currentTarget as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      void handleFiles(input.files);
      input.value = '';
    }
  }

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  const inProgress = $derived(Array.from(uploads.values()));
</script>

<section
  aria-labelledby="attachments-heading"
  class="flex flex-col border border-section bg-bg"
>
  <h2
    id="attachments-heading"
    class="border-b border-fg/40 bg-surface/40 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-fg"
  >
    Attachments {#if rows.length > 0}({rows.length}){/if}
  </h2>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class={cx(
      'flex flex-col gap-2 px-3 py-2',
      dragOver && 'bg-accent/10 ring-2 ring-inset ring-accent',
    )}
    ondrop={onDrop}
    ondragover={onDragOver}
    ondragleave={onDragLeave}
    data-testid="attachments-dropzone"
  >
    {#if loading && rows.length === 0}
      <div class="flex justify-center py-3"><Spinner size="sm" /></div>
    {:else if errorMsg !== null}
      <p role="alert" class="text-xs text-danger">Failed to load: {errorMsg}</p>
    {:else if rows.length === 0 && inProgress.length === 0}
      <p class="text-xs text-muted">
        Drag a file here, or click "Choose files…" below.{#if maxBytes > 0}
          Up to {formatBytes(maxBytes)} per file.{/if}
      </p>
    {:else}
      <ul class="flex flex-col gap-1" data-testid="attachments-list">
        {#each rows as row (row.id)}
          <li class="flex items-center gap-2 rounded border border-fg/15 bg-surface/30 px-2 py-1 text-sm">
            <button
              type="button"
              class="min-w-0 flex-1 truncate text-left text-fg hover:underline focus:outline-none focus-visible:underline"
              title={`${row.filename} (${formatBytes(row.size_bytes)})`}
              onclick={() => void onDownload(row)}
            >
              {row.filename}
            </button>
            <span class="shrink-0 text-[11px] text-muted">{formatBytes(row.size_bytes)}</span>
            <IconButton
              aria-label={`Remove ${row.filename}`}
              title="Remove attachment"
              size="sm"
              variant="danger"
              onclick={() => void onDelete(row)}
            >
              {#snippet children()}×{/snippet}
            </IconButton>
          </li>
        {/each}
      </ul>
    {/if}

    {#each inProgress as up, i (i)}
      <div class="flex items-center gap-2 rounded border border-accent/40 bg-accent/5 px-2 py-1 text-sm">
        <span class="min-w-0 flex-1 truncate text-fg" title={up.name}>{up.name}</span>
        <span class="shrink-0 text-[11px] text-muted">
          {#if up.phase === 'hashing'}
            Hashing…
          {:else if up.phase === 'saving'}
            Saving on server…
          {:else}
            {formatBytes(up.loaded)} / {formatBytes(up.total)}
          {/if}
        </span>
      </div>
    {/each}

    <div class="flex items-center justify-between gap-2 pt-1">
      <p class="text-[11px] text-muted">
        Drag &amp; drop, or click to browse.
      </p>
      <Button variant="secondary" size="sm" onclick={onPick}>
        {#snippet children()}Choose files…{/snippet}
      </Button>
      <input
        bind:this={inputEl}
        type="file"
        multiple
        class="hidden"
        onchange={onPicked}
      />
    </div>
  </div>
</section>
