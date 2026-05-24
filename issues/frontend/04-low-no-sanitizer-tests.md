# F4 — No unit tests cover the sanitizer boundary

- **Severity:** low (informational)
- **Agent:** frontend
- **Location:** `client/src/ui/Markdown.svelte` (no co-located `.test.ts`)

## What

A grep across `client/test/` and `client/src/**/*.test.ts` shows no
tests asserting that `<script>`, `<img onerror>`, `javascript:`
hrefs, or `<iframe>` are stripped.

## Why it matters

Any future refactor that swaps the sanitizer or rearranges the
pipeline could silently regress, and there's no canary.

## Suggested fix

Add a Vitest table with ~10 known XSS payloads (the OWASP
cheat-sheet ones) asserting their absence in the rendered
`safeHtml` string.
