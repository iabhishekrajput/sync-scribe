package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type AccessRequest struct {
	ID             uuid.UUID  `json:"id"`
	DocumentID     uuid.UUID  `json:"document_id"`
	RequesterID    string     `json:"requester_id"`
	RequesterName  string     `json:"requester_name,omitempty"`
	RequesterEmail string     `json:"requester_email,omitempty"`
	RequestedRole  string     `json:"requested_role"`
	Message        string     `json:"message,omitempty"`
	Status         string     `json:"status"`
	ResolvedBy     string     `json:"resolved_by,omitempty"`
	ResolvedAt     *time.Time `json:"resolved_at,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
}

func scanAccessRequest(row pgx.Row) (*AccessRequest, error) {
	var req AccessRequest
	err := row.Scan(
		&req.ID,
		&req.DocumentID,
		&req.RequesterID,
		&req.RequesterName,
		&req.RequesterEmail,
		&req.RequestedRole,
		&req.Message,
		&req.Status,
		&req.ResolvedBy,
		&req.ResolvedAt,
		&req.CreatedAt,
		&req.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return &req, nil
}

const accessRequestCols = `
ar.id,
ar.document_id,
ar.requester_id,
COALESCE(u.display_name, ''),
COALESCE(u.email::text, ''),
ar.requested_role,
ar.message,
ar.status,
COALESCE(ar.resolved_by, ''),
ar.resolved_at,
ar.created_at,
ar.updated_at`

func (s *Store) RequestAccess(ctx context.Context, docID uuid.UUID, requesterID, requestedRole, message string) (*AccessRequest, error) {
	if requestedRole == "" {
		requestedRole = "editor"
	}
	if requestedRole != "editor" {
		return nil, ErrInvalidInput
	}
	_, role, err := s.ResolveDocumentRole(ctx, docID, requesterID)
	if err != nil {
		return nil, err
	}
	if role != "viewer" {
		return nil, ErrInvalidInput
	}

	existing, err := scanAccessRequest(s.Pool.QueryRow(ctx, `
SELECT `+accessRequestCols+`
FROM document_access_requests ar
JOIN users u ON u.id = ar.requester_id
WHERE ar.document_id = $1 AND ar.requester_id = $2 AND ar.status = 'pending'
ORDER BY ar.created_at DESC
LIMIT 1
`, docID, requesterID))
	if err == nil {
		return existing, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}

	return scanAccessRequest(s.Pool.QueryRow(ctx, `
WITH inserted AS (
  INSERT INTO document_access_requests (document_id, requester_id, requested_role, message)
  VALUES ($1, $2, $3, $4)
  RETURNING *
)
SELECT `+accessRequestCols+`
FROM inserted ar
JOIN users u ON u.id = ar.requester_id
`, docID, requesterID, requestedRole, message))
}

func (s *Store) ListAccessRequests(ctx context.Context, docID uuid.UUID, ownerID string) ([]AccessRequest, error) {
	d, err := s.GetDocument(ctx, docID, ownerID)
	if err != nil {
		return nil, err
	}
	if d.OwnerID != ownerID {
		return nil, ErrForbidden
	}

	rows, err := s.Pool.Query(ctx, `
SELECT `+accessRequestCols+`
FROM document_access_requests ar
JOIN users u ON u.id = ar.requester_id
WHERE ar.document_id = $1 AND ar.status = 'pending'
ORDER BY ar.created_at ASC
`, docID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]AccessRequest, 0)
	for rows.Next() {
		req, err := scanAccessRequest(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *req)
	}
	return out, rows.Err()
}

func (s *Store) ResolveAccessRequest(ctx context.Context, docID, requestID uuid.UUID, ownerID, decision string) (*AccessRequest, error) {
	if decision != "approved" && decision != "denied" {
		return nil, ErrInvalidInput
	}
	d, err := s.GetDocument(ctx, docID, ownerID)
	if err != nil {
		return nil, err
	}
	if d.OwnerID != ownerID {
		return nil, ErrForbidden
	}

	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	req, err := scanAccessRequest(tx.QueryRow(ctx, `
UPDATE document_access_requests ar
SET status = $4, resolved_by = $3, resolved_at = now(), updated_at = now()
FROM users u
WHERE ar.requester_id = u.id
  AND ar.id = $1
  AND ar.document_id = $2
  AND ar.status = 'pending'
RETURNING `+accessRequestCols, requestID, docID, ownerID, decision))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}

	if decision == "approved" {
		_, err = tx.Exec(ctx, `
INSERT INTO document_access (document_id, user_id, role, granted_by)
VALUES ($1, $2, $3, $4)
ON CONFLICT (document_id, user_id) DO UPDATE SET
  role = EXCLUDED.role,
  granted_by = EXCLUDED.granted_by,
  granted_at = now()
`, docID, req.RequesterID, req.RequestedRole, ownerID)
		if err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return req, nil
}
