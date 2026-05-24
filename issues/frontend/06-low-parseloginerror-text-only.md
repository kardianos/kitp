# F6 — `parseLoginError` returns the raw `?error=` value to be rendered

- **Severity:** informational (not exploitable)
- **Agent:** frontend
- **Location:** `client/src/screens/login_helpers.ts:33`, rendered at `client/src/screens/LoginScreen.svelte:116`

## What

The `?error=…` query param is parsed and shown to the user. The
render site uses Svelte text interpolation `{loginError.message}`
so HTML is escaped — safe.

Worth noting only because a future change to render this via
`{@html}` (or to copy the value into an `href` / `src`) would
become exploitable since the attacker controls the query string in
a phishing URL.

## Why it matters

Pinning intent: this field must stay text-only.

## Suggested fix

Add an inline comment on `parseLoginError` reiterating "render as
text only" (the docblock already hints this but doesn't enforce
it); optionally cap length to ~200 chars to prevent layout abuse.
