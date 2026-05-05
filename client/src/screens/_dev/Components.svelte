<script lang="ts">
  import Button from '../../ui/Button.svelte';
  import IconButton from '../../ui/IconButton.svelte';
  import Spinner from '../../ui/Spinner.svelte';
  import Chip from '../../ui/Chip.svelte';
  import Avatar from '../../ui/Avatar.svelte';
  import Modal from '../../ui/Modal.svelte';
  import ConfirmDialog from '../../ui/ConfirmDialog.svelte';
  import EmptyState from '../../ui/EmptyState.svelte';
  import Combobox from '../../ui/Combobox.svelte';
  import DatePicker from '../../ui/DatePicker.svelte';
  import Toast from '../../ui/Toast.svelte';
  import { notify } from '../../ui/toast.svelte.js';

  let modalOpen = $state(false);
  let confirmOpen = $state(false);

  // Combobox: 50+ options for scroll
  type StatusOpt = 'todo' | 'doing' | 'review' | 'done';
  let single = $state<StatusOpt | null>('todo');
  const statusOptions = [
    { value: 'todo' as const, label: 'To do' },
    { value: 'doing' as const, label: 'Doing' },
    { value: 'review' as const, label: 'Review' },
    { value: 'done' as const, label: 'Done' },
  ];

  let multi = $state<string[]>(['alpha', 'gamma']);
  const greekOptions = [
    'alpha','beta','gamma','delta','epsilon','zeta','eta','theta','iota','kappa',
    'lambda','mu','nu','xi','omicron','pi','rho','sigma','tau','upsilon',
    'phi','chi','psi','omega',
  ].map((g) => ({ value: g, label: g }));

  // 50+ options
  const manyOptions = Array.from({ length: 60 }, (_, i) => ({
    value: `opt-${i + 1}`,
    label: `Option ${i + 1}`,
  }));
  let manyChoice = $state<string | null>(null);

  // DatePicker
  let pickedDate = $state<string | null>(null);
  let pickedDate2 = $state<string | null>('2026-05-04');

  // Form fields inside modal
  let formTitle = $state('');
  let formStatus = $state<StatusOpt | null>('todo');
  let formDate = $state<string | null>(null);

  const avatarNames = ['Alice Anderson', 'Bob', 'Charlie Chen', 'Diana Diaz', 'Eve Esposito'];

  function fireSuccess() {
    notify({ type: 'success', message: 'Saved successfully.' });
  }
  function fireError() {
    notify({ type: 'error', message: 'Something went wrong.' });
  }
  function fireInfo() {
    notify({ type: 'info', message: 'Just so you know…' });
  }
  function fireUndo() {
    notify({
      type: 'success',
      message: 'Task deleted.',
      undo: () => notify({ type: 'info', message: 'Task restored.' }),
      durationMs: 8000,
    });
  }
</script>

<div class="mx-auto max-w-5xl space-y-10 p-8">
  <header>
    <h1 class="text-2xl font-semibold">UI primitives — dev gallery</h1>
    <p class="text-sm text-muted">Visual exercise of every primitive. P3 task #7.</p>
  </header>

  <!-- BUTTONS -->
  <section class="space-y-3">
    <h2 class="text-lg font-semibold">Button</h2>
    <div class="flex flex-wrap items-center gap-2">
      <Button variant="primary">{#snippet children()}Primary{/snippet}</Button>
      <Button variant="secondary">{#snippet children()}Secondary{/snippet}</Button>
      <Button variant="ghost">{#snippet children()}Ghost{/snippet}</Button>
      <Button variant="danger">{#snippet children()}Danger{/snippet}</Button>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <Button size="sm">{#snippet children()}Small{/snippet}</Button>
      <Button size="md">{#snippet children()}Medium{/snippet}</Button>
      <Button size="lg">{#snippet children()}Large{/snippet}</Button>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <Button loading>{#snippet children()}Loading{/snippet}</Button>
      <Button disabled>{#snippet children()}Disabled{/snippet}</Button>
      <Button variant="danger" loading>{#snippet children()}Deleting…{/snippet}</Button>
    </div>
  </section>

  <!-- ICONBUTTONS -->
  <section class="space-y-3">
    <h2 class="text-lg font-semibold">IconButton</h2>
    <div class="flex items-center gap-2">
      <IconButton aria-label="Edit small" size="sm">
        {#snippet children()}<span aria-hidden="true">E</span>{/snippet}
      </IconButton>
      <IconButton aria-label="Edit medium" size="md">
        {#snippet children()}<span aria-hidden="true">E</span>{/snippet}
      </IconButton>
      <IconButton aria-label="Edit large" size="lg">
        {#snippet children()}<span aria-hidden="true">E</span>{/snippet}
      </IconButton>
      <IconButton aria-label="Delete" variant="danger">
        {#snippet children()}<span aria-hidden="true">×</span>{/snippet}
      </IconButton>
      <IconButton aria-label="Save" variant="primary">
        {#snippet children()}<span aria-hidden="true">✓</span>{/snippet}
      </IconButton>
    </div>
  </section>

  <!-- SPINNERS -->
  <section class="space-y-3">
    <h2 class="text-lg font-semibold">Spinner</h2>
    <div class="flex items-center gap-4 text-fg">
      <Spinner size="sm" />
      <Spinner size="md" />
      <Spinner size="lg" />
    </div>
  </section>

  <!-- CHIPS -->
  <section class="space-y-3">
    <h2 class="text-lg font-semibold">Chip</h2>
    <div class="flex flex-wrap items-center gap-2">
      <Chip label="default" />
      <Chip label="accent" variant="accent" />
      <Chip label="danger" variant="danger" />
      <Chip label="removable" removable />
      <Chip label="accent removable" variant="accent" removable />
    </div>
  </section>

  <!-- AVATARS -->
  <section class="space-y-3">
    <h2 class="text-lg font-semibold">Avatar</h2>
    <div class="flex items-center gap-2">
      {#each avatarNames as n (n)}
        <Avatar name={n} size="sm" />
      {/each}
    </div>
    <div class="flex items-center gap-2">
      {#each avatarNames as n (n)}
        <Avatar name={n} size="md" />
      {/each}
    </div>
    <div class="flex items-center gap-2">
      {#each avatarNames as n (n)}
        <Avatar name={n} size="lg" />
      {/each}
    </div>
  </section>

  <!-- COMBOBOX -->
  <section class="space-y-3">
    <h2 class="text-lg font-semibold">Combobox</h2>
    <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
      <div>
        <p class="mb-1 text-xs text-muted">Single (4 opts)</p>
        <Combobox bind:value={single} options={statusOptions} placeholder="Select status" />
        <p class="mt-1 text-xs text-muted">Value: {single ?? '(none)'}</p>
      </div>
      <div>
        <p class="mb-1 text-xs text-muted">Multi (Greek letters)</p>
        <Combobox bind:value={multi} options={greekOptions} multiple placeholder="Pick letters" />
        <p class="mt-1 text-xs text-muted">Value: {multi.join(', ') || '(empty)'}</p>
      </div>
      <div>
        <p class="mb-1 text-xs text-muted">60-option searchable</p>
        <Combobox bind:value={manyChoice} options={manyOptions} placeholder="Search…" />
      </div>
    </div>
  </section>

  <!-- DATE PICKER -->
  <section class="space-y-3">
    <h2 class="text-lg font-semibold">DatePicker</h2>
    <div class="flex flex-wrap items-center gap-3">
      <DatePicker bind:value={pickedDate} placeholder="Empty…" />
      <DatePicker bind:value={pickedDate2} />
      <p class="text-xs text-muted">Values: {pickedDate ?? '(null)'} / {pickedDate2 ?? '(null)'}</p>
    </div>
  </section>

  <!-- MODAL -->
  <section class="space-y-3">
    <h2 class="text-lg font-semibold">Modal</h2>
    <Button onclick={() => (modalOpen = true)}>{#snippet children()}Open modal{/snippet}</Button>
    <Modal bind:open={modalOpen} title="Edit task" size="md">
      <form class="flex flex-col gap-3" onsubmit={(e) => { e.preventDefault(); modalOpen = false; }}>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-muted">Title</span>
          <input
            type="text"
            bind:value={formTitle}
            class="rounded border border-border bg-bg px-2 py-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-muted">Status</span>
          <Combobox bind:value={formStatus} options={statusOptions} />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-muted">Due</span>
          <DatePicker bind:value={formDate} />
        </label>
      </form>
      {#snippet footer()}
        <Button variant="ghost" onclick={() => (modalOpen = false)}>{#snippet children()}Cancel{/snippet}</Button>
        <Button onclick={() => (modalOpen = false)}>{#snippet children()}Save{/snippet}</Button>
      {/snippet}
    </Modal>
  </section>

  <!-- CONFIRM DIALOG -->
  <section class="space-y-3">
    <h2 class="text-lg font-semibold">ConfirmDialog</h2>
    <Button variant="danger" onclick={() => (confirmOpen = true)}>
      {#snippet children()}Delete project{/snippet}
    </Button>
    <ConfirmDialog
      bind:open={confirmOpen}
      title="Delete project?"
      message="This will permanently delete the project and all its tasks. This cannot be undone."
      confirmLabel="Delete"
      danger
      onConfirm={() => notify({ type: 'success', message: 'Project deleted.' })}
    />
  </section>

  <!-- TOAST -->
  <section class="space-y-3">
    <h2 class="text-lg font-semibold">Toast</h2>
    <div class="flex flex-wrap items-center gap-2">
      <Button onclick={fireSuccess}>{#snippet children()}Success{/snippet}</Button>
      <Button variant="danger" onclick={fireError}>{#snippet children()}Error{/snippet}</Button>
      <Button variant="secondary" onclick={fireInfo}>{#snippet children()}Info{/snippet}</Button>
      <Button variant="ghost" onclick={fireUndo}>{#snippet children()}With Undo{/snippet}</Button>
    </div>
  </section>

  <!-- EMPTY STATE -->
  <section class="space-y-3">
    <h2 class="text-lg font-semibold">EmptyState</h2>
    <div class="rounded border border-border bg-surface">
      <EmptyState
        title="No tasks yet"
        description="Press n to create the first one, or import from CSV."
        action={{ label: 'New task', onClick: () => notify({ type: 'info', message: 'Would open quick entry.' }) }}
      />
    </div>
  </section>
</div>

<Toast />
