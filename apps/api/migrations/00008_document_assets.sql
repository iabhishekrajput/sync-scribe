-- Inline document assets (images pasted/dropped into the editor).
-- Stored as bytea so the API stays self-contained at current scale. If a
-- single document's asset total starts crossing tens of MB in production,
-- move blobs to S3-compatible storage and keep this table for metadata.

-- +goose Up
CREATE TABLE document_assets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  uploaded_by  TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes   INT  NOT NULL,
  data         BYTEA NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_document_assets_doc ON document_assets(document_id, created_at DESC);

-- +goose Down
DROP TABLE IF EXISTS document_assets;
