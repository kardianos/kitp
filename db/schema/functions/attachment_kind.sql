-- attachment_kind — the display bucket the web client previews an
-- attachment by:
--   image    → server thumbnail + the gallery's <img>
--   pdf      → the browser's PDF viewer in the gallery
--   markdown → rendered by the web client's Markdown sink in the gallery
--   other    → the attachments list only, no preview
-- Markdown matches on the mime type OR the filename extension: browsers
-- and OSes rarely agree on a type for .md (text/markdown, text/x-markdown,
-- or none at all, which uploads as application/octet-stream).
-- Shared by attachment_create_batch and attachment_list_batch.
CREATE OR REPLACE FUNCTION attachment_kind(mime text, filename text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN lower(btrim(mime)) LIKE 'image/%' THEN 'image'
        WHEN lower(btrim(mime)) = 'application/pdf' THEN 'pdf'
        WHEN lower(btrim(mime)) IN ('text/markdown', 'text/x-markdown')
          OR lower(filename) ~ '\.(md|markdown)$' THEN 'markdown'
        ELSE 'other'
    END
$$;
