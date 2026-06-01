-- Tokenized public share links — the unauthenticated /share/:token entrypoint
-- and the ws ?share_token=… auth path both look up this table.

-- +goose Up
CREATE TABLE document_share_links (
  token        TEXT PRIMARY KEY,
  document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('viewer','editor')),
  created_by   TEXT NOT NULL REFERENCES users(id),
  expires_at   TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_share_links_doc
  ON document_share_links(document_id)
  WHERE revoked_at IS NULL;

-- +goose Down
DROP TABLE IF EXISTS document_share_links;
