-- my_screen_toggles — the phase toggles a personal screen starts with
-- (docs/PERSONAL_SCREENS.md), in the screen toggle_groups shape: New,
-- Active (on) and Closed over the listed card type's status attribute —
-- `status` for tasks, `comm_status` for threads.
CREATE OR REPLACE FUNCTION my_screen_toggles(_list_card_type text)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
    SELECT jsonb_build_array(jsonb_build_object(
        'name', 'phase_scope', 'operator', 'or', 'mode', 'multi',
        'items', jsonb_build_array(
            jsonb_build_object('name', 'triage', 'label', 'New', 'default_on', false,
                'predicate', jsonb_build_object('attr', a.attr, 'op', 'has_phase', 'values', jsonb_build_array('triage'))),
            jsonb_build_object('name', 'active', 'label', 'Active', 'default_on', true,
                'predicate', jsonb_build_object('attr', a.attr, 'op', 'has_phase', 'values', jsonb_build_array('active'))),
            jsonb_build_object('name', 'terminal', 'label', 'Closed', 'default_on', false,
                'predicate', jsonb_build_object('attr', a.attr, 'op', 'has_phase', 'values', jsonb_build_array('terminal'))))))
    FROM (SELECT CASE WHEN _list_card_type = 'comm' THEN 'comm_status' ELSE 'status' END AS attr) a
$$;
