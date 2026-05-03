-- 0006_idempotency.sql — Idempotency-Key store (Phase 21, N-API-5).
--
-- The middleware in internal/obs/idempotency.go upserts into this table
-- per (user_id, key) and replays the stored response on a hash-match
-- lookup. A small background goroutine prunes rows older than 24h every
-- ten minutes; the index supports that DELETE without a sequential scan.

CREATE TABLE IF NOT EXISTS idempotency_response (
    user_id      bigint NOT NULL,
    key          text   NOT NULL,
    request_hash bytea  NOT NULL,
    response     jsonb  NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, key)
);

CREATE INDEX IF NOT EXISTS idempotency_response_created_at
    ON idempotency_response (created_at);
