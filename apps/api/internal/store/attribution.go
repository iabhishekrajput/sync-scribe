package store

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// AttributionUpdate is one persisted Yjs update batch with the identity of
// the writer. The Blob field is encoded as base64 in JSON so the browser can
// replay it through a fresh Y.Doc to reconstruct per-character blame.
type AttributionUpdate struct {
	Seq        int64     `json:"seq"`
	OriginUser string    `json:"origin_user,omitempty"`
	OriginName string    `json:"origin_name,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
	Blob       []byte    `json:"blob"`
}

type AttributionQuery struct {
	SinceUpdateID int64
	Limit         int
}

type AttributionResult struct {
	Updates           []AttributionUpdate `json:"updates"`
	NextSinceUpdateID int64               `json:"next_since_update_id"`
}

// GetAttributionUpdates returns stored updates with origin metadata for
// client-side blame computation. Readers can fetch their own documents;
// guests are gated by the standard GetDocument access check.
//
// limit caps the number of rows (max 1000, default 500). For documents with
// very long histories callers should take the latest snapshot as a base and
// only request updates with seq > snapshot.last_seq — the full replay path
// is O(updates) and gets expensive for thousands of rows.
func (s *Store) GetAttributionUpdates(ctx context.Context, docID uuid.UUID, userID string, query AttributionQuery) (*AttributionResult, error) {
	if _, err := s.GetDocument(ctx, docID, userID); err != nil {
		return nil, err
	}
	limit := query.Limit
	if limit <= 0 || limit > 1000 {
		limit = 500
	}
	since := query.SinceUpdateID
	if since < 0 {
		since = 0
	}
	rows, err := s.Pool.Query(ctx, `
SELECT du.seq,
       COALESCE(du.origin_user, '')  AS origin_user,
       COALESCE(u.display_name, '') AS origin_name,
       du.created_at,
       du.update_blob
FROM document_updates du
LEFT JOIN users u ON u.id = du.origin_user
WHERE du.document_id = $1
  AND du.seq > $2
ORDER BY du.seq ASC
LIMIT $3
`, docID, since, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]AttributionUpdate, 0, 64)
	nextSince := since
	for rows.Next() {
		var a AttributionUpdate
		if err := rows.Scan(
			&a.Seq, &a.OriginUser, &a.OriginName,
			&a.CreatedAt, &a.Blob,
		); err != nil {
			return nil, err
		}
		out = append(out, a)
		nextSince = a.Seq
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return &AttributionResult{Updates: out, NextSinceUpdateID: nextSince}, nil
}
