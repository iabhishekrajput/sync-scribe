-- Yjs delta log + snapshots. The 'guest' actor lives in the CHECK from day
-- one rather than in a follow-up patch — share-link visitors are a first-
-- class write origin alongside humans and agents, not an afterthought.

-- +goose Up
CREATE TABLE document_snapshots (
  document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version       BIGINT NOT NULL,
  state_vector  BYTEA NOT NULL,
  doc_blob      BYTEA NOT NULL,
  last_seq      BIGINT NOT NULL,
  size_bytes    INT GENERATED ALWAYS AS (octet_length(doc_blob)) STORED,
  created_by    TEXT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, version)
);
CREATE INDEX idx_snapshots_doc_time
  ON document_snapshots(document_id, created_at DESC);

CREATE TABLE document_updates (
  document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq           BIGINT NOT NULL,
  update_blob   BYTEA NOT NULL,
  origin_user   TEXT REFERENCES users(id),
  origin_actor  TEXT NOT NULL DEFAULT 'human'
                CHECK (origin_actor IN ('human','agent','guest')),
  agent_intent  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, seq)
);
CREATE INDEX idx_updates_doc_seq ON document_updates(document_id, seq);

-- +goose Down
DROP TABLE IF EXISTS document_updates;
DROP TABLE IF EXISTS document_snapshots;
