/**
 * Workflows screen config for the generic RecordForm — makes a flow's editable
 * scalar properties (name, description, default-create status) editable, which
 * the old read-only detail couldn't do. Creation stays in the MasterDetail
 * create dialog (it collects the structural governed-attribute), so the form
 * has `allowCreate: false`; it only EDITS the selected flow via `flow.set`
 * (update-by-id). The governed attribute + scope ride along in the draft (not
 * shown as fields) so the upsert targets the same flow.
 */

import type { RecordFormScreenConfig } from './record-form.js';
import type { FlowRow } from './specs.js';

/** All-strings form shape; `attributeDefId`/`scopeCardId` are carried (not
 *  rendered) so the save targets the existing flow without changing its key. */
export interface WorkflowDraft {
  id: string;
  name: string;
  doc: string;
  attributeDefId: string;
  scopeCardId: string;
  defaultCreateStatusId: string;
}

export function emptyWorkflowDraft(): WorkflowDraft {
  return { id: '0', name: '', doc: '', attributeDefId: '', scopeCardId: '', defaultCreateStatusId: '' };
}

export function workflowRowToDraft(row: FlowRow): WorkflowDraft {
  return {
    id: row.id,
    name: row.name,
    doc: row.doc ?? '',
    attributeDefId: row.attribute_def_id ?? '',
    scopeCardId: row.scope_card_id ?? '',
    defaultCreateStatusId: row.default_create_status_id ?? '',
  };
}

/** Build the flow.set wire input (camelCase; the spec encodes to snake + applies
 *  omit rules). Keeps the existing governed attribute + scope so the update
 *  hits the same flow; default_create_status is omitted when blank (PATCH —
 *  the server keeps the stored value, matching the comm intake picker). */
export function workflowDraftToInput(d: WorkflowDraft, projectId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: d.name.trim(),
    attributeDefId: d.attributeDefId,
    scopeCardId: d.scopeCardId !== '' ? d.scopeCardId : projectId,
    doc: d.doc,
  };
  if (d.id !== '' && d.id !== '0') out['id'] = d.id;
  if (d.defaultCreateStatusId && d.defaultCreateStatusId !== '0') {
    out['defaultCreateStatusId'] = d.defaultCreateStatusId;
  }
  return out;
}

export function validateWorkflowDraft(d: WorkflowDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (d.name.trim() === '') errors['name'] = 'Workflow name is required.';
  if (d.attributeDefId === '') errors['attributeDefId'] = 'Workflow is missing its governed attribute.';
  return errors;
}

export const WORKFLOW_FORM: RecordFormScreenConfig = {
  title: 'Workflow',
  projectScopePath: 'scope.projectId',
  saveSpec: 'flow.set',
  listSpec: 'flow.list',
  listProjectKey: 'scopeCardId', // flow.list scopes on scope_card_id, not project_id
  allowCreate: false, // creation is via the MasterDetail create dialog (governed attr)
  saveButtonLabel: 'Save workflow',
  rowToDraft: (row) => workflowRowToDraft(row as unknown as FlowRow) as unknown as Record<string, unknown>,
  draftToInput: (draft, projectId) => workflowDraftToInput(draft as unknown as WorkflowDraft, projectId),
  emptyDraft: () => emptyWorkflowDraft() as unknown as Record<string, unknown>,
  validate: (draft) => validateWorkflowDraft(draft as unknown as WorkflowDraft),
  fields: [
    { name: 'name', label: 'Name', kind: 'text' },
    // The governed attribute identifies the flow (status vs comm_status) — shown
    // read-only since changing it is structural (set at create).
    { name: 'attribute_def_name', label: 'Governs', kind: 'readonly' },
    { name: 'doc', label: 'Description', kind: 'text', placeholder: 'What this workflow governs' },
    {
      name: 'defaultCreateStatusId',
      label: 'Initial status (new items)',
      kind: 'selectFromQuery',
      optionsFrom: {
        spec: 'card.select_with_attributes',
        input: {
          cardTypeName: { lit: 'status' },
          parentCardId: { fromProject: true },
          order: { lit: [{ field: 'attributes.title', direction: 'ASC' }] },
        },
        valueField: 'id',
        labelField: 'attributes.title',
        placeholderLabel: 'No default (flow triage)',
      },
    },
  ],
};
