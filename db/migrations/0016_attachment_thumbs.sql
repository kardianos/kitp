-- 0016_attachment_thumbs.sql — link a per-attachment thumbnail file.
--
-- The thumbnail is a separate `file` row produced server-side at upload
-- time when the original mime type is a known image (png/jpg/webp/gif).
-- The thumb is stored as JPEG with aggressive compression and lives in
-- the same chunked CAS layer as any other file. Pointing at a sibling
-- `file` row (rather than carving a new table) lets the CAS reaper sweep
-- abandoned thumbs through the existing `attachment.file_id` consumer
-- column — we just register `thumb_file_id` as a second consumer.
--
-- Forward-only.

ALTER TABLE attachment
    ADD COLUMN IF NOT EXISTS thumb_file_id bigint REFERENCES file(id);

-- Reaper anti-join: the thumb file should be considered live as long as
-- the parent attachment is active. A partial index keeps the `IS NOT NULL`
-- branch cheap.
CREATE INDEX IF NOT EXISTS idx_attachment_thumb_file_id
    ON attachment(thumb_file_id) WHERE deleted_at IS NULL AND thumb_file_id IS NOT NULL;
