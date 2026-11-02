-- theme.file_get handler — one of a theme's own files (not the base
-- theme's: those are theme.base_file). Returns where the bytes live; the
-- Go PostRun reads them and fills in the content.
--
-- Input:  {"theme_id", "path"}
-- Result: {"path", "mime_type", "size_bytes", "cas_address"}
--
-- Authz: admin only (the dispatcher's AllowedRoles).
CREATE OR REPLACE FUNCTION theme_file_get_batch(
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
    _row record;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF workspace_area_off('sites') THEN
            RETURN QUERY SELECT _idx, false, 'area_off'::text,
                'theme.file_get: Sites is switched off for this workspace'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        BEGIN
            _theme := NULLIF(_raw->>'theme_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'theme.file_get: theme_id must be a card id'::text, NULL::jsonb;
            CONTINUE;
        END;
        SELECT tf.path, tf.mime_type, tf.size_bytes, tf.cas_address INTO _row
        FROM theme_file tf
        JOIN card c ON c.id = tf.theme_id AND c.deleted_at IS NULL
        WHERE tf.theme_id = _theme AND tf.path = _raw->>'path';
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'file_not_found'::text,
                format('theme.file_get: theme %s has no file %L', _theme, _raw->>'path'), NULL::jsonb;
            CONTINUE;
        END IF;
        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('path', _row.path, 'mime_type', _row.mime_type,
                               'size_bytes', _row.size_bytes, 'cas_address', _row.cas_address);
    END LOOP;
END;
$$;
