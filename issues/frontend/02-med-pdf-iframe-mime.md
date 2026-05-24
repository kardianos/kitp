# F2 — PDF iframe loads a blob whose MIME type is server-controlled

- **Severity:** medium (depends on server behaviour)
- **Status:** ⊘ WONTFIX 2026-05-22
- **Agent:** frontend
- **Location:** `client/src/ui/widgets/AttachmentInlineView.svelte:68`

## Decision

Project owner dismissed: the audit's framing inverts the trust
model. In this architecture the server is the source of truth and
the client trusts what it serves; defending the client against a
malicious server's MIME header isn't a useful posture. Any future
"server lies about MIME" concern is addressed by the upload-time
filename sanitiser (B-side controls) and by treating the
attachment bytes as already-vetted at write time, not by adding
client-side sniffing.

## What

`<iframe title={filename} src={url}>` where `url =
URL.createObjectURL(blob)` and `blob` is whatever
`/api/v1/attachment/{id}/view` returns. The blob's MIME type comes
from the server's `Content-Type` header. The iframe has no
`sandbox` attribute and the blob URL is same-origin with the SPA.

If a malicious user uploads an HTML payload, sets the upload's
stored `mimeType` to `application/pdf` so `kind === 'pdf'` on the
read side, and the server faithfully echoes the uploader-asserted
Content-Type on the `/view` route, the HTML will execute in a
same-origin frame.

## Why it matters

Full DOM/cookie-equivalent access from the iframe (the
`kitp_session` cookie is HttpOnly, but the iframe can issue
`fetch('/api/v1/batch', …)` with `credentials: 'same-origin'` and
impersonate the viewer).

## Suggested fix

Add `sandbox="allow-same-origin"` (no `allow-scripts`) — or, safer,
sniff client-side: after `fetchAttachmentBlob`, check
`blob.type === 'application/pdf'` before falling into the iframe
branch; otherwise render the "download" placeholder.

Pair with a server fix that re-derives Content-Type from sniffing
the bytes, not the uploader-supplied value, and sends
`X-Content-Type-Options: nosniff`.
