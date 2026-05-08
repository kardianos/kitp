-- 0025_gate_card_types.sql — gate_template + gate card_types.
--
-- Background: WORKFLOW_SUBCARDS_PLAN.md + WORKFLOW_HYBRID_PLAN.md +
-- IMPL_PLAN_SCOPED_WORKFLOW Phase 3.
--
-- gate_template lives under workflow_def. When a card classifies, the
-- dispatcher walks the workflow's gate_template children and clones
-- each one into a runtime gate sub-card under the parent card. gate
-- itself parents to task (so far) — additional parent-eligible
-- card_types can be added in follow-up migrations.
--
-- v1 uses a single generic `gate` card_type with a `gate_kind`
-- attribute discriminator; specialized card types (signoff, test_plan)
-- are layerable later.
--
-- Forward-only and idempotent.

INSERT INTO card_type (name, parent_card_type_id, allow_self_parent, is_built_in)
SELECT 'gate_template', id, false, true FROM card_type WHERE name = 'workflow_def'
ON CONFLICT (name) DO NOTHING;

INSERT INTO card_type (name, parent_card_type_id, allow_self_parent, is_built_in)
SELECT 'gate', id, false, true FROM card_type WHERE name = 'task'
ON CONFLICT (name) DO NOTHING;
