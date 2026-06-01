-- Persist content-relative anchors for comments so they follow edits.

-- +goose Up
ALTER TABLE document_comments
  ADD COLUMN anchor_start BYTEA,
  ADD COLUMN anchor_end BYTEA,
  ADD COLUMN anchor_text TEXT NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE document_comments
  DROP COLUMN IF EXISTS anchor_text,
  DROP COLUMN IF EXISTS anchor_end,
  DROP COLUMN IF EXISTS anchor_start;
