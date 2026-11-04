-- login_unrevoke_person — an admin is giving this person a login
-- (person.grant_account): a login revoked earlier while it was theirs
-- (user_account.revoked_person_card_id) stops blocking its identity, whatever
-- email the new login has — their address may have changed, or the old
-- login had none (review 2026-11-03 round 4 #12). As login_unrevoke does by
-- email: its oidc_sub and email are cleared, so the identity's next sign-in
-- attaches to the new login; the revoked row stays.
CREATE OR REPLACE FUNCTION login_unrevoke_person(person bigint) RETURNS void
LANGUAGE sql AS $$
  UPDATE user_account
     SET oidc_sub = NULL, email = NULL
   WHERE login_revoked_at IS NOT NULL
     AND revoked_person_card_id = login_unrevoke_person.person
$$;
