-- card_access_mint — make one secret route (docs/MAIL_INTAKE_AND_CALENDARS.md
-- §5): a calendar URL or an inbound mail route on a card. The token is 20
-- random bytes as 40 lowercase hex characters — lowercase because mail
-- systems may lowercase an address's local part — and only its SHA-256
-- (auth.HashSecret's form) is stored; the caller hands the token back once.
-- hint is its first 6 characters, so a list can tell routes apart.
CREATE OR REPLACE FUNCTION card_access_mint(
    _card_id bigint,
    _purpose text,
    _provider text,
    _comment text,
    _policy jsonb,
    _signing_key text,
    _actor bigint
) RETURNS TABLE (id bigint, token text, hint text)
LANGUAGE plpgsql AS $$
DECLARE
    _token text := encode(gen_random_bytes(20), 'hex');
    _id bigint;
BEGIN
    INSERT INTO card_access (card_id, purpose, token_hash, hint, comment, provider, policy, signing_key, created_by)
    VALUES (_card_id, _purpose,
            encode(sha256(convert_to(_token, 'UTF8')), 'hex'),
            left(_token, 6),
            COALESCE(_comment, ''), COALESCE(_provider, ''), COALESCE(_policy, '{}'::jsonb),
            CASE WHEN COALESCE(_signing_key, '') <> ''
                 THEN pgp_sym_encrypt(_signing_key, current_setting('app.comm_secret_key')) END,
            _actor)
    RETURNING card_access.id INTO _id;
    RETURN QUERY SELECT _id, _token, left(_token, 6);
END;
$$;
