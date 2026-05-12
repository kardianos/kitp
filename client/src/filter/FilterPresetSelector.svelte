<script lang="ts">
  /**
   * Tiny combobox that lists the saved `filter` cards for a screen and
   * fires `onchange` when the user picks one. The parent owns the
   * active filter id and applies the preset's predicate / axes — this
   * component is presentation only.
   */
  import type { CardWithAttrs, ID } from '../reg/types';
  import Combobox from '../ui/Combobox.svelte';
  import { readTitle } from './screen_preset.svelte';

  interface Props {
    filters: CardWithAttrs[];
    activeId: ID | null;
    onchange: (id: ID | null) => void;
  }

  let { filters, activeId, onchange }: Props = $props();

  const options = $derived.by((): { value: string; label: string }[] => {
    return filters.map((f) => ({ value: f.id.toString(), label: readTitle(f) }));
  });

  const selected = $derived<string | null>(
    activeId !== null ? activeId.toString() : null,
  );

  function onPick(v: string | string[] | null): void {
    if (Array.isArray(v)) return;
    if (v === null || v === '') {
      onchange(null);
      return;
    }
    try {
      onchange(BigInt(v));
    } catch {
      /* ignore unparseable */
    }
  }
</script>

<!-- Skip the picker entirely when the screen has no saved filters; the
     screen still works (no preset = blank predicate). -->
{#if filters.length > 0}
  <div class="flex items-center gap-1 text-xs text-muted">
    <span>View:</span>
    <span class="w-40">
      <Combobox
        aria-label="Saved filter preset"
        options={options}
        value={selected}
        searchable={filters.length > 8}
        placeholder="Default"
        onchange={onPick}
      />
    </span>
  </div>
{/if}
