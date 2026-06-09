/**
 * NestedEditor — the richer nested-collection editors that mount in a
 * MasterDetail detail pane below the scalar fields.
 *
 * The plain `MasterDetailRelation` framework (a flat existing-relations list +
 * an inline add form) covers the Users role/person case, but three admin
 * screens need genuinely richer nested editors — a grouped transition list with
 * a mini-form + a delete-guard, a bind/unbind matrix with per-edge required +
 * ordering, and a filter-card manager with a structured predicate editor. Each
 * is a focused, imperative control keyed by a `kind` discriminator; the
 * MasterDetail spawns ONE of them into its detail pane, passing the parent
 * scope so the editor watches the parent's selection.
 *
 * Reactivity: the editor watches `<parentScope>.selectedId` + `<parentScope>.
 * items` (the same leaves the MasterDetail detail effect reads) so a selection
 * change re-renders it. Loads (the flow's steps, every card_type, the value
 * cards for the from/to pickers, the screen's filter cards) fire imperatively
 * through `this.ctx.api.callByName`; writes do too, then RELOAD so the editor
 * reflects server truth (the same posture as MasterDetail's relation reload).
 *
 * The editors hold their OWN state under `<scopeKey>.*` in the tree so a
 * recycled / re-rendered editor never carries stale data.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import type { ApiFault } from '../core/dispatch.js';
import { DropPlaceholder, computeDropTarget } from '../ui/drag-placeholder.js';
import { Modal } from '../ui/modal.js';
import { EditableField } from '../ui/editable-field.js';
import { readPath, fieldText, type MasterDetailItem } from './master-detail.js';
import {
  type Predicate,
  type WireNode,
  toWire,
  fromWire,
  fromWhereLeaves,
} from '../filter/predicate.js';
import type { CardWherePredicate } from '../projects/project-helpers.js';
import type {
  FlowStepRow,
  CardTypeRow,
  AttributeDefRow,
  AttributeDefBoundCardType,
  FlowPreviewDeleteOutput,
  FlowStepBlocker,
  CommChannel,
  ActivitySinkRow,
  UserTokenRow,
  RoleMappingRow,
  RoleRow,
  RoleListOutput,
  UserRoleListOutput,
  UserRoleAssignment,
  FlowRow,
  FlowListOutput,
} from './specs.js';
import {
  type ActivityLeafOp,
  ACTIVITY_LEAF_OPS,
  ACTIVITY_KIND_OPTIONS,
  activityPredicateFromString,
  activityPredicateToString,
  activityOpLabel,
  appendLeaf,
  removeLeafAt,
  setConnective,
  topLevelLeaves,
} from './activity-predicate.js';

/* -------------------------------------------------------------------------- */
/* Config.                                                                     */
/* -------------------------------------------------------------------------- */

export type NestedEditorKind =
  | 'flowSteps'
  | 'edgeMatrix'
  | 'screenFilters'
  | 'activitySinkConfig'
  | 'agentTokens'
  | 'roleMappings';

export interface NestedEditorConfig extends BaseControlConfig {
  type: 'NestedEditor';
  /** Which editor to render. */
  kind: NestedEditorKind;
  /** The PARENT MasterDetail scopeKey (its selectedId + items are watched). */
  parentScope: string;
  /** This editor's own tree namespace for loaded data + draft state. */
  scopeKey: string;
  /** Screen title — set when this editor IS the screen (e.g. the standalone
   *  OIDC Claims Workspace screen) so the admin outlet's breadcrumb reads it. */
  title?: string;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    NestedEditor: NestedEditorConfig;
  }
}

/* -------------------------------------------------------------------------- */
/* Pure helpers (exported for the unit tests).                                 */
/* -------------------------------------------------------------------------- */

export interface FromBucket {
  fromCardId: string;
  steps: FlowStepRow[];
}

/**
 * Bucket flow_steps by `from_card_id`, preserving the server order (sort_order
 * then label) within each bucket and first-seen order across buckets.
 */
export function groupStepsByFrom(steps: readonly FlowStepRow[]): FromBucket[] {
  const order: string[] = [];
  const byId = new Map<string, FromBucket>();
  for (const s of steps) {
    const key = s.from_card_id;
    let b = byId.get(key);
    if (b === undefined) {
      b = { fromCardId: key, steps: [] };
      byId.set(key, b);
      order.push(key);
    }
    b.steps.push(s);
  }
  return order.map((id) => byId.get(id)!).filter((b): b is FromBucket => b !== undefined);
}

/** Numeric-safe compare of two id-shaped strings (wire ids are JSON strings
 *  carrying bigint values). Falls back to localeCompare for non-digit values. */
export function compareIdStrings(a: string, b: string): number {
  const ad = /^-?\d+$/.test(a);
  const bd = /^-?\d+$/.test(b);
  if (ad && bd) {
    const ai = BigInt(a);
    const bi = BigInt(b);
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  }
  return a.localeCompare(b);
}

export interface MatrixRow {
  cardType: CardTypeRow;
  bound: boolean;
  ordering: number;
  required: boolean;
}

/**
 * Build the bind/unbind matrix rows for an attribute_def over every card_type:
 * for each card_type, whether the def is bound to it + its ordering + required
 * flag (0 / false when not bound).
 */
export function boundMatrix(
  cardTypes: readonly CardTypeRow[],
  boundTo: readonly AttributeDefBoundCardType[],
): MatrixRow[] {
  const byId = new Map<string, { ordering: number; required: boolean }>();
  for (const b of boundTo) {
    byId.set(b.card_type_id, { ordering: b.ordering ?? 0, required: b.is_required === true });
  }
  return cardTypes.map((ct) => {
    const hit = byId.get(ct.id);
    return {
      cardType: ct,
      bound: hit !== undefined,
      ordering: hit?.ordering ?? 0,
      required: hit?.required ?? false,
    };
  });
}

/** A flow_step draft for the inline mini-form. */
export interface FlowStepDraft {
  id: string;
  fromCardId: string;
  toCardId: string;
  label: string;
  requiresRoleId: string;
  sortOrder: string;
  /** Presentation bit: true → standalone button in the TransitionBar, false →
   *  folded into the bar's overflow dropdown. Read identically for task + comm. */
  standalone: boolean;
}

/** Validate a flow_step draft: non-empty label + distinct non-zero from/to. */
export function validateStepDraft(d: FlowStepDraft): { ok: boolean; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (d.fromCardId === '' || d.fromCardId === '0') errors['fromCardId'] = 'Pick a starting value';
  if (d.toCardId === '' || d.toCardId === '0') errors['toCardId'] = 'Pick a destination value';
  if (d.fromCardId !== '' && d.fromCardId === d.toCardId && d.fromCardId !== '0') {
    errors['toCardId'] = 'From and To must differ';
  }
  if (d.label.trim() === '') errors['label'] = 'Label is required';
  const so = d.sortOrder.trim();
  if (so !== '' && !/^-?\d+$/.test(so)) errors['sortOrder'] = 'Sort order must be a whole number';
  return { ok: Object.keys(errors).length === 0, errors };
}

/** Parse a UI sort_order string to an int (0 when blank / invalid). */
export function parseSortOrder(raw: string): number {
  const t = raw.trim();
  return /^-?\d+$/.test(t) ? Number(t) : 0;
}

/** Render the flow.delete `flow_disallowed` blocker list as a callout body. */
export function formatBlockers(blockers: readonly FlowStepBlocker[]): string {
  if (blockers.length === 0) return 'This flow has blocking transitions.';
  const head = `${blockers.length} transition${blockers.length === 1 ? '' : 's'} still reference this flow — remove them first:`;
  const lines = blockers.map((b) => `  • ${b.label === '' ? `#${b.flow_step_id}` : b.label}`);
  return [head, ...lines].join('\n');
}

/* -------------------------------------------------------------------------- */
/* Comm-channel / activity-sink drafts (the WRITE-ONLY-SECRET rule).           */
/*                                                                             */
/* The form shape is all-strings so inputs bind uniformly; the *_to_set        */
/* converters apply the omit-on-blank rule so a field that the user never      */
/* typed into is OMITTED from the wire payload (server preserves the stored     */
/* value). Password / secret fields ALWAYS start blank on load (never echoed)  */
/* and are sent ONLY when the user typed a new value.                          */
/* -------------------------------------------------------------------------- */

export interface CommChannelDraft {
  id: string;
  name: string;
  channelType: string;
  imapHost: string;
  imapPort: string;
  imapUsername: string;
  /** Blank on load; a non-empty value is the ONLY thing that writes a password. */
  imapPassword: string;
  smtpHost: string;
  smtpPort: string;
  smtpUsername: string;
  /** Blank on load. */
  smtpPassword: string;
  fromAddress: string;
  /** Status card id for new intake tasks; '' = leave unchanged / use the
   *  project flow default. */
  intakeStatusId: string;
  channelStatus: string;
  /** What to auto-append to outbound reply bodies: 'none' | 'comm_name' |
   *  'user_name'. */
  signatureMode: string;
}

export function emptyChannelDraft(): CommChannelDraft {
  return {
    id: '0', name: '', channelType: 'email',
    imapHost: '', imapPort: '', imapUsername: '', imapPassword: '',
    smtpHost: '', smtpPort: '', smtpUsername: '', smtpPassword: '',
    fromAddress: '', intakeStatusId: '', channelStatus: 'enabled',
    signatureMode: 'comm_name',
  };
}

/** Hydrate a draft from a server row. Host / port / username are stored
 *  config (not secrets), so they hydrate from the row — otherwise a saved
 *  channel shows blank ports + usernames. Only PASSWORD fields stay blank;
 *  the GUI shows "configured" via the row's has_*_password flags. */
export function channelRowToDraft(row: CommChannel): CommChannelDraft {
  return {
    id: row.id,
    name: row.name,
    channelType: row.channelType === '' ? 'email' : row.channelType,
    imapHost: row.imapHost ?? '',
    imapPort: portToStr(row.imapPort),
    imapUsername: row.imapUsername ?? '',
    imapPassword: '',
    smtpHost: row.smtpHost ?? '',
    smtpPort: portToStr(row.smtpPort),
    smtpUsername: row.smtpUsername ?? '',
    smtpPassword: '',
    fromAddress: row.fromAddress ?? '',
    intakeStatusId: row.intakeStatusId ?? '',
    channelStatus: row.channelStatus === '' ? 'enabled' : row.channelStatus,
    signatureMode: !row.signatureMode ? 'comm_name' : row.signatureMode,
  };
}

/** A stored port (0 / undefined = unset) as the form's all-strings value. */
function portToStr(port: number | undefined): string {
  return port === undefined || port === 0 ? '' : String(port);
}

/** Per-field error messages; empty record = valid. Mirrors the server gate. */
export function validateChannelDraft(d: CommChannelDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (d.name.trim() === '') errors['name'] = 'Channel name is required.';
  if (d.channelType.trim() === '') errors['channelType'] = 'Channel type is required.';
  else if (d.channelType !== 'email') errors['channelType'] = "Channel type 'email' is the only supported value in v1.";
  if (d.imapPort !== '' && !isPositiveInt(d.imapPort)) errors['imapPort'] = 'IMAP port must be a positive integer.';
  if (d.smtpPort !== '' && !isPositiveInt(d.smtpPort)) errors['smtpPort'] = 'SMTP port must be a positive integer.';
  return errors;
}

/**
 * Convert a (validated) draft to the comm_channel.set wire input. name +
 * channel_type always present; text/port fields omit-on-blank; PASSWORD fields
 * are sent ONLY when non-empty (the user typed a new value) — omitted otherwise
 * so the server preserves the stored cipher.
 */
export function channelDraftToSet(d: CommChannelDraft, projectId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    projectId,
    name: d.name.trim(),
    channelType: d.channelType.trim(),
  };
  if (d.id !== '' && d.id !== '0') out['id'] = d.id;
  if (d.imapHost.trim() !== '') out['imapHost'] = d.imapHost.trim();
  const ip = parsePort(d.imapPort);
  if (ip !== 0) out['imapPort'] = ip;
  if (d.imapUsername.trim() !== '') out['imapUsername'] = d.imapUsername.trim();
  if (d.imapPassword !== '') out['imapPassword'] = d.imapPassword;
  if (d.smtpHost.trim() !== '') out['smtpHost'] = d.smtpHost.trim();
  const sp = parsePort(d.smtpPort);
  if (sp !== 0) out['smtpPort'] = sp;
  if (d.smtpUsername.trim() !== '') out['smtpUsername'] = d.smtpUsername.trim();
  if (d.smtpPassword !== '') out['smtpPassword'] = d.smtpPassword;
  // intake_status uses PATCH semantics server-side (0 = leave unchanged), so we
  // only send it when a real status is chosen. There's no "clear back to none".
  if (d.intakeStatusId && d.intakeStatusId !== '0') out['intakeStatusId'] = d.intakeStatusId;
  if (d.fromAddress.trim() !== '') out['fromAddress'] = d.fromAddress.trim();
  if (d.channelStatus !== '') out['channelStatus'] = d.channelStatus;
  if (d.signatureMode !== '') out['signatureMode'] = d.signatureMode;
  return out;
}

export interface ActivitySinkDraft {
  id: string;
  name: string;
  sinkKind: string;
  msgraphTenantId: string;
  msgraphClientId: string;
  /** Blank on load; a non-empty value is the ONLY thing that writes the secret. */
  msgraphClientSecret: string;
  msgraphTeamId: string;
  msgraphChannelId: string;
  channelStatus: string;
  /** The activity_filter predicate JSON string ('' = match every row). */
  activityFilter: string;
}

export function emptySinkDraft(): ActivitySinkDraft {
  return {
    id: '0', name: '', sinkKind: 'msgraph_teams',
    msgraphTenantId: '', msgraphClientId: '', msgraphClientSecret: '',
    msgraphTeamId: '', msgraphChannelId: '', channelStatus: 'enabled',
    activityFilter: '',
  };
}

/** Hydrate a sink draft. The client SECRET always starts blank (never echoed). */
export function sinkRowToDraft(row: ActivitySinkRow): ActivitySinkDraft {
  return {
    id: row.id,
    name: row.name,
    sinkKind: row.sink_kind === '' ? 'msgraph_teams' : row.sink_kind,
    msgraphTenantId: row.msgraph_tenant_id ?? '',
    msgraphClientId: (row as unknown as { msgraph_client_id?: string }).msgraph_client_id ?? '',
    msgraphClientSecret: '',
    msgraphTeamId: row.msgraph_team_id ?? '',
    msgraphChannelId: row.msgraph_channel_id ?? '',
    channelStatus: row.channel_status === '' ? 'enabled' : row.channel_status,
    activityFilter: (row as unknown as { activity_filter?: string }).activity_filter ?? '',
  };
}

export function validateSinkDraft(d: ActivitySinkDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (d.name.trim() === '') errors['name'] = 'Sink name is required.';
  if (d.sinkKind.trim() === '') errors['sinkKind'] = 'Sink kind is required.';
  else if (d.sinkKind !== 'msgraph_teams') errors['sinkKind'] = "Sink kind 'msgraph_teams' is the only supported value in v1.";
  return errors;
}

/** Convert a sink draft to the activity_sink.set wire input. The client secret
 *  is sent ONLY when non-empty; activity_filter is always sent (so clearing all
 *  leaves writes '' = match-everything). */
export function sinkDraftToSet(d: ActivitySinkDraft, projectId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    projectId,
    name: d.name.trim(),
    sinkKind: d.sinkKind.trim(),
  };
  if (d.id !== '' && d.id !== '0') out['id'] = d.id;
  if (d.msgraphTenantId.trim() !== '') out['msgraphTenantId'] = d.msgraphTenantId.trim();
  if (d.msgraphClientId.trim() !== '') out['msgraphClientId'] = d.msgraphClientId.trim();
  if (d.msgraphClientSecret !== '') out['msgraphClientSecret'] = d.msgraphClientSecret;
  if (d.msgraphTeamId.trim() !== '') out['msgraphTeamId'] = d.msgraphTeamId.trim();
  if (d.msgraphChannelId.trim() !== '') out['msgraphChannelId'] = d.msgraphChannelId.trim();
  out['activityFilter'] = d.activityFilter;
  if (d.channelStatus !== '') out['channelStatus'] = d.channelStatus;
  return out;
}

function isPositiveInt(s: string): boolean {
  if (!/^\d+$/.test(s.trim())) return false;
  const n = Number(s);
  return Number.isInteger(n) && n > 0;
}
function parsePort(s: string): number {
  const t = s.trim();
  if (t === '') return 0;
  const n = Number(t);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** Status options shared by the channel + sink config forms. */
export const CHANNEL_STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'enabled', label: 'Enabled' },
  { value: 'disabled-admin', label: 'Disabled (admin)' },
  { value: 'disabled-fault', label: 'Disabled (fault)' },
];

/** Outbound-reply signature options for the comm-channel config form. */
export const SIGNATURE_MODE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'none', label: 'Append nothing' },
  { value: 'comm_name', label: 'Append channel name' },
  { value: 'user_name', label: 'Append sender name' },
];

/* -------------------------------------------------------------------------- */
/* Control.                                                                    */
/* -------------------------------------------------------------------------- */

export class NestedEditor extends Control<NestedEditorConfig> {
  /** Monotonic load gate so a stale async delivery resolves to a no-op. */
  private loadSeq = 0;


  /** flowSteps drag-reorder (shared DnD kit): the dragged step id + its
   *  from_card_id (drag is constrained WITHIN a from-group). One placeholder per
   *  from-group, recreated each renderFlowSteps. */
  private draggingStepId: string | null = null;
  private draggingStepFrom: string | null = null;
  private stepPlaceholders: DropPlaceholder[] = [];

  /** The open Add/Edit-transition modal (#16), if any. */
  private stepModal: Modal | null = null;

  private get selectedPath(): string[] {
    return `${this.config.parentScope}.selectedId`.split('.');
  }
  private get itemsPath(): string[] {
    return `${this.config.parentScope}.items`.split('.');
  }
  private p(seg: string): string[] {
    return `${this.config.scopeKey}.${seg}`.split('.');
  }

  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'nested-editor';
    el.dataset.control = 'NestedEditor';
    el.dataset.kind = this.config.kind;
    return el;
  }

  protected render(): void {
    // Tear down any flowSteps drop placeholders + the transition modal on destroy.
    this.onDestroy(() => {
      for (const p of this.stepPlaceholders) p.destroy();
      this.stepPlaceholders = [];
      this.stepModal?.destroy();
      this.stepModal = null;
    });
    // Re-render on selection OR items change (an optimistic parent edit, a
    // promoted create id). The data loads fire as a side effect keyed on the
    // selected id changing (tracked via loadSeq so a re-render without an id
    // change doesn't re-fetch).
    this.effect(() => {
      const sel = this.ctx.tree.at(this.selectedPath).get<string | null>() ?? null;
      const items = (this.ctx.tree.at(this.itemsPath).get<MasterDetailItem[]>() ?? []) as MasterDetailItem[];
      // Reads of the editor's own loaded leaves so a load delivery repaints.
      this.subscribeLoadedLeaves();
      const item = sel === null ? null : items.find((it) => it.id === sel) ?? null;
      // roleMappings edits a GLOBAL table (claim_value → role), so it renders
      // regardless of the parent Roles selection.
      if (this.config.kind === 'roleMappings') {
        this.renderRoleMappings();
      } else if (this.config.kind === 'activitySinkConfig') {
        this.renderSinkConfig(item);
      } else {
        this.renderEditor(item);
      }
    }, 'nested.render');

    // A separate effect drives the loads when the selected id changes (one-way:
    // reads selectedId, writes only the editor's own load leaves).
    this.effect(() => {
      const sel = this.ctx.tree.at(this.selectedPath).get<string | null>() ?? null;
      const items = (this.ctx.tree.at(this.itemsPath).get<MasterDetailItem[]>() ?? []) as MasterDetailItem[];
      const item = sel === null ? null : items.find((it) => it.id === sel) ?? null;
      this.loadFor(item);
    }, 'nested.load');

    // roleMappings is the only editor that loads independently of selection;
    // kick its one-time global load on mount.
    if (this.config.kind === 'roleMappings') this.loadRoleMappings();
  }

  /** Subscribe (track) the editor's loaded leaves so a delivery repaints. */
  private subscribeLoadedLeaves(): void {
    switch (this.config.kind) {
      case 'flowSteps':
        this.ctx.tree.at(this.p('steps')).get();
        this.ctx.tree.at(this.p('valueCards')).get();
        this.ctx.tree.at(this.p('roles')).get();
        this.ctx.tree.at(this.p('preview')).get();
        this.ctx.tree.at(this.p('draft')).get();
        break;
      case 'edgeMatrix':
        this.ctx.tree.at(this.p('cardTypes')).get();
        break;
      case 'screenFilters':
        this.ctx.tree.at(this.p('filters')).get();
        this.ctx.tree.at(this.p('editingId')).get();
        this.ctx.tree.at(this.p('flows')).get(); // workflow (#27) options
        break;
      // activitySinkConfig does NOT subscribe to `draft`: every keystroke writes
      // the draft (per-field update), and subscribing would re-render the whole
      // form on each letter — replacing the live `<input>` and losing focus
      // mid-word. Structural draft writes (hydrate on selection change, "+ New"
      // click, save reset) call renderSinkConfig explicitly instead.
      case 'activitySinkConfig':
        break;
      case 'agentTokens':
        this.ctx.tree.at(this.p('tokens')).get();
        this.ctx.tree.at(this.p('mint')).get();
        this.ctx.tree.at(this.p('agentRoles')).get();
        this.ctx.tree.at(this.p('roleCatalogue')).get();
        break;
      case 'roleMappings':
        this.ctx.tree.at(this.p('mappings')).get();
        this.ctx.tree.at(this.p('roles')).get();
        break;
    }
  }

  /* ----------------------------- loads ---------------------------------- */

  private loadFor(item: MasterDetailItem | null): void {
    if (item === null) return;
    switch (this.config.kind) {
      case 'flowSteps':
        this.loadFlowSteps(item);
        break;
      case 'edgeMatrix':
        this.loadCardTypes();
        break;
      case 'screenFilters':
        this.loadScreenFilters(item.id);
        break;
      case 'activitySinkConfig':
        this.hydrateSinkDraft(item);
        break;
      case 'agentTokens':
        this.loadAgentDetail(item.id);
        break;
      case 'roleMappings':
        // Global — loaded on mount, not per-selection.
        break;
    }
  }

  private loadFlowSteps(flow: MasterDetailItem): void {
    const seq = ++this.loadSeq;
    const flowId = flow.id;
    const attrDefId = fieldText(flow.raw, 'attribute_def_id');
    const scopeCardId = fieldText(flow.raw, 'scope_card_id');

    this.ctx.api.callByName('flow_step.list', { flowId }, (out) => {
      if (!this.isAlive() || seq !== this.loadSeq) return;
      this.ctx.tree.at(this.p('steps')).set((out as { rows: FlowStepRow[] }).rows ?? []);
    }, { alive: () => this.isAlive() });

    // Resolve the value-card type from the flow's attribute_def, then load the
    // value cards under the flow's project scope for the from/to picker labels.
    this.ctx.api.callByName('attribute_def.select', {}, (out) => {
      if (!this.isAlive() || seq !== this.loadSeq) return;
      const defs = (out as { rows: AttributeDefRow[] }).rows ?? [];
      const def = defs.find((d) => d.id === attrDefId) ?? null;
      const targetType = def?.target_card_type_name ?? '';
      if (targetType === '' || scopeCardId === '' || scopeCardId === '0') {
        this.ctx.tree.at(this.p('valueCards')).set([]);
        return;
      }
      this.ctx.api.callByName(
        'card.select_with_attributes',
        { cardTypeName: targetType, parentCardId: scopeCardId },
        (cardsOut) => {
          if (!this.isAlive() || seq !== this.loadSeq) return;
          const rows = (cardsOut as { rows: Array<Record<string, unknown>> }).rows ?? [];
          this.ctx.tree.at(this.p('valueCards')).set(
            rows.map((r) => ({ id: fieldText(r, 'id'), label: fieldText(r, 'attributes.title') || `#${fieldText(r, 'id')}` })),
          );
        },
        { alive: () => this.isAlive() },
      );
    }, { alive: () => this.isAlive() });

    this.ctx.api.callByName('role.list', {}, (out) => {
      if (!this.isAlive() || seq !== this.loadSeq) return;
      const rows = (out as { rows: Array<Record<string, unknown>> }).rows ?? [];
      this.ctx.tree.at(this.p('roles')).set(rows.map((r) => ({ id: fieldText(r, 'id'), name: fieldText(r, 'name') })));
    }, { alive: () => this.isAlive() });
  }

  private loadCardTypes(): void {
    const node = this.ctx.tree.at(this.p('cardTypes'));
    // card_type is global reference data; load once and reuse across defs.
    if (Array.isArray(node.peek())) return;
    const seq = ++this.loadSeq;
    this.ctx.api.callByName('card_type.select', {}, (out) => {
      if (!this.isAlive() || seq !== this.loadSeq) return;
      node.set((out as { rows: CardTypeRow[] }).rows ?? []);
    }, { alive: () => this.isAlive() });
  }

  private loadScreenFilters(screenId: string): void {
    const seq = ++this.loadSeq;
    this.ctx.api.callByName(
      'card.select_with_attributes',
      { cardTypeName: 'filter', parentCardId: screenId },
      (out) => {
        if (!this.isAlive() || seq !== this.loadSeq) return;
        this.ctx.tree.at(this.p('filters')).set((out as { rows: Array<Record<string, unknown>> }).rows ?? []);
      },
      { alive: () => this.isAlive() },
    );
    // Workflow options (#27): the flows the screen's flow_ref can point at. Loaded
    // once; the renderer filters to the active project's flows by scope_card_id.
    this.ctx.api.callByName(
      'flow.list',
      {},
      (out) => {
        if (!this.isAlive()) return;
        this.ctx.tree.at(this.p('flows')).set((out as FlowListOutput).rows ?? []);
      },
      { alive: () => this.isAlive() },
    );
  }

  /* ----------------------------- dispatch ------------------------------- */

  /** Reload the current editor's data after a write (server-truth posture). */
  private reload(): void {
    const sel = this.ctx.tree.at(this.selectedPath).peek<string | null>() ?? null;
    const items = (this.ctx.tree.at(this.itemsPath).peek<MasterDetailItem[]>() ?? []) as MasterDetailItem[];
    const item = sel === null ? null : items.find((it) => it.id === sel) ?? null;
    // Force a refetch by invalidating the load gate.
    if (this.config.kind === 'edgeMatrix') this.ctx.tree.at(this.p('cardTypes')).set(undefined);
    this.loadFor(item);
  }

  private showFault(label: string, f: ApiFault): void {
    const msg =
      f.kind === 'sub_error' ? `${f.code}: ${f.message}` :
      f.kind === 'http' ? `http ${f.status}` :
      f.kind === 'network' ? f.message :
      f.kind === 'decode' ? f.message : `aborted: ${f.reason}`;
    this.setFault({ kind: 'sub_error', code: 'nested_editor', message: `${label}: ${msg}` });
  }

  /* ----------------------------- render --------------------------------- */

  private renderEditor(item: MasterDetailItem | null): void {
    if (item === null) {
      this.el.replaceChildren();
      return;
    }
    switch (this.config.kind) {
      case 'flowSteps':
        this.renderFlowSteps(item);
        break;
      case 'edgeMatrix':
        this.renderEdgeMatrix(item);
        break;
      case 'screenFilters':
        this.renderScreenFilters(item);
        break;
      case 'activitySinkConfig':
        this.renderSinkConfig(item);
        break;
      case 'agentTokens':
        this.renderAgentTokens(item);
        break;
      case 'roleMappings':
        // Rendered by renderRoleMappings() from the selection-independent path.
        break;
    }
  }

  /** Read the shared project scope (the comm-channel / activity-sink screens
   *  are project-scoped; the parent MasterDetail list refires on this leaf). */
  private scopeProjectId(): string {
    const v = this.ctx.tree.at(['scope', 'projectId']).peek<unknown>();
    if (v === null || v === undefined) return '';
    return typeof v === 'bigint' ? v.toString() : String(v);
  }

  /* --------------------------- flow steps ------------------------------- */

  private renderFlowSteps(flow: MasterDetailItem): void {
    // Discard the previous render's drop placeholders (their group hosts are
    // about to be replaced); recreated per from-group below.
    for (const p of this.stepPlaceholders) p.destroy();
    this.stepPlaceholders = [];

    const frag = document.createDocumentFragment();

    const heading = document.createElement('div');
    heading.className = 'nested-editor__heading';
    // The flow NAME, inline-editable via the shared pencil control (#15) —
    // replaces the old "Rename…" window.prompt button.
    const name = new EditableField({
      value: String(flow.raw['name'] ?? ''),
      ariaLabel: 'Rename workflow',
      className: 'nested-editor__flow-name',
      onCommit: (next) => this.renameFlow(flow, next),
    });
    heading.append(name.el);
    const title = document.createElement('span');
    title.className = 'nested-editor__title muted';
    title.textContent = 'transitions';
    heading.append(title);

    // The flow-delete guard button.
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-danger nested-editor__flow-delete';
    delBtn.dataset.neFlowDelete = '';
    delBtn.textContent = 'Delete flow…';
    this.listen(delBtn, 'click', () => this.previewFlowDelete(flow.id));
    heading.append(delBtn);
    frag.append(heading);

    // The delete-guard preview / blocker callout (rendered into this slot).
    const guard = document.createElement('div');
    guard.className = 'nested-editor__guard';
    guard.dataset.neGuard = '';
    const preview = this.ctx.tree.at(this.p('preview')).peek<FlowPreviewDeleteOutput | { blockers: FlowStepBlocker[] } | null>() ?? null;
    if (preview !== null) this.renderGuard(guard, flow.id, preview);
    frag.append(guard);

    const valueCards = (this.ctx.tree.at(this.p('valueCards')).peek<Array<{ id: string; label: string }>>() ?? []) as Array<{ id: string; label: string }>;
    const titleById = new Map(valueCards.map((c) => [c.id, c.label]));
    const steps = (this.ctx.tree.at(this.p('steps')).peek<FlowStepRow[]>() ?? []) as FlowStepRow[];
    // Group steps by `from` value-card AND impose a STABLE order on the groups
    // themselves: the canonical value-card sequence (the order the kanban /
    // attribute screens show statuses), falling back to the from_card_id as a
    // numeric tie-break. Without this the chart re-shuffled groups whenever the
    // server's `sort_order, label, id` row order changed which step appeared
    // first (a transition's label edit could flip group order).
    const buckets = groupStepsByFrom(steps);
    const orderIdx = new Map(valueCards.map((c, i) => [c.id, i]));
    buckets.sort((a, b) => {
      const ai = orderIdx.get(a.fromCardId) ?? Number.MAX_SAFE_INTEGER;
      const bi = orderIdx.get(b.fromCardId) ?? Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return compareIdStrings(a.fromCardId, b.fromCardId);
    });

    const list = document.createElement('div');
    list.className = 'nested-editor__steps';
    list.dataset.neSteps = '';
    if (buckets.length === 0) {
      const none = document.createElement('div');
      none.className = 'muted';
      none.dataset.neStepsEmpty = '';
      none.textContent = 'No transitions yet.';
      list.append(none);
    }
    for (const b of buckets) {
      const group = document.createElement('div');
      group.className = 'nested-editor__step-group';
      group.dataset.neFromGroup = b.fromCardId;
      const ghead = document.createElement('div');
      ghead.className = 'nested-editor__step-group-head muted';
      ghead.textContent = `From: ${titleById.get(b.fromCardId) ?? `#${b.fromCardId}`}`;
      group.append(ghead);
      // Reordering only matters WITHIN a from-group, so a lone transition has
      // nothing to reorder — suppress its drag grip (it otherwise reads broken).
      const reorderable = b.steps.length > 1;
      for (const s of b.steps) {
        group.append(this.buildStepRow(flow.id, s, titleById, reorderable));
      }

      // Drag-reorder WITHIN this from-group (shared DnD kit). Container-level
      // dragover/drop so releasing in the gap commits; constrained to the same
      // from_card_id (cross-group moves would re-key from-status — a different
      // edit). Commit reassigns the group's existing sort_order slots, leaving
      // other groups' (globally-ordered) steps untouched.
      const bucketSteps = b.steps;
      const placeholder = new DropPlaceholder(group, { className: 'drop-placeholder--steps' });
      this.stepPlaceholders.push(placeholder);
      this.listen(group, 'dragover', (ev) => {
        if (this.draggingStepId === null || this.draggingStepFrom !== b.fromCardId) return;
        ev.preventDefault();
        const t = computeDropTarget(group, (ev as DragEvent).clientY, this.draggingStepId, '[data-ne-step-row]');
        placeholder.showAtY(t.y);
      });
      this.listen(group, 'drop', (ev) => {
        if (this.draggingStepId === null || this.draggingStepFrom !== b.fromCardId) return;
        ev.preventDefault();
        placeholder.pulse();
        const t = computeDropTarget(group, (ev as DragEvent).clientY, this.draggingStepId, '[data-ne-step-row]');
        const movedId = this.draggingStepId;
        this.draggingStepId = null;
        this.draggingStepFrom = null;
        this.reorderSteps(flow.id, bucketSteps, movedId, t.slot);
      });

      list.append(group);
    }
    frag.append(list);

    // Add a transition — opens the editor in a modal (#16), not an inline form
    // at the bottom (which read as a surprising always-present panel).
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn nested-editor__step-add';
    addBtn.dataset.neStepAdd = '';
    addBtn.textContent = '+ Add transition';
    this.listen(addBtn, 'click', () =>
      this.openStepModal(flow.id, {
        id: '0',
        fromCardId: '',
        toCardId: '',
        label: '',
        requiresRoleId: '',
        sortOrder: '',
        standalone: false,
      }),
    );
    frag.append(addBtn);

    this.el.replaceChildren(frag);
  }

  private buildStepRow(
    flowId: string,
    s: FlowStepRow,
    titleById: Map<string, string>,
    reorderable: boolean,
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = 'nested-editor__step-row';
    row.dataset.neStepRow = s.id;
    // `data-card-id` lets the shared computeDropTarget skip the dragged row.
    row.dataset.cardId = s.id;

    if (reorderable) {
      // Drag handle (shared DnD kit) — reorders within the from-group.
      const handle = document.createElement('span');
      handle.className = 'nested-editor__step-drag';
      handle.dataset.neStepDrag = s.id;
      handle.draggable = true;
      handle.setAttribute('aria-hidden', 'true');
      handle.title = 'Drag to reorder';
      handle.textContent = '⠿';
      this.listen(handle, 'dragstart', (ev) => {
        this.draggingStepId = s.id;
        this.draggingStepFrom = s.from_card_id;
        const dt = (ev as DragEvent).dataTransfer;
        if (dt) {
          dt.effectAllowed = 'move';
          dt.setData('text/plain', s.id);
        }
      });
      this.listen(handle, 'dragend', () => {
        this.draggingStepId = null;
        this.draggingStepFrom = null;
        for (const p of this.stepPlaceholders) p.hide();
      });
      row.append(handle);
    } else {
      // Lone transition in its from-group → nothing to reorder. Render an inert
      // spacer (no grip) so the row still aligns with reorderable groups.
      const spacer = document.createElement('span');
      spacer.className = 'nested-editor__step-drag nested-editor__step-drag--inert';
      spacer.setAttribute('aria-hidden', 'true');
      row.append(spacer);
    }

    const label = document.createElement('span');
    label.className = 'nested-editor__step-label';
    const to = titleById.get(s.to_card_id) ?? `#${s.to_card_id}`;
    label.textContent = `${s.label} → ${to}`;
    row.append(label);

    // At-a-glance presentation indicator: standalone button vs overflow menu.
    const present = document.createElement('span');
    present.className = 'nested-editor__step-present muted';
    present.dataset.neStandaloneBadge = s.standalone ? '1' : '0';
    present.textContent = s.standalone ? 'button' : 'menu';
    present.title = s.standalone
      ? 'Shown as its own button on the status bar'
      : 'Tucked into the “Status ▾” dropdown';
    row.append(present);

    if (s.requires_role_name !== '') {
      const role = document.createElement('span');
      role.className = 'nested-editor__step-role muted';
      role.textContent = s.requires_role_name;
      row.append(role);
    }

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'btn nested-editor__step-edit';
    edit.dataset.neStepEdit = s.id;
    edit.textContent = 'Edit';
    this.listen(edit, 'click', () => {
      this.openStepModal(flowId, {
        id: s.id,
        fromCardId: s.from_card_id,
        toCardId: s.to_card_id,
        label: s.label,
        requiresRoleId: s.requires_role_id === '0' ? '' : s.requires_role_id,
        sortOrder: String(s.sort_order),
        standalone: s.standalone,
      } satisfies FlowStepDraft);
    });
    row.append(edit);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-danger nested-editor__step-delete';
    del.dataset.neStepDelete = s.id;
    del.textContent = 'Delete';
    this.listen(del, 'click', () => this.deleteStep(flowId, s.id));
    row.append(del);

    return row;
  }

  /** Open the Add/Edit-transition editor in a modal (#16) — replaces the old
   *  inline-at-the-bottom form. Builds the form for `draft` into a fresh modal
   *  and opens it; save closes it + reloads, Esc/×/backdrop dismiss. */
  private openStepModal(flowId: string, draft: FlowStepDraft): void {
    this.stepModal?.destroy();
    const valueCards = (this.ctx.tree.at(this.p('valueCards')).peek<Array<{ id: string; label: string }>>() ?? []) as Array<{ id: string; label: string }>;
    const editing = draft.id !== '0' && draft.id !== '';
    const modal = new Modal({
      title: editing ? 'Edit transition' : 'Add transition',
      className: 'nested-editor__step-modal',
      host: this.el,
    });
    this.stepModal = modal;
    modal.element.append(this.buildStepForm(flowId, valueCards, draft, () => modal.close()));
    modal.open();
  }

  private buildStepForm(
    flowId: string,
    valueCards: Array<{ id: string; label: string }>,
    draft: FlowStepDraft,
    onDone: () => void,
  ): HTMLElement {
    const roles = (this.ctx.tree.at(this.p('roles')).peek<Array<{ id: string; name: string }>>() ?? []) as Array<{ id: string; name: string }>;
    const editing = draft.id !== '0' && draft.id !== '';

    const form = document.createElement('div');
    form.className = 'nested-editor__step-form';
    form.dataset.neStepForm = '';

    // Instruction text: explain what a transition IS, in plain terms.
    const intro = document.createElement('p');
    intro.className = 'nested-editor__step-intro muted';
    intro.dataset.neStepIntro = '';
    intro.textContent =
      'A transition is a one-click status change shown as a button on the task’s status bar. ' +
      'Pick the status a task must be in (From), the status the button moves it to (To), and the label the user clicks.';
    form.append(intro);

    const fromSel = this.valueCardSelect('neFrom', valueCards, draft.fromCardId);
    const toSel = this.valueCardSelect('neTo', valueCards, draft.toCardId);

    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.className = 'nested-editor__step-input';
    labelInput.dataset.neLabel = '';
    labelInput.placeholder = 'e.g. Accept, Start, Resolve';
    labelInput.value = draft.label;

    const roleSel = document.createElement('select');
    roleSel.className = 'nested-editor__step-select';
    roleSel.dataset.neRole = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '— any role —';
    roleSel.append(blank);
    for (const r of roles) {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = r.name;
      if (r.id === draft.requiresRoleId) opt.selected = true;
      roleSel.append(opt);
    }
    roleSel.value = draft.requiresRoleId;

    const sortInput = document.createElement('input');
    sortInput.type = 'text';
    sortInput.className = 'nested-editor__step-input';
    sortInput.dataset.neSort = '';
    sortInput.placeholder = 'e.g. 1';
    sortInput.value = draft.sortOrder;

    const standaloneInput = document.createElement('input');
    standaloneInput.type = 'checkbox';
    standaloneInput.className = 'nested-editor__step-check';
    standaloneInput.dataset.neStandalone = '';
    standaloneInput.checked = draft.standalone;

    // Each control gets a label + a one-line help caption.
    const field = (labelText: string, control: HTMLElement, help: string): HTMLElement => {
      const wrap = document.createElement('label');
      wrap.className = 'nested-editor__step-field';
      const lbl = document.createElement('span');
      lbl.className = 'nested-editor__step-field-label';
      lbl.textContent = labelText;
      const hint = document.createElement('span');
      hint.className = 'nested-editor__step-field-help muted';
      hint.textContent = help;
      wrap.append(lbl, control, hint);
      return wrap;
    };

    form.append(
      field('From status', fromSel, 'The status a task must currently be in for this button to appear.'),
      field('To status', toSel, 'The status the task moves to when the button is clicked.'),
      field('Button label', labelInput, 'The action text the user sees on the status bar.'),
      field('Required role', roleSel, 'Who may use this transition — leave as “any role” for no restriction.'),
      field('Sort order', sortInput, 'Lower numbers list first among a status’s buttons.'),
      field('Standalone button', standaloneInput, 'On = its own button on the status bar; off = tucked into the “Status ▾” dropdown.'),
    );

    const err = document.createElement('div');
    err.className = 'nested-editor__step-error';
    err.dataset.neStepError = '';
    err.style.display = 'none';
    form.append(err);

    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'btn btn-primary nested-editor__step-submit';
    submit.dataset.neStepSubmit = '';
    submit.textContent = editing ? 'Save transition' : 'Add transition';
    this.listen(submit, 'click', () => {
      const d: FlowStepDraft = {
        id: draft.id,
        fromCardId: fromSel.value,
        toCardId: toSel.value,
        label: labelInput.value,
        requiresRoleId: roleSel.value,
        sortOrder: sortInput.value,
        standalone: standaloneInput.checked,
      };
      const v = validateStepDraft(d);
      if (!v.ok) {
        err.style.display = '';
        err.textContent = Object.values(v.errors)[0] ?? 'Invalid transition';
        return;
      }
      this.saveStep(flowId, d, onDone);
    });
    form.append(submit);

    return form;
  }

  private valueCardSelect(role: string, cards: Array<{ id: string; label: string }>, current: string): HTMLSelectElement {
    const sel = document.createElement('select');
    sel.className = 'nested-editor__step-select';
    sel.dataset[role] = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '— pick —';
    sel.append(blank);
    for (const c of cards) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.label;
      if (c.id === current) opt.selected = true;
      sel.append(opt);
    }
    sel.value = current;
    return sel;
  }

  private saveStep(flowId: string, d: FlowStepDraft, onDone?: () => void): void {
    this.clearFault();
    // On INSERT with a blank sort order, land the new transition AFTER the
    // existing ones in its from-group (max + 10) instead of 0 — a 0 would tie
    // with siblings, sort alphabetically, AND block drag-reorder (a tied group
    // can't be renumbered). An explicit value is respected as authored.
    const inserting = d.id === '' || d.id === '0';
    const sortOrder =
      inserting && d.sortOrder.trim() === ''
        ? this.nextStepSortOrder(d.fromCardId)
        : parseSortOrder(d.sortOrder);
    this.ctx.api.callByName(
      'flow_step.set',
      {
        id: d.id,
        flowId,
        fromCardId: d.fromCardId,
        toCardId: d.toCardId,
        label: d.label.trim(),
        requiresRoleId: d.requiresRoleId,
        sortOrder,
        standalone: d.standalone,
      },
      () => {
        if (!this.isAlive()) return;
        onDone?.(); // close the editor modal
        this.reload();
      },
      { alive: () => this.isAlive(), onErr: (f) => this.showFault('flow_step.set', f) },
    );
  }

  /**
   * The sort_order to give a NEW transition in a from-group: 10 past the
   * group's current max (10, 20, 30… ladder), so it lands last and carries a
   * distinct value. Reads the loaded steps from the tree.
   */
  private nextStepSortOrder(fromCardId: string): number {
    const steps = this.ctx.tree.at(this.p('steps')).peek<FlowStepRow[]>() ?? [];
    let max = 0;
    for (const s of steps) {
      if (s.from_card_id === fromCardId && s.sort_order > max) max = s.sort_order;
    }
    return max + 10;
  }

  /**
   * Drag-reorder a step WITHIN its from-group to `slot` (insertion index with
   * the dragged step removed). Reassigns the whole group a fresh ascending
   * `(i+1)*10` ladder so the new order is always representable — reusing the
   * group's existing values broke when they tied (e.g. all 0 for freshly-added
   * steps), leaving reorder a silent no-op. The TransitionBar only ever shows
   * one from-group at a time (list_for_card filters to the card's current
   * status), so renumbering a group can't disturb cross-group ordering.
   * Persists each changed step via flow_step.set, then reloads once.
   */
  private reorderSteps(flowId: string, bucketSteps: readonly FlowStepRow[], movedId: string, slot: number): void {
    const idx = bucketSteps.findIndex((s) => s.id === movedId);
    if (idx < 0) return;
    const next = bucketSteps.slice();
    const [moved] = next.splice(idx, 1);
    next.splice(Math.max(0, Math.min(slot, next.length)), 0, moved!);
    if (next.every((s, i) => s.id === bucketSteps[i]?.id)) return; // no change

    // Fresh ladder; only persist rows whose value actually changes.
    const changes = next
      .map((s, i) => ({ s, want: (i + 1) * 10 }))
      .filter(({ s, want }) => s.sort_order !== want);
    if (changes.length === 0) return;

    this.clearFault();
    let remaining = changes.length;
    const done = (): void => {
      if (this.isAlive() && --remaining <= 0) this.reload();
    };
    for (const { s, want } of changes) {
      this.ctx.api.callByName(
        'flow_step.set',
        {
          id: s.id,
          flowId,
          fromCardId: s.from_card_id,
          toCardId: s.to_card_id,
          label: s.label,
          requiresRoleId: s.requires_role_id === '0' ? '' : s.requires_role_id,
          sortOrder: want,
          // Preserve the presentation bit — flow_step.set overwrites the whole
          // row, so omitting it would silently reset standalone to false.
          standalone: s.standalone,
        },
        done,
        { alive: () => this.isAlive(), onErr: (f) => this.showFault('flow_step.set', f) },
      );
    }
  }

  private deleteStep(_flowId: string, stepId: string): void {
    this.clearFault();
    this.ctx.api.callByName(
      'flow_step.delete',
      { flowStepId: stepId },
      () => {
        if (!this.isAlive()) return;
        this.reload();
      },
      { alive: () => this.isAlive(), onErr: (f) => this.showFault('flow_step.delete', f) },
    );
  }

  /** Rename a flow: flow.set is a full-row upsert, so preserve the row's other
   *  fields (governed attribute + scope) and only change the name. On success,
   *  patch the parent list item so the row + detail title repaint. */
  private renameFlow(flow: MasterDetailItem, nextName: string): void {
    this.clearFault();
    const cur = String(flow.raw['name'] ?? '');
    const trimmed = nextName.trim();
    if (trimmed === '' || trimmed === cur) return;
    const dcs = flow.raw['default_create_status_id'];
    this.ctx.api.callByName(
      'flow.set',
      {
        id: flow.id,
        name: trimmed,
        doc: String(flow.raw['doc'] ?? ''),
        attributeDefId: String(flow.raw['attribute_def_id'] ?? ''),
        scopeCardId: String(flow.raw['scope_card_id'] ?? ''),
        defaultCreateStatusId: dcs !== undefined && dcs !== null ? String(dcs) : undefined,
      },
      () => {
        if (!this.isAlive()) return;
        const node = this.ctx.tree.at(this.itemsPath);
        const rows = (node.peek<MasterDetailItem[]>() ?? []) as MasterDetailItem[];
        node.set(rows.map((it) => (it.id === flow.id ? { id: it.id, raw: { ...it.raw, name: trimmed } } : it)));
      },
      { alive: () => this.isAlive(), onErr: (f) => this.showFault('flow.set', f) },
    );
  }

  private previewFlowDelete(flowId: string): void {
    this.clearFault();
    this.ctx.api.callByName(
      'flow.preview_delete',
      { flowId },
      (out) => {
        if (!this.isAlive()) return;
        this.ctx.tree.at(this.p('preview')).set(out as FlowPreviewDeleteOutput);
      },
      { alive: () => this.isAlive(), onErr: (f) => this.showFault('flow.preview_delete', f) },
    );
  }

  private renderGuard(
    host: HTMLElement,
    flowId: string,
    preview: FlowPreviewDeleteOutput | { blockers: FlowStepBlocker[] },
  ): void {
    host.replaceChildren();
    if ('blockers' in preview) {
      // The flow.delete blocker rejection — block + list the offenders.
      const callout = document.createElement('pre');
      callout.className = 'nested-editor__blockers';
      callout.dataset.neBlockers = '';
      callout.textContent = formatBlockers(preview.blockers);
      host.append(callout);
      return;
    }
    const summary = document.createElement('div');
    summary.className = 'nested-editor__guard-summary';
    summary.dataset.neGuardSummary = '';
    const ph = preview.tasks_by_phase;
    summary.textContent = `"${preview.flow_name}": ${preview.step_count} step(s); ${preview.tasks_currently_in_flow_states} task(s) in this flow's states (triage ${ph.triage} / active ${ph.active} / terminal ${ph.terminal}).`;
    host.append(summary);

    if (preview.step_count > 0) {
      // Steps still exist → flow.delete will be blocked; tell the admin.
      const note = document.createElement('div');
      note.className = 'nested-editor__guard-note muted';
      note.textContent = 'Remove the transitions above before deleting the flow.';
      host.append(note);
    }

    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn btn-danger nested-editor__guard-confirm';
    confirm.dataset.neGuardConfirm = '';
    confirm.textContent = 'Confirm delete flow';
    this.listen(confirm, 'click', () => this.confirmFlowDelete(flowId));
    host.append(confirm);

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn nested-editor__guard-cancel';
    cancel.dataset.neGuardCancel = '';
    cancel.textContent = 'Cancel';
    this.listen(cancel, 'click', () => this.ctx.tree.at(this.p('preview')).set(null));
    host.append(cancel);
  }

  private confirmFlowDelete(flowId: string): void {
    this.clearFault();
    this.ctx.api.callByName(
      'flow.delete',
      { flowId },
      () => {
        if (!this.isAlive()) return;
        // Success: clear the guard + drop the flow from the parent list.
        this.ctx.tree.at(this.p('preview')).set(null);
        this.removeParentItem(flowId);
      },
      {
        alive: () => this.isAlive(),
        onErr: (f) => {
          // A `flow_disallowed` rejection rides a structured blocker list on the
          // fault detail — surface it in the guard slot rather than the generic
          // fault row.
          if (f.kind === 'sub_error' && f.code === 'flow_disallowed') {
            const detail = (f.detail ?? {}) as { blockers?: FlowStepBlocker[] };
            this.ctx.tree.at(this.p('preview')).set({ blockers: detail.blockers ?? [] });
            return;
          }
          this.showFault('flow.delete', f);
        },
      },
    );
  }

  /** Drop a deleted parent row from the MasterDetail items + clear selection. */
  private removeParentItem(id: string): void {
    const node = this.ctx.tree.at(this.itemsPath);
    const rows = (node.peek<MasterDetailItem[]>() ?? []) as MasterDetailItem[];
    node.set(rows.filter((it) => it.id !== id));
    if ((this.ctx.tree.at(this.selectedPath).peek<string | null>() ?? null) === id) {
      this.ctx.tree.at(this.selectedPath).set(null);
    }
  }

  /* --------------------------- edge matrix ------------------------------ */

  private renderEdgeMatrix(def: MasterDetailItem): void {
    const frag = document.createDocumentFragment();

    const heading = document.createElement('h3');
    heading.className = 'nested-editor__title';
    heading.textContent = 'Bound card types';
    frag.append(heading);

    const cardTypes = (this.ctx.tree.at(this.p('cardTypes')).peek<CardTypeRow[]>() ?? []) as CardTypeRow[];
    const boundTo = (readPath(def.raw, 'bound_to') as AttributeDefBoundCardType[] | undefined) ?? [];
    const rows = boundMatrix(cardTypes, boundTo);

    const matrix = document.createElement('div');
    matrix.className = 'nested-editor__matrix';
    matrix.dataset.neMatrix = '';
    if (rows.length === 0) {
      const none = document.createElement('div');
      none.className = 'muted';
      none.textContent = 'Loading card types…';
      matrix.append(none);
    }
    for (const r of rows) {
      matrix.append(this.buildMatrixRow(def.id, r));
    }
    frag.append(matrix);

    this.el.replaceChildren(frag);
  }

  private buildMatrixRow(defId: string, r: MatrixRow): HTMLElement {
    const row = document.createElement('div');
    row.className = 'nested-editor__matrix-row';
    row.dataset.neMatrixRow = r.cardType.id;

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'nested-editor__matrix-toggle';
    toggle.dataset.neToggle = r.cardType.id;
    (toggle as HTMLInputElement).checked = r.bound;
    this.listen(toggle, 'change', () => {
      if ((toggle as HTMLInputElement).checked) {
        this.bindEdge(defId, r.cardType.id, r.required, r.ordering);
      } else {
        this.unbindEdge(defId, r.cardType.id);
      }
    });
    row.append(toggle);

    const name = document.createElement('span');
    name.className = 'nested-editor__matrix-name';
    name.textContent = r.cardType.name;
    row.append(name);

    // Per-edge required + ordering, only meaningful when bound.
    const req = document.createElement('input');
    req.type = 'checkbox';
    req.className = 'nested-editor__matrix-required';
    req.dataset.neRequired = r.cardType.id;
    (req as HTMLInputElement).checked = r.required;
    (req as HTMLInputElement).disabled = !r.bound;
    this.listen(req, 'change', () => {
      // Re-bind (idempotent INSERT won't update; delete + insert to change). The
      // edge.insert ON CONFLICT DO NOTHING means we must drop then re-add to
      // change required/ordering.
      this.rebindEdge(defId, r.cardType.id, (req as HTMLInputElement).checked, r.ordering);
    });
    row.append(fieldLabel(req, 'required', 'nested-editor__matrix-field'));

    const ord = document.createElement('input');
    ord.type = 'text';
    ord.className = 'nested-editor__matrix-ordering';
    ord.dataset.neOrdering = r.cardType.id;
    (ord as HTMLInputElement).value = String(r.ordering);
    (ord as HTMLInputElement).disabled = !r.bound;
    const commitOrd = (): void => {
      const next = parseSortOrder((ord as HTMLInputElement).value);
      if (next === r.ordering) return;
      this.rebindEdge(defId, r.cardType.id, r.required, next);
    };
    this.listen(ord, 'blur', commitOrd);
    this.listen(ord, 'keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Enter') { (ev as KeyboardEvent).preventDefault(); commitOrd(); }
    });
    row.append(fieldLabel(ord, 'order', 'nested-editor__matrix-field', true));

    return row;
  }

  private bindEdge(defId: string, cardTypeId: string, required: boolean, ordering: number): void {
    this.clearFault();
    this.ctx.api.callByName(
      'edge.insert',
      { attributeDefId: defId, cardTypeId, isRequired: required, ordering },
      () => { if (this.isAlive()) this.reloadParentDef(defId); },
      { alive: () => this.isAlive(), onErr: (f) => this.showFault('edge.insert', f) },
    );
  }

  private unbindEdge(defId: string, cardTypeId: string): void {
    this.clearFault();
    this.ctx.api.callByName(
      'edge.delete',
      { attributeDefId: defId, cardTypeId },
      (out) => {
        if (!this.isAlive()) return;
        const o = out as { ok: boolean; usageCount?: number };
        if (!o.ok && o.usageCount !== undefined && o.usageCount > 0) {
          this.setFault({
            kind: 'sub_error',
            code: 'edge_in_use',
            message: `Cannot unbind: ${o.usageCount} value(s) still use this attribute on that card type.`,
          });
        }
        this.reloadParentDef(defId);
      },
      { alive: () => this.isAlive(), onErr: (f) => this.showFault('edge.delete', f) },
    );
  }

  /** Change required/ordering on an existing edge: delete then re-insert (the
   *  insert is ON CONFLICT DO NOTHING, so an in-place update needs the drop). */
  private rebindEdge(defId: string, cardTypeId: string, required: boolean, ordering: number): void {
    this.clearFault();
    this.ctx.api.callByName(
      'edge.delete',
      { attributeDefId: defId, cardTypeId },
      () => {
        if (!this.isAlive()) return;
        this.ctx.api.callByName(
          'edge.insert',
          { attributeDefId: defId, cardTypeId, isRequired: required, ordering },
          () => { if (this.isAlive()) this.reloadParentDef(defId); },
          { alive: () => this.isAlive(), onErr: (f) => this.showFault('edge.insert', f) },
        );
      },
      { alive: () => this.isAlive(), onErr: (f) => this.showFault('edge.delete', f) },
    );
  }

  /** Reload the attribute_def list (so the def's `bound_to` reflects the edge
   *  change) and patch the matching parent item in place. */
  private reloadParentDef(defId: string): void {
    this.ctx.api.callByName('attribute_def.select', {}, (out) => {
      if (!this.isAlive()) return;
      const defs = (out as { rows: AttributeDefRow[] }).rows ?? [];
      const fresh = defs.find((d) => d.id === defId);
      if (!fresh) return;
      const node = this.ctx.tree.at(this.itemsPath);
      const rows = (node.peek<MasterDetailItem[]>() ?? []) as MasterDetailItem[];
      node.set(rows.map((it) => (it.id === defId ? { id: it.id, raw: fresh as unknown as Record<string, unknown> } : it)));
    }, { alive: () => this.isAlive() });
  }

  /* --------------------------- screen filters --------------------------- */

  private renderScreenFilters(screen: MasterDetailItem): void {
    const frag = document.createDocumentFragment();

    // Workflow (flow_ref) + base phase (toggle_groups) editors (#27).
    frag.append(this.buildScreenWorkflowPhase(screen));

    const heading = document.createElement('div');
    heading.className = 'nested-editor__heading';
    const title = document.createElement('h3');
    title.className = 'nested-editor__title';
    title.textContent = 'Filters';
    heading.append(title);

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-primary nested-editor__filter-add';
    addBtn.dataset.neFilterAdd = '';
    addBtn.textContent = '+ Add filter';
    this.listen(addBtn, 'click', () => this.addFilter(screen.id));
    heading.append(addBtn);
    frag.append(heading);

    const filters = (this.ctx.tree.at(this.p('filters')).peek<Array<Record<string, unknown>>>() ?? []) as Array<Record<string, unknown>>;
    const defaultFilter = fieldText(screen.raw, 'attributes.default_filter');

    const list = document.createElement('div');
    list.className = 'nested-editor__filters';
    list.dataset.neFilters = '';
    if (filters.length === 0) {
      const none = document.createElement('div');
      none.className = 'muted';
      none.dataset.neFiltersEmpty = '';
      none.textContent = 'No filters on this screen yet.';
      list.append(none);
    }
    // The card_type the screen's body lists (flow-derived; status→task,
    // comm_status→comm). Scopes the predicate builder's attribute vocabulary so
    // a comm screen's filter offers comm attributes, not task's.
    const cardType = this.screenCardType(screen);
    for (const f of filters) {
      list.append(this.buildFilterRow(screen.id, f, defaultFilter, cardType));
    }
    frag.append(list);

    this.el.replaceChildren(frag);
  }

  /**
   * Workflow (flow_ref) + base-phase (toggle_groups) editors for a screen (#27).
   * Workflow is a select over the active project's flows (a flow id; '' = the
   * project default). Base phase is a single select that rewrites the screen's
   * `toggle_groups` so the chosen phase is the default-on one (drives the phase
   * toggles + the #24 default-create-status base).
   */
  private buildScreenWorkflowPhase(screen: MasterDetailItem): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'nested-editor__screen-config';
    wrap.dataset.neScreenConfig = '';

    const heading = document.createElement('h3');
    heading.className = 'nested-editor__title';
    heading.textContent = 'Workflow & phase';
    wrap.append(heading);

    // Workflow (flow_ref) — the screen's flows are those scoped to its project.
    const projectId = fieldText(screen.raw, 'parent_card_id');
    const flows = (this.ctx.tree.at(this.p('flows')).peek<FlowRow[]>() ?? []) as FlowRow[];
    const projectFlows = flows.filter((f) => (f.scope_card_id ?? '') === projectId);
    const curFlow = fieldText(screen.raw, 'attributes.flow_ref');

    const flowRow = document.createElement('label');
    flowRow.className = 'nested-editor__config-row';
    const flowLabel = document.createElement('span');
    flowLabel.className = 'nested-editor__config-label';
    flowLabel.textContent = 'Workflow';
    const flowSel = document.createElement('select');
    flowSel.className = 'nested-editor__config-select';
    flowSel.dataset.neScreenFlow = '';
    const flowNone = document.createElement('option');
    flowNone.value = '';
    flowNone.textContent = 'Project default';
    flowSel.append(flowNone);
    for (const f of projectFlows) {
      const o = document.createElement('option');
      o.value = f.id;
      o.textContent = f.name;
      flowSel.append(o);
    }
    flowSel.value = projectFlows.some((f) => f.id === curFlow) ? curFlow : '';
    this.listen(flowSel, 'change', () => this.setScreenFlow(screen.id, flowSel.value));
    flowRow.append(flowLabel, flowSel);
    wrap.append(flowRow);

    // Base phase (toggle_groups phase_scope default_on).
    const phaseRow = document.createElement('label');
    phaseRow.className = 'nested-editor__config-row';
    const phaseLabel = document.createElement('span');
    phaseLabel.className = 'nested-editor__config-label';
    phaseLabel.textContent = 'Base phase';
    const phaseSel = document.createElement('select');
    phaseSel.className = 'nested-editor__config-select';
    phaseSel.dataset.neScreenBasePhase = '';
    for (const opt of BASE_PHASE_OPTIONS) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      phaseSel.append(o);
    }
    phaseSel.value = currentBasePhase(fieldText(screen.raw, 'attributes.toggle_groups'));
    this.listen(phaseSel, 'change', () => this.setScreenBasePhase(screen.id, phaseSel.value));
    phaseRow.append(phaseLabel, phaseSel);
    wrap.append(phaseRow);

    return wrap;
  }

  /** Set the screen's workflow override (flow_ref). '' → 0 = use project default. */
  private setScreenFlow(screenId: string, flowId: string): void {
    this.clearFault();
    this.patchScreenAttr(screenId, 'flow_ref', flowId);
    this.ctx.api.callByName(
      'attribute.update',
      { cardId: screenId, attributeName: 'flow_ref', value: flowId === '' ? 0 : Number(flowId) },
      () => { if (this.isAlive()) this.reload(); },
      { alive: () => this.isAlive() },
    );
  }

  /** Set the screen's base phase by rewriting its toggle_groups phase_scope. */
  private setScreenBasePhase(screenId: string, phase: string): void {
    this.clearFault();
    const items = (this.ctx.tree.at(this.itemsPath).peek<MasterDetailItem[]>() ?? []) as MasterDetailItem[];
    const screen = items.find((it) => it.id === screenId) ?? null;
    const cur = screen === null ? '' : fieldText(screen.raw, 'attributes.toggle_groups');
    const next = withBasePhase(cur, phase);
    this.patchScreenAttr(screenId, 'toggle_groups', next);
    this.ctx.api.callByName(
      'attribute.update',
      { cardId: screenId, attributeName: 'toggle_groups', value: next },
      () => { if (this.isAlive()) this.reload(); },
      { alive: () => this.isAlive() },
    );
  }

  /** Optimistically patch one attribute on the parent screen item (the radio /
   *  selects reflect it immediately; the reload reconciles to server truth). */
  private patchScreenAttr(screenId: string, attr: string, value: string): void {
    const node = this.ctx.tree.at(this.itemsPath);
    const rows = (node.peek<MasterDetailItem[]>() ?? []) as MasterDetailItem[];
    node.set(
      rows.map((it) => {
        if (it.id !== screenId) return it;
        const attrs = { ...((it.raw['attributes'] as Record<string, unknown> | undefined) ?? {}), [attr]: value };
        return { id: it.id, raw: { ...it.raw, attributes: attrs } };
      }),
    );
  }

  /**
   * The card_type the screen's body lists, derived from its `flow_ref` the SAME
   * way the runtime does (screen-resolve `ScreenPresetSet.cardType`): the flow's
   * governed attribute_def's bound card_type (status→task, comm_status→comm).
   * Falls back to 'task' when the screen has no explicit flow_ref or the flow /
   * card_type can't be resolved — matching the runtime default. The predicate
   * builder scopes its attribute vocabulary to this, so a Comms screen's filter
   * offers comm attributes (comm_status, acked, …) instead of task's.
   */
  private screenCardType(screen: MasterDetailItem): string {
    const flowRef = fieldText(screen.raw, 'attributes.flow_ref');
    if (flowRef === '' || flowRef === '0') return 'task';
    const flows = (this.ctx.tree.at(this.p('flows')).peek<FlowRow[]>() ?? []) as FlowRow[];
    const ct = flows.find((fl) => fl.id === flowRef)?.attribute_def_card_type_name;
    return typeof ct === 'string' && ct !== '' ? ct : 'task';
  }

  private buildFilterRow(screenId: string, f: Record<string, unknown>, defaultFilter: string, cardType: string): HTMLElement {
    const id = fieldText(f, 'id');
    const row = document.createElement('div');
    row.className = 'nested-editor__filter-row';
    row.dataset.neFilterRow = id;

    const editingId = fieldText({ v: this.ctx.tree.at(this.p('editingId')).peek() }, 'v');

    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'nested-editor__filter-title';
    titleInput.dataset.neFilterTitle = id;
    titleInput.value = fieldText(f, 'attributes.title');
    const commitTitle = (): void => {
      const next = titleInput.value;
      if (next === fieldText(f, 'attributes.title')) return;
      this.updateFilterAttr(screenId, id, 'title', next);
    };
    this.listen(titleInput, 'blur', commitTitle);
    this.listen(titleInput, 'keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Enter') { (ev as KeyboardEvent).preventDefault(); commitTitle(); }
    });
    row.append(titleInput);

    // Default-filter radio (set the screen's default_filter to this id).
    const def = document.createElement('input');
    def.type = 'radio';
    def.className = 'nested-editor__filter-default';
    def.dataset.neFilterDefault = id;
    (def as HTMLInputElement).checked = defaultFilter === id;
    this.listen(def, 'change', () => this.setDefaultFilter(screenId, id));
    row.append(fieldLabel(def, 'default', 'nested-editor__filter-field'));

    // Edit-predicate toggle: mounts a PredicateFilter into a slot below the row.
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn nested-editor__filter-edit';
    editBtn.dataset.neFilterEdit = id;
    editBtn.textContent = editingId === id ? 'Close predicate' : 'Edit predicate';
    this.listen(editBtn, 'click', () => {
      this.ctx.tree.at(this.p('editingId')).set(editingId === id ? null : id);
    });
    row.append(editBtn);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-danger nested-editor__filter-delete';
    del.dataset.neFilterDelete = id;
    del.textContent = 'Remove';
    this.listen(del, 'click', () => this.deleteFilter(screenId, id));
    row.append(del);

    if (editingId === id) {
      row.append(this.buildPredicateEditor(screenId, id, f, cardType));
    }

    return row;
  }

  /** Mount a PredicateFilter for the filter card's predicate; commit writes the
   *  JSON predicate back to the card's `predicate` attribute. */
  private buildPredicateEditor(screenId: string, filterId: string, f: Record<string, unknown>, cardType: string): HTMLElement {
    const slot = document.createElement('div');
    slot.className = 'nested-editor__predicate';
    slot.dataset.nePredicate = filterId;

    // Seed the editor's predicate leaf from the card's stored predicate JSON
    // (the `{ where?, tree? }` shape the filter card stores — flat AND →
    // `where[]`, structured → `tree`).
    const predPath = this.p(`predicate.${filterId}`);
    const raw = fieldText(f, 'attributes.predicate');
    this.ctx.tree.at(predPath).set(fromFilterJson(raw));

    // Seed the group + sort leaves from the filter card so the builder edits the
    // full view definition (predicate + group + sort), not just the predicate.
    const groupPath = this.p(`group.${filterId}`);
    this.ctx.tree.at(groupPath).set(fieldText(f, 'attributes.group_by_attr'));
    const sortPath = this.p(`sort.${filterId}`);
    let sortSeed: unknown = null;
    const sortRaw = fieldText(f, 'attributes.sort');
    if (sortRaw !== '') {
      try {
        const a: unknown = JSON.parse(sortRaw);
        if (Array.isArray(a)) sortSeed = a;
      } catch {
        // malformed sort → start empty.
      }
    }
    this.ctx.tree.at(sortPath).set(sortSeed);

    this.spawn(
      'PredicateFilter',
      {
        type: 'PredicateFilter',
        valuePath: predPath.join('.'),
        // Scope the predicate vocabulary to the card_type the screen lists
        // (flow-derived; comm screen → comm). The runtime filter bar scopes the
        // same way (screen-host predicateCardType), so the saved predicate and
        // the live bar can't disagree on what attributes exist.
        schema: { cardType },
        // The universal view builder: also edit Group by + Sort by here.
        groupPath: groupPath.join('.'),
        sortPath: sortPath.join('.'),
      },
      slot,
    );

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-primary nested-editor__predicate-save';
    save.dataset.nePredicateSave = filterId;
    save.textContent = 'Save view';
    this.listen(save, 'click', () => {
      const predicate = this.ctx.tree.at(predPath).peek<Predicate | null>() ?? null;
      const json = predicate === null ? '' : JSON.stringify(toFilterJson(predicate));
      this.updateFilterAttr(screenId, filterId, 'predicate', json);
      // Persist the group + sort alongside the predicate (the full view def).
      this.updateFilterAttr(screenId, filterId, 'group_by_attr', this.ctx.tree.at(groupPath).peek<string>() ?? '');
      const sortVal = this.ctx.tree.at(sortPath).peek<unknown>();
      this.updateFilterAttr(
        screenId,
        filterId,
        'sort',
        Array.isArray(sortVal) && sortVal.length > 0 ? JSON.stringify(sortVal) : '',
      );
      this.ctx.tree.at(this.p('editingId')).set(null);
    });
    slot.append(save);
    return slot;
  }

  private addFilter(screenId: string): void {
    this.clearFault();
    this.ctx.api.callByName(
      'card.insert',
      { cardTypeName: 'filter', parentCardId: screenId, title: 'New filter' },
      () => { if (this.isAlive()) this.loadScreenFilters(screenId); },
      { alive: () => this.isAlive(), onErr: (f) => this.showFault('card.insert', f) },
    );
  }

  private deleteFilter(screenId: string, filterId: string): void {
    this.clearFault();
    this.ctx.api.callByName(
      'card.delete',
      { cardId: filterId },
      () => { if (this.isAlive()) this.loadScreenFilters(screenId); },
      { alive: () => this.isAlive(), onErr: (f) => this.showFault('card.delete', f) },
    );
  }

  private updateFilterAttr(screenId: string, filterId: string, attributeName: string, value: unknown): void {
    this.clearFault();
    this.ctx.api.callByName(
      'attribute.update',
      { cardId: filterId, attributeName, value },
      () => { if (this.isAlive()) this.loadScreenFilters(screenId); },
      { alive: () => this.isAlive(), onErr: (f) => this.showFault('attribute.update', f) },
    );
  }

  private setDefaultFilter(screenId: string, filterId: string): void {
    this.clearFault();
    // The screen card carries the `default_filter` attribute pointing at one of
    // its filter cards; patch the PARENT screen item optimistically too so the
    // radio reflects the new default immediately.
    const node = this.ctx.tree.at(this.itemsPath);
    const rows = (node.peek<MasterDetailItem[]>() ?? []) as MasterDetailItem[];
    node.set(
      rows.map((it) => {
        if (it.id !== screenId) return it;
        const attrs = { ...(it.raw['attributes'] as Record<string, unknown> | undefined ?? {}), default_filter: filterId };
        return { id: it.id, raw: { ...it.raw, attributes: attrs } };
      }),
    );
    this.ctx.api.callByName(
      'attribute.update',
      { cardId: screenId, attributeName: 'default_filter', value: filterId },
      () => { /* parent already patched optimistically */ },
      { alive: () => this.isAlive(), onErr: (f) => this.showFault('attribute.update (default_filter)', f) },
    );
  }

  /* ----------------------- activity-sink config ------------------------- */

  private hydrateSinkDraft(item: MasterDetailItem): void {
    const node = this.ctx.tree.at(this.p('draft'));
    const cur = node.peek<ActivitySinkDraft | null>() ?? null;
    if (cur !== null && cur.id === item.id) return;
    node.set(sinkRowToDraft(item.raw as unknown as ActivitySinkRow));
    // Structural draft write (selection change): re-render explicitly since the
    // render effect doesn't subscribe to `draft` (focus-survival rule).
    this.renderSinkConfig(item);
  }

  private renderSinkConfig(item: MasterDetailItem | null): void {
    const existing = this.ctx.tree.at(this.p('draft')).peek<ActivitySinkDraft | null>() ?? null;
    const draft: ActivitySinkDraft | null =
      existing ?? (item !== null ? sinkRowToDraft(item.raw as unknown as ActivitySinkRow) : null);

    const frag = document.createDocumentFragment();
    const heading = document.createElement('div');
    heading.className = 'nested-editor__heading';
    const title = document.createElement('h3');
    title.className = 'nested-editor__title';
    title.textContent = draft !== null && draft.id !== '0' && draft.id !== '' ? 'Sink configuration' : 'New sink';
    heading.append(title);
    const newBtn = document.createElement('button');
    newBtn.type = 'button';
    newBtn.className = 'btn nested-editor__config-new';
    newBtn.dataset.neSinkNew = '';
    newBtn.textContent = '+ New sink';
    this.listen(newBtn, 'click', () => {
      this.ctx.tree.at(this.p('draft')).set(emptySinkDraft());
      this.renderSinkConfig(null);
    });
    heading.append(newBtn);
    frag.append(heading);

    if (draft === null) {
      const hint = document.createElement('div');
      hint.className = 'muted';
      hint.dataset.neConfigEmpty = '';
      hint.textContent = 'Select a sink to edit it, or add a new one.';
      frag.append(hint);
      this.el.replaceChildren(frag);
      return;
    }
    const row = (item !== null ? item.raw : {}) as unknown as ActivitySinkRow;

    const form = document.createElement('div');
    form.className = 'nested-editor__config-form';
    form.dataset.neSinkConfig = '';

    const update = (patch: Partial<ActivitySinkDraft>): void => {
      const next = { ...(this.ctx.tree.at(this.p('draft')).peek<ActivitySinkDraft>() ?? draft), ...patch };
      this.ctx.tree.at(this.p('draft')).set(next);
    };

    form.append(this.textField('neName', 'Name', draft.name, (v) => update({ name: v })));
    form.append(this.textField('neTenant', 'MS Graph tenant', draft.msgraphTenantId, (v) => update({ msgraphTenantId: v })));
    form.append(this.textField('neClientId', 'MS Graph client id', draft.msgraphClientId, (v) => update({ msgraphClientId: v })));
    form.append(this.secretField('neClientSecret', 'MS Graph client secret', draft.msgraphClientSecret, row.has_client_secret, (v) => update({ msgraphClientSecret: v })));
    form.append(this.textField('neTeam', 'MS Graph team', draft.msgraphTeamId, (v) => update({ msgraphTeamId: v })));
    form.append(this.textField('neChannel', 'MS Graph channel', draft.msgraphChannelId, (v) => update({ msgraphChannelId: v })));
    form.append(this.selectField('neStatus', 'Status', CHANNEL_STATUS_OPTIONS, draft.channelStatus, (v) => update({ channelStatus: v })));
    frag.append(form);

    // The activity-filter editor (a predicate over single activity rows).
    frag.append(this.buildActivityFilterEditor(draft, update, item));

    const err = document.createElement('div');
    err.className = 'nested-editor__config-error';
    err.dataset.neConfigError = '';
    err.style.display = 'none';
    frag.append(err);

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-primary nested-editor__config-save';
    save.dataset.neConfigSave = '';
    save.textContent = 'Save sink';
    this.listen(save, 'click', () => {
      const d = (this.ctx.tree.at(this.p('draft')).peek<ActivitySinkDraft>() ?? draft);
      const errors = validateSinkDraft(d);
      const first = Object.values(errors)[0];
      if (first !== undefined) {
        err.style.display = '';
        err.textContent = first;
        return;
      }
      this.saveSink(d);
    });
    frag.append(save);
    this.el.replaceChildren(frag);
  }

  /** The activity-filter editor: a list of top-level leaves over single activity
   *  rows + an "Add leaf" mini-form + a connective (AND/OR) toggle. Stores the
   *  JSON string on the draft's `activityFilter`. */
  private buildActivityFilterEditor(
    draft: ActivitySinkDraft,
    update: (patch: Partial<ActivitySinkDraft>) => void,
    item: MasterDetailItem | null,
  ): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'nested-editor__activity-filter';
    wrap.dataset.neActivityFilter = '';

    const heading = document.createElement('div');
    heading.className = 'nested-editor__field-label muted';
    heading.textContent = 'Activity filter (which rows to push)';
    wrap.append(heading);

    const predicate = activityPredicateFromString(draft.activityFilter);
    const leaves = topLevelLeaves(predicate);

    if (predicate !== null && predicate.kind === 'composite' && predicate.items.length > 1) {
      const conn = document.createElement('select');
      conn.className = 'nested-editor__af-conn';
      conn.dataset.neAfConn = '';
      for (const op of ['and', 'or'] as const) {
        const opt = document.createElement('option');
        opt.value = op;
        opt.textContent = activityOpLabel(op);
        if (predicate.op === op) opt.selected = true;
        conn.append(opt);
      }
      conn.value = predicate.op;
      this.listen(conn, 'change', () => {
        const next = setConnective(activityPredicateFromString(draft.activityFilter), conn.value as 'and' | 'or');
        update({ activityFilter: activityPredicateToString(next) });
        // Structural filter-tree change → re-render explicitly (the render
        // effect doesn't track `draft`; keystroke updates skip re-render so
        // text inputs keep focus, but the filter leaves list does need it).
        this.renderSinkConfig(item);
      });
      wrap.append(conn);
    }

    const list = document.createElement('div');
    list.className = 'nested-editor__af-leaves';
    list.dataset.neAfLeaves = '';
    if (leaves.length === 0) {
      const none = document.createElement('div');
      none.className = 'muted';
      none.dataset.neAfEmpty = '';
      none.textContent = 'No filter — push every activity row.';
      list.append(none);
    }
    leaves.forEach((entry, i) => {
      const r = document.createElement('div');
      r.className = 'nested-editor__af-leaf';
      r.dataset.neAfLeaf = String(i);
      const txt = document.createElement('span');
      txt.className = 'nested-editor__af-leaf-text';
      txt.textContent = entry.summary;
      r.append(txt);
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'btn btn-danger nested-editor__af-remove';
      rm.dataset.neAfRemove = String(i);
      rm.textContent = 'Remove';
      this.listen(rm, 'click', () => {
        const next = removeLeafAt(activityPredicateFromString(draft.activityFilter), i);
        update({ activityFilter: activityPredicateToString(next) });
        this.renderSinkConfig(item); // structural change — see connective handler above.
      });
      r.append(rm);
      list.append(r);
    });
    wrap.append(list);

    // Add-leaf mini-form: op select + comma-separated values.
    const addForm = document.createElement('div');
    addForm.className = 'nested-editor__af-add';
    addForm.dataset.neAfAdd = '';

    const opSel = document.createElement('select');
    opSel.className = 'nested-editor__af-op';
    opSel.dataset.neAfOp = '';
    for (const op of ACTIVITY_LEAF_OPS) {
      const opt = document.createElement('option');
      opt.value = op;
      opt.textContent = activityOpLabel(op);
      opSel.append(opt);
    }

    const valInput = document.createElement('input');
    valInput.type = 'text';
    valInput.className = 'nested-editor__af-values';
    valInput.dataset.neAfValues = '';
    valInput.placeholder = 'values (comma-separated; e.g. card_create, comment)';

    const hint = document.createElement('span');
    hint.className = 'nested-editor__af-hint muted';
    hint.textContent = `kinds: ${ACTIVITY_KIND_OPTIONS.map((k) => k.value).join(', ')}`;

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn nested-editor__af-add-btn';
    addBtn.dataset.neAfAddBtn = '';
    addBtn.textContent = '+ Add leaf';
    this.listen(addBtn, 'click', () => {
      const op = opSel.value as ActivityLeafOp;
      const values = valInput.value.split(',').map((s) => s.trim()).filter((s) => s !== '');
      if (values.length === 0) return;
      const next = appendLeaf(activityPredicateFromString(draft.activityFilter), { kind: 'leaf', op, values });
      update({ activityFilter: activityPredicateToString(next) });
      this.renderSinkConfig(item); // structural change — see connective handler above.
    });

    addForm.append(opSel, valInput, addBtn, hint);
    wrap.append(addForm);
    return wrap;
  }

  private saveSink(d: ActivitySinkDraft): void {
    const projectId = this.scopeProjectId();
    if (projectId === '' || projectId === '0') {
      this.setFault({ kind: 'sub_error', code: 'no_project', message: 'Pick a project before saving a sink.' });
      return;
    }
    this.clearFault();
    this.ctx.api.callByName(
      'activity_sink.set',
      sinkDraftToSet(d, projectId),
      () => {
        if (!this.isAlive()) return;
        this.ctx.tree.at(this.p('draft')).set(null);
        // Render-effect doesn't subscribe to `draft` (focus-survival rule), so
        // re-render explicitly after the structural save reset.
        this.renderSinkConfig(null);
        this.reloadProjectScopedList('activity_sink.list');
      },
      { alive: () => this.isAlive(), onErr: (f) => this.showFault('activity_sink.set', f) },
    );
  }

  /* --------------------------- agent tokens ----------------------------- */

  private loadTokens(agentId: string): void {
    const seq = ++this.loadSeq;
    this.ctx.api.callByName('user_token.list', { userId: agentId }, (out) => {
      if (!this.isAlive() || seq !== this.loadSeq) return;
      this.ctx.tree.at(this.p('tokens')).set((out as { rows: UserTokenRow[] }).rows ?? []);
    }, { alive: () => this.isAlive(), onErr: (f) => this.showFault('user_token.list', f) });
  }

  /** Initial per-selection load for the agent detail: the agent's tokens, its
   *  current role grants (user_role.list), and the role catalogue (role.list)
   *  for the assign dropdown — all under ONE load gate so a stale agent
   *  switch can't interleave. Token / role writes reload their slice only. */
  private loadAgentDetail(agentId: string): void {
    const seq = ++this.loadSeq;
    this.ctx.api.callByName('user_token.list', { userId: agentId }, (out) => {
      if (!this.isAlive() || seq !== this.loadSeq) return;
      this.ctx.tree.at(this.p('tokens')).set((out as { rows: UserTokenRow[] }).rows ?? []);
    }, { alive: () => this.isAlive(), onErr: (f) => this.showFault('user_token.list', f) });
    this.ctx.api.callByName('user_role.list', { userId: agentId }, (out) => {
      if (!this.isAlive() || seq !== this.loadSeq) return;
      this.ctx.tree.at(this.p('agentRoles')).set((out as UserRoleListOutput).rows ?? []);
    }, { alive: () => this.isAlive(), onErr: (f) => this.showFault('user_role.list', f) });
    this.ctx.api.callByName('role.list', {}, (out) => {
      if (!this.isAlive() || seq !== this.loadSeq) return;
      this.ctx.tree.at(this.p('roleCatalogue')).set((out as RoleListOutput).rows ?? []);
    }, { alive: () => this.isAlive() });
  }

  /** Reload just the agent's role grants after an assign/revoke (the catalogue
   *  is stable, so it isn't re-fetched). */
  private loadAgentRoles(agentId: string): void {
    const seq = ++this.loadSeq;
    this.ctx.api.callByName('user_role.list', { userId: agentId }, (out) => {
      if (!this.isAlive() || seq !== this.loadSeq) return;
      this.ctx.tree.at(this.p('agentRoles')).set((out as UserRoleListOutput).rows ?? []);
    }, { alive: () => this.isAlive(), onErr: (f) => this.showFault('user_role.list', f) });
  }

  /** Grant a (global) role to the agent, then reload its grants. The server
   *  enforces the parent-grants-subset rule (an owner can only grant non-admin
   *  roles they hold); a violation surfaces as an inline fault. */
  private assignAgentRole(agentId: string, roleName: string): void {
    if (roleName === '') return;
    this.clearFault();
    this.ctx.api.callByName(
      'user_role.set',
      { userId: agentId, roleName },
      () => { if (this.isAlive()) this.loadAgentRoles(agentId); },
      { alive: () => this.isAlive(), onErr: (f) => this.showFault('user_role.set', f) },
    );
  }

  /** Revoke one of the agent's role grants (scope must match the grant: a
   *  global grant passes no scope), then reload. */
  private revokeAgentRole(agentId: string, roleName: string, scopeProjectId?: string): void {
    this.clearFault();
    const input: Record<string, unknown> = { userId: agentId, roleName };
    if (scopeProjectId !== undefined && scopeProjectId !== '') input.scopeProjectId = scopeProjectId;
    this.ctx.api.callByName(
      'user_role.revoke',
      input,
      () => { if (this.isAlive()) this.loadAgentRoles(agentId); },
      { alive: () => this.isAlive(), onErr: (f) => this.showFault('user_role.revoke', f) },
    );
  }

  private buildAgentRoleRow(agentId: string, g: UserRoleAssignment): HTMLElement {
    const row = document.createElement('div');
    row.className = 'nested-editor__agent-role-row';
    row.dataset.neAgentRoleRow = g.role_name;
    const name = document.createElement('span');
    name.className = 'nested-editor__agent-role-name';
    name.textContent = g.role_name;
    row.append(name);
    if (g.scope_project_id !== undefined) {
      const scope = document.createElement('span');
      scope.className = 'nested-editor__agent-role-scope muted';
      scope.textContent = g.scope_project_title ?? `project #${g.scope_project_id}`;
      row.append(scope);
    }
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'btn btn-danger nested-editor__agent-role-revoke';
    rm.dataset.neAgentRoleRevoke = g.role_name;
    rm.textContent = 'Revoke';
    this.listen(rm, 'click', () => this.revokeAgentRole(agentId, g.role_name, g.scope_project_id));
    row.append(rm);
    return row;
  }

  private renderAgentTokens(agent: MasterDetailItem): void {
    const frag = document.createDocumentFragment();

    /* ----------------------------- Roles ------------------------------- */
    const rolesHeading = document.createElement('h3');
    rolesHeading.className = 'nested-editor__title';
    rolesHeading.textContent = 'Roles';
    frag.append(rolesHeading);

    const rolesNote = document.createElement('div');
    rolesNote.className = 'nested-editor__guard-note muted';
    rolesNote.textContent =
      'The roles this agent acts as. Effective permissions are the intersection of these grants and the owner’s roles — an owner can only grant non-admin roles they hold themselves.';
    frag.append(rolesNote);

    const grants = (this.ctx.tree.at(this.p('agentRoles')).peek<UserRoleAssignment[]>() ?? []) as UserRoleAssignment[];
    const catalogue = (this.ctx.tree.at(this.p('roleCatalogue')).peek<RoleRow[]>() ?? []) as RoleRow[];

    const rolesList = document.createElement('div');
    rolesList.className = 'nested-editor__agent-roles';
    rolesList.dataset.neAgentRoles = '';
    if (grants.length === 0) {
      const none = document.createElement('div');
      none.className = 'muted';
      none.dataset.neAgentRolesEmpty = '';
      none.textContent = 'No roles granted yet.';
      rolesList.append(none);
    }
    for (const g of grants) rolesList.append(this.buildAgentRoleRow(agent.id, g));
    frag.append(rolesList);

    // Single "Assign role" dropdown (assign-on-pick). Excludes roles already
    // held globally so you can't re-grant the same one; agents get GLOBAL
    // grants here (the "acts as" role), so no scope field.
    const heldGlobal = new Set(grants.filter((g) => g.scope_project_id === undefined).map((g) => g.role_name));
    const assign = document.createElement('select');
    assign.className = 'nested-editor__agent-role-assign';
    assign.dataset.neAgentRoleAssign = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '+ Assign role…';
    assign.append(placeholder);
    for (const r of catalogue) {
      if (heldGlobal.has(r.name)) continue;
      const opt = document.createElement('option');
      opt.value = r.name;
      opt.textContent = r.name;
      assign.append(opt);
    }
    assign.value = '';
    this.listen(assign, 'change', () => {
      const roleName = assign.value;
      if (roleName === '') return;
      this.assignAgentRole(agent.id, roleName);
      assign.value = '';
    });
    frag.append(assign);

    /* --------------------------- API tokens ---------------------------- */
    const heading = document.createElement('h3');
    heading.className = 'nested-editor__title';
    heading.textContent = 'API tokens';
    frag.append(heading);

    // The just-minted secret, surfaced ONCE in a copyable reveal then gone.
    const mint = this.ctx.tree.at(this.p('mint')).peek<{ agentId: string; label: string; token: string } | null>() ?? null;
    if (mint !== null && mint.agentId === agent.id) {
      frag.append(this.buildMintReveal(mint));
    }

    // Mint form: a label + Mint button.
    const mintForm = document.createElement('div');
    mintForm.className = 'nested-editor__token-mint';
    mintForm.dataset.neTokenMint = '';
    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.className = 'nested-editor__token-label';
    labelInput.dataset.neTokenLabel = '';
    labelInput.placeholder = 'Token label (unique per agent, e.g. laptop)';
    const mintBtn = document.createElement('button');
    mintBtn.type = 'button';
    mintBtn.className = 'btn btn-primary nested-editor__token-mint-btn';
    mintBtn.dataset.neTokenMintBtn = '';
    mintBtn.textContent = 'Mint token';
    this.listen(mintBtn, 'click', () => {
      const label = labelInput.value.trim();
      if (label === '') return;
      this.mintToken(agent.id, label);
      labelInput.value = '';
    });
    mintForm.append(labelInput, mintBtn);
    frag.append(mintForm);

    // The token list (labels + timestamps only — secret never returned here).
    const tokens = (this.ctx.tree.at(this.p('tokens')).peek<UserTokenRow[]>() ?? []) as UserTokenRow[];
    const list = document.createElement('div');
    list.className = 'nested-editor__tokens';
    list.dataset.neTokens = '';
    if (tokens.length === 0) {
      const none = document.createElement('div');
      none.className = 'muted';
      none.dataset.neTokensEmpty = '';
      none.textContent = 'No tokens minted yet.';
      list.append(none);
    }
    for (const t of tokens) {
      list.append(this.buildTokenRow(agent.id, t));
    }
    frag.append(list);

    this.el.replaceChildren(frag);
  }

  private buildMintReveal(mint: { label: string; token: string }): HTMLElement {
    const box = document.createElement('div');
    box.className = 'nested-editor__token-reveal';
    box.dataset.neTokenReveal = '';
    const note = document.createElement('div');
    note.className = 'nested-editor__token-reveal-note';
    note.textContent = `New token "${mint.label}" — copy now, it will not be shown again.`;
    box.append(note);
    const codeRow = document.createElement('div');
    codeRow.className = 'nested-editor__token-reveal-row';
    const code = document.createElement('code');
    code.className = 'nested-editor__token-value';
    code.dataset.neTokenValue = '';
    code.textContent = mint.token;
    codeRow.append(code);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn nested-editor__token-copy';
    copy.dataset.neTokenCopy = '';
    copy.textContent = 'Copy';
    this.listen(copy, 'click', () => {
      const nav = (globalThis as { navigator?: { clipboard?: { writeText?: (s: string) => unknown } } }).navigator;
      if (nav?.clipboard?.writeText) {
        // Fire-and-forget; the secret stays only in the DOM reveal.
        void nav.clipboard.writeText(mint.token);
      }
    });
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'btn nested-editor__token-dismiss';
    dismiss.dataset.neTokenDismiss = '';
    dismiss.textContent = 'Dismiss';
    this.listen(dismiss, 'click', () => this.ctx.tree.at(this.p('mint')).set(null));
    codeRow.append(copy, dismiss);
    box.append(codeRow);
    return box;
  }

  private buildTokenRow(agentId: string, t: UserTokenRow): HTMLElement {
    const row = document.createElement('div');
    row.className = 'nested-editor__token-row';
    row.dataset.neTokenRow = t.label;
    const label = document.createElement('span');
    label.className = 'nested-editor__token-row-label';
    label.textContent = t.label;
    row.append(label);
    const created = document.createElement('span');
    created.className = 'nested-editor__token-row-time muted';
    created.textContent = t.created_at;
    row.append(created);
    const status = document.createElement('span');
    status.className = 'nested-editor__token-row-status';
    const revoked = t.revoked_at !== undefined && t.revoked_at !== '';
    status.textContent = revoked ? 'revoked' : 'active';
    row.append(status);
    if (!revoked) {
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'btn btn-danger nested-editor__token-revoke';
      rm.dataset.neTokenRevoke = t.label;
      rm.textContent = 'Revoke';
      this.listen(rm, 'click', () => this.revokeToken(agentId, t.label));
      row.append(rm);
    }
    return row;
  }

  private mintToken(agentId: string, label: string): void {
    this.clearFault();
    this.ctx.api.callByName(
      'user_token.create',
      { userId: agentId, label },
      (out) => {
        if (!this.isAlive()) return;
        const o = (out ?? {}) as { token?: unknown; label?: unknown };
        const token = typeof o.token === 'string' ? o.token : '';
        const lbl = typeof o.label === 'string' ? o.label : label;
        // Stash the one-shot secret for the copyable reveal, then reload the list.
        this.ctx.tree.at(this.p('mint')).set({ agentId, label: lbl, token });
        this.loadTokens(agentId);
      },
      { alive: () => this.isAlive(), onErr: (f) => this.showFault('user_token.create', f) },
    );
  }

  private revokeToken(agentId: string, label: string): void {
    this.clearFault();
    this.ctx.api.callByName(
      'user_token.revoke',
      { userId: agentId, label },
      () => { if (this.isAlive()) this.loadTokens(agentId); },
      { alive: () => this.isAlive(), onErr: (f) => this.showFault('user_token.revoke', f) },
    );
  }

  /* --------------------------- role mappings ---------------------------- */

  private loadRoleMappings(): void {
    const seq = ++this.loadSeq;
    this.ctx.api.callByName('role_mapping.list', {}, (out) => {
      if (!this.isAlive() || seq !== this.loadSeq) return;
      this.ctx.tree.at(this.p('mappings')).set((out as { rows: RoleMappingRow[] }).rows ?? []);
    }, { alive: () => this.isAlive(), onErr: (f) => this.showFault('role_mapping.list', f) });
    this.ctx.api.callByName('role.list', {}, (out) => {
      if (!this.isAlive()) return;
      const rows = (out as { rows: RoleRow[] }).rows ?? [];
      this.ctx.tree.at(this.p('roles')).set(rows.map((r) => ({ id: r.id, name: r.name })));
    }, { alive: () => this.isAlive() });
  }

  private renderRoleMappings(): void {
    const frag = document.createDocumentFragment();

    const heading = document.createElement('h3');
    heading.className = 'nested-editor__title';
    heading.textContent = 'OIDC claim → role mappings';
    frag.append(heading);

    const note = document.createElement('div');
    note.className = 'nested-editor__guard-note muted';
    note.textContent =
      'Each row maps an OIDC group/claim value to a role assigned at login. Role definitions and their grants live on the Roles screen (seed-managed, read-only).';
    frag.append(note);

    const mappings = (this.ctx.tree.at(this.p('mappings')).peek<RoleMappingRow[]>() ?? []) as RoleMappingRow[];
    const roles = (this.ctx.tree.at(this.p('roles')).peek<Array<{ id: string; name: string }>>() ?? []) as Array<{ id: string; name: string }>;

    const list = document.createElement('div');
    list.className = 'nested-editor__mappings';
    list.dataset.neMappings = '';
    if (mappings.length === 0) {
      const none = document.createElement('div');
      none.className = 'muted';
      none.dataset.neMappingsEmpty = '';
      none.textContent = 'No role mappings configured.';
      list.append(none);
    }
    for (const m of mappings) {
      list.append(this.buildMappingRow(m, roles));
    }
    frag.append(list);

    // Add-mapping mini-form: claim_value + role select.
    const addForm = document.createElement('div');
    addForm.className = 'nested-editor__mapping-add';
    addForm.dataset.neMappingAdd = '';
    const claimInput = document.createElement('input');
    claimInput.type = 'text';
    claimInput.className = 'nested-editor__mapping-claim';
    claimInput.dataset.neMappingClaim = '';
    claimInput.placeholder = 'claim value (e.g. kitp-admins)';
    const roleSel = document.createElement('select');
    roleSel.className = 'nested-editor__mapping-role';
    roleSel.dataset.neMappingRole = '';
    for (const r of roles) {
      const opt = document.createElement('option');
      opt.value = r.name;
      opt.textContent = r.name;
      roleSel.append(opt);
    }
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-primary nested-editor__mapping-add-btn';
    addBtn.dataset.neMappingAddBtn = '';
    addBtn.textContent = '+ Add mapping';
    this.listen(addBtn, 'click', () => {
      const claim = claimInput.value.trim();
      const role = roleSel.value;
      if (claim === '' || role === '') return;
      this.setMapping(claim, role);
      claimInput.value = '';
    });
    addForm.append(claimInput, roleSel, addBtn);
    frag.append(addForm);

    this.el.replaceChildren(frag);
  }

  private buildMappingRow(m: RoleMappingRow, roles: Array<{ id: string; name: string }>): HTMLElement {
    const row = document.createElement('div');
    row.className = 'nested-editor__mapping-row';
    row.dataset.neMappingRow = m.claim_value;
    const claim = document.createElement('span');
    claim.className = 'nested-editor__mapping-row-claim';
    claim.textContent = m.claim_value;
    row.append(claim);
    // The role is editable in place (re-`set` upserts on the claim_value PK).
    const sel = document.createElement('select');
    sel.className = 'nested-editor__mapping-row-role';
    sel.dataset.neMappingRowRole = m.claim_value;
    for (const r of roles) {
      const opt = document.createElement('option');
      opt.value = r.name;
      opt.textContent = r.name;
      if (r.name === m.role_name) opt.selected = true;
      sel.append(opt);
    }
    sel.value = m.role_name;
    this.listen(sel, 'change', () => {
      if (sel.value === m.role_name) return;
      this.setMapping(m.claim_value, sel.value);
    });
    row.append(sel);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'btn btn-danger nested-editor__mapping-delete';
    rm.dataset.neMappingDelete = m.claim_value;
    rm.textContent = 'Remove';
    this.listen(rm, 'click', () => this.deleteMapping(m.claim_value));
    row.append(rm);
    return row;
  }

  private setMapping(claimValue: string, roleName: string): void {
    this.clearFault();
    this.ctx.api.callByName(
      'role_mapping.set',
      { claimValue, roleName },
      () => { if (this.isAlive()) this.loadRoleMappings(); },
      { alive: () => this.isAlive(), onErr: (f) => this.showFault('role_mapping.set', f) },
    );
  }

  private deleteMapping(claimValue: string): void {
    this.clearFault();
    this.ctx.api.callByName(
      'role_mapping.delete',
      { claimValue },
      () => { if (this.isAlive()) this.loadRoleMappings(); },
      { alive: () => this.isAlive(), onErr: (f) => this.showFault('role_mapping.delete', f) },
    );
  }

  /* --------------------------- shared form bits ------------------------- */

  /** A one-way text field (label + input). Commits its value to the supplied
   *  setter on every input so the draft stays current without a re-render. */
  private textField(role: string, label: string, value: string, onInput: (v: string) => void): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'nested-editor__config-field';
    const span = document.createElement('span');
    span.className = 'nested-editor__field-label muted';
    span.textContent = label;
    wrap.append(span);
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'nested-editor__config-input';
    input.dataset[role] = '';
    input.value = value;
    this.listen(input, 'input', () => onInput(input.value));
    wrap.append(input);
    return wrap;
  }

  /**
   * A WRITE-ONLY secret field: blank on load (the value is never echoed), with
   * a state caption reading "configured" / "not set" from the row's has_* flag.
   * A value typed here is the ONLY thing that writes the secret; left blank, the
   * field is omitted from the payload (server preserves the stored cipher).
   */
  private secretField(role: string, label: string, value: string, configured: boolean, onInput: (v: string) => void): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'nested-editor__config-field nested-editor__config-secret';
    const span = document.createElement('span');
    span.className = 'nested-editor__field-label muted';
    span.textContent = label;
    wrap.append(span);
    const input = document.createElement('input');
    input.type = 'password';
    input.className = 'nested-editor__config-input';
    input.dataset[role] = '';
    input.value = value;
    input.placeholder = configured ? '•••••••• (leave blank to keep)' : 'not set — enter to configure';
    this.listen(input, 'input', () => onInput(input.value));
    wrap.append(input);
    const state = document.createElement('span');
    state.className = 'nested-editor__secret-state muted';
    state.dataset.neSecretState = role;
    state.textContent = configured ? 'configured' : 'not set';
    wrap.append(state);
    return wrap;
  }

  private selectField(role: string, label: string, options: ReadonlyArray<{ value: string; label: string }>, value: string, onChange: (v: string) => void): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'nested-editor__config-field';
    const span = document.createElement('span');
    span.className = 'nested-editor__field-label muted';
    span.textContent = label;
    wrap.append(span);
    const sel = document.createElement('select');
    sel.className = 'nested-editor__config-select';
    sel.dataset[role] = '';
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      if (o.value === value) opt.selected = true;
      sel.append(opt);
    }
    sel.value = value;
    this.listen(sel, 'change', () => onChange(sel.value));
    wrap.append(sel);
    return wrap;
  }

  /**
   * Reload the project-scoped parent list (comm_channel.list / activity_sink.
   * list) and rewrite the parent MasterDetail's `items` leaf directly — the
   * server-truth posture (a fresh create surfaces with its id; an edit reflects
   * the canonical row). The parent's list query fires on the shared
   * `scope.projectId` signal, which a save doesn't change, so we re-issue the
   * read ourselves. One tree write outside any tracked effect — cascade-safe.
   */
  private reloadProjectScopedList(specKey: string): void {
    const projectId = this.scopeProjectId();
    if (projectId === '' || projectId === '0') return;
    this.ctx.api.callByName(
      specKey,
      { projectId },
      (out) => {
        if (!this.isAlive()) return;
        const rows = (out as { rows?: Array<Record<string, unknown>> }).rows ?? [];
        const items = rows
          .map((r) => {
            const id = r['id'];
            if (id === null || id === undefined) return null;
            return { id: String(id), raw: r };
          })
          .filter((it): it is MasterDetailItem => it !== null);
        this.ctx.tree.at(this.itemsPath).set(items);
      },
      { alive: () => this.isAlive(), onErr: (f) => this.showFault(specKey, f) },
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Filter-card predicate (de)serialization. A filter card stores its predicate */
/* as the CANONICAL bare WIRE NODE (a leaf `{attr,op,...}` or a connective      */
/* group) — the exact shape the seed, `screen-resolve.readPredicate()`, and the */
/* ScreenFilterBar's "save filter" both read+write via toWire/fromWire. Using   */
/* anything else (e.g. a `{where}/{tree}` wrapper) means a saved filter can't be */
/* read back at runtime, and a seed/runtime predicate renders empty in the      */
/* builder. Load tolerates the legacy `{where}/{tree}` wrapper an older build    */
/* may have written.                                                            */
/* -------------------------------------------------------------------------- */

/** Encode a Predicate to the canonical filter-card wire node (caller stringifies). */
function toFilterJson(predicate: Predicate): WireNode {
  return toWire(predicate);
}

/** Decode a stored filter-card predicate JSON string to a Predicate (or null
 *  for an empty / unparseable value). Inverse of {@link toFilterJson}. */
function fromFilterJson(raw: string): Predicate | null {
  const t = raw.trim();
  if (t === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as { where?: unknown; tree?: unknown };
  try {
    // Legacy wrapper tolerated on load.
    if (Array.isArray(obj.where)) return fromWhereLeaves(obj.where as CardWherePredicate[]);
    if (obj.tree !== undefined && obj.tree !== null) return fromWire(obj.tree);
    // Canonical: a bare wire node (leaf or connective group).
    return fromWire(parsed);
  } catch {
    return null;
  }
}

/**
 * A `<label>` wrapping a control + a text span (no `document.createTextNode`,
 * which the test DOM shim lacks). `before=true` puts the text before the
 * control (e.g. "order [input]"); default is "[checkbox] required".
 */
function fieldLabel(control: HTMLElement, text: string, className: string, before = false): HTMLElement {
  const label = document.createElement('label');
  label.className = `${className} muted`;
  const span = document.createElement('span');
  span.className = `${className}-text`;
  span.textContent = text;
  if (before) label.append(span, control);
  else label.append(control, span);
  return label;
}

/* ---- Screen base-phase (#27): toggle_groups phase_scope helpers ----------- */

const BASE_PHASE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'All phases (no base)' },
  { value: 'triage', label: 'Triage' },
  { value: 'active', label: 'Active' },
  { value: 'terminal', label: 'Closed' },
];

const PHASE_LABELS: Record<string, string> = { triage: 'Triage', active: 'Active', terminal: 'Closed' };

function isObjVal(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object';
}

/** Parse a toggle_groups JSON string to an array of groups (never throws). */
function parseGroups(json: string): unknown[] {
  if (typeof json !== 'string' || json.trim() === '') return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** The base phase a toggle_groups JSON encodes: the phase_scope item whose
 *  `default_on` is true. '' when there's no phase_scope group / none default-on. */
function currentBasePhase(toggleGroupsJson: string): string {
  const ps = parseGroups(toggleGroupsJson).find(
    (g) => isObjVal(g) && (g as { name?: unknown }).name === 'phase_scope',
  );
  if (!isObjVal(ps)) return '';
  const items = Array.isArray((ps as { items?: unknown }).items) ? (ps as { items: unknown[] }).items : [];
  for (const it of items) {
    if (isObjVal(it) && (it as { default_on?: unknown }).default_on === true) {
      const pred = (it as { predicate?: { values?: unknown } }).predicate;
      if (pred && Array.isArray(pred.values)) return String(pred.values[0] ?? '');
      return String((it as { name?: unknown }).name ?? '');
    }
  }
  return '';
}

/** Rewrite a toggle_groups JSON string so its phase_scope group's `default_on`
 *  is set ONLY for `phase` (or drop the phase_scope group when phase is ''),
 *  preserving every OTHER group (e.g. the Inbox's `mine_only` scope group). */
function withBasePhase(toggleGroupsJson: string, phase: string): string {
  const others = parseGroups(toggleGroupsJson).filter(
    (g) => !(isObjVal(g) && (g as { name?: unknown }).name === 'phase_scope'),
  );
  const groups = phase === '' ? others : [buildPhaseScopeGroup(phase), ...others];
  return JSON.stringify(groups);
}

function buildPhaseScopeGroup(basePhase: string): Record<string, unknown> {
  const phases = ['triage', 'active', 'terminal'];
  return {
    name: 'phase_scope',
    operator: 'or',
    mode: 'multi',
    items: phases.map((ph) => ({
      name: ph,
      label: PHASE_LABELS[ph] ?? ph,
      predicate: { attr: 'status', op: 'has_phase', values: [ph] },
      default_on: ph === basePhase,
    })),
  };
}

export function registerNestedEditor(): void {
  Control.register('NestedEditor', NestedEditor);
}
