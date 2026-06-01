-- Retention audit log and helpers for snapshot GC + update pruning.

-- +goose Up

-- retention_runs logs each GC pass so operators can verify the job ran and
-- see how much data was freed, without needing to query pg_stat.
CREATE TABLE retention_runs (
  id            BIGSERIAL PRIMARY KEY,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  snapshots_deleted  INT NOT NULL DEFAULT 0,
  updates_deleted    BIGINT NOT NULL DEFAULT 0,
  docs_processed     INT NOT NULL DEFAULT 0
);

-- Index on finished_at so the admin endpoint can cheaply fetch recent runs.
CREATE INDEX idx_retention_runs_finished ON retention_runs(finished_at DESC NULLS FIRST);

-- +goose Down
DROP TABLE IF EXISTS retention_runs;
