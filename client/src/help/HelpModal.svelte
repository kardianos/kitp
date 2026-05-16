<!--
  HelpModal — renders the page-help markdown returned by either
  help.get_topic (admin screens) or help.get_screen (task screens).
  Mounted by AppShell.svelte; the open flag and topic come from the
  shared `helpContext` store updated by `<HelpButton>`.

  The modal fetches on every open rather than caching: the screen card's
  default filter changes more often than the user opens this dialog, so
  a stale cache here would be worse than a re-fetch. If profiling shows
  the round-trip is felt, add a per-topic cache keyed by (kind, key).
-->
<script lang="ts">
  import { getDispatcher } from '../dispatch/context';
  import { helpGetScreen, helpGetTopic } from '../reg/handlers';
  import type {
    HelpGetScreenInput,
    HelpGetScreenOutput,
    HelpGetTopicInput,
    HelpGetTopicOutput,
  } from '../reg/types';
  import Markdown from '../ui/Markdown.svelte';
  import Modal from '../ui/Modal.svelte';
  import Spinner from '../ui/Spinner.svelte';
  import { helpContext, type HelpTopic } from './help_context.svelte';

  interface Props {
    open: boolean;
  }
  let { open = $bindable() }: Props = $props();

  const dispatcher = getDispatcher();

  let title = $state<string>('Help');
  let markdown = $state<string>('');
  let loading = $state<boolean>(false);
  let error = $state<string | null>(null);

  // Track the last topic we fetched so the $effect re-runs on each open
  // (because we mutate `open` after the fetch settles, simply gating on
  // open + topic identity is enough; no async-cancel dance needed).
  $effect(() => {
    if (!open) return;
    const t = helpContext.topic;
    if (t === null) {
      markdown = '';
      title = 'Help';
      error = 'No help is published for this page yet.';
      return;
    }
    void fetchHelp(t);
  });

  async function fetchHelp(t: HelpTopic): Promise<void> {
    loading = true;
    error = null;
    try {
      if (t.kind === 'topic') {
        const out = await dispatcher.request<HelpGetTopicInput, HelpGetTopicOutput>({
          endpoint: helpGetTopic.endpoint,
          action: helpGetTopic.action,
          data: { topic: t.topic },
        });
        title = out.title;
        markdown = out.markdown;
      } else {
        const out = await dispatcher.request<HelpGetScreenInput, HelpGetScreenOutput>({
          endpoint: helpGetScreen.endpoint,
          action: helpGetScreen.action,
          data: { screenCardId: t.screenCardId },
        });
        title = out.title;
        markdown = out.markdown;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      markdown = '';
    } finally {
      loading = false;
    }
  }
</script>

<Modal bind:open size="lg" {title}>
  {#if loading}
    <div class="flex items-center justify-center py-8">
      <Spinner size="md" />
    </div>
  {:else if error !== null}
    <p class="text-sm text-muted">{error}</p>
  {:else}
    <Markdown source={markdown} />
  {/if}
</Modal>
