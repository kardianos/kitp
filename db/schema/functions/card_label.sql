-- card_label — a card's display title: its `title` attribute, else its
-- `reply_subject` (reply_body cards carry a subject instead of a title).
-- '' when it has neither.
CREATE OR REPLACE FUNCTION card_label(card_id bigint)
RETURNS text LANGUAGE sql STABLE AS $$
    SELECT COALESCE((
        SELECT NULLIF(av.value #>> '{}', '')
        FROM attribute_value av
        JOIN attribute_def ad ON ad.id = av.attribute_def_id
        WHERE av.card_id = card_label.card_id
          AND ad.name IN ('title', 'reply_subject')
          AND NULLIF(av.value #>> '{}', '') IS NOT NULL
        ORDER BY ad.name = 'title' DESC
        LIMIT 1
    ), '')
$$;
