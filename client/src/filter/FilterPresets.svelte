<script lang="ts">
  /**
   * "Saved filters" dropdown — localStorage-backed named presets,
   * scoped per screen via the `scope` prop.
   *
   * Storage layout (one localStorage entry per preset):
   *
   *   key   = `kitp.filter.<scope>.<presetName>`
   *   value = JSON.stringify(predicateToJson(predicate))
   *
   * One entry per preset (rather than a single index blob) keeps writes
   * cheap and allows partial corruption recovery — a malformed preset
   * is silently skipped on read instead of poisoning the whole list.
   *
   * MVP only; a future phase can swap the backend to a server-side
   * `filter_preset.{select,save,delete}` handler (§5.9 of the plan).
   */

  import { tick } from 'svelte';
  import {
    autoUpdate,
    computePosition,
    flip,
    offset,
  } from '@floating-ui/dom';
  import Button from '../ui/Button.svelte';
  import IconButton from '../ui/IconButton.svelte';
  import {
    predicateFromJson,
    predicateToJson,
    type Predicate,
  } from './predicate.js';

  interface Props {
    scope: string;
    predicate: Predicate | null;
    onLoad: (p: Predicate | null) => void;
  }

  let { scope, predicate, onLoad }: Props = $props();

  /* ---- localStorage helpers ---------------------------------------------- */

  function keyPrefix(): string {
    return `kitp.filter.${scope}.`;
  }

  /** Read every preset for this scope. Empty array if storage unavailable. */
  function readPresets(): { name: string; predicate: Predicate | null }[] {
    if (typeof localStorage === 'undefined') return [];
    const prefix = keyPrefix();
    const out: { name: string; predicate: Predicate | null }[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k === null) continue;
        if (!k.startsWith(prefix)) continue;
        const name = k.slice(prefix.length);
        const raw = localStorage.getItem(k);
        if (raw === null) continue;
        try {
          if (raw === 'null') {
            out.push({ name, predicate: null });
            continue;
          }
          const parsed = JSON.parse(raw);
          out.push({ name, predicate: predicateFromJson(parsed) });
        } catch {
          // Corrupt entry — skip silently.
        }
      }
    } catch {
      // localStorage may throw in privacy contexts; treat as empty.
      return [];
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  function writePreset(name: string, p: Predicate | null) {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = p === null ? 'null' : JSON.stringify(predicateToJson(p));
      localStorage.setItem(keyPrefix() + name, raw);
    } catch {
      // ignored
    }
  }

  function deletePreset(name: string) {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.removeItem(keyPrefix() + name);
    } catch {
      // ignored
    }
  }

  /* ---- Reactive state ---------------------------------------------------- */

  // Track a "version" we bump on every save/delete to force `presets` to
  // re-read storage. Simpler than a storage-event listener and good enough
  // for an MVP single-tab UX.
  let storageVersion = $state(0);
  // Re-read whenever the dropdown opens or the version bumps.
  let open = $state(false);
  let savingNew = $state(false);
  let newName = $state('');

  const presets = $derived.by(() => {
    void storageVersion;
    void scope;
    if (!open) return [];
    return readPresets();
  });

  /* ---- Floating dropdown plumbing --------------------------------------- */

  let triggerEl: HTMLButtonElement | null = $state(null);
  let popupEl: HTMLDivElement | null = $state(null);
  let cleanupFloat: (() => void) | null = null;

  async function openMenu() {
    open = true;
    await tick();
    if (!triggerEl || !popupEl) return;
    cleanupFloat?.();
    cleanupFloat = autoUpdate(triggerEl, popupEl, () => {
      if (!triggerEl || !popupEl) return;
      void computePosition(triggerEl, popupEl, {
        placement: 'bottom-end',
        middleware: [offset(4), flip()],
      }).then(({ x, y }) => {
        if (!popupEl) return;
        // Reveal only once positioned — see Combobox.svelte for the
        // rationale (avoids the (0,0) flash before computePosition).
        Object.assign(popupEl.style, {
          left: `${x}px`,
          top: `${y}px`,
          visibility: 'visible',
        });
      });
    });
  }

  function closeMenu() {
    open = false;
    savingNew = false;
    newName = '';
    cleanupFloat?.();
    cleanupFloat = null;
  }

  function onDocPointerDown(e: PointerEvent) {
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
      cleanupFloat?.();
    };
  });

  /* ---- Actions ----------------------------------------------------------- */

  function load(p: Predicate | null) {
    onLoad(p);
    closeMenu();
  }

  function commitSave() {
    const name = newName.trim();
    if (name === '') return;
    writePreset(name, predicate);
    storageVersion += 1;
    savingNew = false;
    newName = '';
  }

  function remove(name: string) {
    deletePreset(name);
    storageVersion += 1;
  }

  function onNewKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      savingNew = false;
      newName = '';
    }
  }
</script>

<div class="relative inline-block">
  <button
    bind:this={triggerEl}
    type="button"
    class="inline-flex h-9 items-center gap-1 rounded-md border border-border bg-surface px-3 text-sm text-fg hover:bg-border/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    aria-haspopup="menu"
    aria-expanded={open}
    onclick={() => (open ? closeMenu() : openMenu())}
  >
    <span>Saved filters</span>
    <svg viewBox="0 0 12 12" class="h-3 w-3 text-muted" aria-hidden="true">
      <path
        d="M2 4 L6 8 L10 4"
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
      class="z-50 flex w-64 flex-col overflow-hidden rounded-md border border-border bg-bg shadow-lg"
      role="menu"
      style="position: fixed; left: 0; top: 0; visibility: hidden;"
    >
      <ul class="max-h-64 overflow-auto py-1 text-sm">
        {#if presets.length === 0}
          <li class="px-3 py-2 text-muted">No saved filters yet.</li>
        {:else}
          {#each presets as p (p.name)}
            <li class="flex items-center gap-1 px-2 py-1">
              <button
                type="button"
                class="flex-1 truncate rounded px-2 py-1 text-left hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                onclick={() => load(p.predicate)}
              >
                {p.name}
              </button>
              <IconButton
                aria-label="Delete preset {p.name}"
                variant="ghost"
                size="sm"
                onclick={() => remove(p.name)}
              >
                ×
              </IconButton>
            </li>
          {/each}
        {/if}
      </ul>

      <div class="border-t border-border p-2">
        {#if savingNew}
          <div class="flex gap-1">
            <input
              type="text"
              placeholder="Preset name"
              bind:value={newName}
              onkeydown={onNewKeydown}
              class="h-8 flex-1 rounded border border-border bg-bg px-2 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
            <Button
              size="sm"
              variant="primary"
              disabled={newName.trim() === ''}
              onclick={commitSave}
            >
              Save
            </Button>
          </div>
        {:else}
          <Button
            size="sm"
            variant="secondary"
            class="w-full"
            onclick={() => {
              savingNew = true;
              newName = '';
            }}
          >
            Save current as…
          </Button>
        {/if}
      </div>
    </div>
  {/if}
</div>
