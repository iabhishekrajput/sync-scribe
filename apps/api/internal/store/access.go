package store

import (
	"context"
	"time"

	"github.com/google/uuid"
)

type DocumentAccess struct {
	DocumentID  uuid.UUID `json:"document_id"`
	UserID      string    `json:"user_id"`
	Role        string    `json:"role"`
	GrantedBy   string    `json:"granted_by"`
	GrantedAt   time.Time `json:"granted_at"`
	Email       string    `json:"email,omitempty"`
	DisplayName string    `json:"display_name,omitempty"`
}

func (s *Store) ListAccess(ctx context.Context, docID uuid.UUID, ownerID string) ([]DocumentAccess, error) {
	d, err := s.GetDocument(ctx, docID, ownerID)
	if err != nil {
		return nil, err
	}
	if d.OwnerID != ownerID {
		return nil, ErrForbidden
	}

	rows, err := s.Pool.Query(ctx, `
SELECT a.document_id, a.user_id, a.role, a.granted_by, a.granted_at, u.email::text, u.display_name
FROM document_access a
JOIN users u ON u.id = a.user_id
WHERE a.document_id = $1
ORDER BY a.granted_at ASC
`, docID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]DocumentAccess, 0)
	for rows.Next() {
		var a DocumentAccess
		if err := rows.Scan(&a.DocumentID, &a.UserID, &a.Role, &a.GrantedBy, &a.GrantedAt, &a.Email, &a.DisplayName); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *Store) UpsertAccess(ctx context.Context, docID uuid.UUID, ownerID, userID, role string) (*DocumentAccess, error) {
	if role != "viewer" && role != "editor" && role != "owner" {
		return nil, ErrInvalidInput
	}
	if userID == "" {
		return nil, ErrInvalidInput
	}
	d, err := s.GetDocument(ctx, docID, ownerID)
	if err != nil {
		return nil, err
	}
	if d.OwnerID != ownerID {
		return nil, ErrForbidden
	}
	if d.OwnerID == userID {
		return nil, ErrInvalidInput
	}

	var exists bool
	if err := s.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM users WHERE id = $1)`, userID).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrNotFound
	}

	var out DocumentAccess
	err = s.Pool.QueryRow(ctx, `
INSERT INTO document_access (document_id, user_id, role, granted_by)
VALUES ($1, $2, $3, $4)
ON CONFLICT (document_id, user_id) DO UPDATE SET
  role = EXCLUDED.role,
  granted_by = EXCLUDED.granted_by,
  granted_at = now()
RETURNING document_id, user_id, role, granted_by, granted_at
`, docID, userID, role, ownerID).Scan(&out.DocumentID, &out.UserID, &out.Role, &out.GrantedBy, &out.GrantedAt)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *Store) DeleteAccess(ctx context.Context, docID uuid.UUID, ownerID, userID string) error {
	d, err := s.GetDocument(ctx, docID, ownerID)
	if err != nil {
		return err
	}
	if d.OwnerID != ownerID {
		return ErrForbidden
	}
	tag, err := s.Pool.Exec(ctx, `DELETE FROM document_access WHERE document_id = $1 AND user_id = $2`, docID, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
