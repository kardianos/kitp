<script lang="ts">
  /**
   * Single attachment thumbnail image. Owns the lifecycle of exactly one
   * blob URL — fetched on mount (or when `attachmentId` flips), revoked
   * on unmount or before the next fetch. Tied to a single `<img>`
   * element so the URL can never be revoked while the DOM still
   * references it (which surfaces in the dev console as
   * `ERR_FILE_NOT_FOUND` once the browser tries to decode again).
   *
   * The previous shared-Map approach in AttachmentsPreviewStrip raced:
   * tear-down ran in the strip's $effect *while* the corresponding
   * `<img>` was still in the DOM, leaving the browser to retry a
   * revoked URL. Pinning ownership to the component instance fixes
   * that — Svelte unmounts the `<img>` before running the effect's
   * cleanup, so the URL outlives the DOM that uses it.
   */
  import { getContext } from 'svelte';
  import type { AuthState } from '../../auth/auth_state.svelte';
  import { fetchAttachmentBlob } from '../../attachments/upload';

  interface Props {
    attachmentId: number;
    alt?: string;
    /** Tailwind classes forwarded to the `<img>`. */
    class?: string;
  }

  let { attachmentId, alt = '', class: klass = '' }: Props = $props();

  const authState = getContext<AuthState | null>('authState') ?? null;

  let url = $state<string | null>(null);

  $effect(() => {
    const id = attachmentId; // tracked dep — re-run on prop change
    let cancelled = false;
    let createdUrl: string | null = null;
    void fetchAttachmentBlob(id, 'thumb', authState)
      .then((blob) => {
        if (cancelled) return;
        createdUrl = URL.createObjectURL(blob);
        url = createdUrl;
      })
      .catch(() => {
        // Silent — the parent renders a placeholder when `url` stays null.
      });
    return () => {
      cancelled = true;
      // Drop the rune *before* the URL revoke so any Svelte-driven re-render
      // pulls the `<img>` out of the DOM ahead of the revoke.
      url = null;
      if (createdUrl !== null) {
        URL.revokeObjectURL(createdUrl);
        createdUrl = null;
      }
    };
  });
</script>

{#if url !== null}
  <img src={url} {alt} class={klass} loading="lazy" />
{/if}
