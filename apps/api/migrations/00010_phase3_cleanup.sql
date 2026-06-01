-- +goose Up
DROP TABLE IF EXISTS document_agent_limits;

DROP INDEX IF EXISTS idx_users_actor;

ALTER TABLE document_updates
  DROP COLUMN IF EXISTS origin_actor,
  DROP COLUMN IF EXISTS agent_intent;

ALTER TABLE documents
  DROP COLUMN IF EXISTS agents_paused;

ALTER TABLE users
  DROP COLUMN IF EXISTS actor;

-- +goose Down
ALTER TABLE users
  ADD COLUMN actor TEXT NOT NULL DEFAULT 'human' CHECK (actor IN ('human','agent'));

CREATE INDEX idx_users_actor ON users(actor) WHERE actor = 'agent';

ALTER TABLE documents
  ADD COLUMN agents_paused BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE document_updates
  ADD COLUMN origin_actor TEXT NOT NULL DEFAULT 'human'
    CHECK (origin_actor IN ('human','agent','guest')),
  ADD COLUMN agent_intent TEXT;

CREATE TABLE document_agent_limits (
  document_id      UUID PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  writes_per_min   INTEGER NOT NULL DEFAULT 60   CHECK (writes_per_min >= 0),
  max_region_chars INTEGER NOT NULL DEFAULT 4096 CHECK (max_region_chars >= 0),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
