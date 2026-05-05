<script lang="ts">
  import { cx } from '../util/class_names.js';

  interface Props {
    name: string;
    size?: 'sm' | 'md' | 'lg';
    class?: string;
  }

  let { name, size = 'md', class: klass = '' }: Props = $props();

  function initials(n: string): string {
    const parts = n.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) {
      const p0 = parts[0];
      return ((p0 ? p0.charAt(0) : '?')).toUpperCase();
    }
    const p0 = parts[0];
    const pn = parts[parts.length - 1];
    const first = p0 ? p0.charAt(0) : '';
    const last = pn ? pn.charAt(0) : '';
    return (first + last).toUpperCase();
  }

  /** Stable hue derived from a 32-bit FNV-ish name hash. */
  function hueFromName(n: string): number {
    let h = 2166136261;
    for (let i = 0; i < n.length; i++) {
      h ^= n.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) % 360;
  }

  const initialsText = $derived(initials(name));
  const hue = $derived(hueFromName(name));
  const bg = $derived(`hsl(${hue}, 55%, 45%)`);

  const sizeClass = $derived.by(() => {
    switch (size) {
      case 'sm':
        return 'h-6 w-6 text-[10px]';
      case 'lg':
        return 'h-12 w-12 text-base';
      default:
        return 'h-8 w-8 text-xs';
    }
  });
</script>

<span
  class={cx(
    'inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white select-none',
    sizeClass,
    klass,
  )}
  style="background-color: {bg}"
  title={name}
  aria-label={name}
>
  {initialsText}
</span>
