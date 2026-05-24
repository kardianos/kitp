# F5 — `marked.setOptions` is a global mutation

- **Severity:** informational
- **Status:** ✅ RESOLVED 2026-05-22 (folded into F3)
- **Agent:** frontend
- **Location:** `client/src/ui/Markdown.svelte:33`

## Resolution

Markdown pipeline extracted into `client/src/util/markdown.ts`.
`marked.setOptions` runs once at module import; the
`afterSanitizeAttributes` DOMPurify hook registers once at module
import. Per-component-instance re-application is eliminated.

## What

`marked.setOptions(...)` is called at module top-level on the
singleton, not on a local `Marked` instance. Currently the only
consumer, but if a second module ever imports `marked` and calls
`setOptions` differently, they'll fight at runtime.

## Why it matters

Configuration drift hazard, not a current vuln.

## Suggested fix

Construct:

```ts
const md = new marked.Marked({ async: false, gfm: true, breaks: true });
```

…and use `md.parse` so each consumer owns its config.
