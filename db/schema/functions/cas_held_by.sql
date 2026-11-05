-- cas_held_by — whether an account may name stored bytes (a CAS address) in
-- file.create: it sent those bytes itself (cas_blob_holder, written by the
-- chunk and signed-upload routes; an agent and its owner count as one).
-- Knowing a hash is not having the bytes: without this anyone could claim a
-- stored file by its sha256, and cas.missing_chunks told them which ones
-- exist (review 2026-11-03 round 2 #21). cas.missing_chunks reports bytes an
-- account doesn't hold as missing, so the client sends them; storing them
-- again is a no-op that records the holder.
--
-- The holder rows are looked up by key — the reader's principal and that
-- principal's personal agents (cas_reader_principals) — not by working out
-- every holder's principal: with thousands of holders of one address that
-- cost 90 ms an address (round 4 #15). Set-based callers (file.create,
-- cas.missing_chunks) work the set out once and match it themselves. A
-- workspace agent (owned by System) is its own principal, so System's
-- agents are not System's. Bytes in a file the
-- account may read don't count: such a file is attached by id
-- (attachment.create), not by its bytes (round 3 #7).
CREATE OR REPLACE FUNCTION cas_held_by(address text, reader bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM cas_blob_holder h
        WHERE h.address = cas_held_by.address
          AND h.user_id = ANY (cas_reader_principals(reader)))
$$;
