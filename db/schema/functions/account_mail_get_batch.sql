-- account_mail.get — admin: the mail account that sends account emails
-- (address verification codes), or none; and the accounts it may be
-- (choices: every live mail account with an outgoing server and a From
-- address, with its project's title).
CREATE OR REPLACE FUNCTION account_mail_get_batch(actor_id bigint, inputs jsonb)
RETURNS TABLE (idx int, ok boolean, code text, message text, result jsonb)
LANGUAGE sql STABLE AS $$
    WITH attr AS (
        SELECT av.card_id, ad.name, av.value #>> '{}' AS v
        FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
        WHERE ad.name IN ('title', 'smtp_host', 'from_address')
    ), choices AS (
        SELECT ch.id, COALESCE(t.v, '') AS name, COALESCE(pt.v, '') AS project, f.v AS from_address
        FROM card ch
        JOIN card_type ct ON ct.id = ch.card_type_id AND ct.name = 'comm_channel'
        JOIN attr h ON h.card_id = ch.id AND h.name = 'smtp_host' AND btrim(h.v) <> ''
        JOIN attr f ON f.card_id = ch.id AND f.name = 'from_address' AND btrim(f.v) <> ''
        LEFT JOIN attr t ON t.card_id = ch.id AND t.name = 'title'
        LEFT JOIN attr pt ON pt.card_id = ch.parent_card_id AND pt.name = 'title'
        WHERE ch.deleted_at IS NULL
    )
    SELECT (r.ord - 1)::int, true, ''::text, ''::text,
           jsonb_build_object(
               'channel_id', COALESCE((
                   SELECT m.channel_id::text FROM account_mail m JOIN card c ON c.id = m.channel_id AND c.deleted_at IS NULL), ''),
               'choices', COALESCE((
                   SELECT jsonb_agg(jsonb_build_object('id', c.id::text, 'name', c.name, 'project', c.project, 'from_address', c.from_address)
                                    ORDER BY c.project, c.name, c.id)
                   FROM choices c), '[]'::jsonb))
    FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
$$;
