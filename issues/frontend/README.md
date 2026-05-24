# Frontend security audit — Svelte SPA

Source paths: `client/src/`. Threat model: XSS via user-controlled
content (task titles, descriptions, comments, comm bodies, person /
contact emails, attribute values, slugs, URLs). The SPA renders
untrusted strings into the DOM in many places. The server doesn't
sanitize — it stores Unicode-normalized text verbatim. Trust is
established at render time.

## Summary

Overall posture is **strong**. The codebase has exactly one
`{@html}` site (`Markdown.svelte`), routed through `marked` →
`DOMPurify` with no caller bypass; zero `innerHTML` /
`outerHTML` / `insertAdjacentHTML` / `document.write`; zero
`eval` / `new Function()` / string-`setTimeout`; consistent
`credentials: 'same-origin'` on every `fetch`; no `target="_blank"`
in source; no `window.open` / `postMessage`; cookies are never read
or written from JS (BFF model); `JSON.parse` is always wrapped in
`try/catch`; every `<a href={…}>` is built from path literals or
internal id strings.

**Biggest concern is environmental, not code**: there is no
Content-Security-Policy (no meta tag, and the server does not
appear to send one), and the PDF inline-view iframe loads a `blob:`
URL whose MIME type is server-controlled, so a mislabeled-as-PDF
attachment could execute same-origin script if the server ever
returns `Content-Type: text/html` for it.

## Findings

| # | Severity | Title |
|---|----------|-------|
| F1 | medium  | [No Content-Security-Policy](01-med-no-csp.md) |
| F2 | medium  | [PDF iframe loads server-controlled MIME blob](02-med-pdf-iframe-mime.md) |
| F3 | low     | [DOMPurify invoked with default config](03-low-dompurify-defaults.md) |
| F4 | low     | [No unit tests cover sanitizer boundary](04-low-no-sanitizer-tests.md) |
| F5 | info    | [`marked.setOptions` is a global mutation](05-low-marked-global-mutation.md) |
| F6 | info    | [`parseLoginError` renders raw `?error=` value](06-low-parseloginerror-text-only.md) |
| F7 | info    | [`downloadAttachment` uses server-supplied filename](07-low-download-filename.md) |

## Categories checked clean

- **`{@html …}` proliferation:** exactly one occurrence
  (`ui/Markdown.svelte:51`), routed through the documented sanitizer;
  verified by `grep -rn "{@html" client/src/`.
- **Direct DOM mutation (`innerHTML` / `outerHTML` /
  `insertAdjacentHTML` / `document.write`):** zero hits anywhere
  under `client/src/`.
- **`eval`, `new Function`, `Worker(string)`, string-form
  `setTimeout` / `setInterval`:** zero hits. All `setTimeout` /
  `setInterval` callers pass a function reference.
- **`document.cookie` reads or writes:** zero hits. Session cookie
  is HttpOnly and lives entirely server-side per the BFF design.
- **`href={…}` with non-literal values:** all five non-literal sites
  (`AppShell.svelte:252`, `NavSidebar.svelte:145/182/223`,
  `TaskRefLink.svelte:46`, `ProjectsScreen.svelte:290`,
  `AdminProjectsScreen.svelte:356`) compose paths from `/`-prefixed
  literals + numeric ids / known slug strings — no `javascript:` /
  `data:` reachability.
- **`src={…}`:** only blob URLs created locally in
  `AttachmentThumbImage.svelte:62` and
  `AttachmentInlineView.svelte:68/70`. Image case is safe; iframe
  case is finding F2.
- **`window.open` / `postMessage` / popup / inline
  `target="_blank"`:** zero hits in source.
- **`location.href = …` / `location.assign(…)`:** two hits, both
  literal / build-time strings (`'/projects'` in
  `AdminAgentsScreen.svelte:203`;
  `${KITP_API_BASE}/api/v1/auth/oidc/start` in
  `LoginScreen.svelte:45` where `KITP_API_BASE` is a Vite
  build-time env). No user-controlled redirect targets.
- **`fetch()` credentials handling:** every fetch (auth_state,
  attachments/upload, AdminAgents impersonate, import_wizard,
  project_export, dispatcher) is same-origin and either explicitly
  sets `credentials: 'same-origin'` or relies on the same-origin
  default; cookie rides correctly. No `credentials: 'include'` to a
  foreign origin.
- **`JSON.parse` exposure:** every call site (`dispatcher.ts:536`,
  `screen_preset.svelte.ts` x3, `activity_predicate.ts:127`,
  `admin_screens_helpers.ts:73`, `validate.ts:172`) is wrapped in
  `try / catch`.
- **localStorage / sessionStorage writes:** only the theme
  (`'kitp.theme'`), sidebar-collapse flag, project scope, and
  templates flag — all small, attacker-uninfluenceable controls.
  None of the stored values are ever re-injected into the DOM as
  HTML.
- **`URLSearchParams` use of `window.location.search`:** only
  `LoginScreen.svelte:35` (the `?error=` field, rendered as text —
  see finding F6).
- **`history.pushState` / `replaceState`:** only with internal SPA
  paths; `pushState` doesn't execute JS regardless of value.
- **`target="_blank"` rel-noopener:** no source-literal
  `target="_blank"` exists; markdown-rendered links rely on
  DOMPurify + modern-browser implicit noopener (see F3 for a
  belt-and-braces fix).
