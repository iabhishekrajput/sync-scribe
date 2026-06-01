-- Phase 2 collaboration review and owner audit trail.

-- +goose Up
CREATE TABLE document_comments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  author_id    TEXT NOT NULL REFERENCES users(id),
  kind         TEXT NOT NULL CHECK (kind IN ('comment','suggestion')),
  line_number  INT CHECK (line_number IS NULL OR line_number > 0),
  body         TEXT NOT NULL,
  resolved_at  TIMESTAMPTZ,
  resolved_by  TEXT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_comments_doc_open
  ON document_comments(document_id, created_at DESC)
  WHERE resolved_at IS NULL;

CREATE TABLE document_activity (
  id           BIGSERIAL PRIMARY KEY,
  document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  actor_id     TEXT REFERENCES users(id),
  actor_label  TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_activity_doc_time
  ON document_activity(document_id, created_at DESC);

-- +goose Down
DROP TABLE IF EXISTS document_activity;
DROP TABLE IF EXISTS document_comments;
