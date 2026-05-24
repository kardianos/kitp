# B4 — OIDC email-fallback does not require `email_verified`

- **Severity:** HIGH
- **Status:** ✅ RESOLVED 2026-05-21
- **Agent:** backend
- **Location:** `server/internal/auth/oidc/oidc.go:437-464` (the email-fallback block in `provisionUser`)

## Resolution

`provisionUser` now reads `claims["email_verified"]` and gates the
fallback on it. The override is exposed as
`Config.TrustUnverifiedEmail`, wired from
`KITP_OIDC_TRUST_UNVERIFIED_EMAIL=1`. Default is OFF — fail closed.

When the gate rejects (unverified email + no override), the
fallback is skipped and the user falls through to the
fresh-insert path, getting their own new `user_account` row
instead of attaching to a pre-created admin.

Env-var documented in `cmd/kitpd/main.go`'s header block. OIDC
package tests still green.

## What

When `sub` doesn't match a `user_account` row and the claim has a
non-empty `email`, the code attaches the OIDC sub to the first
`user_account WHERE email = ? AND oidc_sub IS NULL`. There is no
`email_verified` claim check.

If the OIDC OP allows users to claim an unverified arbitrary email
(common with self-service OPs or misconfigured Azure AD B2C
tenants), an attacker who knows the bootstrap admin's email can
pre-empt the legitimate admin by signing in first.

## Why it matters

This is the published bootstrap attack vector for OIDC apps that
match by email. Combined with B2 (race in init-mode admin grant),
the attacker who pre-empts the email becomes the admin.

## Suggested fix

Require `email_verified == true` (and, where the OP supports it, an
`iss` allowlist) before honoring the email fallback. Configurable
via env so trusted-OP deployments can opt out.

```go
if email != "" {
    emailVerified, _ := claims["email_verified"].(bool)
    if !emailVerified && !v.cfg.TrustUnverifiedEmail {
        // skip the email fallback; fall through to fresh insert
    } else {
        // existing email-match path
    }
}
```

Document the `TrustUnverifiedEmail` knob loudly — it should default
off and only be flipped for deployments whose OP is known to verify
emails out-of-band.
