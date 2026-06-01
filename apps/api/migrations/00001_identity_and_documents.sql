-- People, documents, ACLs, and email-invite flow live together because they
-- share the same lifetime: you can't create access or invites without a doc,
-- you can't claim either without a user. Splitting them across files would
-- only force every dev to read all four to understand permissioning.

-- +goose Up
-- +goose StatementBegin
CREATE EXTENSION IF NOT EXISTS citext;
-- +goose StatementEnd

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         CITEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL,
  avatar_url    TEXT,
  actor         TEXT NOT NULL DEFAULT 'human' CHECK (actor IN ('human','agent')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ
);
CREATE INDEX idx_users_actor ON users(actor) WHERE actor = 'agent';

CREATE TABLE documents (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id             TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title                TEXT NOT NULL DEFAULT 'Untitled',
  current_version      BIGINT NOT NULL DEFAULT 0,
  link_default_role    TEXT NOT NULL DEFAULT 'private'
                       CHECK (link_default_role IN ('private','link_view','link_edit')),
  agents_paused        BOOLEAN NOT NULL DEFAULT false,
  deleted_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_documents_owner ON documents(owner_id) WHERE deleted_at IS NULL;

CREATE TABLE document_access (
  document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('viewer','editor','owner')),
  granted_by   TEXT NOT NULL REFERENCES users(id),
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, user_id)
);
CREATE INDEX idx_access_user ON document_access(user_id);

CREATE TABLE document_invites (
  token        TEXT PRIMARY KEY,
  document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  email        CITEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('viewer','editor')),
  invited_by   TEXT NOT NULL REFERENCES users(id),
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '14 days'),
  claimed_at   TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_invites_email ON document_invites(email)
  WHERE claimed_at IS NULL AND revoked_at IS NULL;

-- +goose Down
DROP TABLE IF EXISTS document_invites;
DROP TABLE IF EXISTS document_access;
DROP TABLE IF EXISTS documents;
DROP TABLE IF EXISTS users;
