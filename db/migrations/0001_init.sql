-- 0001_init.sql — base schema for kitp
-- forward-only; safe to re-run via the migration runner (the runner enforces idempotency)

CREATE TABLE IF NOT EXISTS user_account (
    id              bigserial PRIMARY KEY,
    oidc_sub        text UNIQUE,
    display_name    text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS card_type (
    id                      serial PRIMARY KEY,
    name                    text NOT NULL UNIQUE,
    parent_card_type_id     int REFERENCES card_type(id),
    allow_self_parent       boolean NOT NULL DEFAULT false,
    is_built_in             boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS attribute_def (
    id              serial PRIMARY KEY,
    name            text NOT NULL UNIQUE,
    value_type      text NOT NULL,
    is_built_in     boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS edge (
    id                  serial PRIMARY KEY,
    card_type_id        int NOT NULL REFERENCES card_type(id),
    attribute_def_id    int NOT NULL REFERENCES attribute_def(id),
    is_required         boolean NOT NULL DEFAULT false,
    ordering            int NOT NULL DEFAULT 0,
    UNIQUE (card_type_id, attribute_def_id)
);

CREATE TABLE IF NOT EXISTS card (
    id              bigserial PRIMARY KEY,
    card_type_id    int NOT NULL REFERENCES card_type(id),
    parent_card_id  bigint REFERENCES card(id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz
);

CREATE INDEX IF NOT EXISTS idx_card_parent_card_id ON card(parent_card_id);
CREATE INDEX IF NOT EXISTS idx_card_card_type_id ON card(card_type_id);

CREATE TABLE IF NOT EXISTS activity (
    id                  bigserial PRIMARY KEY,
    card_id             bigint NOT NULL REFERENCES card(id),
    kind                text NOT NULL,
    attribute_def_id    int REFERENCES attribute_def(id),
    value_old           jsonb,
    value_new           jsonb,
    actor_id            bigint NOT NULL REFERENCES user_account(id),
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activity_card_id_created_at ON activity(card_id, created_at);

CREATE TABLE IF NOT EXISTS attribute_value (
    card_id             bigint NOT NULL REFERENCES card(id),
    attribute_def_id    int NOT NULL REFERENCES attribute_def(id),
    value               jsonb,
    last_activity_id    bigint REFERENCES activity(id),
    PRIMARY KEY (card_id, attribute_def_id)
);

CREATE TABLE IF NOT EXISTS process (
    id      serial PRIMARY KEY,
    name    text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS process_step (
    process_id  int NOT NULL REFERENCES process(id),
    ordinal     int NOT NULL,
    endpoint    text NOT NULL,
    action      text NOT NULL,
    PRIMARY KEY (process_id, ordinal)
);

CREATE TABLE IF NOT EXISTS role (
    id      serial PRIMARY KEY,
    name    text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS role_grant (
    role_id         int NOT NULL REFERENCES role(id),
    card_type_id    int NOT NULL REFERENCES card_type(id),
    process_id      int NOT NULL REFERENCES process(id),
    PRIMARY KEY (role_id, card_type_id, process_id)
);

CREATE TABLE IF NOT EXISTS user_role (
    id              bigserial PRIMARY KEY,
    user_id         bigint NOT NULL REFERENCES user_account(id),
    role_id         int NOT NULL REFERENCES role(id),
    scope_card_id   bigint REFERENCES card(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_user_role_scoped
    ON user_role(user_id, role_id, scope_card_id)
    WHERE scope_card_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_user_role_global
    ON user_role(user_id, role_id)
    WHERE scope_card_id IS NULL;

CREATE TABLE IF NOT EXISTS comment_body (
    id              bigserial PRIMARY KEY,
    body            text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);
