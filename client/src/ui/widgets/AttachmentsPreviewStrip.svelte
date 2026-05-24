<script lang="ts">
  /**
   * Visual strip of image + PDF attachments for one card, with a built-in
   * gallery modal. Renders only attachments classified as `image` or `pdf`
   * by the server (everything else stays in the right-rail
   * AttachmentsSection list).
   *
   * - Each tile is a small JPEG thumbnail (or a placeholder for PDFs and
   *   for images whose thumb generation failed) plus a length-limited
   *   filename (prefix...suffix.ext) underneath.
   * - Click a tile to open the gallery modal at that index. Inside the
   *   modal, ←/→ navigate; Esc / overlay click closes; for PDFs we hand
   *   bytes off to a fullscreen <iframe> so the browser's native PDF
   *   viewer renders them.
   *
   * Per-tile blob URL ownership lives in {@link AttachmentThumbImage};
   * the gallery's full-size view lives in {@link AttachmentInlineView}.
   * That keeps URL lifecycles tied to the component instance that
   * actually mounts the underlying `<img>` / `<iframe>` element, so
   * unmounting the DOM automatically revokes its URL with no chance
   * of the browser hitting a revoked URL.
   *
   * The strip fetches its own attachment list — the `version` prop lets
   * a parent (TaskDetailScreen) bump a counter to force a refetch after
   * uploads / deletes from the right rail.
   */

  import { tick } from 'svelte';
  import { getDispatcher } from '../../dispatch/context';
  import { attachmentList } from '../../reg/handlers';
  import type {
    AttachmentListInput,
    AttachmentListOutput,
    AttachmentRow,
    ID,
  } from '../../reg/types';
  import { cx } from '../../util/class_names';
  import AttachmentThumbImage from './AttachmentThumbImage.svelte';
  import AttachmentInlineView from './AttachmentInlineView.svelte';

  interface Props {
    cardId: ID;
    /**
     * Bumped by the parent each time the underlying attachment list might
     * have changed (upload finished, delete committed elsewhere).
     */
    version?: number;
  }

  let { cardId, version = 0 }: Props = $props();

  const dispatcher = getDispatcher();

  let rows = $state<AttachmentRow[]>([]);

  /** The kind subset shown in the strip: `image` and `pdf` only. */
  const previewable = $derived(
    rows.filter((r) => r.kind === 'image' || r.kind === 'pdf'),
  );

  // ---------------------------------------------------------------------- //
  // Data fetch                                                             //
  // ---------------------------------------------------------------------- //

  async function refresh(): Promise<void> {
    if (cardId === 0n) {
      rows = [];
      return;
    }
    try {
      const out = await dispatcher.request<
        AttachmentListInput,
        AttachmentListOutput
      >({
        endpoint: attachmentList.endpoint,
        action: attachmentList.action,
        data: { cardId },
      });
      rows = out.rows;
    } catch {
      // The right-rail AttachmentsSection surfaces fetch failures already;
      // the strip stays silent on its own list-load errors so we don't
      // double-toast.
      rows = [];
    }
  }

  $effect(() => {
    void cardId;
    void version;
    void refresh();
  });

  // ---------------------------------------------------------------------- //
  // Filename truncation                                                    //
  // ---------------------------------------------------------------------- //

  /** prefix...suffix.ext, where the dots are literal ASCII. */
  function truncateFilename(name: string, max = 18): string {
    if (name.length <= max) return name;
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot) : '';
    const base = dot > 0 ? name.slice(0, dot) : name;
    // Reserve 3 chars for "..." plus the extension.
    const keep = max - 3 - ext.length;
    if (keep < 4) {
      // Filename basically all extension; just hard-truncate.
      return name.slice(0, Math.max(1, max - 3)) + '...';
    }
    const head = Math.ceil(keep * 0.6);
    const tail = keep - head;
    return base.slice(0, head) + '...' + base.slice(base.length - tail) + ext;
  }

  // ---------------------------------------------------------------------- //
  // Gallery modal                                                          //
  // ---------------------------------------------------------------------- //

  let galleryOpen = $state(false);
  let galleryIndex = $state(0);
  /** Element we restore focus to on close. */
  let lastFocused: HTMLElement | null = null;
  let dialogEl: HTMLDivElement | null = $state(null);

  const galleryRow = $derived(previewable[galleryIndex] ?? null);

  function openAt(idx: number): void {
    if (idx < 0 || idx >= previewable.length) return;
    lastFocused = (document.activeElement as HTMLElement | null) ?? null;
    galleryIndex = idx;
    galleryOpen = true;
  }

  function closeGallery(): void {
    if (!galleryOpen) return;
    galleryOpen = false;
    if (lastFocused) {
      const el = lastFocused;
      lastFocused = null;
      queueMicrotask(() => el.focus?.());
    }
  }

  function step(delta: number): void {
    if (previewable.length === 0) return;
    const next = (galleryIndex + delta + previewable.length) % previewable.length;
    galleryIndex = next;
  }

  // Focus the dialog after open so keyboard navigation works without an
  // initial click.
  $effect(() => {
    if (!galleryOpen) return;
    void tick().then(() => {
      dialogEl?.focus();
    });
  });

  // Capture-phase keydown so the gallery handles Esc / q / arrows
  // BEFORE the global shortcut dispatcher (which is registered as a
  // bubble-phase listener at app boot). With this in place pressing Esc
  // while the gallery is open closes only the gallery — the screen's
  // own Esc-to-goBack stays inert until the second press, by which
  // point the gallery is already closed.
  $effect(() => {
    if (!galleryOpen) return;
    const onCapture = (e: KeyboardEvent): void => {
      if (!galleryOpen) return;
      switch (e.key) {
        case 'Escape':
        case 'q':
          e.preventDefault();
          e.stopImmediatePropagation();
          closeGallery();
          return;
        case 'ArrowRight':
        case ']':
          e.preventDefault();
          e.stopImmediatePropagation();
          step(1);
          return;
        case 'ArrowLeft':
        case '[':
          e.preventDefault();
          e.stopImmediatePropagation();
          step(-1);
          return;
      }
    };
    window.addEventListener('keydown', onCapture, true /* capture */);
    return () => {
      window.removeEventListener('keydown', onCapture, true);
    };
  });

  function portal(node: HTMLElement) {
    const body = typeof document !== 'undefined' ? document.body : null;
    if (body) body.appendChild(node);
    return {
      destroy() {
        if (node.parentNode) node.parentNode.removeChild(node);
      },
    };
  }
</script>

{#if previewable.length > 0}
  <section
    aria-label="Attachment previews"
    class="border-t border-section"
    data-testid="attachments-preview-strip"
  >
    <div class="flex flex-wrap gap-3 px-3 py-2">
      {#each previewable as item, idx (item.id)}
        <button
          type="button"
          class={cx(
            'group flex w-24 flex-col items-stretch gap-1 rounded border border-fg/15 bg-surface/30 p-1.5 text-left',
            'hover:border-accent hover:bg-surface/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          )}
          title={item.filename}
          onclick={() => openAt(idx)}
          data-testid="attachment-thumb-tile"
        >
          <div class="flex h-20 w-full items-center justify-center overflow-hidden bg-bg">
            {#if item.kind === 'image' && item.thumb_file_id > 0}
              <AttachmentThumbImage
                attachmentId={item.id}
                alt=""
                class="max-h-full max-w-full object-contain"
              />
            {:else if item.kind === 'pdf'}
              <!-- Plain SVG document icon — works without external assets. -->
              <svg
                viewBox="0 0 24 24"
                class="h-10 w-10 text-muted"
                aria-hidden="true"
                fill="currentColor"
              >
                <path d="M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 1.5V8h4.5L13 3.5z" />
                <text x="7" y="17" font-size="6" font-family="sans-serif" fill="white">PDF</text>
              </svg>
            {:else}
              <!-- Image without a generated thumb (decode/encode failed) -->
              <svg
                viewBox="0 0 24 24"
                class="h-10 w-10 text-muted"
                aria-hidden="true"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
              >
                <rect x="3" y="4" width="18" height="16" rx="1.5" />
                <circle cx="8" cy="9" r="1.5" />
                <path d="M3 17l5-5 4 4 3-3 6 6" />
              </svg>
            {/if}
          </div>
          <span class="block truncate text-[11px] text-fg" aria-hidden="true">
            {truncateFilename(item.filename)}
          </span>
        </button>
      {/each}
    </div>
  </section>
{/if}

{#if galleryOpen && galleryRow}
  <!-- Fullscreen-ish gallery overlay. We portal it onto <body> so parent
       overflow / transform stacking can't clip the modal. -->
  <div use:portal class="fixed inset-0 z-50 flex items-center justify-center">
    <button
      type="button"
      class="absolute inset-0 bg-black/85"
      aria-label="Close gallery"
      tabindex="-1"
      onclick={closeGallery}
    ></button>

    <div
      bind:this={dialogEl}
      role="dialog"
      aria-modal="true"
      aria-label={galleryRow.filename}
      tabindex="-1"
      class="relative z-10 flex max-h-[95vh] w-[95vw] flex-col gap-2 outline-none"
      data-testid="attachment-gallery"
    >
      <!-- Header bar -->
      <div class="flex items-center justify-between gap-2 text-on-image">
        <span class="truncate text-sm font-medium" title={galleryRow.filename}>
          {galleryRow.filename}
        </span>
        <span class="shrink-0 text-xs text-on-image/70">
          {galleryIndex + 1} / {previewable.length}
        </span>
        <button
          type="button"
          class="ml-2 inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-on-image hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
          onclick={closeGallery}
          aria-label="Close gallery"
        >
          <svg viewBox="0 0 16 16" class="h-4 w-4" aria-hidden="true">
            <path
              d="M4 4 L12 12 M12 4 L4 12"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>

      <!-- Body — image or PDF iframe.
           {#key galleryRow.id} forces a full unmount + remount of the
           inline-view component on each step, so its $effect cleanup
           runs exactly once per row and revokes its blob URL deterministically. -->
      <div class="relative flex flex-1 items-center justify-center overflow-hidden">
        {#key galleryRow.id}
          <AttachmentInlineView
            attachmentId={galleryRow.id}
            kind={galleryRow.kind}
            filename={galleryRow.filename}
          />
        {/key}

        {#if previewable.length > 1}
          <button
            type="button"
            class="absolute left-1 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-on-image hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
            onclick={() => step(-1)}
            aria-label="Previous"
          >
            <svg viewBox="0 0 16 16" class="h-5 w-5" aria-hidden="true">
              <path
                d="M10 3 L5 8 L10 13"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
                fill="none"
              />
            </svg>
          </button>
          <button
            type="button"
            class="absolute right-1 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-on-image hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
            onclick={() => step(1)}
            aria-label="Next"
          >
            <svg viewBox="0 0 16 16" class="h-5 w-5" aria-hidden="true">
              <path
                d="M6 3 L11 8 L6 13"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
                fill="none"
              />
            </svg>
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}
