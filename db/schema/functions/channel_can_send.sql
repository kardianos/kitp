-- channel_can_send — whether a mail account has a way out: a From address,
-- and what its send method (send_method; unset = smtp, what accounts used
-- before the setting) needs — an SMTP host; Mailgun's domain and API key;
-- Postmark's server token; or the webhook's URL and signing secret
-- (comm_secret.send_secret). 'none' never sends. It says nothing of whether
-- the account is enabled (channel_status). docs/MAIL_INTAKE_AND_CALENDARS.md,
-- "Sending". Read by project_mail_account, account_mail.get and
-- comm_channel.list.
CREATE OR REPLACE FUNCTION channel_can_send(channel_id bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
    WITH a AS (
        SELECT
            COALESCE(NULLIF(max(av.value #>> '{}') FILTER (WHERE ad.name = 'send_method'), ''), 'smtp') AS method,
            COALESCE(btrim(max(av.value #>> '{}') FILTER (WHERE ad.name = 'smtp_host')), '')     AS smtp_host,
            COALESCE(btrim(max(av.value #>> '{}') FILTER (WHERE ad.name = 'send_domain')), '')   AS domain,
            COALESCE(btrim(max(av.value #>> '{}') FILTER (WHERE ad.name = 'send_url')), '')      AS url,
            COALESCE(btrim(max(av.value #>> '{}') FILTER (WHERE ad.name = 'from_address')), '')  AS from_address
        FROM attribute_value av
        JOIN attribute_def ad ON ad.id = av.attribute_def_id
        WHERE av.card_id = channel_can_send.channel_id
          AND ad.name IN ('send_method', 'smtp_host', 'send_domain', 'send_url', 'from_address')
    ), s AS (
        SELECT EXISTS (SELECT 1 FROM comm_secret cs
                       WHERE cs.channel_card_id = channel_can_send.channel_id
                         AND cs.send_secret IS NOT NULL) AS has_secret
    )
    SELECT a.from_address <> '' AND CASE a.method
        WHEN 'smtp' THEN a.smtp_host <> ''
        WHEN 'mailgun' THEN a.domain <> '' AND s.has_secret
        WHEN 'postmark' THEN s.has_secret
        WHEN 'webhook' THEN a.url <> '' AND s.has_secret
        ELSE false
    END
    FROM a, s
$$;
