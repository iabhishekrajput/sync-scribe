-- Per-doc caps on AI-agent activity. Sidecar table rather than columns on
-- documents so the common SELECT path (which doesn't need limits) stays lean.

-- +goose Up
CREATE TABLE document_agent_limits (
  document_id      UUID PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  writes_per_min   INTEGER NOT NULL DEFAULT 60   CHECK (writes_per_min  >= 0),
  max_region_chars INTEGER NOT NULL DEFAULT 4096 CHECK (max_region_chars >= 0),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE IF EXISTS document_agent_limits;
