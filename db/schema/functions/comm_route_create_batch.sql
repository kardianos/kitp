-- comm_route.create — add an inbound route to a mail account: a POST URL
-- (purpose inbound_post; provider raw / mailgun / postmark) or an SMTP
-- address (inbound_smtp). Returns the secret token ONCE; the client builds
-- the URL (/api/v1/comm/inbound/<token>, + /mime for Mailgun) or the address
-- (<token>@KITP_SMTP_DOMAIN). Mailgun needs its webhook signing key (stored
-- pgp_sym_encrypt'ed). The policy arrives validated and normalised by the Go
-- input type (mailin.Policy). Admin only. docs/MAIL_INTAKE_AND_CALENDARS.md §5.
CREATE OR REPLACE FUNCTION comm_route_create_batch(
    actor_id bigint,
    inputs jsonb
) RETURNS TABLE (idx int, ok boolean, code text, message text, result jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    _idx int;
    _raw jsonb;
    _channel bigint;
    _purpose text;
    _provider text;
    _key text;
    _m record;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF COALESCE(_raw->>'channel_id', '') !~ '^\d+$' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text, 'comm_route.create: channel_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        _channel := (_raw->>'channel_id')::bigint;
        IF NOT EXISTS (SELECT 1 FROM card c JOIN card_type ct ON ct.id = c.card_type_id
                       WHERE c.id = _channel AND ct.name = 'comm_channel' AND c.deleted_at IS NULL) THEN
            RETURN QUERY SELECT _idx, false, 'not_found'::text,
                format('comm_route.create: mail account %s not found', _channel), NULL::jsonb;
            CONTINUE;
        END IF;
        _purpose := COALESCE(_raw->>'purpose', '');
        _provider := lower(COALESCE(_raw->>'provider', ''));
        _key := btrim(COALESCE(_raw->>'signing_key', ''));
        IF _purpose = 'inbound_post' THEN
            IF _provider NOT IN ('raw', 'mailgun', 'postmark') THEN
                RETURN QUERY SELECT _idx, false, 'validation'::text,
                    format('comm_route.create: provider %L: use raw, mailgun or postmark', _provider), NULL::jsonb;
                CONTINUE;
            END IF;
            IF _provider = 'mailgun' AND _key = '' THEN
                RETURN QUERY SELECT _idx, false, 'validation'::text,
                    'comm_route.create: a Mailgun route needs its webhook signing key'::text, NULL::jsonb;
                CONTINUE;
            END IF;
            IF _provider <> 'mailgun' THEN
                _key := '';
            END IF;
        ELSIF _purpose = 'inbound_smtp' THEN
            _provider := '';
            _key := '';
        ELSE
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('comm_route.create: purpose %L: use inbound_post or inbound_smtp', _purpose), NULL::jsonb;
            CONTINUE;
        END IF;
        SELECT * INTO _m FROM card_access_mint(_channel, _purpose, _provider,
            left(btrim(COALESCE(_raw->>'comment', '')), 200),
            COALESCE(_raw->'policy', '{}'::jsonb), _key, comm_route_create_batch.actor_id);
        RETURN QUERY SELECT _idx, true, ''::text, ''::text, jsonb_build_object(
            'id', _m.id::text, 'token', _m.token, 'hint', _m.hint,
            'purpose', _purpose, 'provider', _provider);
    END LOOP;
END;
$$;
