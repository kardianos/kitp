<!--
  ExportMenu — compact download dropdown for the per-screen task export.

  Mounted next to the View kebab on ScreenFilterBar. The icon button
  pops a tiny menu with three format choices (CSV / XLSX / ZIP); each
  fires the corresponding helper from screens/admin/project_export
  with the screen's projectId and active predicate, so the downloaded
  file contains exactly the rows the user is looking at.

  When the host screen has no projectId (the All-projects view), the
  button stays hidden — exports are per-project.
-->
<script lang="ts">
  import { tick } from 'svelte';
  import {
    autoUpdate,
    computePosition,
    flip,
    offset,
  } from '@floating-ui/dom';

  import type { Predicate } from './predicate';
  import type { ID } from '../reg/types';
  import {
    downloadProjectExportCsv,
    downloadProjectExportXlsx,
    downloadProjectExportZip,
  } from '../screens/admin/project_export';
  import { notify } from '../ui/toast.svelte';

  interface Props {
    /** Project to export. Null hides the button (All-projects view). */
    projectId: ID | null;
    /** Active screen predicate; sent as the `tree` query param so the
     *  export reflects whatever the user filtered down to. */
    predicate: Predicate | null;
  }

  let { projectId, predicate }: Props = $props();

  let open = $state(false);
  let triggerEl: HTMLButtonElement | null = $state(null);
  let popupEl: HTMLDivElement | null = $state(null);
  let cleanup: (() => void) | null = null;

  async function openMenu(): Promise<void> {
    open = true;
    await tick();
    if (!triggerEl || !popupEl) return;
    cleanup?.();
    cleanup = autoUpdate(triggerEl, popupEl, () => {
      if (!triggerEl || !popupEl) return;
      void computePosition(triggerEl, popupEl, {
        placement: 'bottom-end',
        middleware: [offset(4), flip()],
      }).then(({ x, y }) => {
        if (!popupEl) return;
        Object.assign(popupEl.style, {
          left: `${x}px`,
          top: `${y}px`,
          opacity: '1',
          pointerEvents: 'auto',
        });
      });
    });
  }

  function closeMenu(): void {
    open = false;
    cleanup?.();
    cleanup = null;
  }

  function onDocPointerDown(e: PointerEvent): void {
    if (!open) return;
    const t = e.target as Node | null;
    if (!t) return;
    if (popupEl?.contains(t)) return;
    if (triggerEl?.contains(t)) return;
    closeMenu();
  }

  $effect(() => {
    if (open) {
      document.addEventListener('pointerdown', onDocPointerDown, true);
      return () => {
        document.removeEventListener('pointerdown', onDocPointerDown, true);
      };
    }
    return undefined;
  });

  $effect(() => {
    return () => {
      cleanup?.();
    };
  });

  /** One-shot guard so a slow download click doesn't queue multiple
   *  requests if the user keeps clicking. The button reads as
   *  "Exporting…" while a fetch is in flight. */
  let running = $state(false);

  async function run(action: () => Promise<void>): Promise<void> {
    if (projectId === null) return;
    running = true;
    closeMenu();
    try {
      await action();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Export failed: ${msg}` });
    } finally {
      running = false;
    }
  }

  function exportCsv(): void {
    if (projectId === null) return;
    void run(() =>
      downloadProjectExportCsv({
        projectId,
        includeDeleted: false,
        predicate,
        authState: null,
      }),
    );
  }

  function exportXlsx(): void {
    if (projectId === null) return;
    void run(() =>
      downloadProjectExportXlsx({
        projectId,
        includeDeleted: false,
        predicate,
        authState: null,
      }),
    );
  }

  function exportZip(): void {
    if (projectId === null) return;
    void run(() =>
      downloadProjectExportZip({
        projectId,
        includeDeleted: false,
        includeAttachments: true,
        includeActivity: false,
        predicate,
        authState: null,
      }),
    );
  }
</script>

{#if projectId !== null}
  <div class="relative inline-block">
    <button
      bind:this={triggerEl}
      type="button"
      class="inline-flex h-7 w-7 items-center justify-center rounded border border-border bg-bg text-muted hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label="Export filtered tasks"
      title={running ? 'Exporting…' : 'Export filtered tasks'}
      data-testid="export-menu-trigger"
      disabled={running}
      onclick={() => (open ? closeMenu() : void openMenu())}
    >
      <svg viewBox="0 0 16 16" class="h-3.5 w-3.5" aria-hidden="true">
        <!-- Tray + down arrow: classic "download" glyph. -->
        <path
          d="M8 2 L8 10 M5 7 L8 10 L11 7"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          fill="none"
        />
        <path
          d="M3 12 L3 13.5 L13 13.5 L13 12"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          fill="none"
        />
      </svg>
    </button>

    {#if open}
      <div
        bind:this={popupEl}
        role="menu"
        class="kf-float-anchor-fade z-50 flex w-52 flex-col overflow-hidden rounded-md border border-border bg-bg py-1 text-sm shadow-lg"
        data-testid="export-menu-popup"
      >
        <div class="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
          Export filtered tasks
        </div>
        <button
          type="button"
          role="menuitem"
          class="px-3 py-1.5 text-left text-fg hover:bg-surface focus:outline-none focus-visible:bg-surface"
          onclick={exportCsv}
        >
          As CSV
        </button>
        <button
          type="button"
          role="menuitem"
          class="px-3 py-1.5 text-left text-fg hover:bg-surface focus:outline-none focus-visible:bg-surface"
          onclick={exportXlsx}
        >
          As Excel (.xlsx)
        </button>
        <button
          type="button"
          role="menuitem"
          class="px-3 py-1.5 text-left text-fg hover:bg-surface focus:outline-none focus-visible:bg-surface"
          onclick={exportZip}
        >
          As ZIP (with attachments)
        </button>
      </div>
    {/if}
  </div>
{/if}
