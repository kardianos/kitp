-- card_date — a card's stored date attribute (start_date, due_date, …) as
-- its ISO text, or NULL when it has none: no row, or the JSON null a removal
-- leaves. Read by attribute.update and the attribute_value_date_order
-- trigger to judge a write against the card's other date.
CREATE OR REPLACE FUNCTION card_date(card_id bigint, attr_name text)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT av.value #>> '{}'
  FROM attribute_value av
  JOIN attribute_def ad ON ad.id = av.attribute_def_id
  WHERE av.card_id = $1 AND ad.name = $2 AND jsonb_typeof(av.value) = 'string'
$$;
