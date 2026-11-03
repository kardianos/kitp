-- watch_list_owned_by — whether a live watch list belongs to the account
-- (its subscriber is watch_owner(_actor)). Watch lists are each account's
-- own: no admin exception here (an admin cleans up through card.*).
-- docs/WATCH_LISTS.md.
CREATE OR REPLACE FUNCTION watch_list_owned_by(_list bigint, _actor bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM card c
        JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'watch_list'
        JOIN attribute_value av ON av.card_id = c.id
        JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'subscriber'
        WHERE c.id = _list AND c.deleted_at IS NULL
          AND jsonb_typeof(av.value) = 'number'
          AND (av.value)::text::bigint = watch_owner(_actor))
$$;
