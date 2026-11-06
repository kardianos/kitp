-- project_mail_account — the mail account a thread moved into a project
-- sends from (task.move, review 2026-11-03 round 2 #13 / round 3 #10): the
-- project's live comm_channel best able to carry the conversation — one
-- that is enabled (channel_status absent or 'enabled'), then one that can
-- send (channel_can_send: SMTP or an HTTP API set up), then one that reads mail in (an IMAP host and an intake mode other
-- than 'ignore'), lowest id last. NULL when the project has no account.
CREATE OR REPLACE FUNCTION project_mail_account(project_id bigint) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT ch.id
  FROM card ch
  JOIN card_type cht ON cht.id = ch.card_type_id AND cht.name = 'comm_channel'
  LEFT JOIN LATERAL (
      SELECT
        COALESCE(max(av.value #>> '{}') FILTER (WHERE ad.name = 'channel_status'), 'enabled') AS status,
        COALESCE(max(av.value #>> '{}') FILTER (WHERE ad.name = 'smtp_host'), '')             AS smtp_host,
        COALESCE(max(av.value #>> '{}') FILTER (WHERE ad.name = 'imap_host'), '')             AS imap_host,
        COALESCE(max(av.value #>> '{}') FILTER (WHERE ad.name = 'intake_mode'), '')           AS intake_mode
      FROM attribute_value av
      JOIN attribute_def ad ON ad.id = av.attribute_def_id
      WHERE av.card_id = ch.id
        AND ad.name IN ('channel_status', 'smtp_host', 'imap_host', 'intake_mode')
  ) a ON true
  WHERE ch.parent_card_id = project_mail_account.project_id
    AND ch.deleted_at IS NULL
  ORDER BY (a.status = 'enabled') DESC,
           channel_can_send(ch.id) DESC,
           (a.imap_host <> '' AND a.intake_mode <> 'ignore') DESC,
           ch.id
  LIMIT 1
$$;
