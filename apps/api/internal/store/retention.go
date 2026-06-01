package store

import (
	"context"
	"time"

	"github.com/rs/zerolog/log"
)

const (
	// MaxSnapshotsPerDoc is the maximum number of snapshots we keep per
	// document. Older snapshots are deleted by the retention job.
	MaxSnapshotsPerDoc = 100

	// UpdateRetentionWindow is how long we keep document_updates rows whose
	// seq falls below the oldest retained snapshot's last_seq. The window
	// provides a short rollback buffer even after GC runs.
	UpdateRetentionWindow = 7 * 24 * time.Hour

	// DefaultRetentionInterval is how often the retention loop wakes up.
	// Nightly is sufficient; there's no time-critical urgency here.
	DefaultRetentionInterval = 1 * time.Hour
)

// RetentionResult summarises what one GC pass removed.
type RetentionResult struct {
	DocsProcessed    int
	SnapshotsDeleted int
	UpdatesDeleted   int64
	Duration         time.Duration
}

// RunRetentionPass executes one full GC pass: prune excess snapshots for every
// document that has more than MaxSnapshotsPerDoc, then delete document_updates
// rows that are (a) covered by a retained snapshot AND (b) older than
// UpdateRetentionWindow. Returns a summary suitable for logging or storing.
func (s *Store) RunRetentionPass(ctx context.Context) (RetentionResult, error) {
	start := time.Now()

	// Record the start of the run.
	var runID int64
	if err := s.Pool.QueryRow(ctx,
		`INSERT INTO retention_runs (started_at) VALUES (now()) RETURNING id`,
	).Scan(&runID); err != nil {
		return RetentionResult{}, err
	}

	var res RetentionResult

	// --- Step 1: snapshot GC ---
	// For each document with more than MaxSnapshotsPerDoc snapshots, delete
	// the oldest ones, keeping the most recent N.
	snapshotRows, err := s.Pool.Query(ctx, `
WITH ranked AS (
  SELECT
    document_id,
    version,
    ROW_NUMBER() OVER (PARTITION BY document_id ORDER BY version DESC) AS rn
  FROM document_snapshots
)
SELECT document_id, version FROM ranked WHERE rn > $1
`, MaxSnapshotsPerDoc)
	if err != nil {
		return RetentionResult{}, err
	}
	defer snapshotRows.Close()

	type snapKey struct {
		docID   string
		version int64
	}
	toDelete := make([]snapKey, 0, 32)
	for snapshotRows.Next() {
		var k snapKey
		if err := snapshotRows.Scan(&k.docID, &k.version); err != nil {
			return RetentionResult{}, err
		}
		toDelete = append(toDelete, k)
	}
	if err := snapshotRows.Err(); err != nil {
		return RetentionResult{}, err
	}
	snapshotRows.Close()

	for _, k := range toDelete {
		tag, err := s.Pool.Exec(ctx,
			`DELETE FROM document_snapshots WHERE document_id = $1 AND version = $2`,
			k.docID, k.version)
		if err != nil {
			log.Warn().Err(err).Str("doc", k.docID).Int64("version", k.version).Msg("retention: snapshot delete")
			continue
		}
		res.SnapshotsDeleted += int(tag.RowsAffected())
	}

	// --- Step 2: update pruning ---
	// Delete document_updates rows where:
	//   seq <= (oldest retained snapshot's last_seq for that doc)  AND
	//   created_at < now() - UpdateRetentionWindow
	// The age guard ensures we never delete updates younger than the window
	// even if a snapshot covers them (preserves short-term rollback ability).
	cutoff := time.Now().Add(-UpdateRetentionWindow)
	tag, err := s.Pool.Exec(ctx, `
DELETE FROM document_updates du
WHERE du.created_at < $1
  AND du.seq <= (
    SELECT MIN(ds.last_seq)
    FROM document_snapshots ds
    WHERE ds.document_id = du.document_id
  )
`, cutoff)
	if err != nil {
		return RetentionResult{}, err
	}
	res.UpdatesDeleted = tag.RowsAffected()

	// Count distinct processed docs (those that had at least one action).
	if err := s.Pool.QueryRow(ctx,
		`SELECT COUNT(DISTINCT document_id) FROM document_snapshots`,
	).Scan(&res.DocsProcessed); err != nil {
		res.DocsProcessed = -1 // non-fatal
	}

	res.Duration = time.Since(start)

	// Record the completed run.
	_, _ = s.Pool.Exec(ctx, `
UPDATE retention_runs
SET finished_at = now(),
    snapshots_deleted = $2,
    updates_deleted = $3,
    docs_processed = $4
WHERE id = $1
`, runID, res.SnapshotsDeleted, res.UpdatesDeleted, res.DocsProcessed)

	return res, nil
}

// RunRetentionLoop runs retention passes on the given interval until ctx is
// cancelled. Designed to be called as a goroutine from main. Each pass result
// is logged; errors don't stop the loop.
func (s *Store) RunRetentionLoop(ctx context.Context, interval time.Duration) {
	log.Info().Dur("interval", interval).Msg("retention: loop started")
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			log.Info().Msg("retention: loop stopped")
			return
		case <-ticker.C:
			result, err := s.RunRetentionPass(ctx)
			if err != nil {
				log.Error().Err(err).Msg("retention: pass failed")
				continue
			}
			log.Info().
				Int("docs", result.DocsProcessed).
				Int("snapshots_gc", result.SnapshotsDeleted).
				Int64("updates_pruned", result.UpdatesDeleted).
				Dur("dur", result.Duration).
				Msg("retention: pass complete")
		}
	}
}
