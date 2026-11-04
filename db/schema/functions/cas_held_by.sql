-- cas_held_by — whether an account may name stored bytes (a CAS address) in
-- file.create: it sent those bytes itself (cas_blob_holder, written by the
-- chunk and signed-upload routes; an agent and its owner count as one).
-- Knowing a hash is not having the bytes: without this anyone could claim a
-- stored file by its sha256, and cas.missing_chunks told them which ones
-- exist (review 2026-11-03 round 2 #21). cas.missing_chunks reports bytes an
-- account doesn't hold as missing, so the client sends them; storing them
-- again is a no-op that records the holder.
--
-- Bytes that are part of a file the account may read used to count too, but
-- that asked file_readable_by of every file sharing the bytes — about 1 ms
-- each, so an upload of a common file (a signature logo in thousands of
-- threads) timed out (round 3 #7). A file the account may read is attached
-- by id (attachment.create), not by its bytes. Migration 0037 recorded every
-- file's creator as a holder of its bytes.
CREATE OR REPLACE FUNCTION cas_held_by(address text, reader bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
               SELECT 1 FROM cas_blob_holder h
               WHERE h.address = cas_held_by.address
                 AND account_principal(h.user_id) = account_principal(reader))
$$;
