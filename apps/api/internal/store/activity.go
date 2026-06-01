package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

type ActivityEvent struct {
	ID         int64          `json:"id"`
	DocumentID uuid.UUID      `json:"document_id"`
	ActorID    string         `json:"actor_id,omitempty"`
	ActorLabel string         `json:"actor_label"`
	EventType  string         `json:"event_type"`
	Detail     map[string]any `json:"detail"`
	CreatedAt  time.Time      `json:"created_at"`
}

func (s *Store) RecordActivity(ctx context.Context, docID uuid.UUID, actorID, eventType string, detail map[string]any) error {
	label := actorID
	if actorID != "" {
		_ = s.Pool.QueryRow(ctx, `SELECT display_name FROM users WHERE id = $1`, actorID).Scan(&label)
	}
	if label == "" {
		label = "Guest"
	}
	b, err := json.Marshal(detail)
	if err != nil {
		return err
	}
	_, err = s.Pool.Exec(ctx, `
INSERT INTO document_activity (document_id, actor_id, actor_label, event_type, detail)
VALUES ($1, NULLIF($2, ''), $3, $4, $5)
`, docID, actorID, label, eventType, b)
	return err
}

func (s *Store) ListActivity(ctx context.Context, docID uuid.UUID, ownerID string, limit int) ([]ActivityEvent, error) {
	d, err := s.GetDocument(ctx, docID, ownerID)
	if err != nil {
		return nil, err
	}
	if d.OwnerID != ownerID {
		return nil, ErrForbidden
	}
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	rows, err := s.Pool.Query(ctx, `
SELECT id, document_id, COALESCE(actor_id, ''), actor_label, event_type, detail, created_at
FROM document_activity
WHERE document_id = $1
ORDER BY created_at DESC
LIMIT $2
`, docID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]ActivityEvent, 0)
	for rows.Next() {
		var event ActivityEvent
		var detailBytes []byte
		if err := rows.Scan(&event.ID, &event.DocumentID, &event.ActorID, &event.ActorLabel, &event.EventType, &detailBytes, &event.CreatedAt); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(detailBytes, &event.Detail); err != nil {
			event.Detail = map[string]any{}
		}
		out = append(out, event)
	}
	return out, rows.Err()
}
