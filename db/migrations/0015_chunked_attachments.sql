-- 0015_chunked_attachments.sql — switch attachments to a chunked CAS model
-- via a generic `file` table.
--
-- Layered shape:
--   cas_blob              — content-addressed bytes (one row per ~1 MB chunk).
--   file                  — a logical "file" with name + size + mime; reusable
--                           by any consumer (attachments today, avatars / inbox
--                           imports / etc. later).
--   file_chunk            — ordered list of cas_blob addresses per file.
--   attachment            — links a card to a file (the only current
--                           consumer of `file`). filename / size / chunks
--                           live on `file`, not here.
--
-- Forward-only: any pre-existing attachment rows are forfeited (dev-only;
-- run `make db-reset` if you've been testing 0014 already).

CREATE TABLE IF NOT EXISTS file (
    id          bigserial PRIMARY KEY,
    filename    text NOT NULL,
    size_bytes  bigint NOT NULL,
    mime_type   text NOT NULL DEFAULT 'application/octet-stream',
    created_at  timestamptz NOT NULL DEFAULT now(),
    created_by  bigint NOT NULL REFERENCES user_account(id)
);

CREATE TABLE IF NOT EXISTS file_chunk (
    file_id      bigint NOT NULL REFERENCES file(id) ON DELETE CASCADE,
    seq          int NOT NULL,
    cas_address  text NOT NULL REFERENCES cas_blob(address),
    chunk_size   bigint NOT NULL,
    PRIMARY KEY (file_id, seq)
);

-- Reaper walks file_chunk.cas_address to find live cas_blob references;
-- a secondary index keeps the anti-join cheap.
CREATE INDEX IF NOT EXISTS idx_file_chunk_cas_address
    ON file_chunk(cas_address);

-- Replace attachment.cas_address (from 0014) and the now-irrelevant
-- filename / created_by columns with attachment.file_id. Existing rows
-- are forfeited.
DROP INDEX IF EXISTS idx_attachment_cas_address;
DELETE FROM attachment;
ALTER TABLE attachment DROP COLUMN IF EXISTS cas_address;
ALTER TABLE attachment DROP COLUMN IF EXISTS filename;
ALTER TABLE attachment DROP COLUMN IF EXISTS created_by;
ALTER TABLE attachment ADD COLUMN IF NOT EXISTS file_id bigint NOT NULL REFERENCES file(id);

CREATE INDEX IF NOT EXISTS idx_attachment_file_id
    ON attachment(file_id) WHERE deleted_at IS NULL;
