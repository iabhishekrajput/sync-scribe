-- Viewer-initiated access upgrade requests.

-- +goose Up
CREATE TABLE document_access_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  requester_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_role  TEXT NOT NULL DEFAULT 'editor' CHECK (requested_role IN ('viewer','editor')),
  message         TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','canceled')),
  resolved_by     TEXT REFERENCES users(id),
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_access_requests_one_pending
  ON document_access_requests(document_id, requester_id)
  WHERE status = 'pending';
CREATE INDEX idx_access_requests_doc_status
  ON document_access_requests(document_id, status, created_at DESC);

-- +goose Down
DROP TABLE IF EXISTS document_access_requests;
