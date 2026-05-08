-- 0026_gate_attrs.sql — gate-related attribute_defs + edges + status options.
--
-- Background: WORKFLOW_SUBCARDS_PLAN.md "New card types" + Phase 3.
--
-- - gate_kind: discriminator (signoff, test_plan, review, …) on both
--   gate_template and runtime gate cards.
-- - required_in_states: text array — which parent states require this
--   gate to be approved before transitioning into them.
-- - default_assignee: user_ref (or eventually a role_ref); copied from
--   template to runtime gate at spawn time.
-- - gate_template_ref: card_ref on runtime gate cards pointing back to
--   the workflow's gate_template. Rename-safe key for the transition
--   guard.
-- - gate cards reuse the existing `status` and `assignee` attributes;
--   we add scoped `status` options (pending/approved/rejected/n_a)
--   only when scoped to the gate card_type via the workflow_def_id
--   axis (handled by attribute_def_option scope rules).
--
-- Forward-only and idempotent.

INSERT INTO attribute_def (name, value_type, is_built_in) VALUES
    ('gate_kind',          'text',     true),
    ('required_in_states', 'text',     true),  -- stored as JSON array string
    ('default_assignee',   'user_ref', true),
    ('gate_template_ref',  'card_ref', true),
    ('gate_status',        'enum',     true)
ON CONFLICT (name) DO NOTHING;

-- gate_template required attributes: title, gate_kind, required_in_states.
-- default_assignee is optional.
INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
SELECT ct.id, ad.id,
       CASE WHEN ad.name IN ('gate_kind','required_in_states') THEN true ELSE false END,
       row_number() OVER (ORDER BY ad.name)
FROM card_type ct
CROSS JOIN attribute_def ad
WHERE ct.name = 'gate_template'
  AND ad.name IN ('gate_kind','required_in_states','default_assignee')
ON CONFLICT (card_type_id, attribute_def_id, COALESCE(project_type_id, 0), COALESCE(workflow_def_id, 0)) DO NOTHING;

-- gate_template also carries title (built-in required).
INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
SELECT ct.id, ad.id, true, 0
FROM card_type ct
CROSS JOIN attribute_def ad
WHERE ct.name = 'gate_template' AND ad.name = 'title'
ON CONFLICT (card_type_id, attribute_def_id, COALESCE(project_type_id, 0), COALESCE(workflow_def_id, 0)) DO NOTHING;

-- gate runtime card: title (required), gate_kind (required),
-- gate_template_ref (required), gate_status (required), assignee
-- (optional), required_in_states (copied from template), default_assignee
-- omitted.
INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
SELECT ct.id, ad.id,
       CASE WHEN ad.name IN ('title','gate_kind','gate_template_ref','gate_status') THEN true ELSE false END,
       row_number() OVER (ORDER BY ad.name)
FROM card_type ct
CROSS JOIN attribute_def ad
WHERE ct.name = 'gate'
  AND ad.name IN ('title','gate_kind','gate_template_ref','gate_status','assignee','required_in_states')
ON CONFLICT (card_type_id, attribute_def_id, COALESCE(project_type_id, 0), COALESCE(workflow_def_id, 0)) DO NOTHING;

-- Status options for gate_status — the dedicated enum keeps gate
-- statuses out of the task status picker.
INSERT INTO attribute_def_option (attribute_def_id, value, label, ordering)
SELECT ad.id, v.value, v.label, v.ordering
FROM attribute_def ad
CROSS JOIN (VALUES
    ('pending',  'Pending',  0),
    ('approved', 'Approved', 1),
    ('rejected', 'Rejected', 2),
    ('n_a',      'N/A',      3)
) AS v(value, label, ordering)
WHERE ad.name = 'gate_status'
ON CONFLICT (attribute_def_id, value, COALESCE(project_type_id, 0), COALESCE(project_card_id, 0), COALESCE(workflow_def_id, 0)) DO NOTHING;
