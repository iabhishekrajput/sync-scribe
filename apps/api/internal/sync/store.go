package sync

import (
	"context"

	"github.com/google/uuid"

	docstore "github.com/abhishek/sync-scribe/api/internal/store"
)

// updateStore is the slim slice of *docstore.Store the sync package needs.
// Keeping the surface small makes test mocks trivial.
type updateStore interface {
	AppendUpdate(ctx context.Context, docID uuid.UUID, originUser string, blob []byte) (int64, error)
	LoadUpdates(ctx context.Context, docID uuid.UUID) ([][]byte, error)
}

type dbStore struct{ s *docstore.Store }

func (d *dbStore) AppendUpdate(ctx context.Context, docID uuid.UUID, originUser string, blob []byte) (int64, error) {
	return d.s.AppendUpdate(ctx, docID, originUser, blob)
}

func (d *dbStore) LoadUpdates(ctx context.Context, docID uuid.UUID) ([][]byte, error) {
	return d.s.LoadUpdates(ctx, docID)
}
