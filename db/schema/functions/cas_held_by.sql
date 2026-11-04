-- cas_held_by — whether an account may name stored bytes (a CAS address) in
-- file.create: it sent those bytes itself (cas_blob_holder, written by the
-- chunk and signed-upload routes; an agent and its owner count as one), or
-- they are already part of a file it may read (file_readable_by). Knowing a
-- hash is not having the bytes: without this anyone could claim a stored
-- file by its sha256, and cas.missing_chunks told them which ones exist
-- (review 2026-11-03 round 2 #21). cas.missing_chunks reports bytes an
-- account doesn't hold as missing, so the client sends them; storing them
-- again is a no-op that records the holder.
CREATE OR REPLACE FUNCTION cas_held_by(address text, reader bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
               SELECT 1 FROM cas_blob_holder h
               WHERE h.address = cas_held_by.address
                 AND account_principal(h.user_id) = account_principal(reader))
        OR EXISTS (
               SELECT 1 FROM file_chunk fc
               WHERE fc.cas_address = cas_held_by.address
                 AND file_readable_by(reader, fc.file_id))
$$;
