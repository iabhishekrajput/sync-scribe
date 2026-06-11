package store

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type SnapshotSummary struct {
	DocumentID     uuid.UUID        `json:"document_id"`
	Version        int64            `json:"version"`
	UpdateStartSeq int64            `json:"update_start_seq"`
	UpdateCount    int64            `json:"update_count"`
	LastSeq        int64            `json:"last_seq"`
	SizeBytes      int              `json:"size_bytes"`
	CreatedBy      string           `json:"created_by,omitempty"`
	CreatedByName  string           `json:"created_by_name,omitempty"`
	CreatedAt      time.Time        `json:"created_at"`
	ActorBreakdown map[string]int64 `json:"actor_breakdown"`
	PreviewText    bool             `json:"preview_text"`
}

type SnapshotBody struct {
	DocumentID uuid.UUID `json:"document_id"`
	Version    int64     `json:"version"`
	Body       string    `json:"body"`
	CanPreview bool      `json:"can_preview"`
	CreatedAt  time.Time `json:"created_at"`
}

type MarkdownExport struct {
	Filename string
	Body     []byte
	Version  int64
}

// PutSnapshot stores a new snapshot of the document body as raw markdown
// bytes in doc_blob with an empty state_vector. Readers treat the column as
// opaque bytes and round-trip via the CRDT layer.
//
// Returns the new version number.
func (s *Store) PutSnapshot(ctx context.Context, docID uuid.UUID, authorID string, body []byte) (int64, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var version int64
	if err := tx.QueryRow(ctx,
		`SELECT current_version + 1 FROM documents WHERE id = $1 FOR UPDATE`, docID).
		Scan(&version); err != nil {
		return 0, err
	}

	var lastSeq int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(seq), 0) FROM document_updates WHERE document_id = $1`, docID).
		Scan(&lastSeq); err != nil {
		return 0, err
	}

	if _, err := tx.Exec(ctx, `
INSERT INTO document_snapshots (document_id, version, state_vector, doc_blob, last_seq, created_by)
VALUES ($1, $2, ''::bytea, $3, $4, $5)
`, docID, version, body, lastSeq, authorID); err != nil {
		return 0, err
	}

	if _, err := tx.Exec(ctx,
		`UPDATE documents SET current_version = $2, updated_at = now() WHERE id = $1`,
		docID, version); err != nil {
		return 0, err
	}
	return version, tx.Commit(ctx)
}

func (s *Store) ListSnapshots(ctx context.Context, docID uuid.UUID, userID string) ([]SnapshotSummary, error) {
	if _, err := s.GetDocument(ctx, docID, userID); err != nil {
		return nil, err
	}

	rows, err := s.Pool.Query(ctx, `
WITH snapshots AS (
  SELECT
    document_id,
    version,
    last_seq,
    size_bytes,
    created_by,
    created_at,
    doc_blob,
    COALESCE(LAG(last_seq) OVER (PARTITION BY document_id ORDER BY version), 0) AS prev_last_seq
  FROM document_snapshots
  WHERE document_id = $1
)
SELECT
  s.document_id,
  s.version,
  s.prev_last_seq + 1,
  GREATEST(s.last_seq - s.prev_last_seq, 0),
  s.last_seq,
  s.size_bytes,
  COALESCE(s.created_by, ''),
  COALESCE(u.display_name, ''),
  s.created_at,
  s.doc_blob,
  COALESCE(a.user_count, 0),
  COALESCE(a.guest_count, 0)
FROM snapshots s
LEFT JOIN users u ON u.id = s.created_by
LEFT JOIN LATERAL (
  SELECT
    count(*) FILTER (WHERE origin_user IS NOT NULL) AS user_count,
    count(*) FILTER (WHERE origin_user IS NULL) AS guest_count
  FROM document_updates u
  WHERE u.document_id = s.document_id
    AND u.seq > s.prev_last_seq
    AND u.seq <= s.last_seq
) a ON true
ORDER BY s.version ASC
`, docID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]SnapshotSummary, 0)
	for rows.Next() {
		var snap SnapshotSummary
		var body []byte
		var userCount, guestCount int64
		if err := rows.Scan(
			&snap.DocumentID,
			&snap.Version,
			&snap.UpdateStartSeq,
			&snap.UpdateCount,
			&snap.LastSeq,
			&snap.SizeBytes,
			&snap.CreatedBy,
			&snap.CreatedByName,
			&snap.CreatedAt,
			&body,
			&userCount,
			&guestCount,
		); err != nil {
			return nil, err
		}
		snap.ActorBreakdown = map[string]int64{"user": userCount, "guest": guestCount}
		snap.PreviewText = utf8.Valid(body)
		out = append(out, snap)
	}
	return out, rows.Err()
}

func (s *Store) GetSnapshot(ctx context.Context, docID uuid.UUID, version int64, userID string) (*SnapshotBody, error) {
	if _, err := s.GetDocument(ctx, docID, userID); err != nil {
		return nil, err
	}
	var body []byte
	var out SnapshotBody
	err := s.Pool.QueryRow(ctx, `
SELECT document_id, version, doc_blob, created_at
FROM document_snapshots
WHERE document_id = $1 AND version = $2
`, docID, version).Scan(&out.DocumentID, &out.Version, &body, &out.CreatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	out.CanPreview = utf8.Valid(body)
	if out.CanPreview {
		out.Body = string(body)
	}
	return &out, nil
}

func (s *Store) RestoreSnapshot(ctx context.Context, docID uuid.UUID, version int64, userID string) (*Document, int64, error) {
	d, role, err := s.ResolveDocumentRole(ctx, docID, userID)
	if err != nil {
		return nil, 0, err
	}
	if !CanRoleWrite(role) {
		return nil, 0, ErrForbidden
	}
	var body []byte
	err = s.Pool.QueryRow(ctx, `
SELECT doc_blob
FROM document_snapshots
WHERE document_id = $1 AND version = $2
`, docID, version).Scan(&body)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, 0, ErrNotFound
		}
		return nil, 0, err
	}
	newVersion, err := s.PutSnapshot(ctx, docID, userID, body)
	if err != nil {
		return nil, 0, err
	}
	refreshed, err := s.GetDocument(ctx, d.ID, userID)
	if err != nil {
		return nil, 0, err
	}
	return refreshed, newVersion, nil
}

// LatestSnapshotBody returns the most recent snapshot's bytes, or empty slice
// if the document has no snapshots yet.
func (s *Store) LatestSnapshotBody(ctx context.Context, docID uuid.UUID) ([]byte, int64, error) {
	var body []byte
	var version int64
	err := s.Pool.QueryRow(ctx, `
SELECT doc_blob, version FROM document_snapshots
WHERE document_id = $1
ORDER BY version DESC
LIMIT 1
`, docID).Scan(&body, &version)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, 0, nil
		}
		return nil, 0, err
	}
	return body, version, nil
}

func (s *Store) ExportMarkdown(ctx context.Context, docID uuid.UUID, userID string) (*MarkdownExport, error) {
	d, err := s.GetDocument(ctx, docID, userID)
	if err != nil {
		return nil, err
	}
	body, version, err := s.LatestSnapshotBody(ctx, docID)
	if err != nil {
		return nil, err
	}
	if version == 0 {
		return nil, ErrInvalidInput
	}
	if !utf8.Valid(body) {
		return nil, ErrInvalidInput
	}
	return &MarkdownExport{
		Filename: safeMarkdownFilename(d.Title),
		Body:     body,
		Version:  version,
	}, nil
}

func safeMarkdownFilename(title string) string {
	title = strings.TrimSpace(title)
	if title == "" {
		title = "Untitled"
	}
	var b strings.Builder
	for _, r := range title {
		switch {
		case r >= 'a' && r <= 'z':
			b.WriteRune(r)
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r)
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-' || r == '_':
			b.WriteRune(r)
		case r == ' ':
			b.WriteRune('-')
		}
	}
	if b.Len() == 0 {
		return "Untitled.md"
	}
	return b.String() + ".md"
}
