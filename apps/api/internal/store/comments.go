package store

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type DocumentComment struct {
	ID          uuid.UUID  `json:"id"`
	DocumentID  uuid.UUID  `json:"document_id"`
	AuthorID    string     `json:"author_id"`
	AuthorName  string     `json:"author_name"`
	Kind        string     `json:"kind"`
	LineNumber  *int       `json:"line_number,omitempty"`
	AnchorStart []byte     `json:"anchor_start,omitempty"`
	AnchorEnd   []byte     `json:"anchor_end,omitempty"`
	AnchorText  string     `json:"anchor_text,omitempty"`
	Body        string     `json:"body"`
	ResolvedAt  *time.Time `json:"resolved_at,omitempty"`
	ResolvedBy  string     `json:"resolved_by,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
}

func (s *Store) ListComments(ctx context.Context, docID uuid.UUID, userID string, includeResolved bool) ([]DocumentComment, error) {
	if _, err := s.GetDocument(ctx, docID, userID); err != nil {
		return nil, err
	}
	rows, err := s.Pool.Query(ctx, `
SELECT c.id, c.document_id, c.author_id, COALESCE(u.display_name, c.author_id),
       c.kind, c.line_number, c.anchor_start, c.anchor_end, c.anchor_text,
       c.body, c.resolved_at, COALESCE(c.resolved_by, ''), c.created_at
FROM document_comments c
JOIN users u ON u.id = c.author_id
WHERE c.document_id = $1
  AND ($2 OR c.resolved_at IS NULL)
ORDER BY c.resolved_at NULLS FIRST, c.created_at DESC
`, docID, includeResolved)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]DocumentComment, 0)
	for rows.Next() {
		var c DocumentComment
		if err := rows.Scan(
			&c.ID,
			&c.DocumentID,
			&c.AuthorID,
			&c.AuthorName,
			&c.Kind,
			&c.LineNumber,
			&c.AnchorStart,
			&c.AnchorEnd,
			&c.AnchorText,
			&c.Body,
			&c.ResolvedAt,
			&c.ResolvedBy,
			&c.CreatedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) CreateComment(ctx context.Context, docID uuid.UUID, userID, kind string, lineNumber *int, anchorStart, anchorEnd []byte, anchorText, body string) (*DocumentComment, error) {
	d, role, err := s.ResolveDocumentRole(ctx, docID, userID)
	if err != nil {
		return nil, err
	}
	if !CanRoleWrite(role) {
		return nil, ErrForbidden
	}
	kind = strings.TrimSpace(kind)
	if kind == "" {
		kind = "comment"
	}
	if kind != "comment" && kind != "suggestion" {
		return nil, ErrInvalidInput
	}
	body = strings.TrimSpace(body)
	if body == "" {
		return nil, ErrInvalidInput
	}
	if (len(anchorStart) == 0) != (len(anchorEnd) == 0) {
		return nil, ErrInvalidInput
	}
	var out DocumentComment
	err = s.Pool.QueryRow(ctx, `
INSERT INTO document_comments (document_id, author_id, kind, line_number, anchor_start, anchor_end, anchor_text, body)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING id, document_id, author_id, kind, line_number, anchor_start, anchor_end, anchor_text, body, resolved_at, COALESCE(resolved_by, ''), created_at
`, d.ID, userID, kind, lineNumber, anchorStart, anchorEnd, anchorText, body).Scan(
		&out.ID,
		&out.DocumentID,
		&out.AuthorID,
		&out.Kind,
		&out.LineNumber,
		&out.AnchorStart,
		&out.AnchorEnd,
		&out.AnchorText,
		&out.Body,
		&out.ResolvedAt,
		&out.ResolvedBy,
		&out.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	var name string
	_ = s.Pool.QueryRow(ctx, `SELECT display_name FROM users WHERE id = $1`, userID).Scan(&name)
	out.AuthorName = name
	_ = s.RecordActivity(ctx, docID, userID, "comment.created", map[string]any{"kind": kind, "line_number": lineNumber})
	return &out, nil
}

func (s *Store) ResolveComment(ctx context.Context, docID, commentID uuid.UUID, userID string) (*DocumentComment, error) {
	d, role, err := s.ResolveDocumentRole(ctx, docID, userID)
	if err != nil {
		return nil, err
	}
	if !CanRoleWrite(role) {
		return nil, ErrForbidden
	}
	var out DocumentComment
	err = s.Pool.QueryRow(ctx, `
UPDATE document_comments c
SET resolved_at = COALESCE(resolved_at, now()), resolved_by = COALESCE(resolved_by, $3)
FROM users u
WHERE c.author_id = u.id
  AND c.document_id = $1
  AND c.id = $2
RETURNING c.id, c.document_id, c.author_id, u.display_name, c.kind, c.line_number, c.anchor_start, c.anchor_end, c.anchor_text, c.body, c.resolved_at, COALESCE(c.resolved_by, ''), c.created_at
`, d.ID, commentID, userID).Scan(
		&out.ID,
		&out.DocumentID,
		&out.AuthorID,
		&out.AuthorName,
		&out.Kind,
		&out.LineNumber,
		&out.AnchorStart,
		&out.AnchorEnd,
		&out.AnchorText,
		&out.Body,
		&out.ResolvedAt,
		&out.ResolvedBy,
		&out.CreatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	_ = s.RecordActivity(ctx, docID, userID, "comment.resolved", map[string]any{"comment_id": commentID.String()})
	return &out, nil
}

func (s *Store) DeleteComment(ctx context.Context, docID, commentID uuid.UUID, userID string) error {
	d, role, err := s.ResolveDocumentRole(ctx, docID, userID)
	if err != nil {
		return err
	}
	if !CanRoleWrite(role) {
		return ErrForbidden
	}
	tag, err := s.Pool.Exec(ctx, `
DELETE FROM document_comments
WHERE document_id = $1
  AND id = $2
`, d.ID, commentID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	_ = s.RecordActivity(ctx, docID, userID, "comment.deleted", map[string]any{"comment_id": commentID.String()})
	return nil
}
