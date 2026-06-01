package store

import (
	"context"
	"time"
)

type User struct {
	ID          string    `json:"id"`
	Email       string    `json:"email"`
	DisplayName string    `json:"display_name"`
	AvatarURL   string    `json:"avatar_url,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
}

// UpsertUser materializes the row on first authenticated touch and refreshes
// profile fields on every subsequent call. last_seen_at is bumped so we can
// tell who's actually using SyncScribe vs. who has a stale token.
//
// Idempotent — safe to call on every /api/me hit.
func (s *Store) UpsertUser(ctx context.Context, u User) (*User, error) {
const q = `
INSERT INTO users (id, email, display_name, avatar_url, last_seen_at)
VALUES ($1, $2, $3, NULLIF($4,''), now())
ON CONFLICT (id) DO UPDATE SET
  email         = EXCLUDED.email,
  display_name  = EXCLUDED.display_name,
  avatar_url    = COALESCE(EXCLUDED.avatar_url, users.avatar_url),
  last_seen_at  = now()
RETURNING id, email, display_name, COALESCE(avatar_url,''), created_at
`
	var out User
	err := s.Pool.QueryRow(ctx, q, u.ID, u.Email, u.DisplayName, u.AvatarURL).
		Scan(&out.ID, &out.Email, &out.DisplayName, &out.AvatarURL, &out.CreatedAt)
	if err != nil {
		return nil, err
	}
	if err := s.ClaimPendingInvitesForUser(ctx, out.ID, out.Email); err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *Store) ClaimPendingInvitesForUser(ctx context.Context, userID, email string) error {
	if userID == "" || email == "" {
		return nil
	}
	_, err := s.Pool.Exec(ctx, `
WITH pending AS (
  SELECT document_id, role, invited_by
  FROM document_invites
  WHERE email = $2
    AND claimed_at IS NULL
    AND revoked_at IS NULL
    AND expires_at > now()
),
granted AS (
  INSERT INTO document_access (document_id, user_id, role, granted_by)
  SELECT document_id, $1, role, invited_by
  FROM pending
  ON CONFLICT (document_id, user_id) DO UPDATE SET
    role = EXCLUDED.role,
    granted_by = EXCLUDED.granted_by,
    granted_at = now()
  RETURNING document_id
)
UPDATE document_invites
SET claimed_at = now()
WHERE email = $2
  AND claimed_at IS NULL
  AND revoked_at IS NULL
  AND expires_at > now()
  AND document_id IN (SELECT document_id FROM granted)
`, userID, email)
	return err
}
