package store

import (
	"context"

	"github.com/google/uuid"
)

// AppendUpdate writes a raw Yjs update to document_updates. seq is computed
// in-memory per doc via the next-value subquery; plan.md §6 calls out that
// BIGSERIAL global hot-spot is the wrong choice. For M3 we read MAX(seq)+1
// per insert. Move to an in-memory per-doc counter in the Hub when we see
// contention.
//
// origin_user is the per-user provenance substrate (PLAN.md §4) — empty
// originUser (guests) stores NULL via NULLIF so the users FK holds.
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
