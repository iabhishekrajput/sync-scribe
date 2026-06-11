package store

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type Document struct {
	ID              uuid.UUID `json:"id"`
	OwnerID         string    `json:"owner_id"`
	Title           string    `json:"title"`
	CurrentVersion  int64     `json:"current_version"`
	LinkDefaultRole string    `json:"link_default_role"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

const documentCols = `id, owner_id, title, current_version, link_default_role, created_at, updated_at`

type DocumentListOptions struct {
	Query string
	Scope string
	Limit int
}

type RenameInput struct {
	Title string `json:"title"`
}

func scanDoc(row pgx.Row) (*Document, error) {
	var d Document
	if err := row.Scan(&d.ID, &d.OwnerID, &d.Title, &d.CurrentVersion, &d.LinkDefaultRole, &d.CreatedAt, &d.UpdatedAt); err != nil {
		return nil, err
	}
	return &d, nil
}

func (s *Store) CreateDocument(ctx context.Context, ownerID, title string) (*Document, error) {
	if title == "" {
		title = "Untitled"
	}
	row := s.Pool.QueryRow(ctx, `
INSERT INTO documents (owner_id, title)
VALUES ($1, $2)
RETURNING `+documentCols, ownerID, title)
	return scanDoc(row)
}

// ListDocumentsForUser returns docs the user owns or has been granted access
// to, excluding soft-deleted ones. Newest first.
func (s *Store) ListDocumentsForUser(ctx context.Context, userID string, opts DocumentListOptions) ([]Document, error) {
	query := strings.TrimSpace(opts.Query)
	scope := opts.Scope
	if scope == "" {
		scope = "all"
	}
	limit := opts.Limit
	if limit <= 0 {
		limit = 50
	}
	const q = `
SELECT ` + documentCols + `
FROM documents d
WHERE d.deleted_at IS NULL
  AND (
    d.owner_id = $1
    OR EXISTS (SELECT 1 FROM document_access a WHERE a.document_id = d.id AND a.user_id = $1)
  )
  AND ($2 = '' OR d.title ILIKE '%' || $2 || '%')
  AND (
    $3 = 'all'
    OR ($3 = 'owned' AND d.owner_id = $1)
    OR ($3 = 'shared' AND d.owner_id <> $1)
  )
ORDER BY d.updated_at DESC
LIMIT $4
`
	rows, err := s.Pool.Query(ctx, q, userID, query, scope, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]Document, 0)
	for rows.Next() {
		var d Document
		if err := rows.Scan(&d.ID, &d.OwnerID, &d.Title, &d.CurrentVersion, &d.LinkDefaultRole, &d.CreatedAt, &d.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (s *Store) GetDocument(ctx context.Context, id uuid.UUID, userID string) (*Document, error) {
	const q = `
SELECT ` + documentCols + `
FROM documents d
WHERE d.id = $1 AND d.deleted_at IS NULL
`
	d, err := scanDoc(s.Pool.QueryRow(ctx, q, id))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if !s.CanRead(ctx, d, userID) {
		return nil, ErrForbidden
	}
	return d, nil
}

func (s *Store) ResolveDocumentRole(ctx context.Context, id uuid.UUID, userID string) (*Document, string, error) {
	d, err := scanDoc(s.Pool.QueryRow(ctx, `
SELECT `+documentCols+`
FROM documents
WHERE id = $1 AND deleted_at IS NULL
`, id))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, "", ErrNotFound
		}
		return nil, "", err
	}
	if d.OwnerID == userID {
		return d, "owner", nil
	}
	var role string
	err = s.Pool.QueryRow(ctx,
		`SELECT role FROM document_access WHERE document_id=$1 AND user_id=$2`,
		id, userID).Scan(&role)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, "", ErrForbidden
		}
		return nil, "", err
	}
	return d, role, nil
}

func (s *Store) CanRead(ctx context.Context, d *Document, userID string) bool {
	if d.OwnerID == userID {
		return true
	}
	var count int
	_ = s.Pool.QueryRow(ctx,
		`SELECT count(*) FROM document_access WHERE document_id=$1 AND user_id=$2`,
		d.ID, userID).Scan(&count)
	return count > 0
}

func (s *Store) CanWrite(ctx context.Context, d *Document, userID string) bool {
	if d.OwnerID == userID {
		return true
	}
	var role string
	err := s.Pool.QueryRow(ctx,
		`SELECT role FROM document_access WHERE document_id=$1 AND user_id=$2`,
		d.ID, userID).Scan(&role)
	if err != nil {
		return false
	}
	return role == "editor" || role == "owner"
}

func CanRoleWrite(role string) bool {
	return role == "editor" || role == "owner"
}

func (s *Store) RenameDocument(ctx context.Context, id uuid.UUID, ownerID, title string) (*Document, error) {
	const q = `
UPDATE documents SET title = $3, updated_at = now()
WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL
RETURNING ` + documentCols
	d, err := scanDoc(s.Pool.QueryRow(ctx, q, id, ownerID, title))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return d, nil
}

func (s *Store) SoftDeleteDocument(ctx context.Context, id uuid.UUID, ownerID string) error {
	tag, err := s.Pool.Exec(ctx,
		`UPDATE documents SET deleted_at = now() WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`,
		id, ownerID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
