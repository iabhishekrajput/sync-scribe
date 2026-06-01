package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// MaxAssetBytes caps a single upload at 8 MiB. The editor compresses screenshots
// before sending, so this is generous; the cap exists to keep pg row sizes
// bounded.
const MaxAssetBytes = 8 * 1024 * 1024

type Asset struct {
	ID          uuid.UUID `json:"id"`
	DocumentID  uuid.UUID `json:"document_id"`
	UploadedBy  string    `json:"uploaded_by"`
	Filename    string    `json:"filename"`
	ContentType string    `json:"content_type"`
	SizeBytes   int       `json:"size_bytes"`
	CreatedAt   time.Time `json:"created_at"`
}

type AssetBlob struct {
	Asset
	Data []byte
}

func (s *Store) InsertAsset(ctx context.Context, a Asset, data []byte) (*Asset, error) {
	row := s.Pool.QueryRow(ctx, `
INSERT INTO document_assets (document_id, uploaded_by, filename, content_type, size_bytes, data)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING id, created_at
`, a.DocumentID, a.UploadedBy, a.Filename, a.ContentType, a.SizeBytes, data)
	if err := row.Scan(&a.ID, &a.CreatedAt); err != nil {
		return nil, err
	}
	return &a, nil
}

// GetAsset returns the asset blob if it belongs to documentID. The document
// scoping is enforced at the SQL layer so a leaked asset ID alone is useless.
func (s *Store) GetAsset(ctx context.Context, documentID, assetID uuid.UUID) (*AssetBlob, error) {
	var b AssetBlob
	err := s.Pool.QueryRow(ctx, `
SELECT id, document_id, uploaded_by, filename, content_type, size_bytes, created_at, data
FROM document_assets
WHERE id = $1 AND document_id = $2
`, assetID, documentID).Scan(
		&b.ID, &b.DocumentID, &b.UploadedBy, &b.Filename,
		&b.ContentType, &b.SizeBytes, &b.CreatedAt, &b.Data,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &b, nil
}

func (s *Store) ListAssets(ctx context.Context, documentID uuid.UUID) ([]Asset, error) {
	rows, err := s.Pool.Query(ctx, `
SELECT id, document_id, uploaded_by, filename, content_type, size_bytes, created_at
FROM document_assets
WHERE document_id = $1
ORDER BY created_at DESC
LIMIT 200
`, documentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]Asset, 0, 32)
	for rows.Next() {
		var a Asset
		if err := rows.Scan(&a.ID, &a.DocumentID, &a.UploadedBy, &a.Filename,
			&a.ContentType, &a.SizeBytes, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
