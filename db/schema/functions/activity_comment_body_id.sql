-- activity_comment_body_id — the comment_body an activity row shows, or NULL:
-- only a comment and an approval vote (its reason) carry one, as
-- value_new.comment_body_id. Any other row's value_new is an attribute value
-- or similar, which a caller can shape like {"comment_body_id": …}; reading
-- it there showed any comment in the workspace, and a non-numeric one broke
-- the feed (review 2026-11-03 #4). The id is checked before the cast.
CREATE OR REPLACE FUNCTION activity_comment_body_id(_kind text, _value jsonb)
RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN _kind IN ('comment', 'approval_decision')
             AND jsonb_typeof(_value) = 'object'
             AND (_value->>'comment_body_id') ~ '^[0-9]{1,18}$'
        THEN (_value->>'comment_body_id')::bigint
    END
$$;
