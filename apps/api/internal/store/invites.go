package store

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type Invite struct {
	Token         string    `json:"token"`
	DocumentID    uuid.UUID `json:"document_id"`
	Email         string    `json:"email"`
	Role          string    `json:"role"`
	InvitedBy     string    `json:"invited_by"`
	GrantedUserID string    `json:"granted_user_id,omitempty"`
	ExpiresAt     time.Time `json:"expires_at"`
	CreatedAt     time.Time `json:"created_at"`
}

func (s *Store) ListInvites(ctx context.Context, docID uuid.UUID, ownerID string) ([]Invite, error) {
	if err := s.ensureOwner(ctx, docID, ownerID); err != nil {
		return nil, err
	}
	rows, err := s.Pool.Query(ctx, `
SELECT token, document_id, email::text, role, invited_by, expires_at, created_at
FROM document_invites
WHERE document_id = $1
  AND claimed_at IS NULL
  AND revoked_at IS NULL
  AND expires_at > now()
ORDER BY created_at DESC
`, docID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Invite, 0)
	for rows.Next() {
		var invite Invite
		if err := rows.Scan(&invite.Token, &invite.DocumentID, &invite.Email, &invite.Role, &invite.InvitedBy, &invite.ExpiresAt, &invite.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, invite)
	}
	return out, rows.Err()
}

func (s *Store) RevokeInvite(ctx context.Context, docID uuid.UUID, ownerID, token string) error {
	if err := s.ensureOwner(ctx, docID, ownerID); err != nil {
		return err
	}
	tag, err := s.Pool.Exec(ctx, `
UPDATE document_invites
SET revoked_at = now()
WHERE document_id = $1 AND token = $2 AND claimed_at IS NULL AND revoked_at IS NULL
`, docID, token)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) ResendInvite(ctx context.Context, docID uuid.UUID, ownerID, token string) (*Invite, error) {
	if err := s.ensureOwner(ctx, docID, ownerID); err != nil {
		return nil, err
	}
	var email, role string
	err := s.Pool.QueryRow(ctx, `
SELECT email::text, role
FROM document_invites
WHERE document_id = $1 AND token = $2 AND claimed_at IS NULL AND revoked_at IS NULL
`, docID, token).Scan(&email, &role)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := s.RevokeInvite(ctx, docID, ownerID, token); err != nil {
		return nil, err
	}
	return s.CreateInvite(ctx, docID, ownerID, email, role)
}

func (s *Store) CreateInvite(ctx context.Context, docID uuid.UUID, inviterID, email, role string) (*Invite, error) {
	if role != "viewer" && role != "editor" {
		return nil, fmt.Errorf("%w: invalid invite role", ErrInvalidInput)
	}
	email = strings.TrimSpace(email)
	if email == "" || !strings.Contains(email, "@") {
		return nil, fmt.Errorf("%w: invalid invite email", ErrInvalidInput)
	}

	d, err := s.GetDocument(ctx, docID, inviterID)
	if err != nil {
		return nil, err
	}
	if d.OwnerID != inviterID && !s.CanWrite(ctx, d, inviterID) {
		return nil, ErrForbidden
	}

	var userID string
	err = s.Pool.QueryRow(ctx, `SELECT id FROM users WHERE email = $1`, email).Scan(&userID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if userID == d.OwnerID {
		return nil, ErrInvalidInput
	}

	token, err := newInviteToken()
	if err != nil {
		return nil, err
	}

	const q = `
INSERT INTO document_invites (token, document_id, email, role, invited_by)
VALUES ($1, $2, $3, $4, $5)
RETURNING token, document_id, email, role, invited_by, expires_at, created_at
`
	var out Invite
	err = s.Pool.QueryRow(ctx, q, token, docID, email, role, inviterID).
		Scan(&out.Token, &out.DocumentID, &out.Email, &out.Role, &out.InvitedBy, &out.ExpiresAt, &out.CreatedAt)
	if err != nil {
		return nil, err
	}
	if userID != "" {
		if _, err := s.Pool.Exec(ctx, `
INSERT INTO document_access (document_id, user_id, role, granted_by)
VALUES ($1, $2, $3, $4)
ON CONFLICT (document_id, user_id) DO UPDATE SET
  role = EXCLUDED.role,
  granted_by = EXCLUDED.granted_by,
  granted_at = now()
`, docID, userID, role, inviterID); err != nil {
			return nil, err
		}
		if _, err := s.Pool.Exec(ctx, `UPDATE document_invites SET claimed_at = now() WHERE token = $1`, token); err != nil {
			return nil, err
		}
		out.GrantedUserID = userID
	}
	return &out, nil
}

func (s *Store) ClaimInvite(ctx context.Context, token, userID, email string) (*Document, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var docID uuid.UUID
	var role string
	var invitedBy string
	err = tx.QueryRow(ctx, `
SELECT document_id, role, invited_by
FROM document_invites
WHERE token = $1
  AND claimed_at IS NULL
  AND revoked_at IS NULL
  AND expires_at > now()
  AND email = $2
FOR UPDATE
`, token, email).Scan(&docID, &role, &invitedBy)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}

	if _, err := tx.Exec(ctx, `
INSERT INTO document_access (document_id, user_id, role, granted_by)
VALUES ($1, $2, $3, $4)
ON CONFLICT (document_id, user_id) DO UPDATE SET
  role = EXCLUDED.role,
  granted_by = EXCLUDED.granted_by,
  granted_at = now()
`, docID, userID, role, invitedBy); err != nil {
		return nil, err
	}

	if _, err := tx.Exec(ctx, `UPDATE document_invites SET claimed_at = now() WHERE token = $1`, token); err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.GetDocument(ctx, docID, userID)
}

func newInviteToken() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b[:]), nil
}
