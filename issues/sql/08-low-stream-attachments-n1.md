# S8 — `streamAttachments` reads CAS chunks per-attachment serially

- **Severity:** LOW (performance footgun)
- **Status:** ✅ RESOLVED 2026-05-22
- **Agent:** sql
- **Location:** `server/internal/dom/projectexport/full.go:791-814` (`streamAttachments`)

## Resolution

Per DT directive: the `Backend.Get(ctx, address) (io.ReadCloser, error)`
abstraction was the wrong shape. Replaced with
`Backend.GetAll(ctx, addresses []string, w io.Writer) error` —
fetches every chunk address in one query and writes each blob's
bytes to the supplied writer as the rows arrive off the wire.
Single-blob callers pass a one-element slice; there is no `Get`
shortcut left.

PgBackend's implementation uses
`unnest($1::text[]) WITH ORDINALITY` joined to `cas_blob_data` so
duplicate addresses (a file with N identical 1MB blocks dedupped
to one CAS row) replay the same bytes once per occurrence. A
naive `WHERE address = ANY($1)` would collapse the duplicates and
silently truncate the file — caught by an existing regression
test (`TestChunkedUploadDownloadDelete`).

Three call sites migrated:

- `projectexport/full.go` `streamAttachments` — zip writer +
  sha256 hash fan-out via `io.MultiWriter(zipEntry, hasher)`.
  One round-trip per attachment, regardless of chunk count.
- `attachment/http.go` `handleStream` — bytes stream straight to
  the `http.ResponseWriter`.
- `attachment/thumb.go` — single GetAll into the decode buffer.

Two new tests: `TestGetAll_StreamsInOrder` (verifies
`array_position`-style ordering across out-of-order inserts) and
`TestGetAll_MissingAddressReturnsErrNotFound` (partial-set is
treated as a corruption signal).

## What

Per-attachment loop calls `cfg.Storage.Get(ctx, addr)` once per
chunk address, sequentially, holding the zip writer's lock. The
chunk list itself is pre-loaded in one query (good); the byte
fetching is N round-trips to `cas_blob_data` per file.

## Risk

A 200 MB attachment with 1 MB chunks is 200 DB round-trips for
that single file. Multiplied by attachments in a project export,
this is a measurable latency cost. Not a security issue.

## Suggested fix

For the pg backend, fetch all chunk bytes for a file in one query:

```sql
SELECT bytes
FROM cas_blob_data
WHERE address = ANY($1::text[])
ORDER BY array_position($1::text[], address)
```

…then stream the rows into the zip writer in the order they come
back. `array_position` preserves the chunk ordering supplied by
the caller.

Out of scope for the security audit; flagged for the perf backlog.

---

DT: Yes. This is an abstraction failure. Get should be GetAll and all addresses should be fetched at once. The division of address and storage is correct and should remain, but abstraction is wrong. Actually, even better, GetAll should not return a `[][]byte` but write directly to a writer, and in this case write to a ByteBuffer wrapping http writer, ideally we manually write the length beforehand as the individual sizes should be stored in the DB. This avoids buffering everything, but still being more effecient. GetAll for the DB implemnetation should get all and as rows come off the wire, write to the writer one chunk at a time.
