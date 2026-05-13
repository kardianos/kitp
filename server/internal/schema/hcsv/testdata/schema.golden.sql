CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Built-in and user-declared card types.
CREATE TABLE IF NOT EXISTS card_type (
    id bigserial PRIMARY KEY,
    name text NOT NULL,
    is_built_in boolean NOT NULL DEFAULT false,
    allow_self_parent boolean NOT NULL DEFAULT false,
    parent_card_type_id bigint REFERENCES card_type(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS card_type_name_uniq ON card_type (name);

-- Logical workflow name (e.g. card.create).
CREATE TABLE IF NOT EXISTS process (
    id bigserial PRIMARY KEY,
    name text NOT NULL,
    doc text
);
CREATE UNIQUE INDEX IF NOT EXISTS process_name_uniq ON process (name);

-- Application role. Assigned to users via user_role.
CREATE TABLE IF NOT EXISTS role (
    id bigserial PRIMARY KEY,
    name text NOT NULL,
    doc text
);
CREATE UNIQUE INDEX IF NOT EXISTS role_name_uniq ON role (name);

-- Users. id=1 is the System User used by AUTH_MODE=off.
CREATE TABLE IF NOT EXISTS user_account (
    id bigserial PRIMARY KEY,
    oidc_sub text UNIQUE,
    display_name text NOT NULL,
    email text,
    parent_user_id bigint REFERENCES user_account(id) ON DELETE CASCADE,
    is_agent boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- An attribute definition (title, assignee, ...). value_type ∈ {text, number, bool, card_ref, card_ref[]}.
CREATE TABLE IF NOT EXISTS attribute_def (
    id bigserial PRIMARY KEY,
    name text NOT NULL,
    value_type text NOT NULL,
    is_built_in boolean NOT NULL DEFAULT false,
    target_card_type_id bigint REFERENCES card_type(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS attribute_def_name_uniq ON attribute_def (name);

-- A card instance. phase categorises flow-bound value cards (triage/active/terminal); defaults 'active' for non-value cards (the value is unused there).
CREATE TABLE IF NOT EXISTS card (
    id bigserial PRIMARY KEY,
    card_type_id bigint NOT NULL REFERENCES card_type(id) ON DELETE RESTRICT,
    parent_card_id bigint REFERENCES card(id) ON DELETE CASCADE,
    phase text NOT NULL DEFAULT 'active',
    deleted_at timestamptz
);

-- (role, card_type, process) tuple authorising role-holders to invoke process on card_type.
CREATE TABLE IF NOT EXISTS role_grant (
    id bigserial PRIMARY KEY,
    role_id bigint NOT NULL REFERENCES role(id) ON DELETE CASCADE,
    card_type_id bigint NOT NULL REFERENCES card_type(id) ON DELETE CASCADE,
    process_id bigint NOT NULL REFERENCES process(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS role_grant_uniq ON role_grant (role_id, card_type_id, process_id);

-- Append-only stream of card events: card_create, attr_update, tag_apply, comment, ...
CREATE TABLE IF NOT EXISTS activity (
    id bigserial PRIMARY KEY,
    card_id bigint NOT NULL REFERENCES card(id) ON DELETE CASCADE,
    kind text NOT NULL,
    attribute_def_id bigint REFERENCES attribute_def(id) ON DELETE RESTRICT,
    value_old jsonb,
    value_new jsonb,
    actor_id bigint NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_card ON activity (card_id);

-- An attribute_def bound to a card_type, optionally required.
CREATE TABLE IF NOT EXISTS edge (
    id bigserial PRIMARY KEY,
    card_type_id bigint NOT NULL REFERENCES card_type(id) ON DELETE CASCADE,
    attribute_def_id bigint NOT NULL REFERENCES attribute_def(id) ON DELETE CASCADE,
    is_required boolean NOT NULL DEFAULT false,
    ordering double precision NOT NULL DEFAULT 0.0
);
CREATE UNIQUE INDEX IF NOT EXISTS edge_uniq ON edge (card_type_id, attribute_def_id);

-- Assigns a role to a user, optionally scoped to a card subtree. m:n table; no name_column.
CREATE TABLE IF NOT EXISTS user_role (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
    role_id bigint NOT NULL REFERENCES role(id) ON DELETE CASCADE,
    scope_card_id bigint REFERENCES card(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS user_role_uniq ON user_role (user_id, role_id, scope_card_id);

-- Demonstrates partial unique indexes (the live user_role table uses two: one for scoped, one for global).
CREATE TABLE IF NOT EXISTS user_role_v2 (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
    role_id bigint NOT NULL REFERENCES role(id) ON DELETE CASCADE,
    scope_card_id bigint REFERENCES card(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_user_role_scoped ON user_role_v2 (user_id, role_id, scope_card_id) WHERE scope_card_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_user_role_global ON user_role_v2 (user_id, role_id) WHERE scope_card_id IS NULL;

-- Current value of one attribute on one card. Composite PK (card_id, attribute_def_id).
CREATE TABLE IF NOT EXISTS attribute_value (
    card_id bigint NOT NULL REFERENCES card(id) ON DELETE CASCADE,
    attribute_def_id bigint NOT NULL REFERENCES attribute_def(id) ON DELETE RESTRICT,
    value jsonb,
    last_activity_id bigint REFERENCES activity(id) ON DELETE SET NULL,
    PRIMARY KEY (card_id, attribute_def_id)
);
CREATE INDEX IF NOT EXISTS attribute_value_trgm ON attribute_value USING gin ((value::text) gin_trgm_ops);

