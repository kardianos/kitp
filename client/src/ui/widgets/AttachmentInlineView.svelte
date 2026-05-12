<script lang="ts">
  /**
   * Full-size inline view of an attachment for the gallery modal. Same
   * lifecycle contract as AttachmentThumbImage but pulls the original
   * bytes (the `/view` route) and switches between an `<img>` and an
   * `<iframe>` based on whether it's a PDF.
   *
   * Parents should mount this with a `{#key attachmentId}` wrapper so a
   * new ←/→ paging step actually unmounts + remounts and hits the
   * cleanup path, instead of swapping props and racing a stale fetch
   * against a fresh one.
   */
  import { getContext } from 'svelte';
  import type { AuthState } from '../../auth/auth_state.svelte';
  import { fetchAttachmentBlob } from '../../attachments/upload';
  import type { AttachmentKind, ID } from '../../reg/types';

  interface Props {
    attachmentId: ID;
    kind: AttachmentKind;
    /** Used as `<img alt>` and `<iframe title>` for accessibility. */
    filename: string;
  }

  let { attachmentId, kind, filename }: Props = $props();

  const authState = getContext<AuthState | null>('authState') ?? null;

  let url = $state<string | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  $effect(() => {
    const id = attachmentId;
    let cancelled = false;
    let createdUrl: string | null = null;
    loading = true;
    error = null;
    url = null;
    void fetchAttachmentBlob(id, 'view', authState)
      .then((blob) => {
        if (cancelled) return;
        createdUrl = URL.createObjectURL(blob);
        url = createdUrl;
        loading = false;
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        error = e instanceof Error ? e.message : String(e);
        loading = false;
      });
    return () => {
      cancelled = true;
      url = null;
      if (createdUrl !== null) {
        URL.revokeObjectURL(createdUrl);
        createdUrl = null;
      }
    };
  });
</script>

{#if loading}
  <div class="text-sm text-white/80">Loading…</div>
{:else if error !== null}
  <div role="alert" class="text-sm text-white">Failed to load: {error}</div>
{:else if url !== null && kind === 'pdf'}
  <iframe title={filename} src={url} class="h-[85vh] w-full bg-white"></iframe>
{:else if url !== null}
  <img src={url} alt={filename} class="max-h-[85vh] max-w-full object-contain" />
{/if}
