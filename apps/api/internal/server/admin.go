package server

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/abhishek/sync-scribe/api/internal/httpx"
)

// adminAuthorized enforces the static ADMIN_SECRET bearer token. Empty
// secret = no auth (dev only); production should also firewall /admin/*.
func (s *Server) adminAuthorized(w http.ResponseWriter, r *http.Request) bool {
	secret := s.cfg.AdminSecret
	if secret == "" {
		return true
	}
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if token != secret {
		httpx.WriteError(w, r, httpx.Forbidden("Admin bearer token missing or incorrect.", nil))
		return false
	}
	return true
}

// AdminDocStat holds per-document growth stats for the admin endpoint.
type AdminDocStat struct {
	DocumentID      string    `json:"document_id"`
	Title           string    `json:"title"`
	OwnerID         string    `json:"owner_id"`
	UpdateCount     int64     `json:"update_count"`
	UpdateBytes     int64     `json:"update_bytes"`
	SnapshotCount   int64     `json:"snapshot_count"`
	LatestSnapBytes int64     `json:"latest_snapshot_bytes"`
	LastActivityAt  time.Time `json:"last_activity_at"`
}

type AdminStats struct {
	GeneratedAt       time.Time      `json:"generated_at"`
	TotalDocuments    int            `json:"total_documents"`
	TotalUpdateRows   int64          `json:"total_update_rows"`
	TotalUpdateBytes  int64          `json:"total_update_bytes"`
	TotalSnapshotRows int64          `json:"total_snapshot_rows"`
	Documents         []AdminDocStat `json:"documents"`
}

// adminStats returns document growth metrics.
func (s *Server) adminStats(w http.ResponseWriter, r *http.Request) {
	if !s.adminAuthorized(w, r) {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	rows, err := s.store.Pool.Query(ctx, `
SELECT
  d.id,
  d.title,
  d.owner_id,
  COUNT(DISTINCT du.seq)                     AS update_count,
  COALESCE(SUM(octet_length(du.update_blob)), 0) AS update_bytes,
  COUNT(DISTINCT ds.version)                 AS snapshot_count,
  COALESCE(MAX(ds.size_bytes), 0)            AS latest_snap_bytes,
  GREATEST(MAX(du.created_at), MAX(ds.created_at), d.updated_at) AS last_activity_at
FROM documents d
LEFT JOIN document_updates   du ON du.document_id = d.id
LEFT JOIN document_snapshots ds ON ds.document_id = d.id
WHERE d.deleted_at IS NULL
GROUP BY d.id
ORDER BY last_activity_at DESC NULLS LAST
LIMIT 500
`)
	if err != nil {
		httpx.WriteError(w, r, httpx.Internal("Stats query failed.", err))
		return
	}
	defer rows.Close()

	stats := AdminStats{
		GeneratedAt: time.Now().UTC(),
		Documents:   make([]AdminDocStat, 0, 64),
	}

	for rows.Next() {
		var doc AdminDocStat
		if err := rows.Scan(
			&doc.DocumentID,
			&doc.Title,
			&doc.OwnerID,
			&doc.UpdateCount,
			&doc.UpdateBytes,
			&doc.SnapshotCount,
			&doc.LatestSnapBytes,
			&doc.LastActivityAt,
		); err != nil {
			httpx.WriteError(w, r, httpx.Internal("Stats scan failed.", err))
			return
		}
		stats.TotalDocuments++
		stats.TotalUpdateRows += doc.UpdateCount
		stats.TotalUpdateBytes += doc.UpdateBytes
		stats.TotalSnapshotRows += doc.SnapshotCount
		stats.Documents = append(stats.Documents, doc)
	}
	if err := rows.Err(); err != nil {
		httpx.WriteError(w, r, httpx.Internal("Stats row iteration failed.", err))
		return
	}

	writeJSON(w, http.StatusOK, stats)
}

// adminRetentionRuns returns the last N retention run records so operators
// can confirm the GC job is executing on schedule.
func (s *Server) adminRetentionRuns(w http.ResponseWriter, r *http.Request) {
	if !s.adminAuthorized(w, r) {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	rows, err := s.store.Pool.Query(ctx, `
SELECT id, started_at, finished_at, snapshots_deleted, updates_deleted, docs_processed
FROM retention_runs
ORDER BY started_at DESC
LIMIT 50
`)
	if err != nil {
		httpx.WriteError(w, r, httpx.Internal("Retention runs query failed.", err))
		return
	}
	defer rows.Close()

	type run struct {
		ID               int64      `json:"id"`
		StartedAt        time.Time  `json:"started_at"`
		FinishedAt       *time.Time `json:"finished_at,omitempty"`
		SnapshotsDeleted int        `json:"snapshots_deleted"`
		UpdatesDeleted   int64      `json:"updates_deleted"`
		DocsProcessed    int        `json:"docs_processed"`
	}
	out := make([]run, 0, 50)
	for rows.Next() {
		var rr run
		if err := rows.Scan(&rr.ID, &rr.StartedAt, &rr.FinishedAt,
			&rr.SnapshotsDeleted, &rr.UpdatesDeleted, &rr.DocsProcessed); err != nil {
			httpx.WriteError(w, r, httpx.Internal("Retention scan failed.", err))
			return
		}
		out = append(out, rr)
	}
	if err := rows.Err(); err != nil {
		httpx.WriteError(w, r, httpx.Internal("Retention row iteration failed.", err))
		return
	}

	writeJSON(w, http.StatusOK, out)
}
