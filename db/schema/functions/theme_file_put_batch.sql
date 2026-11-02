-- theme.file_put handler — add or replace one of a theme's files. The Go
-- PreRun has already checked the path, stored the bytes as a CAS blob and,
-- for a template, parsed and test-rendered the theme with it; this writes
-- the theme_file row and rebuilds the portals using the theme.
--
-- Input:  {"theme_id", "path", "cas_address", "mime_type", "size_bytes"}
-- Result: {"theme_id": "<id>", "path", "size_bytes", "changed": bool}
--         changed is false when the file already held these bytes.
--
-- Authz: admin only (the dispatcher's AllowedRoles).
CREATE OR REPLACE FUNCTION theme_file_put_batch(
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
    _path text;
    _addr text;
    _mime text;
    _size bigint;
    _changed boolean;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF workspace_area_off('sites') THEN
            RETURN QUERY SELECT _idx, false, 'area_off'::text,
                'theme.file_put: Sites is switched off for this workspace'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        BEGIN
            _theme := NULLIF(_raw->>'theme_id', '')::bigint;
            _size := COALESCE(NULLIF(_raw->>'size_bytes', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'theme.file_put: theme_id must be a card id'::text, NULL::jsonb;
            CONTINUE;
        END;
        _path := _raw->>'path';
        _addr := _raw->>'cas_address';
        _mime := COALESCE(NULLIF(_raw->>'mime_type', ''), 'application/octet-stream');
        IF _theme IS NULL OR COALESCE(_path, '') = '' OR COALESCE(_addr, '') = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'theme.file_put: theme_id, path and the file''s content are required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        PERFORM 1 FROM card c JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'theme'
        WHERE c.id = _theme AND c.deleted_at IS NULL;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'theme_not_found'::text,
                format('theme.file_put: theme %s not found', _theme), NULL::jsonb;
            CONTINUE;
        END IF;

        SELECT tf.cas_address IS DISTINCT FROM _addr OR tf.mime_type IS DISTINCT FROM _mime
          INTO _changed
        FROM theme_file tf WHERE tf.theme_id = _theme AND tf.path = _path;
        _changed := COALESCE(_changed, true);

        IF _changed THEN
            INSERT INTO theme_file (theme_id, path, cas_address, mime_type, size_bytes, updated_at, updated_by)
            VALUES (_theme, _path, _addr, _mime, _size, now(), theme_file_put_batch.actor_id)
            ON CONFLICT (theme_id, path) DO UPDATE SET
                cas_address = EXCLUDED.cas_address,
                mime_type = EXCLUDED.mime_type,
                size_bytes = EXCLUDED.size_bytes,
                updated_at = EXCLUDED.updated_at,
                updated_by = EXCLUDED.updated_by;
            INSERT INTO activity (card_id, kind, value_new, actor_id)
            VALUES (_theme, 'theme_file_put', jsonb_build_object('path', _path, 'size_bytes', _size),
                    theme_file_put_batch.actor_id);
            PERFORM theme_mark_portals_dirty(_theme);
        END IF;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('theme_id', _theme::text, 'path', _path,
                               'size_bytes', _size, 'changed', _changed);
    END LOOP;
END;
$$;
