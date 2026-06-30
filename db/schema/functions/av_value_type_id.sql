-- av_value_type_id — map an attribute_def.value_type to its storage-class
-- id (denormalized onto attribute_value.value_type_id). <1000 = structured
-- scalar / compound (equality via the (attribute_def_id, value) btree);
-- >=1000 = plain text (trigram only, kept OUT of the btree so a large
-- markdown body can't overflow the 2704-byte btree tuple cap). Single
-- source of the mapping, shared by the attribute_value_set_type_id trigger
-- and the value_type_id backfill migration. IMMUTABLE — the mapping is a
-- constant. New value_types: add an explicit arm here; the ELSE defaults to
-- the text class (trigram, no btree) so an unmapped type stays overflow-safe.
CREATE OR REPLACE FUNCTION av_value_type_id(value_type text) RETURNS int
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE value_type
    WHEN 'number'     THEN 10
    WHEN 'bool'       THEN 20
    WHEN 'date'       THEN 30
    WHEN 'card_ref'   THEN 40
    WHEN 'card_ref[]' THEN 50
    WHEN 'text'       THEN 1000
    ELSE 1000
  END
$$;
