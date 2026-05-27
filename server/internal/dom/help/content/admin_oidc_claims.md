# OIDC Claims

Map an **OIDC group/claim value** (the strings your identity provider sends at
sign-in) to a **role**. When someone signs in, every claim value that matches a
row here grants them the mapped role for the session.

- **Add a mapping**: type the claim value (e.g. `kitp-admins`) and pick the role
  it should grant, then **Add**.
- **Remove a mapping**: use the ✕ on its row.

This is the only place sign-in → role assignment is configured. The roles
themselves and the `(card type, action)` grants behind them are defined in the
seed and shown read-only on the **Roles** screen.

A user can match several mappings; they receive the union of the mapped roles.
If no mapping matches, the user signs in with no role (read-only visibility
only), so make sure at least one admin claim is mapped.
