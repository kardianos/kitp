<!--
  MilkdownComposer — a Markdown editor with slash commands and (optional)
  image upload, built on Milkdown / ProseMirror.

  Surface:
    - `bind:value` round-trips the document as Markdown. External writes
       to `value` (e.g. clearing after submit) replace the doc; internal
       changes update the bound value via the listener plugin.
    - `placeholder` is rendered by ProseMirror's empty-paragraph CSS hook
       (`[data-placeholder]` on the doc's first paragraph).
    - `onUploadImage(file)` (optional) returns `{src, alt}` for an inline
       image; when omitted the composer disables image upload entirely.
    - `disabled` reads as a non-editable view (useful while a parent is
       awaiting submission).

  Slash menu:
    The slash plugin tracks the "/" trigger; we keep our own DIV that the
    plugin positions via floating-ui. Items come from `slash_menu.ts`.
    Keyboard: arrows move selection, Enter applies, Esc hides. Mouse
    clicks apply directly.

  Theming:
    The editor body is styled via scoped CSS that reads the same
    `--color-*` tokens the rest of the app uses, so light/dark flip
    automatically with `data-theme="dark"` on <html>.
-->
<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';

  import {
    Editor,
    rootCtx,
    defaultValueCtx,
    editorViewOptionsCtx,
    editorViewCtx,
  } from '@milkdown/core';
  import { commonmark } from '@milkdown/preset-commonmark';
  import { gfm } from '@milkdown/preset-gfm';
  import { listener, listenerCtx } from '@milkdown/plugin-listener';
  import { slashFactory, SlashProvider } from '@milkdown/plugin-slash';
  import { upload, uploadConfig, type Uploader } from '@milkdown/plugin-upload';
  import { replaceAll, getMarkdown } from '@milkdown/utils';
  import type { Ctx } from '@milkdown/ctx';

  import { filterSlashItems, type SlashItem } from './slash_menu';
  import { cx } from '../util/class_names';

  interface Props {
    value: string;
    placeholder?: string;
    disabled?: boolean;
    /**
     * Optional image-upload hook. Called with one File and expected to
     * resolve to `{src, alt}` — the `src` becomes the image node's URL.
     * When undefined the composer disables drop/paste image handling.
     */
    onUploadImage?: (file: File) => Promise<{ src: string; alt: string }>;
    class?: string;
  }

  let {
    value = $bindable(''),
    placeholder = 'Write…',
    disabled = false,
    onUploadImage,
    class: klass = '',
  }: Props = $props();

  /* -------------------------------------------------------- mount nodes */

  let editorEl: HTMLDivElement | null = $state(null);
  let slashEl: HTMLDivElement | null = $state(null);

  /* -------------------------------------------------- slash menu state */

  /**
   * Items currently visible in the slash menu. Reset by the slash
   * provider's onShow; filtered by the query characters typed after "/".
   */
  let slashItems = $state<readonly SlashItem[]>([]);
  let slashSelected = $state(0);
  let slashOpen = $state(false);
  /** The "/" trigger position so we can delete the slash + query on apply. */
  let slashTriggerFrom = $state(0);
  let slashQuery = $state('');

  /* ------------------------------------------------------ editor handle */

  let editor: Editor | null = null;
  let slashProvider: SlashProvider | null = null;
  /** True while we're applying an external `value` write so the listener
   *  won't loop the change back. */
  let applyingExternal = false;

  /* ----------------------------------------------------------- mount */

  onMount(async () => {
    if (editorEl === null || slashEl === null) return;

    // Slash plugin is paired with a single $ctx + $prose. The factory
    // gives us a tuple we register on the editor.
    const slash = slashFactory('main-slash');

    // The uploader bridges Milkdown's image-upload plugin to whatever
    // upload hook the caller passed. When the caller didn't pass one,
    // images dropped/pasted fall through to plain text (no upload).
    const uploader: Uploader = async (files, schema) => {
      if (onUploadImage === undefined) return [];
      const imageType = schema.nodes.image;
      if (imageType === undefined) return [];
      const nodes = [];
      for (let i = 0; i < files.length; i++) {
        const file = files.item(i);
        if (file === null) continue;
        if (!file.type.startsWith('image/')) continue;
        try {
          const { src, alt } = await onUploadImage(file);
          const node = imageType.createAndFill({ src, alt });
          if (node !== null) nodes.push(node);
        } catch (e) {
          // Fail soft: a failed upload should not crash the editor.
          // The parent can surface the error via its own notification.
          console.error('image upload failed', e);
        }
      }
      return nodes;
    };

    editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, editorEl as HTMLElement);
        ctx.set(defaultValueCtx, value);
        ctx.update(editorViewOptionsCtx, (prev) => ({
          ...prev,
          editable: () => !disabled,
          attributes: {
            class: 'milkdown-editor-content',
            'data-testid': 'milkdown-editor',
          },
        }));
        // Slash spec wires the prosemirror plugin to the SlashProvider.
        ctx.set(slash.key, {
          view: () => ({
            update: (view, prevState) => slashProvider?.update(view, prevState),
            destroy: () => slashProvider?.destroy(),
          }),
        });
        // Upload config: hook the uploader; disable HTML-file fallback
        // so we never insert raw <img> tags the renderer would have to
        // sanitise on the way back out.
        ctx.update(uploadConfig.key, (prev) => ({
          ...prev,
          uploader,
          enableHtmlFileUploader: false,
        }));
      })
      .use(commonmark)
      .use(gfm)
      .use(listener)
      .use(upload)
      .use(slash)
      .create();

    // Markdown round-trip: when the user edits, push the resulting
    // markdown back through the bound prop. Guard against the loop where
    // we just applied an external value.
    editor.action((ctx) => {
      ctx.get(listenerCtx).markdownUpdated((_c, md) => {
        if (applyingExternal) return;
        value = md;
      });
    });

    // SlashProvider must be constructed after the editor exists so it
    // can append its content element to the editor's parent.
    slashProvider = new SlashProvider({
      content: slashEl as HTMLElement,
      // floating-ui middleware would land here if we wanted shift/flip
      // behaviour; the defaults already flip on viewport edge.
      shouldShow: (view) => {
        const content = slashProvider?.getContent(view);
        if (content === undefined) return false;
        const trigger = content.at(-1);
        if (trigger !== '/') {
          // The trigger is no longer right under the cursor — but we
          // still want the menu open if the user has been typing a
          // filter. Detect that by checking whether the last "/" we
          // saw is still in the current paragraph and nothing has
          // been deleted past it.
          const idx = content.lastIndexOf('/');
          if (idx < 0) return false;
          slashQuery = content.slice(idx + 1);
          slashItems = filterSlashItems(slashQuery);
          slashSelected = 0;
          return slashItems.length > 0;
        }
        // Trigger just typed — show the full menu.
        slashQuery = '';
        slashItems = filterSlashItems('');
        slashSelected = 0;
        slashTriggerFrom = view.state.selection.from - 1;
        return true;
      },
    });
    slashProvider.onShow = () => {
      slashOpen = true;
    };
    slashProvider.onHide = () => {
      slashOpen = false;
    };
  });

  /* --------------------------------------------------------- destroy */

  onDestroy(() => {
    slashProvider?.destroy();
    editor?.destroy().catch(() => {
      /* swallow — destruction during teardown is best-effort */
    });
  });

  /* ------------------------------------- external value synchronisation */

  /**
   * When the parent rewrites `value` (e.g. clearing after submit), push
   * the new markdown into the editor. Skip the round-trip when the value
   * we already emitted matches — replaceAll would dispatch a transaction
   * that re-fires markdownUpdated and we'd flicker the editor for nothing.
   */
  $effect(() => {
    // Read `value` unconditionally so Svelte tracks it as a dependency
    // even on the first run (when `editor` is null because Editor.make()
    // is still async-resolving in onMount). Without this read-first the
    // initial early-return prevents `value` from being a dep, and later
    // parent writes to `value` (e.g. clear-on-submit) silently drop.
    const next = value;
    if (editor === null) return;
    const current = editor.action((ctx) => getMarkdown()(ctx));
    if (current === next) return;
    applyingExternal = true;
    editor.action(replaceAll(next));
    void tick().then(() => {
      applyingExternal = false;
    });
  });

  /* ----------------------------------------------- slash menu interaction */

  function applySlashItem(item: SlashItem): void {
    if (editor === null) return;
    // Delete the typed "/<query>" range first so the wrap/insert command
    // runs against a clean paragraph; then dispatch the menu item.
    //
    // We can't trust `slashTriggerFrom` captured in shouldShow — the
    // SlashProvider debounces at 200ms, so a typing burst can fire
    // shouldShow only once at the final state where the trigger char
    // is no longer "/". Scan backwards from the live cursor instead,
    // which is correct regardless of how many keystrokes arrived.
    editor.action((ctx: Ctx) => {
      const view = ctx.get(editorViewCtx);
      const { from } = view.state.selection;
      const resolved = view.state.selection.$from;
      // textBetween from the parent's start up to the cursor lets us
      // find the last "/" in the current block. Limit the scan to 200
      // chars — slash queries are short and we don't want to scan
      // arbitrary text content for nothing.
      const start = Math.max(0, resolved.parentOffset - 200);
      const text = resolved.parent.textBetween(
        start,
        resolved.parentOffset,
        undefined,
        '￼',
      );
      const idx = text.lastIndexOf('/');
      if (idx >= 0) {
        const slashDocPos = from - (resolved.parentOffset - (start + idx));
        const tr = view.state.tr.delete(slashDocPos, from);
        view.dispatch(tr);
      }
      item.apply(ctx);
    });
    slashOpen = false;
  }

  function onSlashKeydown(e: KeyboardEvent): void {
    if (!slashOpen) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      slashSelected = (slashSelected + 1) % slashItems.length;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      slashSelected = (slashSelected - 1 + slashItems.length) % slashItems.length;
    } else if (e.key === 'Enter') {
      const it = slashItems[slashSelected];
      if (it !== undefined) {
        e.preventDefault();
        applySlashItem(it);
      }
    } else if (e.key === 'Escape') {
      slashOpen = false;
      slashProvider?.hide();
    }
  }
</script>

<svelte:window onkeydown={onSlashKeydown} />

<div class={cx('milkdown-wrap', klass)} data-disabled={disabled ? '' : undefined}>
  <div bind:this={editorEl} class="milkdown-host"></div>

  <!-- Slash menu. Positioned by floating-ui via SlashProvider. The
       `data-show` attribute toggles visibility; we render the list
       conditionally so it isn't focusable when hidden. -->
  <div bind:this={slashEl} class="milkdown-slash" role="menu">
    {#if slashOpen && slashItems.length > 0}
      <ul class="flex max-h-64 flex-col gap-0 overflow-y-auto py-1">
        {#each slashItems as it, i (it.id)}
          <li>
            <button
              type="button"
              class={cx(
                'flex w-full items-center justify-between gap-3 px-3 py-1 text-left text-sm',
                i === slashSelected ? 'bg-accent/15 text-fg' : 'text-fg hover:bg-accent/10',
              )}
              data-slash-item={it.id}
              onclick={() => applySlashItem(it)}
              onmouseenter={() => (slashSelected = i)}
            >
              <span>{it.label}</span>
              <span class="text-xs text-muted">{it.hint}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<style>
  /* Container: matches the textarea style the editor replaces. */
  .milkdown-wrap {
    border: 1px solid color-mix(in srgb, var(--color-fg) 40%, transparent);
    background: var(--color-bg);
    color: var(--color-fg);
    border-radius: 0; /* match the previous textarea aesthetic */
  }
  .milkdown-wrap[data-disabled] {
    opacity: 0.6;
    pointer-events: none;
  }
  .milkdown-host {
    min-height: 5rem;
    padding: 0.5rem 0.75rem;
    font-size: 0.875rem;
    line-height: 1.4;
  }
  .milkdown-host :global(.milkdown-editor-content) {
    outline: none;
    min-height: 4rem;
  }
  /* Empty-state placeholder. ProseMirror exposes a `data-placeholder`
     attribute on empty doc-firsts when configured; Milkdown's commonmark
     preset does this for the first paragraph. */
  .milkdown-host :global(p.is-empty):first-child::before {
    content: attr(data-placeholder);
    color: var(--color-muted);
    pointer-events: none;
    height: 0;
    float: left;
  }

  /* Headings, lists, blockquote, code — readable defaults sized for
     a comment composer rather than a document. Light + dark inherit
     from the global tokens. */
  .milkdown-host :global(h1) {
    font-size: 1.25rem;
    font-weight: 600;
    margin: 0.5rem 0 0.25rem;
  }
  .milkdown-host :global(h2) {
    font-size: 1.1rem;
    font-weight: 600;
    margin: 0.5rem 0 0.25rem;
  }
  .milkdown-host :global(h3) {
    font-size: 1rem;
    font-weight: 600;
    margin: 0.4rem 0 0.2rem;
  }
  .milkdown-host :global(p) {
    margin: 0.25rem 0;
  }
  .milkdown-host :global(ul),
  .milkdown-host :global(ol) {
    padding-left: 1.4rem;
    margin: 0.25rem 0;
  }
  .milkdown-host :global(ul) {
    list-style: disc;
  }
  .milkdown-host :global(ol) {
    list-style: decimal;
  }
  .milkdown-host :global(blockquote) {
    border-left: 3px solid color-mix(in srgb, var(--color-fg) 30%, transparent);
    padding-left: 0.6rem;
    color: var(--color-muted);
    margin: 0.4rem 0;
  }
  .milkdown-host :global(code) {
    background: var(--color-surface);
    padding: 0.05em 0.3em;
    border-radius: 0.2em;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85em;
  }
  .milkdown-host :global(pre) {
    background: var(--color-surface);
    padding: 0.5rem 0.6rem;
    border-radius: 0.3rem;
    margin: 0.4rem 0;
  }
  .milkdown-host :global(pre code) {
    background: transparent;
    padding: 0;
  }
  .milkdown-host :global(table) {
    border-collapse: collapse;
    margin: 0.5rem 0;
  }
  .milkdown-host :global(th),
  .milkdown-host :global(td) {
    border: 1px solid color-mix(in srgb, var(--color-fg) 25%, transparent);
    padding: 0.25rem 0.5rem;
  }
  .milkdown-host :global(img) {
    max-width: 100%;
    height: auto;
    border-radius: 0.25rem;
  }
  .milkdown-host :global(hr) {
    border: 0;
    border-top: 1px solid color-mix(in srgb, var(--color-fg) 25%, transparent);
    margin: 0.5rem 0;
  }

  /* Slash menu. Positioned absolutely by floating-ui — the SlashProvider
     sets left/top inline. `data-show=false` keeps it in the DOM but
     out of the layout flow. */
  .milkdown-slash {
    position: absolute;
    z-index: 60;
    min-width: 14rem;
    background: var(--color-bg);
    border: 1px solid color-mix(in srgb, var(--color-fg) 30%, transparent);
    border-radius: 0.375rem;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  }
  /* SlashProvider toggles this attribute imperatively — Svelte can't
     see it statically, so escape its scoping check with :global. */
  :global(.milkdown-slash[data-show='false']) {
    visibility: hidden;
    pointer-events: none;
  }
</style>
