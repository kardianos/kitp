-- 0014_attachments.sql — content-addressable storage (CAS) + per-card
-- attachments (the first consumer of CAS).
--
-- The CAS layer is generic. Every blob is keyed by its SHA-256 (hex) and
-- carries metadata (size, mime, storage_kind). Per storage_kind the actual
-- bytes live in a different place:
--   - 'pg'  → cas_blob_data (this file)
--   - 's3'  → an S3 bucket (a future migration; cas_blob_data row absent)
-- Lookup walks every configured backend in order (the server config sets
-- the order), so moving a blob from pg to s3 later is lift-and-shift: copy,
-- swap storage_kind, reaper deletes the old row.
--
-- attachment is one of N possible CAS consumers. Other tables can carry
-- cas_address columns of their own; the reaper service finds unreferenced
-- cas_blob rows by union'ing all consumer tables.
--
-- Forward-only; safe to re-run via the runner's idempotency.

CREATE TABLE IF NOT EXISTS cas_blob (
    address         text PRIMARY KEY,
    size_bytes      bigint NOT NULL,
    mime_type       text NOT NULL DEFAULT 'application/octet-stream',
    storage_kind    text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- Inline pg-storage backend. Only populated when storage_kind='pg' on the
-- corresponding cas_blob row; absent when the blob lives in S3 (or any
-- future external backend).
CREATE TABLE IF NOT EXISTS cas_blob_data (
    address     text PRIMARY KEY REFERENCES cas_blob(address) ON DELETE CASCADE,
    data        bytea NOT NULL
);

CREATE TABLE IF NOT EXISTS attachment (
    id              bigserial PRIMARY KEY,
    card_id         bigint NOT NULL REFERENCES card(id),
    cas_address     text NOT NULL REFERENCES cas_blob(address),
    filename        text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      bigint NOT NULL REFERENCES user_account(id),
    deleted_at      timestamptz
);

-- Per-card lookup hits a B-tree on (card_id, deleted_at).
CREATE INDEX IF NOT EXISTS idx_attachment_card_id_active
    ON attachment(card_id) WHERE deleted_at IS NULL;

-- Reaper walks attachment.cas_address (and any future consumer columns) to
-- find referenced CAS rows. A simple secondary index on cas_address keeps
-- that scan cheap.
CREATE INDEX IF NOT EXISTS idx_attachment_cas_address
    ON attachment(cas_address) WHERE deleted_at IS NULL;
