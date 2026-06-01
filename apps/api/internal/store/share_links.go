package store

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type ShareLink struct {
	Token      string     `json:"token"`
	DocumentID uuid.UUID  `json:"document_id"`
	Role       string     `json:"role"`
	CreatedBy  string     `json:"created_by"`
	ExpiresAt  *time.Time `json:"expires_at,omitempty"`
	RevokedAt  *time.Time `json:"revoked_at,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
}

const shareLinkCols = `token, document_id, role, created_by, expires_at, revoked_at, created_at`

func scanShareLink(row pgx.Row) (*ShareLink, error) {
	var l ShareLink
	if err := row.Scan(&l.Token, &l.DocumentID, &l.Role, &l.CreatedBy, &l.ExpiresAt, &l.RevokedAt, &l.CreatedAt); err != nil {
		return nil, err
	}
	return &l, nil
}

func newShareToken() (string, error) {
	buf := make([]byte, 24) // 192 bits of entropy → 32 chars base64url
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// CreateShareLink issues a new link for the doc. Only the owner can mint
// links. role must be "viewer" or "editor".
//
// expiresAt is optional; nil = never expires (until explicitly revoked).
func (s *Store) CreateShareLink(ctx context.Context, docID uuid.UUID, ownerID, role string, expiresAt *time.Time) (*ShareLink, error) {
	if role != "viewer" && role != "editor" {
		return nil, ErrInvalidInput
	}
	if err := s.ensureOwner(ctx, docID, ownerID); err != nil {
		return nil, err
	}
	token, err := newShareToken()
	if err != nil {
		return nil, err
	}
	row := s.Pool.QueryRow(ctx, `
INSERT INTO document_share_links (token, document_id, role, created_by, expires_at)
VALUES ($1, $2, $3, $4, $5)
RETURNING `+shareLinkCols,
		token, docID, role, ownerID, expiresAt)
	return scanShareLink(row)
}

// ListShareLinks returns all non-revoked, non-expired links for the doc.
// Owner-only — viewers should never enumerate links.
func (s *Store) ListShareLinks(ctx context.Context, docID uuid.UUID, ownerID string) ([]ShareLink, error) {
	if err := s.ensureOwner(ctx, docID, ownerID); err != nil {
		return nil, err
	}
	rows, err := s.Pool.Query(ctx, `
SELECT `+shareLinkCols+`
FROM document_share_links
WHERE document_id = $1
  AND revoked_at IS NULL
  AND (expires_at IS NULL OR expires_at > now())
ORDER BY created_at DESC
`, docID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]ShareLink, 0)
	for rows.Next() {
		l, err := scanShareLink(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *l)
	}
	return out, rows.Err()
}

func (s *Store) RevokeShareLink(ctx context.Context, docID uuid.UUID, ownerID, token string) error {
	if err := s.ensureOwner(ctx, docID, ownerID); err != nil {
		return err
	}
	tag, err := s.Pool.Exec(ctx,
		`UPDATE document_share_links SET revoked_at = now()
		 WHERE token = $1 AND document_id = $2 AND revoked_at IS NULL`,
		token, docID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// LookupShareLink resolves a token to a live link + the doc it points at.
// Returns ErrNotFound for revoked/expired/missing tokens; never reveals
// whether the doc was deleted vs. the link was bad.
func (s *Store) LookupShareLink(ctx context.Context, token string) (*ShareLink, *Document, error) {
	link, err := scanShareLink(s.Pool.QueryRow(ctx,
		`SELECT `+shareLinkCols+` FROM document_share_links WHERE token = $1`, token))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil, ErrNotFound
		}
		return nil, nil, err
	}
	if link.RevokedAt != nil {
		return nil, nil, ErrNotFound
	}
	if link.ExpiresAt != nil && link.ExpiresAt.Before(time.Now()) {
		return nil, nil, ErrNotFound
	}

	doc, err := scanDoc(s.Pool.QueryRow(ctx,
		`SELECT `+documentCols+` FROM documents WHERE id = $1 AND deleted_at IS NULL`, link.DocumentID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil, ErrNotFound
		}
		return nil, nil, err
	}
	return link, doc, nil
}

// ensureOwner returns ErrForbidden if the user isn't the doc owner.
func (s *Store) ensureOwner(ctx context.Context, docID uuid.UUID, userID string) error {
	var ownerID string
	err := s.Pool.QueryRow(ctx,
		`SELECT owner_id FROM documents WHERE id = $1 AND deleted_at IS NULL`, docID).Scan(&ownerID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if ownerID != userID {
		return ErrForbidden
	}
	return nil
}
