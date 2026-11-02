-- theme.file_delete handler — remove one of a theme's files, so the base
-- theme's file of that name (if any) applies again. The Go PreRun checks
-- the theme's templates still parse without it.
--
-- Input:  {"theme_id", "path"}
-- Result: {"deleted": bool}   false when the theme had no such file
--
-- Authz: admin only (the dispatcher's AllowedRoles).
CREATE OR REPLACE FUNCTION theme_file_delete_batch(
    actor_id bigint,
    inputs jsonb
) RETURNS TABLE (
    idx int,
    ok boolean,
    code text,
    message text,
    result jsonb
) LANGUAGE plpgsql AS $$
DECLARE
    _idx int;
    _raw jsonb;
    _theme bigint;
    _n int;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF workspace_area_off('sites') THEN
            RETURN QUERY SELECT _idx, false, 'area_off'::text,
                'theme.file_delete: Sites is switched off for this workspace'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        BEGIN
            _theme := NULLIF(_raw->>'theme_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'theme.file_delete: theme_id must be a card id'::text, NULL::jsonb;
            CONTINUE;
        END;
        DELETE FROM theme_file tf
        USING card c
        WHERE c.id = tf.theme_id AND c.deleted_at IS NULL
          AND tf.theme_id = _theme AND tf.path = _raw->>'path';
        GET DIAGNOSTICS _n = ROW_COUNT;
        IF _n > 0 THEN
            INSERT INTO activity (card_id, kind, value_old, actor_id)
            VALUES (_theme, 'theme_file_delete', jsonb_build_object('path', _raw->>'path'),
                    theme_file_delete_batch.actor_id);
            PERFORM theme_mark_portals_dirty(_theme);
        END IF;
        RETURN QUERY SELECT _idx, true, ''::text, ''::text, jsonb_build_object('deleted', _n > 0);
    END LOOP;
END;
$$;
