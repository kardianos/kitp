-- 0028_propagates_gates.sql — gate inheritance via card_ref propagation.
--
-- Background: WORKFLOW_SHARED_GATES_PLAN.md + IMPL_PLAN_SCOPED_WORKFLOW
-- Phase 4.
--
-- An attribute_def with propagates_gates = true tells the effective-gate
-- resolver: when a card carries a value of this attribute (a card_ref
-- pointing at some "context" card), inherit the context's gate sub-cards
-- as effective gates on the referrer.
--
-- We default the flag true on milestone_ref and component_ref so the
-- common case (a release/component owns gates that apply to every task
-- targeting it) works out of the box.
--
-- Forward-only and idempotent.

ALTER TABLE attribute_def
    ADD COLUMN IF NOT EXISTS propagates_gates boolean NOT NULL DEFAULT false;

UPDATE attribute_def
   SET propagates_gates = true
 WHERE name IN ('milestone_ref', 'component_ref');
