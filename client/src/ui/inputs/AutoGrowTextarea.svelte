<!--
  AutoGrowTextarea — textarea that resizes itself to fit its content,
  capped at a fraction of the viewport.

  The browser doesn't auto-grow textareas natively, and `rows="N"` only
  pins a constant initial height. The well-known trick is: set
  `height = 0`, read `scrollHeight`, write `height = scrollHeight` —
  do that on every input. This component bundles the trick + a
  viewport-fraction cap so a 200-line paste doesn't crowd out the rest
  of the page; once we hit the cap we flip `overflow-y: auto` so the
  textarea scrolls internally.

  Bindings:
    - `bind:value`            — the textarea contents
    - `bind:el`               — the underlying `<textarea>` (for focus,
                                 selection, etc.)

  Everything else is a transparent pass-through to the textarea
  element, so callers compose styling via `class` and event handlers
  via the standard `onkeydown` / `onblur` / `onfocus` props.
-->
<script lang="ts">
  import { cx } from '../../util/class_names.js';

  interface Props {
    /** Textarea contents. Two-way bindable. */
    value: string;
    /**
     * Optional one-way escape hatch for callers whose value lives
     * inside a nested record (so `bind:value` would need an awkward
     * getter/setter pair). Fires on every keystroke; the parent owns
     * the write-back. When set, callers usually pass `value=...` rather
     * than `bind:value=...` to avoid the bindable getter/setter dance.
     */
    onValueChange?: (v: string) => void;
    /** Underlying textarea node — bind to it for imperative focus(). */
    el?: HTMLTextAreaElement | null;
    /**
     * Cap on the auto-grown height as a fraction of `window.innerHeight`.
     * Default 0.75 — matches the description editor's spec; tweak per
     * call site if a smaller surface (e.g. inline comment edit) wants
     * less of the screen.
     */
    maxViewportFraction?: number;
    /** Initial height in CSS rows. Passed through to the element. */
    rows?: number;
    placeholder?: string;
    disabled?: boolean;
    class?: string;
    'aria-label'?: string;
    'data-testid'?: string;
    onkeydown?: (e: KeyboardEvent) => void;
    onblur?: (e: FocusEvent) => void;
    onfocus?: (e: FocusEvent) => void;
  }

  let {
    value = $bindable(),
    onValueChange,
    el = $bindable(null),
    maxViewportFraction = 0.75,
    rows = 3,
    placeholder,
    disabled = false,
    class: klass = '',
    'aria-label': ariaLabel,
    'data-testid': testid,
    onkeydown,
    onblur,
    onfocus,
  }: Props = $props();

  // Re-run whenever the content changes (so growth tracks typing /
  // pastes / external updates), whenever the cap moves, or whenever
  // the ref binds for the first time. We reset to 0 before measuring
  // so the height can SHRINK as well as grow.
  $effect(() => {
    void value;
    void maxViewportFraction;
    const t = el;
    if (t === null) return;
    t.style.height = '0px';
    const cap = Math.floor(window.innerHeight * maxViewportFraction);
    const next = Math.min(t.scrollHeight, cap);
    t.style.height = `${next}px`;
    t.style.overflowY = t.scrollHeight > cap ? 'auto' : 'hidden';
  });
</script>

<!--
  When `onValueChange` is supplied we treat the prop as one-way and
  forward keystrokes through it (the parent writes back to whichever
  nested store it owns). Otherwise we fall back to `bind:value` for
  the standard two-way case.
-->
{#if onValueChange !== undefined}
  <textarea
    bind:this={el}
    {value}
    {rows}
    {placeholder}
    {disabled}
    aria-label={ariaLabel}
    data-testid={testid}
    class={cx('block w-full resize-none', klass)}
    oninput={(e) => onValueChange((e.currentTarget as HTMLTextAreaElement).value)}
    {onkeydown}
    {onblur}
    {onfocus}
  ></textarea>
{:else}
  <textarea
    bind:this={el}
    bind:value
    {rows}
    {placeholder}
    {disabled}
    aria-label={ariaLabel}
    data-testid={testid}
    class={cx('block w-full resize-none', klass)}
    {onkeydown}
    {onblur}
    {onfocus}
  ></textarea>
{/if}
