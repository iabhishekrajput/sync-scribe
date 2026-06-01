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

var ErrNotFound = errors.New("not found")
var ErrForbidden = errors.New("forbidden")
var ErrInvalidInput = errors.New("invalid input")

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

type DocumentAccess struct {
	DocumentID  uuid.UUID `json:"document_id"`
	UserID      string    `json:"user_id"`
	Role        string    `json:"role"`
	GrantedBy   string    `json:"granted_by"`
	GrantedAt   time.Time `json:"granted_at"`
	Email       string    `json:"email,omitempty"`
	DisplayName string    `json:"display_name,omitempty"`
}

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

type RenameInput struct {
	Title string `json:"title"`
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

// PutSnapshot stores a new snapshot of the document body. M2 stores raw
// markdown bytes in doc_blob with an empty state_vector. M3 will replace this
// path with Yjs-encoded blobs from k_yrs_go; readers will treat the column as
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

// AppendUpdate writes a raw Yjs update to document_updates. seq is computed
// in-memory per doc via the next-value subquery; plan.md §6 calls out that
// BIGSERIAL global hot-spot is the wrong choice. For M3 we read MAX(seq)+1
// per insert. Move to an in-memory per-doc counter in the Hub when we see
// contention.
func (s *Store) AppendUpdate(ctx context.Context, docID uuid.UUID, originUser string, blob []byte) (int64, error) {
	const q = `
INSERT INTO document_updates (document_id, seq, update_blob, origin_user)
VALUES (
  $1,
  COALESCE((SELECT MAX(seq) FROM document_updates WHERE document_id = $1), 0) + 1,
  $2,
  NULLIF($3,'')
)
RETURNING seq
`
	var seq int64
	err := s.Pool.QueryRow(ctx, q, docID, blob, originUser).Scan(&seq)
	return seq, err
}

// LoadUpdates returns all stored update blobs for a document in seq order.
// Used at WS connect to replay history into a fresh client Y.Doc.
func (s *Store) LoadUpdates(ctx context.Context, docID uuid.UUID) ([][]byte, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT update_blob FROM document_updates WHERE document_id = $1 ORDER BY seq ASC`,
		docID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([][]byte, 0)
	for rows.Next() {
		var b []byte
		if err := rows.Scan(&b); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
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
