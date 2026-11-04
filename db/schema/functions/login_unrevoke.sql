-- login_unrevoke — an admin is giving someone a login with this email
-- (person.grant_account, person.create tier=user): a login revoked earlier
-- (user.revoke_login) with the same email stops blocking that identity. Its
-- oidc_sub and email are cleared, so the identity's next sign-in attaches to
-- the new login by email instead of reaching the revoked one; the revoked
-- row stays (no roles, no person) so what it wrote keeps its author.
CREATE OR REPLACE FUNCTION login_unrevoke(email text) RETURNS void
LANGUAGE sql AS $$
  UPDATE user_account
     SET oidc_sub = NULL, email = NULL
   WHERE login_revoked_at IS NOT NULL
     AND lower(user_account.email) = lower(btrim(login_unrevoke.email))
$$;
