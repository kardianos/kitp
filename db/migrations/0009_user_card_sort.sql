-- 0009_user_card_sort.sql — per-user inbox ordering.
--
-- The kanban already has a global `sort_order` attribute (added in
-- migration 0008). That ordering is shared across every user, which is
-- exactly what the kanban wants. The inbox, in contrast, is a per-user
-- view: each user wants their own ordering of inbox items so they can
-- drag tasks into a personal priority without disturbing anyone else.
--
-- This table stores that per-user ordering. It is INTENTIONALLY separate
-- from `attribute_value.sort_order` — global vs. personal are two distinct
-- axes. The inbox query LEFT JOINs this table on (user_id, card_id) and
-- ORDERs by `sort_order ASC NULLS LAST`. Cards without a personal sort
-- fall through to a `created_at DESC` tie-breaker.

CREATE TABLE user_card_sort (
    user_id    bigint NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
    card_id    bigint NOT NULL REFERENCES card(id) ON DELETE CASCADE,
    sort_order double precision NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, card_id)
);

CREATE INDEX user_card_sort_user_order ON user_card_sort (user_id, sort_order);
