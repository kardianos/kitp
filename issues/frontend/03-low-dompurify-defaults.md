# F3 — DOMPurify is invoked with default config

- **Severity:** low (informational hardening)
- **Status:** ✅ RESOLVED 2026-05-22
- **Agent:** frontend
- **Location:** `client/src/ui/Markdown.svelte:41`

## Resolution

Pipeline extracted into `client/src/util/markdown.ts` (a single
module that owns marked + DOMPurify setup), with an explicit
config:

- `ALLOWED_TAGS` pins the set of HTML tags marked actually emits
  (CommonMark + GFM tables + task lists). Future DOMPurify
  releases that widen defaults can't silently expose new
  elements.
- `ALLOWED_ATTR` pins the attribute set; `style` and event
  handlers are dropped, `class` survives for layout hooks.
- `ALLOWED_URI_REGEXP` whitelists `http(s):`, `mailto:`,
  `tel:`, `#`, and `/` — no `javascript:`, no `data:`.
- `afterSanitizeAttributes` hook rewrites every `<a href=…>` to
  `target="_blank" rel="noopener noreferrer"` (reverse-tabnabbing
  prevention) and disables task-list checkboxes so a viewer
  can't toggle them.
- `marked.setOptions` runs once at module import — closes F5
  ("global mutation per render") in the same move.

Markdown.svelte is now ~25 lines (down from 50+); the only
public surface is `renderMarkdown(source: string): string`.
`svelte-check` clean.

## What

`DOMPurify.sanitize(rawHtml)` is called without options. Defaults
are safe (strip `<script>`, `on*`, `javascript:` URLs, `<iframe>`,
etc.), but:

- (a) the markdown pipeline allows inline HTML through `marked` and
  relies entirely on DOMPurify's allowlist; if the dep's defaults
  ever loosen in a future major, the boundary moves under us;
- (b) `target` attributes are preserved if a user smuggles one in
  via inline HTML — no automatic `rel="noopener noreferrer"` rewrite
  (modern browsers default to implicit noopener, so the practical
  risk is low).

## Why it matters

Pinning the policy to the codebase decouples our threat model from
upstream defaults.

## Suggested fix

Replace with an explicit config and a hook:

```ts
const safe = DOMPurify.sanitize(rawHtml, {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'iframe', 'form', 'object', 'embed', 'base'],
  FORBID_ATTR: ['style', 'formaction'],
  ALLOWED_URI_REGEXP: /^(?:https?|mailto|tel|#|\/)/i,
});

DOMPurify.addHook('afterSanitizeAttributes', (n) => {
  if (n.tagName === 'A' && n.getAttribute('target') === '_blank') {
    n.setAttribute('rel', 'noopener noreferrer');
  }
});
```

Also pass `gfm` + disable inline HTML in `marked` itself with a
custom tokenizer override if practical.
