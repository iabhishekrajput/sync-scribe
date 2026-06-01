-- +goose Up
-- +goose StatementBegin
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_documents_title_trgm
  ON documents USING gin (title gin_trgm_ops)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_documents_updated
  ON documents(updated_at DESC)
  WHERE deleted_at IS NULL;
-- +goose StatementEnd

-- +goose Down
DROP INDEX IF EXISTS idx_documents_updated;
DROP INDEX IF EXISTS idx_documents_title_trgm;
